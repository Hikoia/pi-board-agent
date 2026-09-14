import {
  WorkflowErrorCode,
  type PersistedRunState,
} from "@quintinshaw/pi-dynamic-workflows";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import {
  ManagedTicketExecutor,
  type ReconcileSummary,
  type TicketBoardAdapter,
  type TicketExecutor,
  type TicketWorkflowManager,
} from "../src/ticket-executor.js";
import {
  TicketWorktrees,
  type TicketExecutionRecord,
} from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const fail = (message: string) => {
  process.exitCode = 1;
  console.log(message);
};
const root = process.env.TMP_DIR!;
const origin = join(root, "origin.git");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.email", "test@example.com");
git(repo, "config", "user.name", "Test");
writeFileSync(join(repo, "README.md"), "base\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "init");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-u", "origin", "main");

const cfg: Config = {
  ..._DEFAULTS,
  project: { owner: "test", number: 1 },
  max_workers: 2,
  builder_timeout_ms: 21600000,
  builder_retries: 1,
  context: { ..._DEFAULTS.context, enabled: false },
  refine: { ..._DEFAULTS.refine, enabled: false },
  review: { ..._DEFAULTS.review, enabled: false },
  watchdog: { ..._DEFAULTS.watchdog, enabled: false },
  telegram: { ..._DEFAULTS.telegram, enabled: false },
  safety: { ..._DEFAULTS.safety, require_clean_worktree: false },
};

class FakeBoard implements TicketBoardAdapter {
  readonly cards = new Map<string, Card>();
  readonly comments = new Map<string, string[]>();
  readonly claimRaces = new Set<string>();
  readonly failStatusOnce = new Set<string>();
  readonly failReleaseOnce = new Set<string>();
  claims = 0;
  releases = 0;

  add(
    itemId: string,
    number: number,
    status = cfg.columns.ready,
    plan = "demo",
  ): Card {
    const card: Card = {
      itemId,
      contentType: "Issue",
      number,
      title: `T${String(number).padStart(3, "0")} ticket`,
      body: "Acceptance criteria",
      status,
      plan,
      type: "Task",
      assignees: [],
      closed: false,
      repoOwner: "test",
      repoName: "repo",
    };
    this.cards.set(itemId, card);
    return structuredClone(card);
  }

  all(): Card[] {
    return [...this.cards.values()].map((card) => structuredClone(card));
  }
  async getCard(itemId: string): Promise<Card | undefined> {
    const card = this.cards.get(itemId);
    return card ? structuredClone(card) : undefined;
  }
  async setStatus(itemId: string, status: string): Promise<void> {
    if (this.failStatusOnce.delete(itemId))
      throw new Error("simulated GitHub status failure");
    this.cards.get(itemId)!.status = status;
  }
  async claim(card: Card): Promise<boolean> {
    this.claims++;
    const current = this.cards.get(card.itemId)!;
    current.assignees = this.claimRaces.has(card.itemId)
      ? ["bot", "rival"]
      : ["bot"];
    return true;
  }
  async release(card: Card): Promise<void> {
    this.releases++;
    if (this.failReleaseOnce.delete(card.itemId))
      throw new Error("simulated GitHub release failure");
    const current = this.cards.get(card.itemId);
    if (current)
      current.assignees = current.assignees.filter((login) => login !== "bot");
  }
  async listComments(card: Card): Promise<string[]> {
    return [...(this.comments.get(card.itemId) ?? [])];
  }
  async comment(card: Card, body: string): Promise<void> {
    this.comments.set(card.itemId, [
      ...(this.comments.get(card.itemId) ?? []),
      body,
    ]);
  }
}

interface ManagerState {
  runs: Map<string, PersistedRunState>;
  starts: number;
  resumes: number;
  pauses: number;
  stops: number;
  lastStartOptions?: {
    maxAgents: number;
    concurrency: number;
    agentRetries: number;
    agentTimeoutMs?: number;
  };
}

const managerStates = new Map<string, ManagerState>();
let runSequence = 0;
const stateFor = (path: string): ManagerState => {
  let state = managerStates.get(path);
  if (!state) {
    state = { runs: new Map(), starts: 0, resumes: 0, pauses: 0, stops: 0 };
    managerStates.set(path, state);
  }
  return state;
};
const makeRun = (
  runId: string,
  args: unknown,
  status: PersistedRunState["status"] = "running",
): PersistedRunState => ({
  runId,
  workflowName: "ticket",
  script: "export const meta={name:'ticket',description:'ticket'}; return [];",
  args,
  status,
  phases: ["Build"],
  agents: [],
  logs: [],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

class FakeManager implements TicketWorkflowManager {
  constructor(
    readonly state: ManagerState,
    recover: boolean,
  ) {
    if (recover)
      for (const run of state.runs.values())
        if (run.status === "running") run.status = "paused";
  }
  start(
    script: string,
    args: { itemId: string; issueNumber: number; taskKey: string },
    options: {
      maxAgents: number;
      concurrency: number;
      agentRetries: number;
      agentTimeoutMs?: number;
    },
  ): string {
    const runId = `run-${++runSequence}`;
    const run = makeRun(runId, args);
    run.script = script;
    this.state.runs.set(runId, run);
    this.state.starts++;
    this.state.lastStartOptions = options;
    return runId;
  }
  list(): PersistedRunState[] {
    return [...this.state.runs.values()];
  }
  async resume(runId: string): Promise<boolean> {
    const run = this.state.runs.get(runId);
    if (!run || run.status !== "paused") return false;
    run.status = "running";
    this.state.resumes++;
    return true;
  }
  async pauseAndWait(runId: string): Promise<void> {
    const run = this.state.runs.get(runId);
    if (run?.status === "running") run.status = "paused";
    this.state.pauses++;
  }
  async stopAndWait(runId: string): Promise<void> {
    const run = this.state.runs.get(runId);
    if (run && (run.status === "running" || run.status === "paused"))
      run.status = "aborted";
    this.state.stops++;
  }
  dispose(): void {}
}

const board = new FakeBoard();
const worktrees = new TicketWorktrees(repo);
const notices: string[] = [];
const makeExecutor = (recover = false) =>
  new ManagedTicketExecutor({
    cwd: repo,
    cfg,
    botLogin: "bot",
    repoOwner: "test",
    repoName: "repo",
    board,
    callback: (message) => notices.push(message),
    worktrees: new TicketWorktrees(repo),
    createManager: (path) => new FakeManager(stateFor(path), recover),
  });
const recordFor = (itemId: string) =>
  worktrees.read(itemId) as TicketExecutionRecord;
const runFor = (itemId: string) => {
  const record = recordFor(itemId);
  return stateFor(record.path).runs.get(record.activeRunId!)!;
};
const complete = (itemId: string, result: unknown) => {
  const run = runFor(itemId);
  run.status = "completed";
  run.result = result;
};

// Ordinary build/review retries replace the retired conflict protocol. The
// separate lifecycle/yield/identity suites retain their race and drain checks.
{
  const executor = makeExecutor();
  const card = board.add("RETRY", 40);
  const launch = () => executor.launch(structuredClone(board.cards.get(card.itemId)!), "demo");
  assert.equal((await launch()).status, "launched");
  const record = recordFor(card.itemId);
  assert.equal(stateFor(record.path).lastStartOptions?.agentTimeoutMs, cfg.builder_timeout_ms);
  assert.equal(stateFor(record.path).lastStartOptions?.agentRetries, cfg.builder_retries);
  assert.equal((await launch()).status, "skipped");
  assert.ok(runFor(card.itemId).script.includes("MERGE_HEAD"));
  assert.ok(runFor(card.itemId).script.includes("needs_decision"));
  assert.ok(!runFor(card.itemId).script.includes("BOARD_AGENT_REPAIR_TEST"));
  console.log("PASS: existing WorkflowManager bounds, duplicate-run gate and ordinary partial/conflict mission are retained");

  writeFileSync(join(record.path, "partial.txt"), "useful interrupted work\n");
  const outcomes = [
    { status: "failure", error: "tests failed", attempted: "node regression.cjs", limitations: "assertion fails", workaround: "continue partial work" },
    { status: "needs_decision", question: "incomplete payload" },
    null,
  ];
  for (const value of outcomes) {
    const run = runFor(card.itemId), id = run.runId;
    complete(card.itemId, [value && { taskKey: record.taskKey, itemId: record.itemId, ...value }]);
    if (!value) (run as any).agents = [{ status: "error", errorCode: "AGENT_TIMEOUT" }];
    await executor.reconcile(board.all());
    assert.equal(board.cards.get(card.itemId)!.status, cfg.columns.ready);
    assert.deepEqual(board.cards.get(card.itemId)!.assignees, []);
    assert.equal(recordFor(card.itemId).retry?.stage, "build");
    assert.equal(recordFor(card.itemId).lastRunId, id);
    assert.equal(recordFor(card.itemId).activeRunId, undefined);
    assert.equal(readFileSync(join(record.path, "partial.txt"), "utf8"), "useful interrupted work\n");
    assert.equal((await launch()).status, "launched");
  }
  const run = runFor(card.itemId);
  run.status = "failed"; run.error = "tool exception after retries";
  await executor.reconcile(board.all());
  assert.ok(recordFor(card.itemId).retry?.reason.includes("tool exception after retries"));
  assert.ok(board.comments.get(card.itemId)!.some((c) => c.includes("node regression.cjs")));
  console.log("PASS: test/tool/timeout/null/incomplete-decision failures persist build retry + diagnostics, release to Ready and preserve dirty work");

  assert.equal((await launch()).status, "launched");
  complete(card.itemId, [{ taskKey: record.taskKey, itemId: record.itemId, status: "needs_decision",
    question: "Which environment is authorized?", context: "Deployment has cost and access implications.",
    options: ["Staging", "Production with approval"], recommendation: "Staging first." }]);
  await executor.reconcile(board.all());
  assert.equal(board.cards.get(card.itemId)!.status, cfg.columns.needs_human);
  const starts = stateFor(record.path).starts;
  await executor.reconcile(board.all());
  assert.equal((await launch()).status, "skipped");
  assert.equal(stateFor(record.path).starts, starts);
  board.cards.get(card.itemId)!.status = cfg.columns.ready;
  assert.equal((await launch()).status, "launched");
  console.log("PASS: only complete decisions enter Needs Human; no comment listener or automatic resume, manual Ready resumes original work");

  // Both before-write and lost-response cuts are re-observed, not new models.
  complete(card.itemId, [{ taskKey: record.taskKey, itemId: record.itemId, status: "failure", error: "retry this exact failure" }]);
  board.failStatusOnce.add(card.itemId);
  await executor.reconcile(board.all());
  const pending = recordFor(card.itemId);
  assert.ok(pending.activeRunId && pending.retry);
  assert.equal((await launch()).status, "skipped");
  board.failReleaseOnce.add(card.itemId);
  await executor.reconcile(board.all());
  assert.equal(board.cards.get(card.itemId)!.status, cfg.columns.ready);
  assert.ok(recordFor(card.itemId).activeRunId);
  assert.equal(executor.activeCount(), 1, "terminal status does not free an unsettled slot");
  const comments = board.comments.get(card.itemId)!.length;
  await makeExecutor().reconcile(board.all());
  assert.equal(board.comments.get(card.itemId)!.length, comments);
  assert.equal(recordFor(card.itemId).activeRunId, undefined);
  console.log("PASS: failed status/release retain run + retry; restart observes partial settlement before a second builder and does not duplicate comments");

  // Missing journals are not success and never new builder authority.
  assert.equal((await launch()).status, "launched");
  const missing = recordFor(card.itemId), savedRun = runFor(card.itemId);
  stateFor(record.path).runs.delete(missing.activeRunId!);
  await executor.reconcile(board.all());
  assert.equal(recordFor(card.itemId).activeRunId, missing.activeRunId);
  assert.equal(recordFor(card.itemId).retry?.stage, "build");
  assert.notEqual(board.cards.get(card.itemId)!.status, cfg.columns.needs_human);
  assert.equal((await launch()).status, "skipped");
  stateFor(record.path).runs.set(savedRun.runId, savedRun);
  savedRun.status = "paused";
  const originalScript = savedRun.script, originalArgs = JSON.stringify(savedRun.args);
  await executor.reconcile(board.all());
  assert.equal(savedRun.status, "running");
  assert.equal(savedRun.script, originalScript); assert.equal(JSON.stringify(savedRun.args), originalArgs);
  console.log("PASS: missing journal retains binding/slot for observation; recovered paused run keeps exact script/args and partial work");

  // Withdrawal wins over terminal success. No clean/reset requirement on retry.
  board.cards.get(card.itemId)!.status = "Backlog";
  await executor.reconcile(board.all());
  assert.equal(board.cards.get(card.itemId)!.status, "Backlog");
  assert.equal(recordFor(card.itemId).activeRunId, undefined);
  assert.equal(savedRun.status, "aborted");
  board.cards.get(card.itemId)!.status = cfg.columns.ready;
  assert.equal((await launch()).status, "launched");
  git(record.path, "add", "."); git(record.path, "commit", "-m", "finish partial work");
  git(record.path, "push", "origin", record.taskBranch);
  complete(card.itemId, [{ taskKey: record.taskKey, itemId: record.itemId, status: "success", branch: record.taskBranch, summary: "complete" }]);
  await executor.reconcile(board.all());
  const sha = git(record.path, "rev-parse", "HEAD");
  assert.equal(recordFor(card.itemId).reviewedTaskSha, sha);
  assert.equal(board.cards.get(card.itemId)!.status, cfg.columns.review);
  console.log("PASS: manual Backlog stops/drains/releases without overwriting lane; dirty manual Ready retry reaches pinned Review");

  const reviewCfg = { ...cfg, review: { ...cfg.review, enabled: true } };
  let reviews = 0, verdict: "pass" | "fail" | "error" = "error";
  const loop = new BoardLoop({ cwd: repo, cfg: reviewCfg, repoOwner: "test", repoName: "repo", botLogin: "bot",
    meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, callback: (m) => notices.push(m), listCards: () => Promise.resolve(board.all()),
    boardOps: { claim: (c) => board.claim(c), refresh: (c) => board.getCard(c.itemId), release: (c) => board.release(c),
      listComments: async (c) => (await board.listComments(c)).map((body, i) => ({ id: `C${i}`, body, author: "bot", createdAt: "" })),
      comment: async (c, body) => { await board.comment(c, body); return "C"; }, setStatus: (c, status) => board.setStatus(c.itemId, status) },
    review: async (input) => {
      reviews++; assert.equal(input.taskSha, sha);
      if (verdict === "error") throw new Error("review tool I/O unavailable");
      return { verdict, taskSha: sha, summary: "review result", findings: verdict === "fail" ? ["src/a.ts: fix regression"] : [] };
    },
  }, createLoopState(), executor, worktrees);
  const beforeReviewStarts = stateFor(record.path).starts;
  await loop.tickNow();
  assert.equal(reviews, 1); assert.equal(recordFor(card.itemId).retry?.stage, "review");
  assert.equal(board.cards.get(card.itemId)!.status, cfg.columns.ready);
  assert.equal(stateFor(record.path).starts, beforeReviewStarts);
  verdict = "pass"; board.failStatusOnce.add(card.itemId);
  await loop.tickNow();
  assert.equal(reviews, 2); assert.ok(recordFor(card.itemId).retry?.reason.includes("AI review passed"));
  await loop.tickNow();
  assert.equal(reviews, 2, "failed status I/O retries settlement, not the reviewer");
  assert.equal(board.cards.get(card.itemId)!.status, cfg.columns.done);
  assert.equal(board.cards.get(card.itemId)!.closed, false);
  assert.equal(recordFor(card.itemId).reviewedTaskSha, sha);
  console.log("PASS: review execution I/O retries the original SHA review (not build); persisted PASS settles Done after status failure without rerunning model or closing Issue");

  board.cards.get(card.itemId)!.status = cfg.columns.review; verdict = "fail";
  await loop.tickNow();
  assert.equal(recordFor(card.itemId).retry?.stage, "build");
  assert.equal(stateFor(record.path).starts, beforeReviewStarts, "no same-ticket second lane in one tick");
  await loop.tickNow();
  assert.equal(stateFor(record.path).starts, beforeReviewStarts + 1);
  assert.ok(runFor(card.itemId).script.includes("fix regression"));
  board.cards.get(card.itemId)!.status = "Backlog"; await executor.reconcile(board.all());
  console.log("PASS: review code FAIL returns to ordinary builder on a later tick with findings in mission");

  // Loop admission starts from supported state; keep the earlier corrupt-record
  // evidence untouched in its separate executor-recovery fixture.
  const slotRepo = join(root, "slot-repo");
  mkdirSync(slotRepo);
  git(slotRepo, "init", "-b", "main");
  const slotWorktrees = new TicketWorktrees(slotRepo);
  const slotCards = [board.add("PVTI_100", 100), board.add("PVTI_101", 101)];
  let slotLaunches = 0;
  const slotExecutor: TicketExecutor = {
    reconcile: async (): Promise<ReconcileSummary> => ({
      active: [],
      resumed: 0,
      adopted: 0,
      needsHuman: 0,
      orphans: 0,
      errors: 0,
    }),
    finalizeClosed: async () => ({ status: "skipped", reason: "test" }),
    launch: async () => {
      slotLaunches++;
      return {
        status: "launched",
        runId: `slot-${slotLaunches}`,
        worktree: repo,
      };
    },
    activeCount: () => 1 + slotLaunches,
    shutdown: async () => undefined,
  };
  const loopDeps: LoopDeps = {
    cwd: slotRepo,
    cfg,
    repoOwner: "test",
    repoName: "repo",
    botLogin: "bot",
    meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
    callback: () => undefined,
    listCards: async () => slotCards,
  };
  await new BoardLoop(
    loopDeps,
    createLoopState(),
    slotExecutor,
    slotWorktrees,
  ).tickNow();
  if (slotLaunches === 1)
    console.log(
      "PASS: global max_workers subtracts active builders without plan guard",
    );
  else fail("FAIL: global worker slot accounting");

  let recoveryLaunches = 0;
  const recoveryExecutor: TicketExecutor = {
    ...slotExecutor,
    activeCount: () => 1 + recoveryLaunches,
    launch: async () => {
      recoveryLaunches++;
      return { status: "launched", runId: "recovery-slot", worktree: repo };
    },
  };
  const recoveryLoop = new BoardLoop(
    loopDeps,
    createLoopState(),
    recoveryExecutor,
    slotWorktrees,
    undefined,
    false,
  );
  await recoveryLoop.tickNow();
  recoveryLoop.enableAdmissions();
  await recoveryLoop.tickNow();
  if (recoveryLaunches === 1)
    console.log(
      "PASS: startup recovery-only mode reconciles without admitting Ready work until promoted",
    );
  else fail("FAIL: recovery-only admission gate");

  const lock = acquireOwnerLock(slotRepo, "bot");
  let secondOwnerRejected = false;
  try {
    acquireOwnerLock(slotRepo, "bot");
  } catch {
    secondOwnerRejected = true;
  }
  lock.release();
  const replacement = acquireOwnerLock(slotRepo, "bot");
  replacement.release();
  if (secondOwnerRejected)
    console.log(
      "PASS: owner lock rejects a second live local process and releases cleanly",
    );
  else fail("FAIL: owner lock exclusivity");
  writeFileSync(
    lock.path,
    JSON.stringify({
      pid: 999999,
      hostname: hostname(),
      token: "stale",
      botLogin: "bot",
      startedAt: new Date(0).toISOString(),
    }),
  );
  const reclaimed = acquireOwnerLock(slotRepo, "bot");
  reclaimed.release();
  console.log("PASS: owner lock reclaims a dead same-host process");
  writeFileSync(
    lock.path,
    JSON.stringify({
      pid: 999999,
      hostname: "another-host",
      token: "foreign",
      botLogin: "bot",
      startedAt: new Date(0).toISOString(),
    }),
  );
  let foreignOwnerRejected = false;
  try {
    acquireOwnerLock(slotRepo, "bot");
  } catch {
    foreignOwnerRejected = true;
  }
  rmSync(lock.path, { force: true });
  if (foreignOwnerRejected)
    console.log("PASS: owner lock fails closed for a different hostname");
  else fail("FAIL: cross-host owner lock");
}

// Real Git + real executor + real BoardLoop; only the remote board and builders
// are offline adapters. Every repository/ref below belongs to this TMP_DIR.
let finalSequence = 0;
async function finalFixture(
  strategy: Config["task_merge_strategy"] = "squash",
  aiReview = false,
) {
  const dir = join(root, `final-executor-${++finalSequence}`);
  const remote = join(dir, "origin.git");
  const checkout = join(dir, "repo");
  mkdirSync(checkout, { recursive: true });
  git(dir, "init", "--bare", remote);
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  writeFileSync(join(checkout, ".gitignore"), ".pi/\n");
  writeFileSync(join(checkout, "base.txt"), "base\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "base");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "-u", "origin", "main");
  const finalCfg: Config = {
    ...cfg,
    task_merge_strategy: strategy,
    review: { ...cfg.review, enabled: aiReview },
    safety: { ...cfg.safety, require_clean_worktree: true },
  };
  const finalBoard = new FakeBoard();
  const card = finalBoard.add(
    `FINAL_${finalSequence}`,
    2000 + finalSequence,
    cfg.columns.done,
  );
  finalBoard.cards.get(card.itemId)!.closed = true;
  card.closed = true;
  const store = new TicketWorktrees(checkout);
  const record = await store.ensure(
    buildTasksForWave(finalCfg, "demo", [card])[0],
    "demo",
  );
  writeFileSync(join(record.path, "accepted.txt"), "approved exact content\n");
  git(record.path, "add", "accepted.txt");
  git(record.path, "commit", "-m", "accepted change");
  git(record.path, "push", "-u", "origin", record.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  const notifications: Array<{
    message: string;
    level: "info" | "warn" | "error";
  }> = [];
  let managers = 0;
  let ensures = 0;
  const make = () => {
    const finalStore = new TicketWorktrees(checkout);
    finalStore.ensure = async () => {
      ensures++;
      throw new Error("finalization must never ensure/recreate a worktree");
    };
    return new ManagedTicketExecutor({
      cwd: checkout,
      cfg: finalCfg,
      botLogin: "bot",
      repoOwner: "test",
      repoName: "repo",
      board: finalBoard,
      worktrees: finalStore,
      callback: (message, level = "info") => {
        notifications.push({ message, level });
      },
      createManager: () => {
        managers++;
        throw new Error("finalization must never create a builder manager");
      },
    });
  };
  const tip = (branch = "main") =>
    git(checkout, "ls-remote", "origin", `refs/heads/${branch}`).split(
      /\s+/,
    )[0];
  const assertNoAdmissions = (settlement = false) => {
    assert.equal(finalBoard.claims, 0);
    if (!settlement) { assert.equal(finalBoard.releases, 0); assert.equal(finalBoard.comments.size, 0); }
    assert.equal(managers, 0);
    assert.equal(ensures, 0);
  };
  return {
    checkout,
    remote,
    finalCfg,
    finalBoard,
    card,
    store,
    record,
    taskSha,
    baseSha,
    notifications,
    make,
    tip,
    assertNoAdmissions,
  };
}

{
  const f = await finalFixture("merge", true);
  f.card.plan = undefined;
  f.finalBoard.cards.get(f.card.itemId)!.plan = undefined;
  rmSync(
    join(
      f.checkout,
      ".pi",
      "board-agent",
      "ticket-worktrees",
      `${f.card.itemId.toLowerCase()}.json`,
    ),
  );
  git(f.checkout, "worktree", "remove", f.record.path);
  git(f.checkout, "push", "origin", "--delete", f.record.taskBranch);
  const loop = new BoardLoop(
    {
      cwd: f.checkout,
      cfg: f.finalCfg,
      repoOwner: "test",
      repoName: "repo",
      botLogin: "bot",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      callback: (message, level = "info") =>
        f.notifications.push({ message, level }),
      listCards: async () => f.finalBoard.all(),
    },
    createLoopState(),
    f.make(),
    f.store,
  );
  await loop.tickNow();
  assert.equal(f.tip(), f.baseSha, "A branch alone is not ownership evidence");
  assert.equal((await f.make().finalizeClosed(f.card)).status, "blocked");
  assert.equal(f.store.localBranchSha(f.record.taskBranch), f.taskSha);
  f.assertNoAdmissions();
  await loop.stop();
  console.log("PASS: unrecorded local-only branch is preserved without guessing ownership, invoking a builder or changing Project state");
}

{
  const f = await finalFixture();
  git(f.checkout, "worktree", "remove", f.record.path);
  git(
    f.checkout,
    "update-ref",
    "-d",
    `refs/heads/${f.record.taskBranch}`,
    f.taskSha,
  );
  mkdirSync(f.record.path);
  writeFileSync(join(f.record.path, "leftover.txt"), "do not delete\n");
  const before = f.finalBoard.all();
  // Unknown leftovers and failed Git observation cannot imply successful cleanup.
  git(
    f.checkout,
    "remote",
    "set-url",
    "origin",
    join(f.checkout, "unavailable.git"),
  );
  for (let restart = 0; restart < 2; restart++) {
    const actual = f.make();
    const loop = new BoardLoop(
      {
        cwd: f.checkout,
        cfg: f.finalCfg,
        repoOwner: "test",
        repoName: "repo",
        botLogin: "bot",
        meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
        callback: (message, level = "info") =>
          f.notifications.push({ message, level }),
        listCards: async () => f.finalBoard.all(),
      },
      createLoopState(),
      actual,
      f.store,
    );
    await loop.tickNow();
    assert.equal((await actual.finalizeClosed(f.card)).status, "blocked");
    await loop.stop();
  }
  assert.ok(!f.notifications.some((n) => n.message.startsWith("Finalized")));
  assert.equal(f.finalBoard.all()[0].closed, true);
  assert.equal(f.finalBoard.all()[0].status, cfg.columns.ready);
  assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "integrate");
  assert.equal(
    readFileSync(join(f.record.path, "leftover.txt"), "utf8"),
    "do not delete\n",
  );
  assert.ok(f.store.has(f.card.itemId));
  f.assertNoAdmissions(true);
  console.log(
    "PASS: missing local ref with unknown leftovers and unavailable remote retains closed Ready integration retry, never deletes work or invents success",
  );
}

for (const strategy of ["squash", "merge"] as const) {
  const f = await finalFixture(strategy);
  assert.equal(_DEFAULTS.review.enabled, false);
  assert.equal(f.store.read(f.card.itemId)!.reviewedTaskSha, undefined);
  const actual = f.make();
  const loop = new BoardLoop(
    {
      cwd: f.checkout,
      cfg: f.finalCfg,
      repoOwner: "test",
      repoName: "repo",
      botLogin: "bot",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      callback: () => undefined,
      listCards: async () => f.finalBoard.all(),
    },
    createLoopState(),
    actual,
    f.store,
  );
  await loop.tickNow();
  const result = f.tip();
  assert.notEqual(
    result,
    f.baseSha,
    "closed Done must reach finalization through the real loop/executor",
  );
  assert.equal(
    git(f.checkout, "show", `${result}:accepted.txt`),
    "approved exact content",
  );
  assert.equal(
    git(f.checkout, "show", "-s", "--format=%P", result),
    `${f.baseSha} ${f.taskSha}`,
  );
  assert.equal(
    git(f.checkout, "show", "-s", "--format=%T", result),
    git(f.checkout, "rev-parse", `${f.taskSha}^{tree}`),
  );
  assert.equal(f.store.has(f.card.itemId), false);
  assert.equal(existsSync(f.record.path), false);
  assert.equal(f.tip(f.record.taskBranch), "");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), f.baseSha);
  assert.equal(git(f.checkout, "branch", "--show-current"), "main");
  assert.equal(git(f.checkout, "status", "--porcelain"), "");
  assert.throws(() =>
    git(
      f.checkout,
      "rev-parse",
      "--verify",
      `refs/heads/${f.record.taskBranch}`,
    ),
  );
  await loop.tickNow();
  await loop.tickNow();
  assert.equal(f.tip(), result);
  assert.deepEqual(await f.make().finalizeClosed(f.card), {
    status: "skipped",
    reason: "No recorded task work remains.",
  });
  assert.equal(
    git(
      f.checkout,
      "log",
      "--format=%H",
      "--fixed-strings",
      `--grep=Board-Agent-Item: ${f.card.itemId}`,
      "origin/main",
    ),
    result,
  );
  assert.deepEqual(f.notifications, [
    {
      message: `Finalized #${f.card.number} "${f.card.title}" at ${result} in main. Deleted local/remote branch ${f.record.taskBranch}, removed its worktree and observed Project Done.`,
      level: "info",
    },
  ]);
  f.assertNoAdmissions();
  console.log(
    `PASS: closed Done ${strategy} E2E finalizes the exact SHA and notifies branch cleanup once; repeated ticks/restart are no-ops`,
  );
}

{
  const f = await finalFixture();
  const expected = structuredClone(f.card);
  const mutations: Array<Partial<Card>> = [
    { closed: false },
    { status: cfg.columns.ready },
    { number: 9999 },
    { itemId: "DIFFERENT" },
    { type: "Story" },
    { contentType: "PullRequest" },
    { contentType: "DraftIssue" },
    { repoOwner: "other" },
    { repoName: "elsewhere" },
  ];
  for (const mutation of mutations) {
    f.finalBoard.cards.set(expected.itemId, { ...expected, ...mutation });
    const outcome = await f.make().finalizeClosed(expected);
    assert.equal(outcome.status, "skipped", JSON.stringify(mutation));
    assert.equal(f.tip(), f.baseSha);
    assert.equal(f.store.read(expected.itemId)!.finalization, undefined);
    assert.ok(existsSync(f.record.path));
  }
  f.finalBoard.cards.delete(expected.itemId);
  assert.equal((await f.make().finalizeClosed(expected)).status, "skipped");
  f.finalBoard.cards.set(expected.itemId, expected);
  const fresh = f.finalBoard.getCard;
  f.finalBoard.getCard = async () => {
    throw new Error("fresh read unavailable");
  };
  assert.deepEqual(await f.make().finalizeClosed(expected), {
    status: "blocked",
    reason: "Error: fresh read unavailable",
  });
  f.finalBoard.getCard = fresh;
  assert.deepEqual(f.notifications, []);
  f.assertNoAdmissions();
  console.log(
    "PASS: finalizer fresh read rejects identity, repository, type, state drift, removal and read errors before any mutation",
  );
  f.finalBoard.cards.get(expected.itemId)!.plan = "changed-after-build";
  assert.equal((await f.make().finalizeClosed(expected)).status, "blocked");
  assert.equal(
    f.finalBoard.cards.get(expected.itemId)!.plan,
    "changed-after-build",
  );
  console.log("PASS: changed Plan/identity is preserved without technical writeback over human state");
}
{
  const f = await finalFixture("merge", true);
  f.store.setReviewedTaskSha(f.card.itemId, f.taskSha);
  writeFileSync(join(f.record.path, "local-only.txt"), "latest local work\n");
  git(f.record.path, "add", "local-only.txt");
  git(f.record.path, "commit", "-m", "local work after review");
  const localSha = git(f.record.path, "rev-parse", "HEAD");
  assert.equal((await f.make().finalizeClosed(f.card)).status, "blocked");
  assert.equal(f.tip(), f.baseSha);
  assert.equal(f.store.localBranchSha(f.record.taskBranch), localSha);
  assert.equal(readFileSync(join(f.record.path, "local-only.txt"), "utf8"), "latest local work\n");
  f.assertNoAdmissions(true);
  console.log("PASS: changed/unpushed work after pinned review is preserved and cannot be integrated or deleted as the old approved SHA");
}
{
  const f = await finalFixture();
  const journal = {
    targetBranch: "main",
    baseSha: f.baseSha,
    taskSha: f.taskSha,
  };
  f.store.update(f.card.itemId, (record) => ({
    ...record,
    finalization: journal,
  }));
  const before = JSON.stringify(f.store.read(f.card.itemId));
  const openReady = { ...f.card, closed: false, status: cfg.columns.ready };
  f.finalBoard.cards.set(f.card.itemId, openReady);
  const actual = f.make();
  const launch = await actual.launch(openReady, "demo");
  assert.equal(launch.status, "skipped");
  assert.match(
    launch.status === "skipped" ? launch.reason : "",
    /pending finalization/,
  );
  await actual.reconcile(f.finalBoard.all());
  await actual.reconcile(f.finalBoard.all());
  assert.equal(JSON.stringify(f.store.read(f.card.itemId)), before);
  assert.equal(f.tip(), f.baseSha);
  f.assertNoAdmissions();
  console.log(
    "PASS: reopened Ready tickets cannot erase or resume builders over pending finalization, including repeated reconciliation",
  );
}

{
  const f = await finalFixture();
  const hook = join(f.remote, "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = refs/heads/${f.record.taskBranch} ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  const first = await f.make().finalizeClosed(f.card);
  assert.equal(first.status, "blocked");
  const published = f.tip();
  assert.notEqual(published, f.baseSha);
  assert.equal(f.store.localBranchSha(f.record.taskBranch), f.taskSha);
  assert.equal(existsSync(f.record.path), true);
  assert.equal(f.tip(f.record.taskBranch), f.taskSha);
  assert.equal(f.store.read(f.card.itemId)!.finalization, undefined);
  assert.deepEqual(f.notifications, []);
  rmSync(hook);
  const restarted = f.make();
  assert.deepEqual(await restarted.finalizeClosed(f.card), {
    status: "finalized",
    resultSha: published,
  });
  assert.equal(
    f.tip(),
    published,
    "retry must not create a second integration commit",
  );
  assert.equal(f.tip(f.record.taskBranch), "");
  assert.equal(f.store.localBranchSha(f.record.taskBranch), undefined);
  assert.equal(existsSync(f.record.path), false);
  assert.deepEqual(await restarted.finalizeClosed(f.card), {
    status: "skipped",
    reason: "No recorded task work remains.",
  });
  assert.equal(f.notifications.length, 1);
  f.assertNoAdmissions(true);
  console.log(
    "PASS: cleanup failure retains the local retry signal; restart finishes without another merge or execution journal",
  );
}
{
  const f = await finalFixture();
  f.store.setActiveRun(f.card.itemId, "still-running");
  const outcome = await f.make().finalizeClosed(f.card);
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.status === "blocked" ? outcome.reason : "", /active/);
  assert.equal(f.tip(), f.baseSha);
  assert.ok(existsSync(f.record.path));
  f.assertNoAdmissions();
  console.log(
    "PASS: an active builder is never merged or deleted during finalization",
  );
}
{
  const f = await finalFixture();
  const journal = {
    targetBranch: "main",
    baseSha: f.baseSha,
    taskSha: f.taskSha,
  };
  // Emulate a mixed journal written by the earlier unsafe implementation.
  const file = join(
    f.checkout,
    ".pi",
    "board-agent",
    "ticket-worktrees",
    `${f.card.itemId.toLowerCase()}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify({
      ...f.record,
      finalization: journal,
      activeRunId: "old-mixed-run",
      activeRunStartedAt: Date.now(),
    }),
  );
  const before = readFileSync(file, "utf8");
  const actual = f.make();
  let boardReads = 0;
  const loop = new BoardLoop(
    {
      cwd: f.checkout,
      cfg: f.finalCfg,
      botLogin: "bot",
      repoOwner: "test",
      repoName: "repo",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      callback: () => undefined,
      listCards: async () => {
        boardReads++;
        return f.finalBoard.all();
      },
    },
    createLoopState(),
    actual,
    f.store,
  );
  await assert.rejects(loop.tickNow(), /Unsupported pre-0.2.0/);
  assert.equal(boardReads, 0);
  assert.equal(f.store.read(f.card.itemId), undefined);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(f.finalBoard.cards.get(f.card.itemId)!.status, cfg.columns.done);
  assert.equal(f.tip(), f.baseSha);
  f.assertNoAdmissions();
  console.log(
    "PASS: invalid mixed finalization/execution state stays read-only; no inferred builder ownership or automatic migration",
  );
}
