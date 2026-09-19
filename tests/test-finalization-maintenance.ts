// Real executor/retry/loop; memory store isolates scheduling and board semantics from Git latency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import { acquireOwnerLock, ownerLockIsHeld } from "../src/owner-lock.js";
import { ManagedTicketExecutor, type TicketBoardAdapter } from "../src/ticket-executor.js";
import { pendingTicketWrite, queueTicketWrite } from "../src/ticket-retry.js";
import { type TicketExecutionRecord, TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd);
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise<void>((r) => setImmediate(r));
function fixture(status = "Done", stage: "integrate" | "cleanup" = "cleanup") {
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = 2; cfg.safety.require_clean_worktree = false;
  const card: Card = { itemId: "A", number: 1, title: "T001 task", body: "approved", type: "Task", contentType: "Issue", repoOwner: "owner", repoName: "repo", status, closed: true, assignees: [] };
  let record: TicketExecutionRecord | undefined = { schemaVersion: 4, itemId: "A", issueNumber: 1, taskKey: "T001", taskBranch: "task/issue-1", baseBranch: "main", path: cwd, createdAt: 1, integration: { baseSha: "a".repeat(40), taskSha: "b".repeat(40), resultSha: "c".repeat(40) }, retry: { stage, reason: "prior failure" } };
  const writes: string[] = [], reads: string[] = [], models: string[] = [];
  const store = new TicketWorktrees(cwd);
  store.read = (id) => id === "A" ? structuredClone(record) : undefined;
  store.list = () => record ? [structuredClone(record)] : [];
  store.update = (_id, mutate) => record = mutate(structuredClone(record!));
  store.finalizeAccepted = async () => { throw new Error("offline Git failure"); };
  store.localBranchSha = () => undefined;
  store.remoteSha = async () => undefined;
  store.completeFinalization = async () => { record = undefined; };
  const board: TicketBoardAdapter = {
    getCard: async (id) => { reads.push(id); return id === "A" ? structuredClone(card) : undefined; },
    claim: async () => { writes.push("claim"); card.assignees = ["bot"]; return true; },
    release: async () => { writes.push("release"); card.assignees = card.assignees.filter((a) => a !== "bot"); },
    setStatus: async (_id, s) => { writes.push(s); card.status = s; },
    reopen: async () => { writes.push("reopen"); card.closed = false; },
    comment: async () => { writes.push("comment"); }, listComments: async () => [],
  };
  const executor = new ManagedTicketExecutor({ cwd, cfg, board, worktrees: store, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback() {}, createManager() { throw new Error("no maintenance model"); } });
  executor.launch = async (c) => { models.push(c.itemId); return { status: "launched", runId: c.itemId, worktree: cwd }; };
  const state = createLoopState();
  const owner = acquireOwnerLock(cwd, "bot");
  const ready = { ...card, itemId: "B", number: 2, status: cfg.columns.ready, closed: false };
  const cards = [card, ready];
  const deps: LoopDeps = { cwd, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, callback() {}, listCards: async () => structuredClone(cards) };
  const loop = new BoardLoop(deps, state, executor, store, owner);
  const queue = () => { card.assignees = ["bot"]; return queueTicketWrite(store, record!, stage, { card: structuredClone(card), status: cfg.columns.ready, reason: "old network failure", retry: true, comment: "obsolete retry comment" }); };
  return { card, cards, deps, cfg, board, store, executor, loop, state, owner, queue, writes, reads, models, record: () => record! };
}

for (const stage of ["integrate", "cleanup"] as const) for (const lane of ["Done", "Backlog", "Ready"]) {
  const f = fixture(lane, stage);
  try {
    assert.equal((await f.executor.finalizeClosed(structuredClone(f.card))).status, "blocked");
    assert.equal(f.card.status, lane, "technical failure must never regress Project Status");
    assert.deepEqual(f.writes, [], "no claim/comment/reopen for technical retry");
    assert.equal(f.record().retry?.stage, stage);
    f.store.finalizeAccepted = async () => "c".repeat(40);
    assert.equal((await f.executor.finalizeClosed(structuredClone(f.card))).status, "finalized");
    assert.equal(f.card.status, "Backlog"); assert.equal(f.record(), undefined);
    assert.deepEqual(f.models, []);
  } finally { await f.loop.stop(); }
}
console.log("PASS: Done/Backlog/old closed Ready technical failures retain the lane, retry locally, and finish without models");

for (const withdrawal of ["none", "body", "open", "owner", "Needs Human"]) {
  const f = fixture();
  try {
    f.queue();
    if (withdrawal === "body") f.card.body = "changed";
    if (withdrawal === "open") f.card.closed = false;
    if (withdrawal === "owner") f.card.assignees.push("human");
    if (withdrawal === "Needs Human") f.card.status = "Needs Human";
    const before = structuredClone(f.card);
    await f.executor.finalizeClosed(structuredClone(f.card));
    assert.equal(pendingTicketWrite(f.record()), undefined);
    assert.ok(f.writes.every((s) => s === "release"), "retirement never replays Ready/comment/reopen");
    assert.equal(f.card.status, before.status); assert.equal(f.card.closed, before.closed);
    assert.equal(f.record().retry?.stage, "cleanup", "withdrawal must not erase the confirmed cleanup-only stage");
    assert.deepEqual(f.card.assignees, before.assignees.filter((a) => a !== "bot"));
  } finally { await f.loop.stop(); }
}
console.log("PASS: old technical Ready writebacks release safely without replay; human withdrawal cancels them");

for (const stage of ["idle", "integration", "pending"]) {
  const f = fixture(); const gate = deferred(), entered = deferred();
  try {
    if (stage === "idle") f.store.update("A", (r) => ({ ...r, integration: undefined, retry: undefined }));
    if (stage === "pending") f.queue();
    const read = f.board.getCard;
    f.board.getCard = async (id) => { entered.resolve(); await gate.promise; return read(id); };
    const tick = f.loop.tickNow();
    await entered.promise; await turn();
    assert.deepEqual(f.models, ["B"], "slow finalization fresh read must not block Ready admission");
    await tick;
    await f.loop.tickNow();
    assert.equal(f.reads.length, 0, "reconcile cannot duplicate the pending finalizer read");
    assert.equal(f.state.activity?.itemId, "A");
    let stopped = false;
    const stop = f.loop.stop().then(() => { stopped = true; });
    await turn(); assert.equal(stopped, false); assert.ok(ownerLockIsHeld(f.owner));
    gate.resolve(); await stop;
    assert.deepEqual(f.writes, [], "stop prevents late board writeback");
    assert.equal(f.state.activity, undefined);
  } finally { gate.resolve(); await f.loop.stop(); }
}
console.log("PASS: slow maintenance fresh read/pending writeback does not block Ready; stop drains it without late writes");

{
  const f = fixture(), order: string[] = [], unhandled: unknown[] = [];
  const rejection = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", rejection);
  try {
    f.cards.push({ ...f.card, itemId: "C", number: 3 });
    f.executor.finalizeClosed = (card) => { order.push(card.itemId); return Promise.reject(new Error("immediate failure")); };
    for (let i = 0; i < 4; i++) { await f.loop.tickNow(); await turn(); }
    assert.deepEqual(order, ["A", "C", "A", "C"], "one attempt per tick; failed first candidate cannot starve the next");
    assert.deepEqual(unhandled, []); assert.equal(f.state.activity, undefined);
    assert.match(f.state.lastBlocker!, /immediate failure/);
    f.deps.listCards = async () => { throw new Error("GitHub unavailable"); };
    const before = f.models.length;
    await assert.rejects(f.loop.tickNow(), /GitHub unavailable/);
    assert.equal(f.models.length, before, "global list failure cannot admit from cached cards");
  } finally { await f.loop.stop(); process.off("unhandledRejection", rejection); }
}
console.log("PASS: stable round-robin, immediate rejection handling and board-wide fail-closed admission");

{
  const f = fixture(), held = deferred(), entered = deferred();
  try {
    f.executor.finalizeClosed = async () => { entered.resolve(); await held.promise; return { status: "skipped", reason: "fixture" }; };
    await f.loop.start(); await entered.promise;
    // A human can reopen and a settlement can remove its record while the
    // finalizer Promise still owns its ticket. Neither grants concurrent work.
    f.card.closed = false; f.card.status = "Ready";
    await f.store.completeFinalization({} as any, "", async () => {});
    await f.loop.tickNow(); await f.loop.tickNow();
    assert.ok(!f.models.includes("A"));
    assert.equal(f.loop.isRunning(), true, "start returned without awaiting finalization");
  } finally { held.resolve(); await f.loop.stop(); }
}
console.log("PASS: tracked finalizer excludes same-ticket builder/reconcile through settlement; start stays nonblocking");

for (const capacity of [1, 2]) {
  const f = fixture(), held = deferred(), entered = deferred(), reviewHeld = deferred(), reviewing = deferred();
  f.cfg.max_workers = capacity;
  const c: Card = { ...f.card, itemId: "C", number: 3, title: "T003 review", status: "Review", closed: false };
  let reviewRecord: TicketExecutionRecord = { schemaVersion: 4, itemId: "C", issueNumber: 3, taskKey: "T003", taskBranch: "task/issue-3", baseBranch: "main", path: cwd, createdAt: 2 };
  const read = f.store.read.bind(f.store), update = f.store.update.bind(f.store);
  f.store.read = (id) => id === "C" ? structuredClone(reviewRecord) : read(id);
  f.store.update = (id, fn) => id === "C" ? reviewRecord = fn(structuredClone(reviewRecord)) : update(id, fn);
  f.cards.push(c);
  f.deps.boardOps = {
    refresh: async () => structuredClone(c), claim: async () => { c.assignees = ["bot"]; return true; },
    release: async () => { c.assignees = []; }, listComments: async () => [], comment: async () => "comment",
    setStatus: async (_c, status) => { c.status = status; },
  };
  f.deps.review = async () => { reviewing.resolve(); await reviewHeld.promise; return { verdict: "pass", summary: "ok", findings: [], taskSha: "b".repeat(40) }; };
  f.executor.activeCount = () => f.models.length; // Model-only budget, not maintenance.
  f.executor.finalizeClosed = async () => { entered.resolve(); await held.promise; return { status: "blocked", reason: "offline" }; };
  try {
    const tick = f.loop.tickNow(); await entered.promise; await reviewing.promise;
    assert.equal(f.state.foreground?.kind, "review");
    assert.equal(f.models.length, capacity - 1);
    assert.equal(f.state.activity?.kind, "finalization");
    reviewHeld.resolve(); await tick;
    assert.equal(c.status, "Done"); assert.equal(f.models.length, 1);
  } finally { held.resolve(); reviewHeld.resolve(); await f.loop.stop(); }
}
console.log("PASS: deferred maintenance admits Review and Ready within max_workers, with no maintenance slot charge");

{
  const f = fixture("Building"), held = deferred(), entered = deferred();
  f.card.closed = false; f.card.assignees = ["bot"];
  queueTicketWrite(f.store, f.record(), "build", { card: structuredClone(f.card), status: "Ready", reason: "model result", retry: true, comment: "build retry" });
  f.board.listComments = async () => { entered.resolve(); await held.promise; return []; };
  const tick = f.loop.tickNow();
  try {
    await entered.promise;
    const stop = f.loop.stop();
    held.resolve(); await tick; await stop;
    assert.deepEqual(f.writes, []); assert.equal(f.card.status, "Building");
    assert.ok(pendingTicketWrite(f.record()), "interrupted model writeback remains durable for the next owner");
  } finally { held.resolve(); await f.loop.stop(); }
}
console.log("PASS: stopping also vetoes pending model writeback after awaited I/O, preserving its durable settlement");

{
  const f = fixture(); let finalized = 0;
  f.card.assignees = ["bot"];
  f.store.update("A", (r) => ({ ...r, integration: undefined }));
  queueTicketWrite(f.store, f.record(), "build", { card: structuredClone(f.card), status: "Ready", reason: "conflict", retry: true, reopen: true });
  f.board.getCard = async (id) => { f.reads.push(id); throw new Error("offline read failure"); };
  f.executor.finalizeClosed = async () => { finalized++; return { status: "skipped", reason: "fixture" }; };
  try {
    for (let i = 0; i < 2; i++) { await f.loop.tickNow(); await turn(); }
    assert.deepEqual(f.reads, ["A", "A"]); assert.equal(finalized, 0);
    assert.ok(f.models.includes("B")); assert.deepEqual(f.writes, []);
  } finally { await f.loop.stop(); }
}
console.log("PASS: failed model reconciliation excludes that ticket from a second same-tick finalization attempt");
