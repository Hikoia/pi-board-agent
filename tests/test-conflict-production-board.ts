import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const globals = globalThis as any;
let respond: (args: string[]) => Promise<unknown>;
globals.__conflictGh = async (command: string, args: string[]) => {
  assert.equal(command, "gh");
  return { ok: true, status: 0, timedOut: false, signal: null, stdout: JSON.stringify(await respond(args)), stderr: "" };
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === new URL("../src/gh.ts", import.meta.url).href && specifier === "./process-runner.js") return {
    url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL("../src/process-runner.ts", import.meta.url).href)}; export const runProcess = (...args) => globalThis.__conflictGh(...args);`)}`, shortCircuit: true,
  };
  return next(specifier, context);
} });
const { fixture } = await import("./conflict-handoff-fixture.js");
const { createProductionTicketExecutor } = await import("../src/ticket-executor.js");
const { reopenIssue } = await import("../src/gh.js");
try {
  for (const corruptReopen of [false, true]) {
    const f = await fixture(); const queries: string[] = [];
    respond = async (args) => {
      if (args[0] === "issue" && args[1] === "view") return { state: f.card.closed ? "CLOSED" : "OPEN", assignees: f.card.assignees.map((login) => ({ login })) };
      if (args[0] === "issue" && args[1] === "edit") {
        if (args.includes("--add-assignee")) f.card.assignees = ["bot"];
        else if (args.includes("--remove-assignee")) f.card.assignees = [];
        else assert.fail("unexpected issue edit");
        return {};
      }
      assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
      const fields = Object.fromEntries(args.filter((s) => s.includes("=")).map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
      const q = fields.query; queries.push(q);
      const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
      if (q.includes("... on ProjectV2Item {")) return { data: { node: { id: f.card.itemId,
        fieldValues: connection([{ name: f.card.status, field: { name: f.cfg.status_field } }, { name: f.card.plan, field: { name: f.cfg.plan_field } }, { name: f.card.type, field: { name: f.cfg.type_field } }]),
        content: { __typename: "Issue", number: f.card.number, title: f.card.title, body: f.card.body, closed: f.card.closed, assignees: { nodes: f.card.assignees.map((login) => ({ login })) }, repository: { owner: { login: "owner" }, name: "repo" } },
      } } };
      if (q.includes("comments(first:")) return { data: { repository: { issue: { comments: connection(f.comments.map((c) => ({ ...c, author: { login: c.author } }))) } } } };
      if (q.includes("addComment(input:")) {
        await f.board.comment(f.card, fields.body);
        const id = f.comments.at(-1)!.id;
        return { data: { addComment: { commentEdge: { node: { id, author: { login: "bot" } } } } } };
      }
      if (q.includes("updateProjectV2ItemFieldValue(input:")) {
        await f.board.setStatus(fields.itemId, fields.optionId);
        return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: fields.itemId } } } };
      }
      if (q.includes("reopenIssue(input:")) {
        assert.equal(fields.id, "ISSUE");
        if (corruptReopen) return { data: { reopenIssue: { issue: { id: fields.id, closed: true } } } };
        await f.board.reopen!(f.card);
        return { data: { reopenIssue: { issue: { id: fields.id, closed: false } } } };
      }
      if (q.includes("issue(number:")) return { data: { repository: { issue: { id: "ISSUE" } } } };
      assert.fail(`Unexpected production gh command: ${q}`);
    };
    const executor = createProductionTicketExecutor({ cwd: f.repo, cfg: f.cfg, worktrees: f.store, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {}, meta: { projectId: "P", statusFieldId: "S", statusOptions: { Ready: "Ready" } } });
    try {
      const result = await executor.finalizeClosed(f.card);
      assert.equal(result.status, "blocked", JSON.stringify(result)); // Integration still awaits conflict resolution, even after a successful handoff.
      assert.equal(f.card.closed, corruptReopen); assert.equal(f.card.status, corruptReopen ? f.cfg.columns.done : f.cfg.columns.ready);
      assert.equal(f.card.body, "Keep original task edits and integrate base behavior.");
      assert.equal(f.comments.length, 1);
      assert.ok(queries.some((q) => q.includes("author { login }")), "production downloads ACTUAL author, not body/association/write reply");
      assert.ok(!queries.some((q) => q.includes("updateIssue(input:")), "no issue-body mutation");
      assert.ok(!queries.some((q) => q.includes("updateIssueComment")));
      console.log(`PASS: production adapter ${corruptReopen ? "retains pending writeback after unconfirmed reopen" : "claims the approved closed Issue and reopens Ready without body edits or legacy marker protocol"}`);
    } finally { await executor.shutdown(); await f.loop.stop(); }
  }
  respond = async () => ({ data: { reopenIssue: { issue: { id: "expected", closed: true } } } });
  await assert.rejects(reopenIssue("expected"), /unconfirmed/);
  console.log("PASS: production new mutation response boundaries reject mismatched comment identity/unconfirmed reopen");
} finally { hooks.deregister(); delete globals.__conflictGh; }
