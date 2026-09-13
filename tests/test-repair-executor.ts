// T14: public executor + installed durable WorkflowManager + real disposable Git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRunPersistence, compactAgentHistory, type WorkflowManagerOptions, type WorkflowRunOptions } from "@quintinshaw/pi-dynamic-workflows";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { repairReviewInput } from "../src/repair.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { runReview } from "../src/review.js";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { ManagedTicketExecutor, createWorkflowManagerAdapter, type TicketBoardAdapter, type TicketExecutorDeps } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let sequence = 0;
async function fixture() {
  const dir = join(root, `repair-${++sequence}`), repo = join(dir, "repo"), origin = join(dir, "origin.git");
  mkdirSync(repo, { recursive: true });
  git(dir, "init", "--bare", origin); git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Offline"); git(repo, "config", "user.email", "offline@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), ".pi/\n");
  writeFileSync(join(repo, "value.json"), '{"task":false,"base":false}\n');
  // The existing test requires BOTH branches' edits. It records the actual tested commit.
  writeFileSync(join(repo, "test.cjs"), `const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
assert.deepEqual(JSON.parse(fs.readFileSync('value.json')), { task: true, base: true });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.mkdirSync('.pi', { recursive: true }); fs.appendFileSync('.pi/tested', sha + '\\n');
console.log('PASS: both original task and base behavior at ' + sha);
`);
  git(repo, "add", "."); git(repo, "commit", "-m", "existing integration test");
  git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = 1; cfg.builder_retries = 0;
  cfg.context.enabled = cfg.review.enabled = cfg.refine.enabled = cfg.watchdog.enabled = cfg.telegram.enabled = cfg.safety.require_clean_worktree = false;
  const card: Card = { itemId: `REPAIR_${sequence}`, number: sequence, contentType: "Issue", type: "Task", title: "T014 preserve original work", body: "Original acceptance: retain task behavior and all prior edits.", plan: "demo", status: cfg.columns.ready, closed: false, assignees: [], repoOwner: "owner", repoName: "repo" };
  const task = buildTasksForWave(cfg, "demo", [card])[0];
  const store = new TicketWorktrees(repo), record = await store.ensure(task, "demo");
  writeFileSync(join(record.path, "value.json"), '{"task":true,"base":false}\n');
  writeFileSync(join(record.path, "task-only.txt"), "original task edit\n");
  git(record.path, "add", "."); git(record.path, "commit", "-m", "original issue implementation"); git(record.path, "push", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  writeFileSync(join(repo, "value.json"), '{"task":false,"base":true}\n');
  writeFileSync(join(repo, "base-only.txt"), "base edit\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base changed"); git(repo, "push", "origin", "main");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const repair = { requestKey: `repair-${sequence}`, baseSha, taskSha };
  const comments: string[] = [];
  const board: TicketBoardAdapter = {
    getCard: async () => structuredClone(card),
    claim: async () => { card.assignees = ["bot"]; return true; },
    release: async () => { card.assignees = []; },
    setStatus: async (_id, status) => { card.status = status; },
    listComments: async () => [...comments], comment: async (_card, body) => { comments.push(body); },
  };
  let calls = 0;
  type Builder = NonNullable<WorkflowRunOptions["agent"]>["run"];
  let builder: Builder = async () => ({ taskKey: task.taskKey, itemId: task.itemId, branch: task.taskBranch, status: "success" });
  const makeExecutor = (context?: TicketExecutorDeps["context"]) => new ManagedTicketExecutor({ cwd: repo, cfg, board, context, worktrees: new TicketWorktrees(repo), botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {},
    createManager: (cwd) => createWorkflowManagerAdapter({ cwd, defaultAgentRetries: 0, callback: () => {}, agent: { async run(prompt: string, options: Parameters<Builder>[1]) { calls++; return builder(prompt, options); } } as NonNullable<WorkflowManagerOptions["agent"]> }),
  });
  const executor = makeExecutor();
  return { repo, origin, cfg, card, task, store, record, repair, comments, board, executor, makeExecutor, setBuilder: (value: Builder) => { builder = value; }, calls: () => calls };
}

const f = await fixture();
try {
  const result = await f.executor.launch(f.card, "demo", undefined, undefined, { ...f.repair, taskSha: f.repair.baseSha });
  assert.equal(result.status, "needs-human", "repair must reject a different initial task SHA before invoking any model");
  assert.equal(f.calls(), 0);
  assert.equal(f.card.status, f.cfg.columns.needs_human);
  assert.equal(git(f.record.path, "rev-parse", "HEAD"), f.repair.taskSha);
  assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.repair.baseSha);
  console.log("PASS: bad initial repair task SHA fails closed before builder invocation");
} finally { await f.executor.shutdown(); }

async function settled(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const persistence = createRunPersistence(f.record.path);
  for (let i = 0; i < 300; i++) {
    const run = persistence.load(runId);
    if (run && ["completed", "failed", "aborted"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Builder did not settle (not a passing test)");
}
// Independent literal wrapper from the builder protocol, NOT the implementation helper.
function testCommand(sha: string, command = "node test.cjs") {
  return `set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1
head=$(git rev-parse HEAD)
status=$(git status --porcelain=v1 --untracked-files=all)
test "$head" = '${sha}'
test -z "$status"
printf '%s\\n' 'BOARD_AGENT_REPAIR_TEST_BEGIN ${sha}'
(
${command}
)
head=$(git rev-parse HEAD)
status=$(git status --porcelain=v1 --untracked-files=all)
test "$head" = '${sha}'
test -z "$status"
printf '%s\\n' 'BOARD_AGENT_REPAIR_TEST_PASS ${sha}'`;
}
async function testAtResult(f: Awaited<ReturnType<typeof fixture>>, options: Parameters<NonNullable<WorkflowRunOptions["agent"]>["run"]>[1], sha: string, command = "node test.cjs") {
  const wrapper = testCommand(sha, command);
  let content: unknown, isError = false;
  try { content = (await createBashTool(f.record.path).execute("repair-test", { command: wrapper }, options?.signal)).content; }
  catch (error) { isError = true; content = [{ type: "text", text: String(error) }]; }
  options?.onHistory?.(compactAgentHistory([
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: wrapper } }] },
    { role: "toolResult", toolName: "bash", isError, content },
  ]));
  return { resultSha: sha, command };
}
function integrate(f: Awaited<ReturnType<typeof fixture>>) {
  assert.throws(() => git(f.record.path, "merge", "--no-edit", f.repair.baseSha), /Command failed/);
  assert.match(git(f.record.path, "ls-files", "--unmerged"), /value.json/, "real index conflict");
  writeFileSync(join(f.record.path, "value.json"), '{"task":true,"base":true}\n');
  git(f.record.path, "add", "value.json"); git(f.record.path, "commit", "-m", "fix: integrate both branch behaviors");
  return git(f.record.path, "rev-parse", "HEAD");
}
{
  const f = await fixture();
  f.setBuilder(async () => {
    integrate(f); git(f.record.path, "push", "origin", f.task.taskBranch);
    return { taskKey: f.task.taskKey, itemId: f.task.itemId, branch: f.task.taskBranch, status: "success" };
  });
  try {
    const launched = await f.executor.launch(f.card, "demo", undefined, undefined, f.repair);
    assert.equal(launched.status, "launched");
    if (launched.status !== "launched") throw new Error("not launched");
    const run = await settled(f, launched.runId);
    assert.equal(run.status, "completed");
    await f.executor.reconcile([f.card]);
    assert.equal(f.card.status, f.cfg.columns.needs_human, "success is not passing integrated test evidence");
    console.log("PASS: a pushed clean integration without test evidence goes to Needs Human despite builder success");
  } finally { await f.executor.shutdown(); }
}

{
  const f = await fixture();
  let resultSha = "";
  f.setBuilder(async (prompt, options) => {
    assert.ok(prompt.includes(f.card.body), "repair never replaces original requirements");
    for (const text of [f.repair.requestKey, f.repair.taskSha, f.repair.baseSha, "blanket ours/theirs", "EXISTING", "Never force-push", "do NOT close"]) assert.ok(prompt.includes(text), text);
    assert.ok(prompt.includes(testCommand("<RESULT_SHA>", "<EXISTING_TEST_COMMAND>")), "mission supplies the executable evidence protocol");
    resultSha = integrate(f);
    const testEvidence = await testAtResult(f, options, resultSha);
    git(f.record.path, "push", "origin", f.task.taskBranch);
    return { taskKey: f.task.taskKey, itemId: f.task.itemId, branch: f.task.taskBranch, status: "success", testEvidence };
  });
  try {
    const launched = await f.executor.launch(f.card, "demo", undefined, undefined, f.repair);
    assert.equal(launched.status, "launched");
    if (launched.status !== "launched") throw new Error("not launched");
    const run = await settled(f, launched.runId);
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.deepEqual((run.args as any).repair, f.repair, "repair is in durable args, not the v3 record");
    assert.equal(run.maxAgents, 1); assert.equal(run.concurrency, 1);
    assert.equal(f.store.read(f.card.itemId)?.schemaVersion, 3);
    assert.equal(Object.hasOwn(f.store.read(f.card.itemId)!, "repair"), false);
    assert.equal(readFileSync(join(f.record.path, ".pi/tested"), "utf8"), resultSha + "\n", "existing tests actually executed at integrated commit");
    assert.equal(readFileSync(join(f.record.path, "task-only.txt"), "utf8"), "original task edit\n");
    assert.equal(readFileSync(join(f.record.path, "base-only.txt"), "utf8"), "base edit\n");
    git(f.repo, "merge-base", "--is-ancestor", f.repair.taskSha, resultSha);
    git(f.repo, "merge-base", "--is-ancestor", f.repair.baseSha, resultSha);
    assert.ok(repairReviewInput(run)?.testEvidence.output.includes("PASS: both original task"));
    await f.executor.reconcile([f.card]);
    assert.equal(f.card.status, f.cfg.columns.review, f.comments.join("\n"));
    assert.equal(f.card.closed, false, "manual validation/close is still required with review disabled");
    assert.equal(f.cfg.review.enabled, false);
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.repair.baseSha);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.repair.baseSha);
    assert.equal(git(f.record.path, "status", "--porcelain"), "");
    assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), resultSha);
    let reviews = 0;
    const notices: string[] = [];
    const loop = new BoardLoop({ cwd: f.repo, cfg: f.cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      callback: (message) => notices.push(message), listCards: async () => [structuredClone(f.card)],
      boardOps: { claim: f.board.claim, refresh: async () => f.board.getCard(f.card.itemId), release: f.board.release, listComments: async () => [], comment: async (_card, body) => { f.comments.push(body); return "comment-id"; }, setStatus: async (_card, status) => { f.card.status = status; } },
      review: async (input) => {
        reviews++;
        assert.deepEqual(input.repair, repairReviewInput(run), "existing Review receives durable repair/test context");
        return runReview(input, async (source, options) => {
          assert.ok(source.includes("REPAIR TEST EVIDENCE"));
          assert.ok(source.includes("node test.cjs"));
          assert.ok(source.includes(f.card.body));
          assert.equal(git(options.cwd, "rev-parse", "HEAD"), resultSha);
          return { result: { verdict: "pass", summary: "Both branches and integrated test evidence reviewed", findings: [] } };
        });
      },
    }, createLoopState(), f.executor, f.store);
    try {
      await loop.tickNow(); assert.equal(reviews, 0, "review.enabled stays authoritative");
      f.cfg.review.enabled = true;
      await loop.tickNow();
      assert.equal(reviews, 1, notices.join("\n"));
      assert.equal(f.card.status, f.cfg.columns.done, notices.join("\n"));
      assert.equal(f.card.closed, false, "AI Review cannot self-close repair");
      assert.equal(f.store.read(f.card.itemId)?.reviewedTaskSha, resultSha);
    } finally { await loop.stop(); }
    await f.executor.shutdown();
    const restarted = f.makeExecutor();
    try { await restarted.reconcile([f.card]); assert.equal(f.calls(), 1); }
    finally { await restarted.shutdown(); }
    console.log("PASS: real conflicting branches preserve both edits, execute existing tests at the pushed integrated SHA, and await Review/manual close without relaunch");
  } finally { await f.executor.shutdown(); }
}

for (const mode of ["missing-base", "invalid-request", "initial-dirty", "last-await-sha"] as const) {
  const f = await fixture();
  try {
    const repair = mode === "missing-base" ? { ...f.repair, baseSha: "0".repeat(40) }
      : mode === "invalid-request" ? { ...f.repair, requestKey: "bad\nrequest" } : f.repair;
    if (mode === "initial-dirty") writeFileSync(join(f.record.path, "task-only.txt"), "keep dirty edit\n");
    const originalGet = f.board.getCard;
    let reads = 0;
    f.board.getCard = async (id) => {
      const card = await originalGet(id);
      if (mode === "last-await-sha" && card?.status === f.cfg.columns.building && ++reads === 2)
        git(f.record.path, "commit", "--allow-empty", "-m", "human moved task at actual-start await");
      return card;
    };
    const result = await f.executor.launch(f.card, "demo", undefined, undefined, repair);
    assert.equal(result.status, "needs-human", mode);
    assert.equal(f.calls(), 0, "no builder invocation");
    assert.equal(f.card.status, f.cfg.columns.needs_human);
    if (mode === "initial-dirty") assert.equal(readFileSync(join(f.record.path, "task-only.txt"), "utf8"), "keep dirty edit\n");
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.repair.baseSha);
    console.log(`PASS: repair admission ${mode} preserves work and blocks invocation`);
  } finally { await f.executor.shutdown(); }
}

for (const mode of ["no-push", "unmerged", "dirty", "failed-test", "failed-pipeline", "missing-history", "unfinished-history", "stale-test-sha", "truncated-history", "forged-summary", "missing-base-ancestry", "missing-task-ancestry", "malformed-persisted-repair", "completion-read-dirty"] as const) {
  const f = await fixture();
  let sha = "";
  f.setBuilder(async (_prompt, options) => {
    if (mode === "unmerged") {
      assert.throws(() => git(f.record.path, "merge", "--no-edit", f.repair.baseSha));
      return { taskKey: f.task.taskKey, itemId: f.task.itemId, branch: f.task.taskBranch, status: "success" };
    }
    if (mode === "missing-base-ancestry") {
      writeFileSync(join(f.record.path, "value.json"), '{"task":true,"base":true}\n');
      git(f.record.path, "add", "value.json"); git(f.record.path, "commit", "-m", "copied behavior without merging designated base");
      sha = git(f.record.path, "rev-parse", "HEAD");
    } else sha = integrate(f);
    if (mode === "missing-task-ancestry") {
      // Disposable corruption fixture: equivalent tree but original work's history is lost.
      sha = git(f.repo, "commit-tree", `${sha}^{tree}`, "-p", f.repair.baseSha, "-m", "lost task ancestry");
      git(f.record.path, "reset", "--hard", sha);
      git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, sha);
    }
    const testEvidence = await testAtResult(f, options, sha, mode === "failed-test" ? "node test.cjs && exit 7" : mode === "failed-pipeline" ? "node test.cjs && (exit 7) | cat" : "node test.cjs");
    if (mode === "dirty") writeFileSync(join(f.record.path, "task-only.txt"), "keep post-test dirty edit\n");
    if (mode === "stale-test-sha") git(f.record.path, "commit", "--allow-empty", "-m", "result changed after tests");
    if (mode !== "no-push") git(f.record.path, "push", "origin", f.task.taskBranch);
    return { taskKey: f.task.taskKey, itemId: f.task.itemId, branch: f.task.taskBranch, status: "success", testEvidence };
  });
  try {
    const launched = await f.executor.launch(f.card, "demo", undefined, undefined, f.repair);
    assert.equal(launched.status, "launched");
    if (launched.status !== "launched") throw new Error("not launched");
    const run = await settled(f, launched.runId);
    assert.equal(run.status, "completed", mode);
    // Restart through the durable public persistence seam, not manager internals.
    await f.executor.shutdown();
    if (mode === "missing-history") run.agents[0].history = [];
    if (mode === "unfinished-history") run.agents[0].history!.push({ role: "assistant", kind: "toolCall", toolName: "bash", text: JSON.stringify({ command: testCommand(sha) }) });
    if (mode === "forged-summary") run.agents[0].history = [{ role: "assistant", kind: "text", text: "PASS: tests run; exitCode=0" }];
    if (mode === "truncated-history") run.agents[0].history!.at(-1)!.text += "... [truncated]";
    if (mode === "malformed-persisted-repair") (run.args as any).repair = { requestKey: f.repair.requestKey, taskSha: f.repair.taskSha };
    createRunPersistence(f.record.path).save(run);
    if (mode === "completion-read-dirty") {
      const originalGet = f.board.getCard;
      let reads = 0;
      f.board.getCard = async (id) => {
        const card = await originalGet(id);
        if (++reads === 2) writeFileSync(join(f.record.path, "task-only.txt"), "changed during completion read\n");
        return card;
      };
    }
    const restarted = f.makeExecutor();
    try {
      const result = await restarted.reconcile([f.card]);
      assert.equal(result.needsHuman, 1, `${mode}: ${f.comments.join("\n")}`);
      assert.equal(f.card.status, f.cfg.columns.needs_human, mode);
      assert.equal(f.card.closed, false);
      assert.equal(f.store.read(f.card.itemId)?.activeRunId, undefined);
      assert.equal(f.calls(), 1, "reconciliation never replaces the durable run");
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.repair.baseSha);
      if (mode === "unmerged") assert.match(git(f.record.path, "ls-files", "--unmerged"), /value.json/);
      if (mode === "dirty") assert.equal(readFileSync(join(f.record.path, "task-only.txt"), "utf8"), "keep post-test dirty edit\n");
      console.log(`PASS: repair success with ${mode} is Needs Human, not Review; original worktree retained`);
    } finally { await restarted.shutdown(); }
  } finally { await f.executor.shutdown(); }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
for (const association of ["active", "launch-window"] as const) {
  const f = await fixture();
  const entered = deferred(), cleaning = deferred(), drained = deferred();
  let calls = 0;
  f.setBuilder(async (_prompt, options) => {
    if (++calls === 1) {
      // HEAD is no longer the admitted original SHA, and both index/worktree are dirty.
      git(f.record.path, "commit", "--allow-empty", "-m", "partial repair before interruption");
      assert.throws(() => git(f.record.path, "merge", "--no-edit", f.repair.baseSha));
      writeFileSync(join(f.record.path, "task-only.txt"), "preserve interrupted edit\n");
      entered.resolve();
      try { await new Promise<never>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")), { once: true })); }
      finally { cleaning.resolve(); await drained.promise; }
    }
    assert.equal(git(f.record.path, "rev-parse", "MERGE_HEAD"), f.repair.baseSha, "resume the existing dirty merge, no replacement worktree");
    assert.notEqual(git(f.record.path, "rev-parse", "HEAD"), f.repair.taskSha, "initial SHA gate is not rerun on recovery");
    assert.equal(readFileSync(join(f.record.path, "task-only.txt"), "utf8"), "preserve interrupted edit\n");
    writeFileSync(join(f.record.path, "value.json"), '{"task":true,"base":true}\n');
    git(f.record.path, "add", "value.json", "task-only.txt"); git(f.record.path, "commit", "-m", "fix: complete interrupted merge");
    const testEvidence = await testAtResult(f, options, git(f.record.path, "rev-parse", "HEAD"));
    git(f.record.path, "push", "origin", f.task.taskBranch);
    return { taskKey: f.task.taskKey, itemId: f.task.itemId, branch: f.task.taskBranch, status: "success", testEvidence };
  });
  try {
    const launched = await f.executor.launch(f.card, "demo", undefined, undefined, f.repair);
    if (launched.status !== "launched") throw new Error(JSON.stringify(launched));
    await entered.promise;
    assert.equal(f.executor.activeCount(), 1);
    const original = createRunPersistence(f.record.path).load(launched.runId)!;
    let stopped = false;
    const stopping = f.executor.shutdown().then(() => { stopped = true; });
    await cleaning.promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(stopped, false, "shutdown retains ownership until cooperative cleanup drains");
    assert.equal(f.executor.activeCount(), 1);
    drained.resolve(); await stopping;
    const paused = createRunPersistence(f.record.path).load(launched.runId)!;
    assert.equal(paused.status, "paused");
    assert.deepEqual(paused.args, original.args); assert.equal(paused.script, original.script);
    if (association === "launch-window") {
      f.store.clearExecution(f.card.itemId);
      f.store.beginLaunch(f.card.itemId, Date.parse(paused.startedAt));
    }
    const restarted = f.makeExecutor();
    try {
      const result = await restarted.reconcile([f.card]);
      assert.equal(result.resumed, 1, JSON.stringify(result));
      assert.equal(result.adopted, association === "launch-window" ? 1 : 0);
      assert.equal(f.store.read(f.card.itemId)?.activeRunId, launched.runId);
      const completed = await settled(f, launched.runId);
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.args, original.args); assert.equal(completed.script, original.script);
      assert.equal(createRunPersistence(f.record.path).list().length, 1, "one durable run across restart/adoption");
      await restarted.reconcile([f.card]);
      assert.equal(f.card.status, f.cfg.columns.review, f.comments.join("\n"));
      assert.equal(calls, 2, "one interrupted invocation and one resume, never a new run");
      assert.equal(readFileSync(join(f.record.path, "task-only.txt"), "utf8"), "preserve interrupted edit\n");
      console.log(`PASS: ${association} pause/drain/restart resumes the same args/script/run/worktree with dirty merge and advanced HEAD`);
    } finally { await restarted.shutdown(); }
  } finally { drained.resolve(); await f.executor.shutdown(); }
}

for (const mode of ["card-during-revision", "stop-during-final-read", "revision-during-final-read", "one-reserved-slot"] as const) {
  const f = await fixture(), entered = deferred(), finish = deferred();
  let revision = true, reads = 0;
  const executor = f.makeExecutor(mode === "one-reserved-slot" ? async () => { entered.resolve(); await finish.promise; return "context"; } : undefined);
  const getCard = f.board.getCard;
  f.board.getCard = async (id) => {
    if (f.card.status === f.cfg.columns.building && ++reads === 2 && mode.endsWith("final-read")) { entered.resolve(); await finish.promise; }
    return getCard(id);
  };
  const launching = executor.launch(f.card, "demo", async () => {
    if (mode === "card-during-revision") { entered.resolve(); await finish.promise; }
    return true;
  }, () => revision && executor.activeCount() === 1, f.repair);
  try {
    await entered.promise;
    assert.equal(f.calls(), 0); assert.equal(executor.activeCount(), 1, "preparation owns max_workers=1 slot");
    if (mode === "card-during-revision") { f.card.status = f.cfg.columns.backlog; f.card.body = "Human withdrew contract"; }
    if (mode === "stop-during-final-read") executor.stopScheduling();
    if (mode === "revision-during-final-read") revision = false;
    finish.resolve();
    const result = await launching;
    if (mode === "one-reserved-slot") assert.equal(result.status, "launched", "actual start must not reserve a second slot");
    else {
      assert.notEqual(result.status, "launched"); assert.equal(f.calls(), 0);
      if (mode === "card-during-revision") { assert.equal(f.card.status, f.cfg.columns.backlog); assert.equal(f.comments.length, 0); }
    }
    assert.equal(git(f.record.path, "rev-parse", "HEAD"), f.repair.taskSha);
    console.log(`PASS: repair actual-start ${mode} preserves the two await orders, stop/revision latch and max_workers=1`);
  } finally { finish.resolve(); await launching; await executor.shutdown(); await f.executor.shutdown(); }
}
