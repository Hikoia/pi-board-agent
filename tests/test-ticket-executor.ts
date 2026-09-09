import {
  WorkflowErrorCode,
  type PersistedRunState,
} from "@quintinshaw/pi-dynamic-workflows";
import { execFileSync } from "node:child_process";
import {
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
import { Inflight } from "../src/inflight.js";
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
git(repo, "branch", "plan/demo", "main");
git(repo, "push", "-u", "origin", "plan/demo");

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
const legacy = new Inflight(repo);
const notices: string[] = [];
const makeExecutor = (recover = false) =>
  new ManagedTicketExecutor({
    cwd: repo,
    cfg,
    botLogin: "bot",
    board,
    callback: (message) => notices.push(message),
    worktrees: new TicketWorktrees(repo),
    legacyInflight: new Inflight(repo),
    createManager: (path) => new FakeManager(stateFor(path), recover),
    ensurePlan: () => undefined,
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

const corrupt76 = board.add("PVTI_76", 76, cfg.columns.building);
const card77 = board.add("PVTI_77", 77, cfg.columns.building);
const orphan78 = board.add("PVTI_78", 78, cfg.columns.building);
const card79 = board.add("PVTI_79", 79);
writeFileSync(
  join(repo, ".pi", "board-agent", "ticket-worktrees", "pvti_76.json"),
  "{ corrupt",
);
legacy.write({
  itemId: card77.itemId,
  issueNumber: 77,
  cardTitle: card77.title,
  plan: "demo",
  taskBranch: "task/t077",
  planBranch: "plan/demo",
  startedAt: Date.now(),
});
let executor = makeExecutor();
const legacySummary = await executor.reconcile(board.all());
if (
  board.cards.get(card77.itemId)?.status === cfg.columns.needs_human &&
  legacySummary.legacy === 1 &&
  !legacy.has(card77.itemId)
) {
  console.log("PASS: legacy inflight ticket is quarantined and archived");
} else console.log("FAIL: legacy inflight recovery");
if (
  board.cards.get(orphan78.itemId)?.status === cfg.columns.needs_human &&
  legacySummary.orphans === 2
) {
  console.log(
    "PASS: In Progress ticket without an execution record is quarantined individually",
  );
} else console.log("FAIL: orphan ticket quarantine");
if (board.cards.get(corrupt76.itemId)?.status === cfg.columns.needs_human) {
  console.log("PASS: corrupt execution JSON cannot hide an In Progress orphan");
} else console.log("FAIL: corrupt execution record quarantine");
await board.setStatus(corrupt76.itemId, cfg.columns.ready);
const corruptRelaunch = await executor.launch(corrupt76, "demo");
if (
  corruptRelaunch.status === "needs-human" &&
  readFileSync(
    join(repo, ".pi", "board-agent", "ticket-worktrees", "pvti_76.json"),
    "utf8",
  ) === "{ corrupt"
) {
  console.log("PASS: corrupt execution JSON is never overwritten by a new run");
} else console.log("FAIL: corrupt execution record was overwritten");
const corruptLegacy = board.add(
  "PVTI_corrupt_legacy",
  771,
  cfg.columns.building,
);
const corruptLegacyPath = join(
  repo,
  ".pi",
  "board-agent",
  "inflight",
  `${corruptLegacy.itemId}.json`,
);
writeFileSync(corruptLegacyPath, "{ corrupt");
const corruptLegacySummary = await executor.reconcile(board.all());
if (
  board.cards.get(corruptLegacy.itemId)?.status === cfg.columns.needs_human &&
  corruptLegacySummary.legacy === 1 &&
  !existsSync(corruptLegacyPath)
) {
  console.log(
    "PASS: corrupt legacy inflight JSON is quarantined by filename identity",
  );
} else console.log("FAIL: corrupt legacy inflight record was ignored");
const launched79 = await executor.launch(card79, "demo");
if (launched79.status === "launched")
  console.log("PASS: same-plan Ready ticket launches despite legacy sibling");
else console.log("FAIL: legacy sibling blocked Ready ticket");
const builderScript = runFor(card79.itemId).script;
const builderStartOptions = stateFor(
  recordFor(card79.itemId).path,
).lastStartOptions;
if (
  builderStartOptions?.agentTimeoutMs === 21600000 &&
  builderStartOptions.agentRetries === 1 &&
  builderScript.includes('"builder_timeout_ms":21600000') &&
  builderScript.includes('"builder_retries":1') &&
  builderScript.includes("timeoutMs: PAYLOAD.cfg.builder_timeout_ms")
)
  console.log(
    "PASS: six-hour timeout and one retry reach executor and generated agent",
  );
else console.log("FAIL: builder timeout launch propagation");
if (
  builderScript.includes("git status --short") &&
  builderScript.includes("git diff") &&
  builderScript.includes("the persistent worktree for this ticket") &&
  builderScript.includes("Only pull") &&
  builderScript.includes("Never reset, stash, overwrite, or discard") &&
  builderScript.includes("clean, committed, and pushed")
)
  console.log(
    "PASS: builder preserves and completes a ticket-owned partial diff",
  );
else console.log("FAIL: ticket-owned dirty-worktree contract");
const startsBeforeDuplicate = [...managerStates.values()].reduce(
  (sum, state) => sum + state.starts,
  0,
);
await executor.launch(card79, "demo");
const startsAfterDuplicate = [...managerStates.values()].reduce(
  (sum, state) => sum + state.starts,
  0,
);
if (startsAfterDuplicate === startsBeforeDuplicate)
  console.log("PASS: active ticket is not dispatched twice");
else console.log("FAIL: active ticket dispatched twice");
const branchCollision = board.add("PVTI_790", 790);
board.cards.get(branchCollision.itemId)!.title = "T079 duplicate branch";
if ((await executor.launch(branchCollision, "demo")).status === "needs-human") {
  console.log("PASS: two tickets cannot share one task branch/worktree");
} else console.log("FAIL: duplicate task branch ownership");
const card80 = board.add("PVTI_80", 80);
if (
  (await executor.launch(card80, "demo")).status === "launched" &&
  executor.activeCount() === 2
) {
  console.log("PASS: two tickets from one plan can run concurrently");
} else console.log("FAIL: same-plan concurrency");

const stale81 = board.add("PVTI_81", 81);
board.cards.get(stale81.itemId)!.status = cfg.columns.backlog;
const stale82 = board.add("PVTI_82", 82);
board.cards.get(stale82.itemId)!.plan = "changed";
const stale83 = board.add("PVTI_83", 83);
board.cards.get(stale83.itemId)!.closed = true;
const staleResults = await Promise.all([
  executor.launch(stale81, "demo"),
  executor.launch(stale82, "demo"),
  executor.launch(stale83, "demo"),
]);
if (staleResults.every((result) => result.status === "skipped"))
  console.log(
    "PASS: final refetch rejects status, Plan, and issue-state changes",
  );
else console.log("FAIL: final refetch validation");
const raced = board.add("PVTI_84", 84);
board.claimRaces.add(raced.itemId);
if (
  (await executor.launch(raced, "demo")).status === "skipped" &&
  board.cards.get(raced.itemId)!.assignees.includes("rival")
) {
  console.log(
    "PASS: post-claim refetch detects competing assignee and releases bot",
  );
} else console.log("FAIL: post-claim race validation");

await executor.shutdown();
if (
  [card79.itemId, card80.itemId].every(
    (itemId) => runFor(itemId).status === "paused",
  )
) {
  console.log("PASS: shutdown pauses active managers and preserves records");
} else console.log("FAIL: shutdown persistence");
complete(card79.itemId, [
  {
    taskKey: "T079",
    itemId: card79.itemId,
    status: "success",
    branch: "task/t079",
    summary: "done",
  },
]);
executor = makeExecutor(true);
const restartSummary = await executor.reconcile(board.all());
if (
  board.cards.get(card79.itemId)?.status === cfg.columns.review &&
  board.cards.get(card79.itemId)?.assignees.length === 0 &&
  !recordFor(card79.itemId).activeRunId &&
  restartSummary.resumed === 1 &&
  runFor(card80.itemId).status === "running"
)
  console.log(
    "PASS: restart consumes completed result and resumes clean paused sibling",
  );
else console.log("FAIL: startup completed/resume recovery");
const successCommentCount = board.comments.get(card79.itemId)?.length ?? 0;
await executor.reconcile(board.all());
if ((board.comments.get(card79.itemId)?.length ?? 0) === successCommentCount)
  console.log("PASS: terminal reconciliation is idempotent");
else console.log("FAIL: duplicate terminal comment");

const dirty = board.add("PVTI_85", 85);
const cleanSibling = board.add("PVTI_851", 851);
await executor.launch(dirty, "demo");
await executor.launch(cleanSibling, "demo");
runFor(dirty.itemId).status = "paused";
const dirtyRecord = recordFor(dirty.itemId);
const dirtyPath = dirtyRecord.path;
const dirtyCommentCount = board.comments.get(dirty.itemId)?.length ?? 0;
writeFileSync(join(dirtyPath, "README.md"), "base\npartial\n");
writeFileSync(join(dirtyPath, "dirty.txt"), "untracked partial\n");
await executor.shutdown();
executor = makeExecutor(true);
const dirtySummary = await executor.reconcile(board.all());
if (
  board.cards.get(dirty.itemId)?.status === cfg.columns.building &&
  recordFor(dirty.itemId).activeRunId === dirtyRecord.activeRunId &&
  runFor(dirty.itemId).status === "running" &&
  runFor(cleanSibling.itemId).status === "running" &&
  dirtySummary.resumed >= 2 &&
  readFileSync(join(dirtyPath, "README.md"), "utf8") === "base\npartial\n" &&
  readFileSync(join(dirtyPath, "dirty.txt"), "utf8") ===
    "untracked partial\n" &&
  (board.comments.get(dirty.itemId)?.length ?? 0) === dirtyCommentCount
) {
  console.log(
    "PASS: owned dirty paused worktree resumes with tracked and untracked changes preserved",
  );
} else console.log("FAIL: owned dirty paused worktree recovery");

const usageLimited = board.add("PVTI_852", 852);
await executor.launch(usageLimited, "demo");
const usageRun = runFor(usageLimited.itemId);
usageRun.status = "paused";
usageRun.pauseReason = "usage_limit";
const usageRecord = recordFor(usageLimited.itemId);
const usageState = stateFor(usageRecord.path);
const usageResumes = usageState.resumes;
const usageStops = usageState.stops;
writeFileSync(join(usageRecord.path, "usage-limit.txt"), "checkpoint\n");
const usageSummary = await executor.reconcile(board.all());
if (
  board.cards.get(usageLimited.itemId)?.status === cfg.columns.building &&
  recordFor(usageLimited.itemId).activeRunId === usageRun.runId &&
  usageRun.status === "paused" &&
  usageState.resumes === usageResumes &&
  usageState.stops === usageStops &&
  usageSummary.active.some(
    (active) => active.runId === usageRun.runId && active.status === "paused",
  ) &&
  existsSync(join(usageRecord.path, "usage-limit.txt")) &&
  !board.comments.get(usageLimited.itemId)?.length
)
  console.log(
    "PASS: dirty usage-limit checkpoint stays paused for the scheduler",
  );
else console.log("FAIL: dirty usage-limit checkpoint recovery");

const ticketOwnedDirty = board.add("PVTI_853", 853);
const ticketOwnedDirtyTask = buildTasksForWave(cfg, "demo", [
  ticketOwnedDirty,
])[0];
const ticketOwnedDirtyRecord = worktrees.ensure(ticketOwnedDirtyTask, "demo");
writeFileSync(
  join(ticketOwnedDirtyRecord.path, "checkpoint.txt"),
  "ticket-owned\n",
);
const ticketOwnedDirtyLaunch = await executor.launch(ticketOwnedDirty, "demo");
if (
  ticketOwnedDirtyLaunch.status === "launched" &&
  ticketOwnedDirtyLaunch.worktree === ticketOwnedDirtyRecord.path &&
  board.cards.get(ticketOwnedDirty.itemId)?.status === cfg.columns.building &&
  recordFor(ticketOwnedDirty.itemId).activeRunId &&
  existsSync(join(ticketOwnedDirtyRecord.path, "checkpoint.txt")) &&
  !board.comments.get(ticketOwnedDirty.itemId)?.length
)
  console.log(
    "PASS: ticket-owned dirty worktree launches without a prior run id",
  );
else console.log("FAIL: ticket-owned dirty worktree launch");

const completedDirty = board.add("PVTI_854", 854);
await executor.launch(completedDirty, "demo");
complete(completedDirty.itemId, [
  {
    taskKey: "T854",
    itemId: completedDirty.itemId,
    status: "success",
    branch: "task/t854",
    summary: "done",
  },
]);
const completedDirtyRecord = recordFor(completedDirty.itemId);
const completedDirtyPath = completedDirtyRecord.path;
writeFileSync(join(completedDirtyPath, "completed-dirty.txt"), "unsafe\n");
await executor.reconcile(board.all());
const completedDirtyComment = (
  board.comments.get(completedDirty.itemId) ?? []
).join("\n");
if (
  board.cards.get(completedDirty.itemId)?.status === cfg.columns.needs_human &&
  !recordFor(completedDirty.itemId).activeRunId &&
  completedDirtyComment.includes(
    `board-agent-run:${completedDirtyRecord.activeRunId}:malformed`,
  ) &&
  completedDirtyComment.includes("dirty worktree") &&
  existsSync(join(completedDirtyPath, "completed-dirty.txt"))
)
  console.log("PASS: dirty completed-success worktree still fails closed");
else console.log("FAIL: dirty completed-success worktree gate");

const timedOut = board.add("PVTI_38", 38);
await executor.launch(timedOut, "demo");
const timedOutRun = runFor(timedOut.itemId);
const timedOutRunId = timedOutRun.runId;
timedOutRun.status = "completed";
timedOutRun.result = [null];
timedOutRun.agentTimeoutMs = 7200000;
timedOutRun.agents = [
  {
    id: 1,
    label: "build T038",
    prompt: "builder prompt",
    status: "error",
    errorCode: WorkflowErrorCode.AGENT_TIMEOUT,
    error: "RAW provider timeout details must stay private",
  },
];
const timedOutPath = recordFor(timedOut.itemId).path;
writeFileSync(join(timedOutPath, "README.md"), "base\npartial timeout work\n");
writeFileSync(join(timedOutPath, "timeout-untracked.txt"), "keep me\n");
const timedOutSummary = await executor.reconcile(board.all());
const timedOutComment = (board.comments.get(timedOut.itemId) ?? []).join("\n");
const timedOutCommentCount = board.comments.get(timedOut.itemId)?.length ?? 0;
await executor.reconcile(board.all());
const timedOutRecord = recordFor(timedOut.itemId);
if (
  timedOutSummary.needsHuman === 1 &&
  board.cards.get(timedOut.itemId)?.status === cfg.columns.needs_human &&
  !timedOutRecord.activeRunId &&
  timedOutRecord.lastRunId === timedOutRunId &&
  timedOutComment.includes(`board-agent-run:${timedOutRunId}:malformed`) &&
  timedOutComment.includes("Builder agent timed out after 7200000 ms.") &&
  timedOutComment.includes("preserve useful changes") &&
  timedOutComment.includes("address the reported blocker before retrying") &&
  !timedOutComment.includes("RAW provider timeout details") &&
  !timedOutComment.includes("dirty worktree") &&
  !timedOutComment.includes("leave the expected task branch clean") &&
  readFileSync(join(timedOutPath, "README.md"), "utf8") ===
    "base\npartial timeout work\n" &&
  readFileSync(join(timedOutPath, "timeout-untracked.txt"), "utf8") ===
    "keep me\n" &&
  (board.comments.get(timedOut.itemId)?.length ?? 0) === timedOutCommentCount
) {
  console.log(
    "PASS: completed null timeout outranks dirtiness and preserves partial work",
  );
} else console.log("FAIL: completed null timeout reconciliation");

const validTimeoutAgent = {
  status: "error",
  errorCode: "AGENT_TIMEOUT",
  error: "RAW malformed metadata details",
};
const malformedAgentCases: Array<{
  number: number;
  agents: unknown;
  timeoutMs?: unknown;
}> = [
  { number: 381, agents: {} },
  { number: 382, agents: [null] },
  { number: 383, agents: [{ ...validTimeoutAgent, status: "done" }] },
  { number: 384, agents: [{ ...validTimeoutAgent, errorCode: "OTHER" }] },
  { number: 385, agents: [validTimeoutAgent], timeoutMs: 0 },
  { number: 386, agents: [validTimeoutAgent], timeoutMs: 1.5 },
  {
    number: 387,
    agents: [validTimeoutAgent],
    timeoutMs: Number.POSITIVE_INFINITY,
  },
];
const malformedAgentRuns: Array<{
  itemId: string;
  runId: string;
  timeout: boolean;
}> = [];
for (const testCase of malformedAgentCases) {
  const card = board.add(`PVTI_${testCase.number}`, testCase.number);
  await executor.launch(card, "demo");
  const run = runFor(card.itemId);
  run.status = "completed";
  run.result = [null];
  const metadata = run as unknown as {
    agents: unknown;
    agentTimeoutMs?: unknown;
  };
  metadata.agents = testCase.agents;
  if ("timeoutMs" in testCase) metadata.agentTimeoutMs = testCase.timeoutMs;
  malformedAgentRuns.push({
    itemId: card.itemId,
    runId: run.runId,
    timeout: "timeoutMs" in testCase,
  });
}
const malformedAgentSummary = await executor.reconcile(board.all());
const malformedAgentGuardsPassed = malformedAgentRuns.every(
  ({ itemId, runId, timeout }) => {
    const comment = (board.comments.get(itemId) ?? []).join("\n");
    const expectedProblem = timeout
      ? "Builder agent timed out."
      : "persisted builder result is malformed";
    return (
      board.cards.get(itemId)?.status === cfg.columns.needs_human &&
      comment.includes(`board-agent-run:${runId}:malformed`) &&
      comment.includes(`**Problem**\n${expectedProblem}\n`) &&
      !comment.includes("RAW") &&
      !comment.includes("timed out after")
    );
  },
);
if (
  malformedAgentSummary.needsHuman === malformedAgentCases.length &&
  malformedAgentSummary.errors === 0 &&
  malformedAgentGuardsPassed
) {
  console.log(
    "PASS: malformed timeout metadata falls back safely and invalid durations are omitted",
  );
} else console.log("FAIL: malformed timeout metadata guards");

const trustedIdentity = board.add("PVTI_37", 37);
await executor.launch(trustedIdentity, "demo");
complete(trustedIdentity.itemId, [
  {
    taskKey: "37",
    itemId: "37",
    status: "success",
    branch: "task/t037",
    summary: "done",
  },
]);
await executor.reconcile(board.all());
if (
  board.cards.get(trustedIdentity.itemId)?.status === cfg.columns.review &&
  !recordFor(trustedIdentity.itemId).activeRunId
)
  console.log(
    "PASS: persisted run identity overrides incorrect echoed identity",
  );
else console.log("FAIL: trusted persisted run identity");

const malformedIdentity = [855, 856, 857].map((number) =>
  board.add(`PVTI_${number}`, number),
);
for (const card of malformedIdentity) await executor.launch(card, "demo");
complete(malformedIdentity[0].itemId, [
  {
    taskKey: "T855",
    itemId: malformedIdentity[0].itemId,
    status: "success",
    branch: "task/t855",
  },
  {
    taskKey: "T999",
    itemId: "PVTI_999",
    status: "failure",
    error: "extra result",
  },
]);
complete(malformedIdentity[1].itemId, [
  {
    taskKey: "T856",
    itemId: malformedIdentity[1].itemId,
    status: "success",
    branch: "task/wrong",
  },
]);
const wrongArgsRun = runFor(malformedIdentity[2].itemId);
wrongArgsRun.status = "completed";
wrongArgsRun.result = [
  {
    taskKey: "T857",
    itemId: malformedIdentity[2].itemId,
    status: "success",
    branch: "task/t857",
  },
];
wrongArgsRun.args = { itemId: "PVTI_wrong", issueNumber: 857, taskKey: "T857" };
await executor.reconcile(board.all());
if (
  malformedIdentity.every(
    (card) => board.cards.get(card.itemId)?.status === cfg.columns.needs_human,
  )
) {
  console.log(
    "PASS: multiple results, wrong branch, and mismatched run args remain quarantined",
  );
} else console.log("FAIL: malformed persisted result guards");

const terminalCards = [86, 87, 88, 89].map((number) =>
  board.add(`PVTI_${number}`, number),
);
for (const card of terminalCards) await executor.launch(card, "demo");
runFor(terminalCards[0].itemId).status = "failed";
runFor(terminalCards[0].itemId).error = "agent failed";
runFor(terminalCards[1].itemId).status = "aborted";
complete(terminalCards[2].itemId, { malformed: true });
const missingRecord = recordFor(terminalCards[3].itemId);
stateFor(missingRecord.path).runs.delete(missingRecord.activeRunId!);
await executor.reconcile(board.all());
if (
  terminalCards.every(
    (card) => board.cards.get(card.itemId)?.status === cfg.columns.needs_human,
  )
) {
  console.log(
    "PASS: failed, aborted, malformed, and missing runs all require human",
  );
} else console.log("FAIL: terminal failure policy");

const explained = board.add("PVTI_894", 894);
await executor.launch(explained, "demo");
complete(explained.itemId, [
  {
    taskKey: "T894",
    itemId: explained.itemId,
    status: "failure",
    error: "Deployment target is missing.",
    attempted: "Checked repository configuration.",
    limitations: "Choosing a target would be unsafe.",
    workaround: "Select staging or production.",
    humanAction: "Reply with the approved target.",
  },
]);
const explainedPath = recordFor(explained.itemId).path;
writeFileSync(join(explainedPath, "README.md"), "base\nstructured partial\n");
writeFileSync(join(explainedPath, "structured-untracked.txt"), "keep me\n");
await executor.reconcile(board.all());
const blockerComment = (board.comments.get(explained.itemId) ?? []).join("\n");
if (
  board.cards.get(explained.itemId)?.status === cfg.columns.needs_human &&
  blockerComment.includes("## ⚠️ Needs human input") &&
  blockerComment.includes("Deployment target is missing.") &&
  blockerComment.includes("Checked repository configuration.") &&
  blockerComment.includes("Choosing a target would be unsafe.") &&
  blockerComment.includes("Select staging or production.") &&
  blockerComment.includes("Reply with the approved target.") &&
  blockerComment.includes("manually move this Project card to `Ready`") &&
  !blockerComment.includes("dirty worktree") &&
  readFileSync(join(explainedPath, "README.md"), "utf8") ===
    "base\nstructured partial\n" &&
  readFileSync(join(explainedPath, "structured-untracked.txt"), "utf8") ===
    "keep me\n"
)
  console.log(
    "PASS: dirty builder failure preserves work and actionable details",
  );
else console.log("FAIL: dirty builder failure human guidance");

const wrongBranchFailure = board.add("PVTI_896", 896);
await executor.launch(wrongBranchFailure, "demo");
complete(wrongBranchFailure.itemId, [
  {
    taskKey: "T896",
    itemId: wrongBranchFailure.itemId,
    status: "failure",
    error: "Build prerequisites are missing.",
    attempted: "Checked the generated artifacts.",
    limitations: "Continuing would produce an invalid build.",
    workaround: "Keep the partial patch for inspection.",
    humanAction: "Restore the expected branch and provide the prerequisite.",
  },
]);
const wrongBranchFailureRecord = recordFor(wrongBranchFailure.itemId);
git(wrongBranchFailureRecord.path, "checkout", "-b", "wrong/probe");
writeFileSync(
  join(wrongBranchFailureRecord.path, "wrong-branch-partial.txt"),
  "keep me\n",
);
await executor.reconcile(board.all());
const wrongBranchFailureComment = (
  board.comments.get(wrongBranchFailure.itemId) ?? []
).join("\n");
if (
  board.cards.get(wrongBranchFailure.itemId)?.status ===
    cfg.columns.needs_human &&
  !recordFor(wrongBranchFailure.itemId).activeRunId &&
  [
    "Build prerequisites are missing.",
    "Checked the generated artifacts.",
    "Continuing would produce an invalid build.",
    "Keep the partial patch for inspection.",
    "Restore the expected branch and provide the prerequisite.",
    "expected branch task/t896, found wrong/probe",
  ].every((text) => wrongBranchFailureComment.includes(text)) &&
  existsSync(
    join(wrongBranchFailureRecord.path, "wrong-branch-partial.txt"),
  )
)
  console.log(
    "PASS: wrong-branch builder failure preserves safety reason and actionable details",
  );
else console.log("FAIL: wrong-branch builder failure details");

const manuallyMoved = board.add("PVTI_895", 895);
await executor.launch(manuallyMoved, "demo");
complete(manuallyMoved.itemId, { malformed: true });
await board.setStatus(manuallyMoved.itemId, cfg.columns.backlog);
await executor.reconcile(board.all());
if (
  board.cards.get(manuallyMoved.itemId)?.status === cfg.columns.backlog &&
  !recordFor(manuallyMoved.itemId).activeRunId
) {
  console.log("PASS: manual status wins over a stale terminal result");
} else console.log("FAIL: stale terminal result overwrote manual status");

const adopting = board.add("PVTI_90", 90);
const adoptingTask = buildTasksForWave(cfg, "demo", [adopting])[0];
const adoptingRecord = worktrees.beginLaunch(
  worktrees.ensure(adoptingTask, "demo").itemId,
  Date.now() - 10,
);
await board.setStatus(adopting.itemId, cfg.columns.building);
const adoptedRun = makeRun("run-adopt", {
  itemId: adopting.itemId,
  issueNumber: 90,
  taskKey: "T090",
});
stateFor(adoptingRecord.path).runs.set(adoptedRun.runId, adoptedRun);
executor = makeExecutor(true);
const adoptedSummary = await executor.reconcile(board.all());
if (
  recordFor(adopting.itemId).activeRunId === adoptedRun.runId &&
  adoptedSummary.adopted === 1
) {
  console.log("PASS: launch crash adopts uniquely matching persisted args");
} else console.log("FAIL: persisted run adoption");

const unstarted = board.add("PVTI_91", 91);
const unstartedTask = buildTasksForWave(cfg, "demo", [unstarted])[0];
worktrees.beginLaunch(
  worktrees.ensure(unstartedTask, "demo").itemId,
  Date.now(),
);
await board.setStatus(unstarted.itemId, cfg.columns.building);
const unstartedSummary = await executor.reconcile(board.all());
const unstartedAfter = recordFor(unstarted.itemId);
if (
  board.cards.get(unstarted.itemId)?.status === cfg.columns.ready &&
  !unstartedAfter.launchingAt &&
  unstartedSummary.needsHuman === 0
) {
  console.log("PASS: proven zero-side-effect launch crash returns to Ready");
} else console.log("FAIL: zero-side-effect launch recovery");

const incident = board.add("PVTI_911", 911, cfg.columns.building);
const incidentTask = buildTasksForWave(cfg, "demo", [incident])[0];
const incidentRecord = worktrees.ensure(incidentTask, "demo");
worktrees.clearExecution(incidentRecord.itemId, "run-incident-a");
await executor.reconcile(board.all());
const firstIncidentComments = board.comments.get(incident.itemId)?.length ?? 0;
await board.setStatus(incident.itemId, cfg.columns.building);
await executor.reconcile(board.all());
const repeatedIncidentComments =
  board.comments.get(incident.itemId)?.length ?? 0;
worktrees.clearExecution(incident.itemId, "run-incident-b");
await board.setStatus(incident.itemId, cfg.columns.building);
await executor.reconcile(board.all());
const incidentComments = board.comments.get(incident.itemId) ?? [];
const nextIncidentComments = incidentComments.length;
if (
  firstIncidentComments === 1 &&
  repeatedIncidentComments === 1 &&
  nextIncidentComments === 2 &&
  incidentComments.some((comment) =>
    comment.includes(":run-incident-a:needs-human -->"),
  ) &&
  incidentComments.some((comment) =>
    comment.includes(":run-incident-b:needs-human -->"),
  )
) {
  console.log("PASS: recovery comments deduplicate per run lineage");
} else console.log("FAIL: recovery comment run lineage");

const flaky = board.add("PVTI_92", 92);
await executor.launch(flaky, "demo");
complete(flaky.itemId, [
  {
    taskKey: "T092",
    itemId: flaky.itemId,
    status: "success",
    branch: "task/t092",
    summary: "done",
  },
]);
board.failStatusOnce.add(flaky.itemId);
await executor.reconcile(board.all());
const retainedAfterMutationFailure = !!recordFor(flaky.itemId).activeRunId;
await executor.reconcile(board.all());
const flakyMarkers = (board.comments.get(flaky.itemId) ?? []).filter(
  (comment) => comment.includes("board-agent-run:"),
);
if (
  retainedAfterMutationFailure &&
  board.cards.get(flaky.itemId)?.status === cfg.columns.review &&
  flakyMarkers.length === 1
) {
  console.log(
    "PASS: GitHub mutation failure retains run and retries outcome exactly once",
  );
} else console.log("FAIL: mutation retry/idempotence");

const removed = board.add("PVTI_93", 93);
await executor.launch(removed, "demo");
const removedRun = runFor(removed.itemId);
board.cards.delete(removed.itemId);
const removedSummary = await executor.reconcile(board.all());
if (
  removedRun.status === "aborted" &&
  !recordFor(removed.itemId).activeRunId &&
  removedSummary.orphans === 1
) {
  console.log(
    "PASS: a removed Project item stops only its run and frees the global slot",
  );
} else console.log("FAIL: removed Project item recovery");

const slotCards = [board.add("PVTI_100", 100), board.add("PVTI_101", 101)];
let slotLaunches = 0;
const slotExecutor: TicketExecutor = {
  reconcile: async (): Promise<ReconcileSummary> => ({
    active: [],
    resumed: 0,
    adopted: 0,
    needsHuman: 0,
    legacy: 0,
    orphans: 0,
    errors: 0,
  }),
  launch: async () => {
    slotLaunches++;
    return {
      status: "launched",
      runId: `slot-${slotLaunches}`,
      worktree: repo,
    };
  },
  activeCount: () => 1,
  shutdown: async () => undefined,
};
const loopDeps: LoopDeps = {
  cwd: repo,
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
  worktrees,
).tickNow();
if (slotLaunches === 1)
  console.log(
    "PASS: global max_workers subtracts active builders without plan guard",
  );
else console.log("FAIL: global worker slot accounting");

let recoveryLaunches = 0;
const recoveryExecutor: TicketExecutor = {
  ...slotExecutor,
  launch: async () => {
    recoveryLaunches++;
    return { status: "launched", runId: "recovery-slot", worktree: repo };
  },
};
const recoveryLoop = new BoardLoop(
  loopDeps,
  createLoopState(),
  recoveryExecutor,
  worktrees,
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
else console.log("FAIL: recovery-only admission gate");

const lock = acquireOwnerLock(repo, "bot");
let secondOwnerRejected = false;
try {
  acquireOwnerLock(repo, "bot");
} catch {
  secondOwnerRejected = true;
}
lock.release();
const replacement = acquireOwnerLock(repo, "bot");
replacement.release();
if (secondOwnerRejected)
  console.log(
    "PASS: owner lock rejects a second live local process and releases cleanly",
  );
else console.log("FAIL: owner lock exclusivity");
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
const reclaimed = acquireOwnerLock(repo, "bot");
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
  acquireOwnerLock(repo, "bot");
} catch {
  foreignOwnerRejected = true;
}
rmSync(lock.path, { force: true });
if (foreignOwnerRejected)
  console.log("PASS: owner lock fails closed for a different hostname");
else console.log("FAIL: cross-host owner lock");
