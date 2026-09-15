// Real loop + foreground workflow runners. Only the model and board I/O are fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { WorkflowAgent } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopBoardOps } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { runDesign } from "../src/refine.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const origin = join(cwd, "origin.git");
git("init", "--bare", origin);
git("init", "-b", "main");
git("config", "user.name", "Offline");
git("config", "user.email", "offline@example.test");
writeFileSync(join(cwd, ".gitignore"), ".pi/\norigin.git/\n");
writeFileSync(join(cwd, "README.md"), "base\n");
git("add", ".gitignore", "README.md");
git("commit", "-m", "fixture");
git("remote", "add", "origin", origin);
git("push", "origin", "main");
git("branch", "task/issue-3");
git("push", "origin", "task/issue-3");
const sha = git("rev-parse", "HEAD");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>((done) => setImmediate(done));
let mode = "";
const globals = globalThis as any;
globals.__foregroundBoard = {
  listPrsWithLabel: async () => [{ number: 3, headRefName: "task/issue-3", headRefOid: sha, isCrossRepository: false, url: "offline:pr-3" }],
  listPrComments: async () => mode === "watch-reply" ? [{ id: "reply-1", author: "maintainer", authorAssociation: "MEMBER", body: "@bot explain", createdAt: "2025-01-01" }] : [],
  getCheckRuns: async () => [{ name: "offline check", status: "completed", conclusion: "failure" }],
};
const shim = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(new URL("../src/gh.ts", import.meta.url).href)};
export const { listPrsWithLabel, listPrComments, getCheckRuns } = globalThis.__foregroundBoard;
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./gh.js" && context.parentURL === new URL("../src/watchdog.ts", import.meta.url).href)
      return { url: shim, shortCircuit: true };
    return next(specifier, context);
  },
});
const original = WorkflowAgent.prototype.run;
try {
  for (mode of ["story", "task-design", "review", "watch-reply", "watch-fix"]) {
    const cfg = structuredClone(_DEFAULTS);
    cfg.safety.require_clean_worktree = false;
    cfg.context.enabled = cfg.telegram.enabled = false;
    cfg.refine.enabled = mode === "story" || mode === "task-design";
    cfg.review.enabled = mode === "review";
    cfg.watchdog.enabled = mode.startsWith("watch-");
    cfg.watchdog.respond_to_mentions = mode === "watch-reply";
    const card: Card = {
      itemId: "PVTI_3", contentType: "Issue", number: 3, title: "Contract", body: "Acceptance",
      repoOwner: "owner", repoName: "repo", plan: "demo", closed: false, assignees: [],
      type: mode === "story" ? "Story" : "Task",
      status: mode === "story" ? cfg.columns.ready : mode === "task-design" ? cfg.columns.needs_design : mode === "review" ? cfg.columns.review : cfg.columns.backlog,
    };
    const comments: IssueComment[] = mode === "task-design" ? [
      { id: "gate", author: "bot", createdAt: "2025-01-01", body: "<!-- board-agent-requirements-gate:3 -->\nApprove requirements" },
      { id: "decision", author: "owner", authorAssociation: "OWNER", createdAt: "2025-01-02", body: "Approved scope" },
    ] : [];
    const worktrees = new TicketWorktrees(cwd);
    if (mode === "review") {
      const dir = join(cwd, ".pi", "board-agent", "ticket-worktrees");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pvti_3.json"), JSON.stringify({
        schemaVersion: 4, itemId: card.itemId, issueNumber: 3, taskKey: "T003", plan: "demo",
        taskBranch: "task/issue-3", baseBranch: "main", path: join(cwd, ".pi", "worktrees", "pvti_3"), createdAt: 1,
      }));
    }
    if (mode.startsWith("watch-"))
      writeFileSync(join(cwd, ".pi", "board-agent", "watchdog-state.json"), JSON.stringify({ 3: { fixAttempts: 0, needsHuman: false, lastSeenCommentId: "" } }));
    const owner = acquireOwnerLock(cwd, "bot");
    const entered = deferred(), cleanup = deferred(), finish = deferred();
    let received: AbortSignal | undefined;
    let cleanups = 0, calls = 0, releases = 0, mutations = 0, drains = 0;
    WorkflowAgent.prototype.run = (async (_prompt, options) => {
      calls++;
      received = options?.signal;
      entered.resolve();
      try {
        await new Promise<never>((_resolve, reject) => {
          if (received?.aborted) reject(new DOMException("cancelled", "AbortError"));
          else received?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
          // Bounded red path when the loop's signal is not connected.
          void finish.promise.then(() => reject(new DOMException("offline teardown", "AbortError")));
        });
      } finally {
        cleanups++;
        cleanup.resolve();
        await finish.promise;
      }
    }) as typeof original;
    const board: LoopBoardOps = {
      claim: async () => { card.assignees = ["bot"]; return true; },
      refresh: async () => structuredClone(card), listComments: async () => comments,
      release: async () => { releases++; card.assignees = []; },
      comment: async () => { mutations++; return "unexpected"; },
      setStatus: async () => { mutations++; },
    };
    const state = createLoopState();
    const loop = new BoardLoop({
      cwd, cfg, repoOwner: "owner", repoName: "repo", botLogin: "bot",
      meta: {
        projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT",
        statusOptions: Object.fromEntries(Object.values(cfg.columns).map((name) => [name, name])),
        planFieldId: "PLAN", planFieldType: "TEXT", typeFieldId: "TYPE", typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK", Story: "STORY" },
      },
      callback: () => {}, listCards: async () => [structuredClone(card)], boardOps: board,
      taskDesignOps: { ...board, design: runDesign, comment: async () => { mutations++; }, updateBody: async () => { mutations++; }, setReady: async () => { mutations++; } },
    }, state, {
      reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
      activeCount: () => 0,
      launch: async () => { throw new Error("unexpected builder launch"); },
      finalizeClosed: async () => { throw new Error("unexpected finalization"); },
      shutdown: async () => { drains++; },
    }, worktrees, owner);
    const tick = loop.tickNow();
    // Do not hide a failure to reach the model behind an unresolved test promise.
    await Promise.race([entered.promise, tick.then(() => { throw new Error(`${mode}: no model reached`); })]);
    const stop = loop.stop();
    const second = loop.stop();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    try {
      assert.ok(received?.aborted, `${mode}: loop stop must reach the foreground runWorkflow signal`);
      await cleanup.promise;
      await turn();
      assert.equal(stopped, false, `${mode}: abort is not cleanup completion`);
      assert.equal(drains, 0, "tick cleanup precedes manager drain");
      assert.equal(releases, 0, "claim must stay held until workflow cleanup settles");
      assert.ok(existsSync(owner.path));
    } finally {
      finish.resolve();
      await Promise.all([tick, stop, second]);
    }
    assert.equal(cleanups, 1);
    assert.equal(calls, 1);
    assert.equal(drains, 1);
    assert.equal(releases, mode.startsWith("watch-") ? 0 : 1);
    assert.equal(mutations, 0, "cancelled output never writes a card");
    assert.equal(state.reviewingTask, null);
    assert.equal(existsSync(owner.path), false);
    if (mode === "review") {
      assert.ok(!readdirSync(join(cwd, ".pi", "worktrees")).some((name) => name.startsWith("review-")));
      assert.equal(git("for-each-ref", "--format=%(refname)", "refs/board-agent/reviews/"), "");
    }
    if (mode === "watch-fix") {
      assert.ok(readdirSync(join(cwd, ".pi", "worktrees")).some((name) => name.startsWith("watchdog-3-")), "cancelled CI fix retains work for inspection, never destructive cleanup");
      assert.equal(git("ls-remote", "origin", "refs/heads/task/issue-3").split(/\s/)[0], sha);
    }
    console.log(`PASS: ${mode} loop cancellation drains actual runWorkflow finally once before claim/owner release, with no stale writes`);
  }
} finally {
  WorkflowAgent.prototype.run = original;
  hooks.deregister();
  delete globals.__foregroundBoard;
}
