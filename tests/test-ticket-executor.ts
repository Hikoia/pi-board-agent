import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { TicketWorktrees, type TicketExecutionRecord } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
const origin = join(root, "origin.git");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

  add(itemId: string, number: number, status = cfg.columns.ready, plan = "demo"): Card {
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

  all(): Card[] { return [...this.cards.values()].map((card) => structuredClone(card)); }
  async getCard(itemId: string): Promise<Card | undefined> {
    const card = this.cards.get(itemId);
    return card ? structuredClone(card) : undefined;
  }
  async setStatus(itemId: string, status: string): Promise<void> {
    if (this.failStatusOnce.delete(itemId)) throw new Error("simulated GitHub status failure");
    this.cards.get(itemId)!.status = status;
  }
  async claim(card: Card): Promise<boolean> {
    this.claims++;
    const current = this.cards.get(card.itemId)!;
    current.assignees = this.claimRaces.has(card.itemId) ? ["bot", "rival"] : ["bot"];
    return true;
  }
  async release(card: Card): Promise<void> {
    this.releases++;
    const current = this.cards.get(card.itemId);
    if (current) current.assignees = current.assignees.filter((login) => login !== "bot");
  }
  async listComments(card: Card): Promise<string[]> { return [...(this.comments.get(card.itemId) ?? [])]; }
  async comment(card: Card, body: string): Promise<void> {
    this.comments.set(card.itemId, [...(this.comments.get(card.itemId) ?? []), body]);
  }
}

interface ManagerState {
  runs: Map<string, PersistedRunState>;
  starts: number;
  resumes: number;
  pauses: number;
  stops: number;
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
  constructor(readonly state: ManagerState, recover: boolean) {
    if (recover) for (const run of state.runs.values()) if (run.status === "running") run.status = "paused";
  }
  start(script: string, args: { itemId: string; issueNumber: number; taskKey: string }): string {
    const runId = `run-${++runSequence}`;
    const run = makeRun(runId, args);
    run.script = script;
    this.state.runs.set(runId, run);
    this.state.starts++;
    return runId;
  }
  list(): PersistedRunState[] { return [...this.state.runs.values()]; }
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
    if (run && (run.status === "running" || run.status === "paused")) run.status = "aborted";
    this.state.stops++;
  }
  dispose(): void {}
}

const board = new FakeBoard();
const worktrees = new TicketWorktrees(repo);
const legacy = new Inflight(repo);
const notices: string[] = [];
const makeExecutor = (recover = false) => new ManagedTicketExecutor({
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
const recordFor = (itemId: string) => worktrees.read(itemId) as TicketExecutionRecord;
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
writeFileSync(join(repo, ".pi", "board-agent", "ticket-worktrees", "pvti_76.json"), "{ corrupt");
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
if (board.cards.get(card77.itemId)?.status === cfg.columns.needs_human && legacySummary.legacy === 1 && !legacy.has(card77.itemId)) {
  console.log("PASS: legacy inflight ticket is quarantined and archived");
} else console.log("FAIL: legacy inflight recovery");
if (board.cards.get(orphan78.itemId)?.status === cfg.columns.needs_human && legacySummary.orphans === 2) {
  console.log("PASS: In Progress ticket without an execution record is quarantined individually");
} else console.log("FAIL: orphan ticket quarantine");
if (board.cards.get(corrupt76.itemId)?.status === cfg.columns.needs_human) {
  console.log("PASS: corrupt execution JSON cannot hide an In Progress orphan");
} else console.log("FAIL: corrupt execution record quarantine");
await board.setStatus(corrupt76.itemId, cfg.columns.ready);
const corruptRelaunch = await executor.launch(corrupt76, "demo");
if (corruptRelaunch.status === "needs-human" && readFileSync(join(repo, ".pi", "board-agent", "ticket-worktrees", "pvti_76.json"), "utf8") === "{ corrupt") {
  console.log("PASS: corrupt execution JSON is never overwritten by a new run");
} else console.log("FAIL: corrupt execution record was overwritten");
const corruptLegacy = board.add("PVTI_corrupt_legacy", 771, cfg.columns.building);
const corruptLegacyPath = join(repo, ".pi", "board-agent", "inflight", `${corruptLegacy.itemId}.json`);
writeFileSync(corruptLegacyPath, "{ corrupt");
const corruptLegacySummary = await executor.reconcile(board.all());
if (board.cards.get(corruptLegacy.itemId)?.status === cfg.columns.needs_human && corruptLegacySummary.legacy === 1 && !existsSync(corruptLegacyPath)) {
  console.log("PASS: corrupt legacy inflight JSON is quarantined by filename identity");
} else console.log("FAIL: corrupt legacy inflight record was ignored");
const launched79 = await executor.launch(card79, "demo");
if (launched79.status === "launched") console.log("PASS: same-plan Ready ticket launches despite legacy sibling");
else console.log("FAIL: legacy sibling blocked Ready ticket");
const startsBeforeDuplicate = [...managerStates.values()].reduce((sum, state) => sum + state.starts, 0);
await executor.launch(card79, "demo");
const startsAfterDuplicate = [...managerStates.values()].reduce((sum, state) => sum + state.starts, 0);
if (startsAfterDuplicate === startsBeforeDuplicate) console.log("PASS: active ticket is not dispatched twice");
else console.log("FAIL: active ticket dispatched twice");
const branchCollision = board.add("PVTI_790", 790);
board.cards.get(branchCollision.itemId)!.title = "T079 duplicate branch";
if ((await executor.launch(branchCollision, "demo")).status === "needs-human") {
  console.log("PASS: two tickets cannot share one task branch/worktree");
} else console.log("FAIL: duplicate task branch ownership");
const card80 = board.add("PVTI_80", 80);
if ((await executor.launch(card80, "demo")).status === "launched" && executor.activeCount() === 2) {
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
if (staleResults.every((result) => result.status === "skipped")) console.log("PASS: final refetch rejects status, Plan, and issue-state changes");
else console.log("FAIL: final refetch validation");
const raced = board.add("PVTI_84", 84);
board.claimRaces.add(raced.itemId);
if ((await executor.launch(raced, "demo")).status === "skipped" && board.cards.get(raced.itemId)!.assignees.includes("rival")) {
  console.log("PASS: post-claim refetch detects competing assignee and releases bot");
} else console.log("FAIL: post-claim race validation");

await executor.shutdown();
if ([card79.itemId, card80.itemId].every((itemId) => runFor(itemId).status === "paused")) {
  console.log("PASS: shutdown pauses active managers and preserves records");
} else console.log("FAIL: shutdown persistence");
complete(card79.itemId, [{ taskKey: "T079", itemId: card79.itemId, status: "success", branch: "task/t079", summary: "done" }]);
executor = makeExecutor(true);
const restartSummary = await executor.reconcile(board.all());
if (
  board.cards.get(card79.itemId)?.status === cfg.columns.review &&
  board.cards.get(card79.itemId)?.assignees.length === 0 &&
  !recordFor(card79.itemId).activeRunId &&
  restartSummary.resumed === 1 &&
  runFor(card80.itemId).status === "running"
) console.log("PASS: restart consumes completed result and resumes clean paused sibling");
else console.log("FAIL: startup completed/resume recovery");
const successCommentCount = board.comments.get(card79.itemId)?.length ?? 0;
await executor.reconcile(board.all());
if ((board.comments.get(card79.itemId)?.length ?? 0) === successCommentCount) console.log("PASS: terminal reconciliation is idempotent");
else console.log("FAIL: duplicate terminal comment");

const dirty = board.add("PVTI_85", 85);
await executor.launch(dirty, "demo");
runFor(dirty.itemId).status = "paused";
writeFileSync(join(recordFor(dirty.itemId).path, "dirty.txt"), "partial\n");
await executor.shutdown();
executor = makeExecutor(true);
const dirtySummary = await executor.reconcile(board.all());
if (board.cards.get(dirty.itemId)?.status === cfg.columns.needs_human && dirtySummary.needsHuman >= 1 && existsSync(recordFor(dirty.itemId).path)) {
  console.log("PASS: dirty paused worktree is preserved in Needs Human");
} else console.log("FAIL: dirty paused worktree recovery");

const terminalCards = [86, 87, 88, 89].map((number) => board.add(`PVTI_${number}`, number));
for (const card of terminalCards) await executor.launch(card, "demo");
runFor(terminalCards[0].itemId).status = "failed";
runFor(terminalCards[0].itemId).error = "agent failed";
runFor(terminalCards[1].itemId).status = "aborted";
complete(terminalCards[2].itemId, { malformed: true });
const missingRecord = recordFor(terminalCards[3].itemId);
stateFor(missingRecord.path).runs.delete(missingRecord.activeRunId!);
await executor.reconcile(board.all());
if (terminalCards.every((card) => board.cards.get(card.itemId)?.status === cfg.columns.needs_human)) {
  console.log("PASS: failed, aborted, malformed, and missing runs all require human");
} else console.log("FAIL: terminal failure policy");

const explained = board.add("PVTI_894", 894);
await executor.launch(explained, "demo");
complete(explained.itemId, [{
  taskKey: "T894",
  itemId: explained.itemId,
  status: "failure",
  error: "Deployment target is missing.",
  attempted: "Checked repository configuration.",
  limitations: "Choosing a target would be unsafe.",
  workaround: "Select staging or production.",
  humanAction: "Reply with the approved target.",
}]);
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
  blockerComment.includes("manually move this Project card to `Ready`")
) console.log("PASS: builder failure leaves actionable human guidance");
else console.log("FAIL: builder failure human guidance");

const manuallyMoved = board.add("PVTI_895", 895);
await executor.launch(manuallyMoved, "demo");
complete(manuallyMoved.itemId, { malformed: true });
await board.setStatus(manuallyMoved.itemId, cfg.columns.backlog);
await executor.reconcile(board.all());
if (board.cards.get(manuallyMoved.itemId)?.status === cfg.columns.backlog && !recordFor(manuallyMoved.itemId).activeRunId) {
  console.log("PASS: manual status wins over a stale terminal result");
} else console.log("FAIL: stale terminal result overwrote manual status");

const adopting = board.add("PVTI_90", 90);
const adoptingTask = buildTasksForWave(cfg, "demo", [adopting])[0];
const adoptingRecord = worktrees.beginLaunch(worktrees.ensure(adoptingTask, "demo").itemId, Date.now() - 10);
await board.setStatus(adopting.itemId, cfg.columns.building);
const adoptedRun = makeRun("run-adopt", { itemId: adopting.itemId, issueNumber: 90, taskKey: "T090" });
stateFor(adoptingRecord.path).runs.set(adoptedRun.runId, adoptedRun);
executor = makeExecutor(true);
const adoptedSummary = await executor.reconcile(board.all());
if (recordFor(adopting.itemId).activeRunId === adoptedRun.runId && adoptedSummary.adopted === 1) {
  console.log("PASS: launch crash adopts uniquely matching persisted args");
} else console.log("FAIL: persisted run adoption");

const unstarted = board.add("PVTI_91", 91);
const unstartedTask = buildTasksForWave(cfg, "demo", [unstarted])[0];
worktrees.beginLaunch(worktrees.ensure(unstartedTask, "demo").itemId, Date.now());
await board.setStatus(unstarted.itemId, cfg.columns.building);
const unstartedSummary = await executor.reconcile(board.all());
const unstartedAfter = recordFor(unstarted.itemId);
if (board.cards.get(unstarted.itemId)?.status === cfg.columns.ready && !unstartedAfter.launchingAt && unstartedSummary.needsHuman === 0) {
  console.log("PASS: proven zero-side-effect launch crash returns to Ready");
} else console.log("FAIL: zero-side-effect launch recovery");

const flaky = board.add("PVTI_92", 92);
await executor.launch(flaky, "demo");
complete(flaky.itemId, [{ taskKey: "T092", itemId: flaky.itemId, status: "success", branch: "task/t092", summary: "done" }]);
board.failStatusOnce.add(flaky.itemId);
await executor.reconcile(board.all());
const retainedAfterMutationFailure = !!recordFor(flaky.itemId).activeRunId;
await executor.reconcile(board.all());
const flakyMarkers = (board.comments.get(flaky.itemId) ?? []).filter((comment) => comment.includes("board-agent-run:"));
if (retainedAfterMutationFailure && board.cards.get(flaky.itemId)?.status === cfg.columns.review && flakyMarkers.length === 1) {
  console.log("PASS: GitHub mutation failure retains run and retries outcome exactly once");
} else console.log("FAIL: mutation retry/idempotence");

const removed = board.add("PVTI_93", 93);
await executor.launch(removed, "demo");
const removedRun = runFor(removed.itemId);
board.cards.delete(removed.itemId);
const removedSummary = await executor.reconcile(board.all());
if (removedRun.status === "aborted" && !recordFor(removed.itemId).activeRunId && removedSummary.orphans === 1) {
  console.log("PASS: a removed Project item stops only its run and frees the global slot");
} else console.log("FAIL: removed Project item recovery");

const slotCards = [board.add("PVTI_100", 100), board.add("PVTI_101", 101)];
let slotLaunches = 0;
const slotExecutor: TicketExecutor = {
  reconcile: async (): Promise<ReconcileSummary> => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, legacy: 0, orphans: 0, errors: 0 }),
  launch: async () => { slotLaunches++; return { status: "launched", runId: `slot-${slotLaunches}`, worktree: repo }; },
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
await new BoardLoop(loopDeps, createLoopState(), slotExecutor, worktrees).tickNow();
if (slotLaunches === 1) console.log("PASS: global max_workers subtracts active builders without plan guard");
else console.log("FAIL: global worker slot accounting");

let recoveryLaunches = 0;
const recoveryExecutor: TicketExecutor = {
  ...slotExecutor,
  launch: async () => { recoveryLaunches++; return { status: "launched", runId: "recovery-slot", worktree: repo }; },
};
const recoveryLoop = new BoardLoop(loopDeps, createLoopState(), recoveryExecutor, worktrees, undefined, false);
await recoveryLoop.tickNow();
recoveryLoop.enableAdmissions();
await recoveryLoop.tickNow();
if (recoveryLaunches === 1) console.log("PASS: startup recovery-only mode reconciles without admitting Ready work until promoted");
else console.log("FAIL: recovery-only admission gate");

const lock = acquireOwnerLock(repo, "bot");
let secondOwnerRejected = false;
try { acquireOwnerLock(repo, "bot"); } catch { secondOwnerRejected = true; }
lock.release();
const replacement = acquireOwnerLock(repo, "bot");
replacement.release();
if (secondOwnerRejected) console.log("PASS: owner lock rejects a second live local process and releases cleanly");
else console.log("FAIL: owner lock exclusivity");
writeFileSync(lock.path, JSON.stringify({ pid: 999999, hostname: hostname(), token: "stale", botLogin: "bot", startedAt: new Date(0).toISOString() }));
const reclaimed = acquireOwnerLock(repo, "bot");
reclaimed.release();
console.log("PASS: owner lock reclaims a dead same-host process");
writeFileSync(lock.path, JSON.stringify({ pid: 999999, hostname: "another-host", token: "foreign", botLogin: "bot", startedAt: new Date(0).toISOString() }));
let foreignOwnerRejected = false;
try { acquireOwnerLock(repo, "bot"); } catch { foreignOwnerRejected = true; }
rmSync(lock.path, { force: true });
if (foreignOwnerRejected) console.log("PASS: owner lock fails closed for a different hostname");
else console.log("FAIL: cross-host owner lock");
