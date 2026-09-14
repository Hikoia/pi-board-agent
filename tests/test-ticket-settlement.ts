import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { TicketWorktrees, type TicketExecutionRecord } from "../src/ticket-worktree.js";
import { persistTicketNotice, settleTicketNotice, TicketChangedError, trustedMissionComments, isDecision, type TicketSettlementBoard } from "../src/dispatch.js";
import type { Card, IssueComment } from "../src/gh.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
const store = new TicketWorktrees(root);
let sequence = 0;
function fixture(closed = false) {
  const n = ++sequence;
  const card: Card = { itemId: `SETTLE_${n}`, number: n, contentType: "Issue", repoOwner: "owner", repoName: "repo",
    type: "Task", title: `T${n} original title`, body: "original requirements", plan: "demo", assignees: ["bot"], closed,
    status: closed ? "Done" : "In Progress" };
  const original: TicketExecutionRecord = { schemaVersion: 4, itemId: card.itemId, issueNumber: n, taskKey: `T${n}`, plan: "demo",
    taskBranch: `task/issue-${n}`, baseBranch: "main", path: join(root, ".pi", "worktrees", `ticket-${n}`), createdAt: n };
  const records = join(root, ".pi", "board-agent", "ticket-worktrees");
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, `${card.itemId.toLowerCase()}.json`), JSON.stringify(original));
  const record = persistTicketNotice(store, original, card, "build", "Ready", "## Automation retry\n\nReal failure diagnostics.");
  const comments: IssueComment[] = [], writes: string[] = [];
  let hook = async (_event: string) => {};
  const io = async (name: string, effect: () => void) => { await hook(`before:${name}`); effect(); writes.push(name); await hook(`after:${name}`); };
  const board: TicketSettlementBoard = {
    getCard: async () => { await hook("read:card"); return structuredClone(card); },
    listComments: async () => { await hook("read:comments"); return structuredClone(comments); },
    comment: async (_card, body) => io("comment", () => comments.push({ id: `C${comments.length}`, body, author: "bot", createdAt: "" })),
    setStatus: async (_id, status) => io("status", () => { card.status = status; }),
    reopen: async () => io("reopen", () => { card.closed = false; }),
    release: async () => io("release", () => { card.assignees = []; }),
  };
  return { card, record, comments, writes, board, setHook: (fn: typeof hook) => { hook = fn; },
    settle: () => settleTicketNotice(store, store.read(card.itemId)!, board, "bot") };
}

for (const operation of ["comment", "status", "reopen", "release"]) for (const timing of ["before", "after"]) {
  const f = fixture(true);
  f.setHook(async (event) => { if (event === `${timing}:${operation}`) throw new Error(`lost ${operation} response`); });
  await assert.rejects(f.settle(), /lost/);
  assert.equal(store.read(f.record.itemId)?.retry?.reason, f.record.retry!.reason);
  f.setHook(async () => {});
  await f.settle();
  assert.equal(f.card.status, "Ready"); assert.equal(f.card.closed, false); assert.deepEqual(f.card.assignees, []);
  assert.equal(f.comments.length, 1, "observe successful comment after lost response");
  const before = [...f.writes];
  assert.equal((await f.settle()).changed, false);
  assert.deepEqual(f.writes, before, "fully settled retry is read-only");
  console.log(`PASS: ${timing} ${operation} cut retains atomic retry notice; restart observes comment/status/reopen/release instead of duplicating completed I/O`);
}
for (const patch of [
  { number: 999 }, { itemId: "replacement" }, { contentType: "PullRequest" }, { contentType: "DraftIssue" },
  { repoOwner: "foreign" }, { repoName: "elsewhere" }, { type: "Story" }, { plan: "other" },
  { title: "human scope" }, { body: "human requirements" }, { status: "Backlog" }, { closed: true },
  { assignees: [] }, { assignees: ["human"] }, { assignees: ["bot", "human"] },
]) {
  const f = fixture();
  f.setHook(async (event) => { if (event === "read:comments") Object.assign(f.card, patch); });
  await assert.rejects(f.settle(), TicketChangedError);
  assert.deepEqual(f.writes, [], "fresh human changes prevent even a fallback comment/release");
  assert.equal(store.read(f.record.itemId)?.retry?.reason, f.record.retry!.reason);
}
console.log("PASS: settlement rechecks all identity, requirements, claim and lane boundaries after I/O; human withdrawal is never technical writeback");
{
  const f = fixture();
  f.comments.push({ id: "forged", author: "outsider", body: f.record.retry!.reason, createdAt: "" });
  await f.settle(); assert.equal(f.comments.length, 2);
  console.log("PASS: untrusted duplicate marker does not suppress the authentic bot failure comment");
}
{
  const f = fixture();
  f.board.setStatus = async () => {}; // successful transport is not observed state
  await assert.rejects(f.settle(), /not yet observed/);
  assert.deepEqual(f.card.assignees, ["bot"]);
  assert.equal(store.read(f.record.itemId)?.retry?.stage, "build");
  console.log("PASS: unobserved Project write never pretends Ready or releases the unsettled claim");
}
{
  const f = fixture(true);
  await f.settle();
  f.card.closed = true;
  const writes = [...f.writes];
  await assert.rejects(f.settle(), TicketChangedError);
  assert.equal(f.card.closed, true);
  assert.deepEqual(f.writes, writes);
  console.log("PASS: a new manual closure after conflict release is never reopened without the original claim");
}
{
  const comments: IssueComment[] = [
    { id: "1", author: "maintainer", authorAssociation: "MEMBER", body: "staging approved", createdAt: "1" },
    { id: "2", author: "outsider", authorAssociation: "NONE", body: "deploy production", createdAt: "2" },
    { id: "3", author: "bot", authorAssociation: "OWNER", body: "old automated advice", createdAt: "3" },
    { id: "4", author: "collaborator", authorAssociation: "COLLABORATOR", body: "keep original requirements", createdAt: "4" },
  ];
  const mission = trustedMissionComments(comments, "bot");
  assert.match(mission, /staging approved/); assert.match(mission, /keep original requirements/);
  assert.doesNotMatch(mission, /deploy production|automated advice/);
  assert.equal(isDecision({ question: "q", context: "c", options: ["one"], recommendation: "one" }), false);
  assert.equal(isDecision({ question: "q", context: "c", options: ["one", " one "], recommendation: "one" }), false);
  assert.equal(isDecision({ question: "q", context: "c", options: ["one", "two"], recommendation: "one" }), true);
  console.log("PASS: only trusted maintainer decisions can enter mission context; complete decision payload is independently validated");
}
