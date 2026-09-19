// Real loop/executor/store/Git; all board/model I/O is offline and deterministic.
import assert from "node:assert/strict";
import { settledTicks } from "./async-loop-fixture.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths, type PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import { normalizeWaveResults, parseDecision } from "../src/dispatch.js";
import type { Card, IssueComment } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { parseReviewOutput, type ReviewInput, type CompletedReview } from "../src/review.js";
import { ManagedTicketExecutor, type TicketBoardAdapter, type TicketWorkflowManager } from "../src/ticket-executor.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";
import { MergeConflictError, TicketWorktrees } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(root, "repo"), origin = join(root, "origin.git");
mkdirSync(repo); git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline"); git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), ".pi/\n"); writeFileSync(join(repo, "work.txt"), "base\n");
git(repo, "add", "."); git(repo, "commit", "-m", "base"); git(repo, "init", "--bare", origin);
git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
const baseSha = git(repo, "rev-parse", "HEAD");
const decision = { question: "Which service is authorized?", context: "The paid provider is unspecified.", options: ["Use the existing free service", "Approve the paid service"], recommendation: "Use the free service until budget approval." };
let sequence = 0;
function fixture() {
  const number = ++sequence;
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = 1;

  cfg.safety.require_clean_worktree = cfg.context.enabled = cfg.telegram.enabled = false;
  const card: Card = { itemId: `RETRY_${number}`, number, contentType: "Issue", type: "Task", title: `T${number} task`, body: "Approved acceptance criteria", repoOwner: "owner", repoName: "repo", closed: false, status: cfg.columns.ready, assignees: [] };
  const store = new TicketWorktrees(repo), comments: IssueComment[] = [], events: string[] = [], notices: string[] = [];
  const runs: PersistedRunState[] = [];
  let starts = 0, reviews = 0, drains = 0, failAt = "", failOnce = true;
  const fail = (step: string) => { events.push(step); if (step === failAt && failOnce) { failOnce = false; throw new Error(`offline ${step} failure`); } };
  const board: TicketBoardAdapter = {
    getCard: async (id) => { fail("read"); return id === card.itemId ? structuredClone(card) : undefined; },
    claim: async () => { card.assignees = ["bot"]; return true; },
    setStatus: async (_id, status) => { fail("status"); card.status = status; },
    release: async () => { fail("release"); card.assignees = card.assignees.filter((a) => a !== "bot"); },
    reopen: async () => { fail("reopen"); card.closed = false; },
    listComments: async () => { fail("listComments"); return comments.filter((c) => c.author === "bot").map((c) => c.body); },
    decisionComments: async () => structuredClone(comments),
    comment: async (_card, body) => { fail("comment"); comments.push({ id: `C${comments.length}`, author: "bot", body, createdAt: new Date().toISOString() }); },
  };
  const manager: TicketWorkflowManager = {
    start(script, args) { starts++; const run: PersistedRunState = { runId: `retry-run-${number}-${starts}`, script, args, status: "running", workflowName: "retry", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), agents: [], logs: [], phases: [] }; runs.push(run); return run.runId; },
    list: () => runs,
    resume: async (id) => { const run = runs.find((r) => r.runId === id)!; run.status = "running"; return true; },
    stopAndWait: async () => { fail("drain"); drains++; },
    pauseAndWait: async () => {}, dispose() {},
  };
  const executor = new ManagedTicketExecutor({ cwd: repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", worktrees: store, board, callback: (s) => notices.push(s), createManager: () => manager });
  assert.equal("repairFor" in executor, false, "New path has no repair authority API");
  assert.equal("repairForReview" in executor, false, "New path has no test-history evidence API");
  let reviewImpl = async (_input: ReviewInput): Promise<CompletedReview> => ({ verdict: "pass", summary: "Looks good", findings: [], taskSha: baseSha });
  const loop = new BoardLoop({ cwd: repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: (s) => notices.push(s), meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, listCards: async () => [structuredClone(card)], boardOps: {
    claim: board.claim, refresh: () => board.getCard(card.itemId), release: board.release,
    listComments: async () => structuredClone(comments),
    comment: async (c, body) => { await board.comment(c, body); return "comment-id"; },
    setStatus: async (c, status) => board.setStatus(c.itemId, status),
  }, review: async (input) => { reviews++; return reviewImpl(input); } }, createLoopState(), executor, store);
  settledTicks(loop);
  const record = () => store.read(card.itemId)!;
  return { cfg, card, store, board, manager, events, comments, notices, runs, executor, loop, record,
    starts: () => starts, reviews: () => reviews, drains: () => drains,
    failAt: (step: string) => { failAt = step; failOnce = true; },
    review: (fn: typeof reviewImpl) => { reviewImpl = fn; },
    complete: (value: Record<string, unknown>) => { const run = runs.at(-1)!; run.status = "completed"; run.result = [{ taskKey: record().taskKey, itemId: card.itemId, ...value }]; },
  };
}

for (const field of ["question", "context", "options", "recommendation"]) {
  const malformed = { ...decision, [field]: field === "options" ? ["one"] : " " };
  assert.equal(parseDecision(malformed), undefined);
  assert.deepEqual(normalizeWaveResults([{ taskKey: "T1", itemId: "I", status: "needs_decision", ...malformed }]), []);
  assert.equal(parseReviewOutput({ verdict: "needs_decision", summary: "choice", findings: [], ...malformed }), null);
}
assert.ok(parseDecision(decision));
assert.ok(parseReviewOutput({ verdict: "needs_decision", summary: "choice", findings: [], ...decision }));
assert.equal(parseReviewOutput({ verdict: "pass", summary: "bad", findings: ["blocking"] }), null);
console.log("PASS: builder/reviewer decisions require complete nonblank question/context/options/recommendation");

for (const mode of ["failure", "malformed-decision", "tool-exception", "timeout"]) {
  const f = fixture();
  await f.loop.tickNow();
  assert.equal(f.starts(), 1); assert.equal(f.record().schemaVersion, 4); assert.equal(f.record().plan, undefined);
  const path = f.record().path;
  writeFileSync(join(path, "partial.txt"), "preserve useful work");
  if (mode === "tool-exception") { f.runs[0].status = "failed"; f.runs[0].error = "tool unavailable"; }
  else if (mode === "timeout") { f.runs[0].status = "completed"; f.runs[0].result = null; f.runs[0].agents = [{ status: "error", errorCode: "AGENT_TIMEOUT" }] as any; }
  else f.complete(mode === "failure" ? { status: "failure", error: "failed tests", humanAction: "obsolete field is NOT a decision" } : { status: "needs_decision", question: "missing rest" });
  await f.loop.tickNow();
  assert.equal(f.starts(), 1, "no same-tick retry"); assert.equal(f.card.status, f.cfg.columns.ready);
  assert.equal(f.record().retry?.stage, "build"); assert.equal(f.record().activeRunId, undefined);
  assert.equal(readFileSync(join(path, "partial.txt"), "utf8"), "preserve useful work");
  await f.loop.tickNow(); assert.equal(f.starts(), 2); assert.equal(f.record().path, path);
  assert.ok(f.runs[1].script.includes("MERGE_HEAD")); assert.ok(!f.runs[1].script.includes("testEvidence"));
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log(`PASS: ${mode} retries build on the original dirty branch, never Needs Human or same-tick relaunch`);
}

{
  const f = fixture(); await f.loop.tickNow(); f.complete({ status: "needs_decision", ...decision });
  await f.loop.tickNow(); assert.equal(f.card.status, f.cfg.columns.needs_human); assert.equal(f.executor.activeCount(), 0);
  f.comments.push({ id: "stranger", author: "stranger", authorAssociation: "NONE", body: "Use paid", createdAt: "now" });
  f.card.status = f.cfg.columns.ready; await f.loop.tickNow(); assert.equal(f.starts(), 1);
  f.card.status = f.cfg.columns.needs_human;
  f.comments.push({ id: "trusted", author: "maintainer", authorAssociation: "MEMBER", body: "Use free", createdAt: "now" });
  await f.loop.tickNow(); assert.equal(f.starts(), 1, "comment alone cannot resume");
  f.card.status = f.cfg.columns.ready; await f.loop.tickNow(); assert.equal(f.starts(), 2);
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log("PASS: Needs Human releases the slot; only manual Ready AND a trusted decision reply permit a new build");
}

for (const step of ["drain", "comment", "status", "release"]) {
  const f = fixture(); await f.loop.tickNow(); f.complete({ status: "failure", error: "failed tests" }); f.failAt(step);
  await f.loop.tickNow(); assert.ok(pendingTicketWrite(f.record())); assert.ok(f.record().activeRunId);
  assert.equal(f.starts(), 1); assert.equal(f.executor.activeCount(), 1, "unsettled terminal run conservatively occupies its slot");
  if (step === "drain") assert.equal(f.comments.length, 0, "drain before writeback/release");
  await f.loop.tickNow(); assert.equal(f.starts(), 1, "settlement tick never launches another builder");
  assert.equal(pendingTicketWrite(f.record()), undefined); assert.equal(f.record().activeRunId, undefined);
  assert.equal(f.comments.length, 1, "idempotent successful comment across status/release cuts");
  await f.loop.tickNow(); assert.equal(f.starts(), 2);
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log(`PASS: failed ${step} retains pending writeback and run identity until drain/release; no second run`);
}

for (const mode of ["infrastructure", "findings", "decision", "malformed", "pass-status", "findings-comment", "pass-release"]) {
  const f = fixture();
  const record = await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  f.card.status = f.cfg.columns.review;
  f.review(async (input) => {
    await input.onPinnedTaskSha?.(baseSha);
    if (mode === "infrastructure") throw new Error("model unavailable");
    if (mode === "malformed") return { verdict: "needs_decision", summary: "bad", findings: [], taskSha: baseSha };
    if (mode.startsWith("findings")) return { verdict: "fail", summary: "fix the endpoint", findings: ["handler: fails validation"], taskSha: baseSha };
    if (mode === "decision") return { verdict: "needs_decision", summary: "choice", findings: [], ...decision, taskSha: baseSha };
    return { verdict: "pass", summary: "good", findings: [], taskSha: baseSha };
  });
  if (mode === "pass-status") f.failAt("status");
  if (mode === "findings-comment") f.failAt("comment");
  if (mode === "pass-release") f.failAt("release");
  await f.loop.tickNow(); assert.equal(f.reviews(), 1); assert.equal(f.starts(), 0);
  if (["pass-status", "pass-release", "findings-comment"].includes(mode)) {
    assert.ok(pendingTicketWrite(f.record()));
    await f.loop.tickNow(); assert.equal(f.reviews(), 1, "retry only pending GitHub I/O"); assert.equal(f.starts(), 0);
  }
  if (mode === "infrastructure" || mode === "malformed") {
    assert.equal(f.record().retry?.stage, "review"); assert.equal(f.card.status, f.cfg.columns.ready);
    f.review(async (input) => { assert.equal(input.taskSha, baseSha, "retry exact original commit"); return { verdict: "pass", summary: "good", findings: [], taskSha: baseSha }; });
    await f.loop.tickNow(); assert.equal(f.reviews(), 2); assert.equal(f.starts(), 0);
    assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.card.closed, false);
  } else if (mode.startsWith("findings")) {
    assert.equal(f.record().retry?.stage, "build"); await f.loop.tickNow(); assert.equal(f.starts(), 1);
    assert.equal(f.record().path, record.path);
  } else if (mode === "decision") {
    assert.equal(f.card.status, f.cfg.columns.needs_human); await f.loop.tickNow(); assert.equal(f.reviews(), 1); assert.equal(f.starts(), 0);
  } else { assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.card.closed, false); }
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log(`PASS: review ${mode} uses the correct retry stage and durable I/O-only settlement; Done remains open`);
}

for (const step of ["comment", "reopen", "status", "release"]) {
  const f = fixture(); const record = await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  f.card.status = f.cfg.columns.done; f.card.closed = true;
  let integrations = 0;
  f.store.finalizeAccepted = async () => { integrations++; throw new MergeConflictError(baseSha, baseSha, "work.txt conflict"); };
  f.failAt(step); await f.loop.tickNow(); assert.ok(pendingTicketWrite(f.record())); assert.equal(integrations, 1);
  await f.loop.tickNow(); assert.equal(integrations, 1, "only settle I/O, not another merge"); assert.equal(f.starts(), 0);
  assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.record().retry?.stage, "build");
  await f.loop.tickNow(); assert.equal(f.starts(), 1); assert.equal(f.record().path, record.path);
  assert.ok(f.runs[0].script.includes(`merge base ${baseSha}`));
  assert.equal(existsSync(join(repo, ".pi", "board-agent", "repair")), false);
  f.complete({ status: "success", branch: record.taskBranch }); await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.review); await f.loop.tickNow(); assert.equal(f.card.status, f.cfg.columns.done);
  assert.equal(f.card.closed, false); assert.equal(integrations, 1, "review pass is NOT renewed manual approval");
  await f.loop.stop();
  console.log(`PASS: conflict ${step} cut resumes comment/reopen/Ready, then original builder/Review/Done and renewed manual close`);
}

{
  const f = fixture(); const record = await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  writeFileSync(join(record.path, "work.txt"), "task\n"); git(record.path, "add", "."); git(record.path, "commit", "-m", "task");
  writeFileSync(join(repo, "work.txt"), "base advanced\n"); git(repo, "add", "work.txt"); git(repo, "commit", "-m", "advance");
  const advanced = git(repo, "rev-parse", "HEAD"); git(repo, "push", "origin", "main");
  assert.throws(() => git(record.path, "merge", "--no-edit", advanced));
  const mergeHead = git(record.path, "rev-parse", "MERGE_HEAD"), diff = git(record.path, "diff");
  await f.loop.tickNow(); assert.equal(f.starts(), 1);
  assert.equal(git(record.path, "rev-parse", "MERGE_HEAD"), mergeHead); assert.equal(git(record.path, "diff"), diff);
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log("PASS: an interrupted MERGE_HEAD and unmerged index resume on the original branch without reset/stash/pull");
}

for (const stage of ["integrate", "cleanup"] as const) {
  const f = fixture(); await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  f.card.status = f.cfg.columns.ready; f.card.closed = true;
  f.store.update(f.card.itemId, (r) => ({ ...r, retry: { stage, reason: "offline prior Git failure" } }));
  let calls = 0;
  f.store.finalizeAccepted = async () => { calls++; throw new Error(`offline ${stage} failed`); };
  await f.loop.tickNow(); assert.equal(calls, 1); assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
  assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.record().retry?.stage, stage);
  await f.loop.stop();
  console.log(`PASS: closed Ready ${stage} retries finalization only and preserves closed approval (Git implementation remains T004)`);
}

{
  const f = fixture(); await f.loop.tickNow();
  const record = f.record();
  // MERGE_HEAD is a per-worktree pseudoref, not writable via update-ref on newer Git.
  writeFileSync(git(record.path, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${baseSha}\n`);
  assert.equal(git(record.path, "status", "--porcelain"), "");
  f.complete({ status: "success", branch: record.taskBranch });
  await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.ready);
  assert.match(f.record().retry!.reason, /MERGE_HEAD/);
  assert.equal(f.reviews(), 0);
  await f.loop.stop();
  console.log("PASS: clean porcelain with an unfinished MERGE_HEAD is a technical build failure, never Review success");
}

{
  const f = fixture();
  const record = await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  f.store.beginLaunch(f.card.itemId); f.card.status = f.cfg.columns.building; f.card.assignees = ["bot"];
  await f.loop.tickNow(); assert.equal(f.starts(), 0); assert.ok(f.record().launchingAt);
  const run: PersistedRunState = { runId: "late-original-run", workflowName: "original", script: "return 'original script';", args: { itemId: record.itemId, issueNumber: record.issueNumber, taskKey: record.taskKey, keep: "original argument" }, status: "paused", phases: [], agents: [], logs: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const dir = workflowProjectPaths(record.path).runsDir; mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(run)); f.runs.push(run);
  const oldLedger = join(repo, ".pi", "board-agent", "repair", "unrelated-old.json");
  mkdirSync(join(oldLedger, ".."), { recursive: true }); writeFileSync(oldLedger, "old ledger remains read-only");
  await f.loop.tickNow();
  assert.equal(f.record().activeRunId, run.runId); assert.equal(f.starts(), 0);
  assert.equal(run.script, "return 'original script';"); assert.equal((run.args as any).keep, "original argument");
  assert.equal(readFileSync(oldLedger, "utf8"), "old ledger remains read-only");
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log("PASS: v4 uncertain launch reobserves only a unique original persisted run, without reading old repair authority");
}

for (const field of ["itemId", "taskKey"]) {
  for (const status of ["success", "needs_decision"]) {
    const f = fixture(); await f.loop.tickNow();
    f.complete({ status, branch: f.record().taskBranch, ...decision, [field]: "WRONG_IDENTITY" });
    await f.loop.tickNow();
    assert.equal(f.card.status, f.cfg.columns.ready);
    assert.equal(f.record().retry?.stage, "build");
    assert.match(f.record().retry!.reason, /malformed/);
    assert.equal(f.reviews(), 0); assert.equal(f.starts(), 1);
    assert.ok(f.comments.every((c) => !c.body.includes(decision.question)));
    await f.loop.stop();
    console.log(`PASS: ${status} with mismatched ${field} is a technical failure, never another ticket's success/decision`);
  }
}

for (const pending of [false, true]) {
  for (const evidence of ["missing", "mismatched"]) {
    for (const withdrawal of ["manual", "missing", "retyped"]) {
      const f = fixture(); await f.loop.tickNow();
      if (pending) {
        f.complete({ status: "failure", error: "failed tests" }); f.failAt("drain");
        await f.loop.tickNow(); assert.ok(pendingTicketWrite(f.record()));
      }
      const record = f.record(), run = structuredClone(f.runs[0]);
      if (evidence === "missing") f.runs.length = 0;
      else f.runs[0].args = { ...(run.args as object), itemId: "WRONG_TICKET" };
      const getCard = f.board.getCard;
      let visible = withdrawal !== "missing";
      f.board.getCard = async (id) => visible ? getCard(id) : undefined;
      f.card.status = "Backlog";
      if (withdrawal === "retyped") f.card.type = "Story";
      const card = structuredClone(f.card), events = f.events.length;
      await f.loop.tickNow();
      assert.deepEqual(f.record(), record); assert.deepEqual(f.card, card);
      assert.equal(f.executor.activeCount(), 1); assert.equal(f.drains(), 0);
      assert.ok(f.events.slice(events).every((step) => step === "read"), "no release/status/comment before observed drain");
      visible = true; f.card.type = "Task"; f.card.status = f.cfg.columns.ready;
      await f.loop.tickNow();
      assert.deepEqual(f.record(), record); assert.equal(f.starts(), 1); assert.equal(f.drains(), 0);
      f.runs.splice(0, f.runs.length, run);
      // Ready matches the pending failure's intended status. Keep an explicit
      // human withdrawal at settlement to test cancellation, not successful I/O.
      if (pending) f.card.status = "Backlog";
      const manualStatus = f.card.status;
      for (const step of ["drain", "release"]) {
        f.failAt(step); await f.loop.tickNow();
        assert.deepEqual(f.record(), record, `failed ${step} retains the original association/writeback`);
        assert.equal(f.starts(), 1); assert.equal(f.card.status, manualStatus);
      }
      await f.loop.tickNow();
      assert.equal(f.record().activeRunId, undefined); assert.equal(f.record().retry, undefined);
      assert.equal(f.starts(), 1, "drain/release settlement cannot relaunch in the same tick");
      assert.equal(f.card.status, manualStatus); assert.equal(f.comments.length, 0); assert.equal(f.reviews(), 0);
      f.card.status = f.cfg.columns.ready; await f.loop.tickNow(); assert.equal(f.starts(), 2);
      await f.loop.stop(); f.store.clearExecution(f.card.itemId);
      console.log(`PASS: ${pending ? "pending writeback" : "active run"} ${evidence} during ${withdrawal} withdrawal retains identity/slot until observed drain and release`);
    }
  }
}

for (const evidence of ["unpersisted", "ambiguous", "corrupt"]) {
  const f = fixture();
  const record = await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  f.store.beginLaunch(f.card.itemId);
  f.card.status = f.cfg.columns.building; f.card.assignees = ["bot"]; f.card.type = "Story";
  const launching = f.record();
  const run: PersistedRunState = { runId: `withdrawn-${evidence}`, workflowName: "original", script: "return 'original';", args: { itemId: record.itemId, issueNumber: record.issueNumber, taskKey: record.taskKey }, status: "running", phases: [], agents: [], logs: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const dir = workflowProjectPaths(record.path).runsDir; mkdirSync(dir, { recursive: true });
  f.runs.push(run);
  if (evidence !== "unpersisted") writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(run));
  if (evidence === "ambiguous") {
    const extra = { ...run, runId: "ambiguous" }; f.runs.push(extra);
    writeFileSync(join(dir, "ambiguous.json"), JSON.stringify(extra));
  }
  if (evidence === "corrupt") writeFileSync(join(dir, "corrupt.json"), "{");
  for (const type of ["Story", "Task"]) {
    f.card.type = type; f.card.status = f.cfg.columns.ready;
    await f.loop.tickNow();
    assert.deepEqual(f.record(), launching); assert.equal(f.executor.activeCount(), 1);
    assert.equal(f.drains(), 0); assert.equal(f.starts(), 0);
  }
  // Resolve only the fixture's uncertain observation; production must retain it.
  f.card.type = "Story"; f.runs.splice(1);
  if (evidence !== "unpersisted") rmSync(join(dir, `${evidence}.json`));
  writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(run));
  f.failAt("drain"); await f.loop.tickNow();
  assert.equal(f.record().activeRunId, run.runId); assert.equal(f.executor.activeCount(), 1);
  await f.loop.tickNow();
  assert.equal(f.record().activeRunId, undefined); assert.equal(f.record().launchingAt, undefined);
  assert.equal(f.record().lastRunId, run.runId); assert.equal(f.drains(), 1); assert.equal(f.starts(), 0);
  assert.equal(f.card.type, "Story"); assert.equal(f.card.status, f.cfg.columns.ready);
  assert.ok(f.events.every((step) => ["read", "drain"].includes(step)), "retyped card receives no remote writes");
  f.card.type = "Task"; await f.loop.tickNow(); assert.equal(f.starts(), 1);
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log(`PASS: withdrawn ${evidence} launch retains its slot until unique persisted observation and successful original drain`);
}

for (const cut of ["manual-drain", "manual-release", "missing-drain", "pending-release"]) {
  const f = fixture(); await f.loop.tickNow();
  if (cut === "pending-release") {
    f.complete({ status: "failure", error: "failed tests" }); f.failAt("drain");
    await f.loop.tickNow(); assert.ok(pendingTicketWrite(f.record()));
  }
  const runId = f.record().activeRunId;
  f.card.status = "Backlog";
  if (cut === "missing-drain") f.card.type = "Story";
  const replace = async () => { await Promise.resolve(); f.store.setActiveRun(f.card.itemId, "replacement-run"); };
  if (cut.endsWith("release")) f.board.release = replace;
  else f.manager.stopAndWait = async (id) => { assert.equal(id, runId); await replace(); };
  await f.loop.tickNow();
  assert.equal(f.record().activeRunId, "replacement-run", "yielded withdrawal cannot clear a replacement association");
  assert.equal(f.executor.activeCount(), 1); assert.equal(f.starts(), 1);
  assert.equal(f.card.status, "Backlog"); assert.equal(f.comments.length, 0); assert.equal(f.reviews(), 0);
  await f.loop.stop(); f.store.clearExecution(f.card.itemId);
  console.log(`PASS: ${cut} withdrawal preserves an execution record replaced across its await`);
}

{
  const f = fixture(); await f.loop.tickNow();
  f.complete({ status: "success", branch: f.record().taskBranch, itemId: "WRONG_TICKET", taskKey: "WRONG_TASK" });
  await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.ready, "a mismatched builder result is malformed, not success for this ticket");
  assert.equal(f.record().retry?.stage, "build");
  assert.equal(f.reviews(), 0);
  await f.loop.stop();
  console.log("PASS: mismatched builder-result identity fails technically without being relabeled as success");
}

{
  const f = fixture();
  await f.store.ensure(buildTasksForWave(f.cfg, "", [f.card])[0]);
  f.store.beginLaunch(f.card.itemId);
  f.card.status = f.cfg.columns.building; f.card.assignees = ["bot"];
  f.card.type = "Story";
  await f.loop.tickNow();
  assert.ok(f.record().launchingAt !== undefined, "a withdrawn ticket does not prove an uncertain launch is drained");
  f.card.type = "Task"; f.card.status = f.cfg.columns.ready;
  await f.loop.tickNow();
  assert.equal(f.starts(), 0, "restoring Ready must not duplicate an unobserved original launch");
  await f.loop.stop();
  console.log("PASS: withdrawal retains an uncertain launch until its original execution can be observed and drained");
}
