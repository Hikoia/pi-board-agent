import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  UsageLimitScheduler,
  WorkflowManager,
  createRunPersistence,
  type PersistedRunState,
  type WorkflowManagerOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import { setTimeout as delay } from "node:timers/promises";
import {
  LegacyTickets,
  conflictRequestKey,
  type ConflictBoardOps,
  type RepairBlocker,
  type LegacyMigrationReport,
} from "./legacy-tickets.js";
import type { OwnerLock } from "./owner-lock.js";
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import { normalizeWaveResults, type WaveOutcome } from "./dispatch.js";
import {
  createComment,
  getCard,
  isTargetIssue,
  listIssueComments,
  release,
  resolveIssueId,
  setStatus,
  tryClaim,
  updateIssueComment,
  reopenIssue,
  type Card,
  type ProjectMetadata,
} from "./gh.js";
import {
  MergeConflictError,
  TicketWorktrees,
  type TicketExecutionRecord,
  type TicketWorktreeRecord,
} from "./ticket-worktree.js";
import { buildTasksForWave, renderWorkflowSource } from "./workflow-prompt.js";
import {
  isRepairRequest,
  repairReviewInput,
  type RepairRequest,
  type RepairReview,
} from "./repair.js";

export type ExecutorStatusCallback = (
  message: string,
  level?: "info" | "warn" | "error",
) => void;

export interface ActiveTicketRun {
  itemId: string;
  taskKey: string;
  runId: string;
  status: string;
  worktree: string;
}

export interface ReconcileSummary {
  active: ActiveTicketRun[];
  resumed: number;
  adopted: number;
  needsHuman: number;
  orphans: number;
  errors: number;
  repairBlockers?: Array<RepairBlocker & { itemId: string }>;
}

export type LaunchResult =
  | { status: "launched"; runId: string; worktree: string }
  | { status: "skipped"; reason: string }
  | { status: "needs-human"; reason: string };

export type FinalizeOutcome =
  | { status: "finalized"; resultSha: string }
  | { status: "conflict"; baseSha: string; taskSha: string; reason: string }
  | { status: "skipped"; reason: string; repair?: RepairRequest }
  | RepairBlocker;

export interface TicketExecutor {
  /** Display only. Never used to authorize launches, recovery or capacity. */
  readonly observation?: {
    active: readonly ActiveTicketRun[];
    occupiedSlots: number;
  };
  reconcile(
    cards: Card[],
    canStartWork?: () => boolean | Promise<boolean>,
    canStartWorkNow?: () => boolean,
  ): Promise<ReconcileSummary>;
  migrateLegacy?(owner: OwnerLock, canMigrate?: () => boolean): Promise<LegacyMigrationReport>;
  /** Migration failures are isolated from all model/board mutations. */
  legacyBlocked?(itemId: string): string | undefined;
  repairFor?(card: Card): Promise<RepairRequest | RepairBlocker | undefined>;
  repairForReview?(
    record: TicketExecutionRecord,
    card: Card,
  ): Promise<RepairReview | RepairBlocker | undefined>;
  /** Observe revision before the final card await, then check local admission
   * synchronously at start. The prepared launch already owns its worker slot. */
  launch(
    card: Card,
    planSlug: string,
    canStartWork?: () => boolean | Promise<boolean>,
    canStartWorkNow?: () => boolean,
    repair?: RepairRequest,
  ): Promise<LaunchResult>;
  finalizeClosed(
    card: Card,
    canStartWork?: () => boolean | Promise<boolean>,
    canStartWorkNow?: () => boolean,
  ): Promise<FinalizeOutcome>;
  activeCount(): number;
  /** Close launches/recovery immediately, before BoardLoop waits for its tick. */
  stopScheduling?(): void;
  shutdown(): Promise<void>;
}

export interface TicketBoardAdapter {
  conflict?: ConflictBoardOps;
  getCard(itemId: string): Promise<Card | undefined>;
  setStatus(itemId: string, status: string): Promise<void>;
  claim(card: Card): Promise<boolean>;
  release(card: Card): Promise<void>;
  listComments(card: Card): Promise<string[]>;
  comment(card: Card, body: string): Promise<void>;
}

export interface TicketWorkflowManager {
  start(
    script: string,
    args: {
      itemId: string;
      issueNumber: number;
      taskKey: string;
      repair?: RepairRequest;
    },
    options: {
      maxAgents: number;
      concurrency: number;
      agentRetries: number;
      agentTimeoutMs?: number;
    },
  ): string;
  list(): PersistedRunState[];
  resume(runId: string): Promise<boolean>;
  /** Fresh host authority after drain, plus a synchronous actual-resume check. */
  setResumeGuard?(
    authorize: (runId: string) => Promise<(() => boolean) | undefined>,
  ): void;
  pauseAndWait(runId: string): Promise<void>;
  stopAndWait(runId: string): Promise<void>;
  /** Arm existing automatic recovery only after fresh host authorization. */
  startScheduling?(): void;
  /** Disable auto-resume without discarding a manager still needing drain. */
  stopScheduling?(): void;
  dispose(): void;
}

export interface TicketExecutorDeps {
  cwd: string;
  cfg: Config;
  botLogin: string;
  repoOwner: string;
  repoName: string;
  board: TicketBoardAdapter;
  callback: ExecutorStatusCallback;
  worktrees: TicketWorktrees;
  createManager(worktree: string): TicketWorkflowManager;
  context?(record: TicketExecutionRecord): Promise<string | undefined>;
}

function statusIs(card: Card, value: string): boolean {
  return (card.status ?? "").toLowerCase() === value.toLowerCase();
}

function runArgsMatch(
  run: PersistedRunState,
  record: TicketWorktreeRecord,
): boolean {
  if (!run.args || typeof run.args !== "object") return false;
  const args = run.args as Record<string, unknown>;
  return (
    args.itemId === record.itemId &&
    args.taskKey === record.taskKey &&
    args.issueNumber === record.issueNumber &&
    (!Object.hasOwn(args, "repair") || isRepairRequest(args.repair))
  );
}

function marker(runId: string, outcome: string): string {
  return `<!-- board-agent-run:${runId}:${outcome} -->`;
}

function completedAgentTimeoutReason(
  run: PersistedRunState,
): string | undefined {
  const agents: unknown = run.agents;
  if (!Array.isArray(agents)) return undefined;

  for (const value of agents) {
    if (!value || typeof value !== "object") continue;
    const agent = value as Record<string, unknown>;
    if (agent.status !== "error" || agent.errorCode !== "AGENT_TIMEOUT")
      continue;

    const timeoutMs: unknown = run.agentTimeoutMs;
    return typeof timeoutMs === "number" &&
      Number.isFinite(timeoutMs) &&
      Number.isInteger(timeoutMs) &&
      timeoutMs > 0
      ? `Builder agent timed out after ${timeoutMs} ms.`
      : "Builder agent timed out.";
  }
  return undefined;
}

function renderNeedsHumanComment(
  reason: string,
  details?: WaveOutcome,
): string {
  const problem =
    reason.trim() || "Automation reported an unspecified blocker.";
  const attempted =
    details?.attempted?.trim() ||
    "Board Agent preserved the current state and stopped instead of guessing.";
  const limitations =
    details?.limitations?.trim() ||
    "Automation cannot safely continue until the blocker above is resolved.";
  const workaround =
    details?.workaround?.trim() ||
    "Inspect the task branch/worktree if present, preserve useful changes, and address the reported blocker before retrying.";
  const humanAction =
    details?.humanAction?.trim() ||
    "Reply with the missing decision or describe the manual fix.";
  return [
    "## ⚠️ Needs human input",
    "",
    "**Problem**",
    problem,
    "",
    "**Attempted**",
    attempted,
    "",
    "**Limitation**",
    limitations,
    "",
    "**Workaround**",
    workaround,
    "",
    "**Human input needed**",
    humanAction,
    "",
    "**Resume**",
    "After resolving the blocker, manually move this Project card to `Ready`. The next builder run will read trusted maintainer comments and continue.",
  ].join("\n");
}

export function createWorkflowManagerAdapter(options: {
  cwd: string;
  modelRegistry?: ModelRegistry;
  mainModel?: string;
  sessionId?: string;
  defaultAgentTimeoutMs?: number;
  defaultAgentRetries: number;
  callback: ExecutorStatusCallback;
  agent?: WorkflowManagerOptions["agent"];
  /** Production cold reads/capacity must not arm usage-limit recovery. */
  deferScheduling?: boolean;
}): TicketWorkflowManager {
  const manager = new WorkflowManager({
    cwd: options.cwd,
    concurrency: 1,
    modelRegistry: options.modelRegistry,
    mainModel: options.mainModel,
    sessionId: options.sessionId,
    defaultAgentTimeoutMs: options.defaultAgentTimeoutMs,
    defaultAgentRetries: options.defaultAgentRetries,
    agent: options.agent,
  });
  const onError = (event: any) =>
    options.callback(
      `Workflow ${event?.runId ?? "unknown"} failed: ${event?.error?.message ?? event?.message ?? "unknown error"}`,
      "warn",
    );
  manager.on("error", onError);
  let stopping = false,
    disposed = false;
  let authorizeResume:
    | ((runId: string) => Promise<(() => boolean) | undefined>)
    | undefined;
  const resumeChecks = new Map<string, () => boolean>();
  let scheduler: UsageLimitScheduler | undefined;
  const startScheduling = () => {
    if (stopping || scheduler) return;
    // The scheduler owns the SAME backoff/timers/persistence, but never gets a
    // raw resume path around the host's repair authorization.
    scheduler = new UsageLimitScheduler(
      {
        on: manager.on.bind(manager),
        off: manager.off.bind(manager),
        listAllRuns: () => manager.listAllRuns(),
        getPersistence: () => manager.getPersistence(),
        resume,
      },
      {
        onDiagnostic: (message) =>
          options.callback(`Workflow scheduler: ${message}`, "warn"),
      },
    );
  };

  // Upstream emits synchronously before executeRun, after its settlement await.
  // Revoke an already-admitted resume if stop/revision/local authority changed.
  const onResumed = ({ runId }: { runId: string }) => {
    if (stopping || (authorizeResume && !resumeChecks.get(runId)?.()))
      manager.pause(runId);
  };
  manager.on("resumed", onResumed);

  const waitForSettlement = async (runId: string) => {
    while (manager.getRun(runId)?.lease) await delay(25);
  };
  async function resume(runId: string): Promise<boolean> {
    if (
      stopping ||
      resumeChecks.has(runId) ||
      manager.getRun(runId)?.status === "running"
    )
      return false;
    // A paused status can precede cooperative teardown by arbitrarily long.
    // Never carry remote permission across that wait.
    await waitForSettlement(runId);
    const canNow = authorizeResume ? await authorizeResume(runId) : () => true;
    if (stopping || !canNow?.() || resumeChecks.has(runId)) return false;
    startScheduling();
    resumeChecks.set(runId, canNow);
    try {
      return (await manager.resume(runId)) && !stopping && canNow();
    } finally {
      resumeChecks.delete(runId);
      if (disposed && !resumeChecks.size) manager.off("resumed", onResumed);
    }
  }
  if (!options.deferScheduling) startScheduling();

  return {
    start(script, args, exec) {
      if (stopping) throw new Error("Workflow manager is stopping.");
      startScheduling();
      const started = manager.startInBackground(script, args, {
        maxAgents: exec.maxAgents,
        concurrency: exec.concurrency,
        agentRetries: exec.agentRetries,
        ...(exec.agentTimeoutMs === undefined
          ? {}
          : { agentTimeoutMs: exec.agentTimeoutMs }),
      });
      void started.promise.catch(() => undefined);
      return started.runId;
    },
    list: () => manager.listAllRuns(),
    startScheduling,
    resume,
    setResumeGuard: (guard) => {
      authorizeResume = guard;
    },
    async pauseAndWait(runId) {
      manager.pause(runId);
      await waitForSettlement(runId);
    },
    async stopAndWait(runId) {
      // 3.10.0 stop() releases its lease immediately; pause() retains it until
      // runWorkflow's cooperative drain finishes. Drain before terminal stop.
      manager.pause(runId);
      await waitForSettlement(runId);
      manager.stop(runId);
    },
    stopScheduling() {
      stopping = true;
      scheduler?.dispose();
    },
    dispose() {
      this.stopScheduling!();
      disposed = true;
      manager.off("error", onError);
      if (!resumeChecks.size) manager.off("resumed", onResumed);
    },
  };
}

export class ManagedTicketExecutor implements TicketExecutor {
  private readonly managers = new Map<string, TicketWorkflowManager>();
  private stopping = false;
  private resumeRevision = 0;
  private canResume: () => boolean | Promise<boolean> = () => true;
  private canResumeNow: () => boolean = () => true;
  observation: NonNullable<TicketExecutor["observation"]> = {
    active: [],
    occupiedSlots: 0,
  };

  private readonly conflicts: LegacyTickets;
  constructor(private readonly deps: TicketExecutorDeps) {
    this.conflicts = new LegacyTickets(deps);
  }

  migrateLegacy(owner: OwnerLock, canMigrate?: () => boolean) {
    return this.conflicts.migrate(owner, canMigrate);
  }

  legacyBlocked(itemId: string): string | undefined {
    return this.conflicts.blockedReason(itemId);
  }

  repairFor(card: Card): Promise<RepairRequest | RepairBlocker | undefined> {
    return this.conflicts.repairFor(card);
  }

  async repairForReview(
    record: TicketExecutionRecord,
    card: Card,
  ): Promise<RepairReview | RepairBlocker | undefined> {
    const required = this.conflicts.requestForRun(record, record.lastRunId);
    // Unknown/rejected authority throws, never authorizes a quarantine write.
    if (!(await this.conflicts.executionCard(record, card, record.lastRunId)))
      throw new Error("Repair Review lost its fresh card/claim authority.");
    try {
      const run = record.lastRunId
        ? createRunPersistence(record.path).load(record.lastRunId)
        : null;
      if (
        required &&
        (!run ||
          run.runId !== record.lastRunId ||
          !runArgsMatch(run, record) ||
          !this.conflicts.matches(record, run.args, run.runId))
      )
        throw new Error(
          "Bound repair Review run is missing or its exact arguments changed.",
        );
      const repair = run ? repairReviewInput(run) : undefined;
      if (required && !repair)
        throw new Error("Bound repair Review evidence is missing.");
      if (
        repair &&
        (!runArgsMatch(run!, record) ||
          !this.conflicts.matches(record, run!.args, run!.runId))
      )
        throw new Error("Repair Review run does not match the ticket record.");
      return repair;
    } catch (error) {
      if (!required) throw error;
      return {
        status: "blocked",
        repair: required,
        reason: `Repair Review evidence invalid: ${String(error)}`,
      };
    }
  }

  private manager(path: string): TicketWorkflowManager {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    let manager = this.managers.get(key);
    if (!manager) {
      if (this.stopping) throw new Error("Executor is stopping.");
      manager = this.deps.createManager(path);
      manager.setResumeGuard?.((runId) => this.resumeAuthority(path, runId));
      this.managers.set(key, manager);
    }
    return manager;
  }

  private async resumeAuthority(
    path: string,
    runId: string,
  ): Promise<(() => boolean) | undefined> {
    try {
      const revision = this.resumeRevision;
      const record = this.deps.worktrees
        .list()
        .find((r) => r.path === path && r.activeRunId === runId);
      if (!record || this.stopping) return undefined;
      const manager = this.manager(path);
      const run = manager.list().find((r) => r.runId === runId);
      const required = this.conflicts.requestForRun(record, runId);
      if (!required && !(run?.args as { repair?: unknown } | undefined)?.repair)
        return () => !this.stopping; // ordinary usage-limit handling is unchanged
      if (
        !run ||
        !runArgsMatch(run, record) ||
        !this.conflicts.matches(record, run.args, runId) ||
        !(await this.canResume())
      )
        return undefined;
      const card = await this.deps.board.getCard(record.itemId);
      if (
        !card ||
        !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") ||
        card.closed ||
        !statusIs(card, this.deps.cfg.columns.building) ||
        card.number !== record.issueNumber ||
        !card.plan ||
        planSlug(card.plan) !== record.plan ||
        card.assignees.length !== 1 ||
        card.assignees[0].toLowerCase() !== this.deps.botLogin.toLowerCase() ||
        !(await this.conflicts.executionCard(record, card))
      )
        return undefined;
      const canNow = () => {
        try {
          if (
            this.stopping ||
            revision !== this.resumeRevision ||
            !this.canResumeNow() ||
            JSON.stringify(this.deps.worktrees.read(record.itemId)) !==
              JSON.stringify(record) ||
            this.deps.worktrees.hasCleanupReceipt(record.itemId) ||
            !this.deps.worktrees.check(record, false).ok
          )
            return false;
          const current = manager.list().find((r) => r.runId === runId);
          return (
            !!current &&
            runArgsMatch(current, record) &&
            this.conflicts.matches(record, current.args, runId)
          );
        } catch {
          return false;
        } // the synchronous resumed veto must never throw before pause()
      };
      return canNow() ? canNow : undefined;
    } catch (error) {
      this.deps.callback(
        `Repair resume ${runId} blocked: ${String(error)}`,
        "warn",
      );
      return undefined;
    }
  }

  private async commentOnce(
    card: Card,
    uniqueMarker: string,
    body: string,
    guard?: () => Promise<void>,
    record?: TicketExecutionRecord,
  ): Promise<void> {
    if (
      record &&
      (await this.conflicts.terminalNotice(
        record,
        card,
        `${uniqueMarker}\n${body}`,
      ))
    )
      return;
    const comments = await this.deps.board.listComments(card);
    if (!comments.some((comment) => comment.includes(uniqueMarker))) {
      await guard?.();
      await this.deps.board.comment(card, `${uniqueMarker}\n${body}`);
    }
  }

  private async quarantineWithoutRecord(
    card: Card,
    reason: string,
  ): Promise<LaunchResult> {
    const current = await this.currentLaunchCard(
      undefined,
      card,
      this.deps.cfg.columns.ready,
    );
    if (!current)
      return { status: "skipped", reason: "card changed during preparation" };
    card = current;
    const uniqueMarker = `<!-- board-agent-recovery:${card.itemId}:worktree -->`;
    try {
      await this.commentOnce(
        card,
        uniqueMarker,
        renderNeedsHumanComment(reason),
      );
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.needs_human,
      );
      card.status = this.deps.cfg.columns.needs_human;
      this.deps.callback(
        `"${card.title}" → ${this.deps.cfg.columns.needs_human}: ${reason}`,
        "warn",
      );
    } finally {
      await this.deps.board.release(card);
    }
    return { status: "needs-human", reason };
  }

  private async moveToNeedsHuman(
    record: TicketWorktreeRecord,
    card: Card,
    reason: string,
    runId?: string,
    markerOutcome = "needs-human",
    details?: WaveOutcome,
  ): Promise<void> {
    let uniqueMarker: string;
    if (runId) {
      uniqueMarker = marker(runId, markerOutcome);
    } else {
      const incident =
        record.lastRunId ?? record.launchingAt ?? record.createdAt;
      uniqueMarker = `<!-- board-agent-recovery:${record.itemId}:${incident}:${markerOutcome} -->`;
    }
    await this.commentOnce(
      card,
      uniqueMarker,
      renderNeedsHumanComment(reason, details),
      () => this.conflicts.assertSettlement(record, card),
      record,
    );
    await this.conflicts.assertSettlement(record, card);
    if (!statusIs(card, this.deps.cfg.columns.needs_human)) {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.needs_human,
      );
      card.status = this.deps.cfg.columns.needs_human;
    }
    await this.conflicts.assertSettlement(record, card);
    await this.deps.board.release(card);
    this.conflicts.abandon(record);
    this.deps.worktrees.clearExecution(record.itemId, runId);
    this.deps.callback(
      `"${card.title}" → ${this.deps.cfg.columns.needs_human}: ${reason}`,
      "warn",
    );
  }

  private async complete(
    record: TicketExecutionRecord,
    card: Card,
    runId: string,
    outcome: WaveOutcome,
  ): Promise<void> {
    const uniqueMarker = marker(runId, "success");
    await this.commentOnce(
      card,
      uniqueMarker,
      `✅ Builder completed on \`${outcome.branch ?? record.taskBranch}\`.\n\n${outcome.summary ?? "Ready for review."}`,
      () => this.conflicts.assertSettlement(record, card),
      record,
    );
    await this.conflicts.assertSettlement(record, card);
    if (!statusIs(card, this.deps.cfg.columns.review)) {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.review,
      );
      card.status = this.deps.cfg.columns.review;
    }
    await this.conflicts.assertSettlement(record, card);
    await this.deps.board.release(card);
    this.deps.worktrees.clearExecution(record.itemId, runId);
    this.deps.callback(
      `"${card.title}" succeeded → ${this.deps.cfg.columns.review}. Worktree: ${record.path}`,
    );
  }

  private matchingLaunchRuns(
    record: TicketExecutionRecord,
    manager: TicketWorkflowManager,
  ): PersistedRunState[] {
    const cutoff = (record.launchingAt ?? 0) - 1000;
    return manager
      .list()
      .filter(
        (run) =>
          run.runId !== record.lastRunId &&
          runArgsMatch(run, record) &&
          this.conflicts.matches(record, run.args, run.runId) &&
          new Date(run.startedAt).getTime() >= cutoff,
      );
  }

  private async recoverLaunching(
    record: TicketExecutionRecord,
    card: Card,
    summary: ReconcileSummary,
  ): Promise<TicketExecutionRecord | undefined> {
    if (record.schemaVersion === 4) {
      const adopted = this.conflicts.observeLaunch(record);
      if (adopted) summary.adopted++;
      else this.deps.callback(`Retained uncertain legacy launch for ${record.itemId}; re-observing without a new builder.`, "warn");
      return adopted;
    }
    let manager: TicketWorkflowManager;
    try {
      manager = this.manager(record.path);
    } catch (error: any) {
      await this.moveToNeedsHuman(
        record,
        card,
        `cannot open persisted workflow state: ${error.message}`,
      );
      summary.needsHuman++;
      return undefined;
    }
    const matches = this.matchingLaunchRuns(record, manager);
    if (matches.length === 1) {
      const run = matches[0];
      const adopted = this.deps.worktrees.setActiveRun(
        record.itemId,
        run.runId,
        new Date(run.startedAt).getTime(),
      );
      this.conflicts.bind(adopted, run.runId, run.args);
      summary.adopted++;
      this.deps.callback(
        `Adopted persisted run ${run.runId} for "${card.title}".`,
      );
      return adopted;
    }
    if (matches.length > 1) {
      await this.moveToNeedsHuman(
        record,
        card,
        "multiple persisted runs match the interrupted launch",
      );
      summary.needsHuman++;
      return undefined;
    }

    let check = this.deps.worktrees.check(record, true);
    const delta = check.ok
      ? await this.deps.worktrees.hasTaskDelta(record)
      : true;
    const current = await this.currentLaunchCard(record, card, card.status);
    if (!current) return undefined;
    card = current;
    // Delta fetch and the fresh card read both yield. Recheck local safety last.
    check = this.deps.worktrees.check(record, true);
    if (check.ok && !delta && !this.deps.worktrees.hasLocalTaskDelta(record)) {
      if (statusIs(card, this.deps.cfg.columns.building)) {
        await this.deps.board.setStatus(
          card.itemId,
          this.deps.cfg.columns.ready,
        );
        card.status = this.deps.cfg.columns.ready;
      }
      await this.deps.board.release(card);
      this.deps.worktrees.clearExecution(record.itemId);
      this.deps.callback(
        `Interrupted launch for "${card.title}" had no side effects; returned to ${this.deps.cfg.columns.ready}.`,
        "warn",
      );
      return undefined;
    }

    await this.moveToNeedsHuman(
      record,
      card,
      check.reason ?? "task branch changed before a run could be identified",
    );
    summary.needsHuman++;
    return undefined;
  }

  private async stopForManualState(
    record: TicketExecutionRecord,
    card: Card,
    manager: TicketWorkflowManager,
  ): Promise<void> {
    const runs = record.activeRunId
      ? manager
          .list()
          .filter(
            (run) =>
              run.runId === record.activeRunId && runArgsMatch(run, record),
          )
      : this.matchingLaunchRuns(record, manager);
    for (const run of runs) await manager.stopAndWait(run.runId);
    if (statusIs(card, this.deps.cfg.columns.ready)) {
      const check = this.deps.worktrees.check(record, true);
      if (!check.ok) {
        await this.moveToNeedsHuman(
          record,
          card,
          `manual retry is unsafe: ${check.reason}`,
          record.activeRunId,
          "manual-dirty",
        );
        return;
      }
    }
    await this.deps.board.release(card);
    this.deps.worktrees.clearExecution(
      record.itemId,
      record.activeRunId ?? (runs.length === 1 ? runs[0].runId : undefined),
    );
    this.deps.callback(
      `Stopped stale execution ${record.activeRunId ?? record.itemId}; preserved manual status ${card.status ?? "unknown"}.`,
      "warn",
    );
  }

  private async reconcileActive(
    record: TicketExecutionRecord,
    card: Card,
    summary: ReconcileSummary,
  ): Promise<void> {
    let manager: TicketWorkflowManager;
    try {
      manager = this.manager(record.path);
    } catch (error: any) {
      if (record.schemaVersion === 4) throw error; // retain the original run for re-observation
      await this.moveToNeedsHuman(
        record,
        card,
        `cannot open workflow manager: ${error.message}`,
        record.activeRunId,
        "manager-error",
      );
      summary.needsHuman++;
      return;
    }

    const run = manager
      .list()
      .find((candidate) => candidate.runId === record.activeRunId);
    if (
      !run ||
      !runArgsMatch(run, record) ||
      !this.conflicts.matches(record, run.args)
    ) {
      if (record.schemaVersion === 4)
        throw new Error("Original migrated workflow is missing/mismatched; retained for re-observation.");
      await this.moveToNeedsHuman(
        record,
        card,
        run
          ? "workflow arguments do not match the ticket record"
          : "persisted workflow run is missing",
        record.activeRunId,
        "missing",
      );
      summary.needsHuman++;
      return;
    }

    const authorized = await this.conflicts.executionCard(record, card);
    if (!authorized) {
      await this.stopMissingCardRun(record, summary);
      return;
    }
    card = authorized;
    this.conflicts.bind(record, run.runId, run.args);
    const completedOutcomes =
      run.status === "completed" ? normalizeWaveResults(run.result) : [];
    const completedOutcome =
      completedOutcomes.length === 1
        ? {
            ...completedOutcomes[0],
            taskKey: record.taskKey,
            itemId: record.itemId,
          }
        : undefined;
    const structural = this.deps.worktrees.check(record, false);
    const planMatches = !!card.plan && planSlug(card.plan) === record.plan;
    if (
      !structural.ok ||
      !planMatches ||
      (record.issueNumber > 0 && card.number !== record.issueNumber)
    ) {
      const failure =
        completedOutcome?.status === "failure" ? completedOutcome : undefined;
      const mismatchReason =
        structural.reason ?? "ticket Plan or issue identity changed";
      await manager.stopAndWait(run.runId);
      await this.moveToNeedsHuman(
        record,
        card,
        failure
          ? `${failure.error ?? "builder reported failure"} Additional safety issue: ${mismatchReason}`
          : mismatchReason,
        run.runId,
        failure ? "failure" : "mismatch",
        failure,
      );
      summary.needsHuman++;
      return;
    }

    if (!statusIs(card, this.deps.cfg.columns.building)) {
      await this.stopForManualState(record, card, manager);
      return;
    }

    manager.startScheduling?.();
    if (run.status === "running" || run.status === "pending") {
      summary.active.push({
        itemId: record.itemId,
        taskKey: record.taskKey,
        runId: run.runId,
        status: run.status,
        worktree: record.path,
      });
      return;
    }

    if (run.status === "paused") {
      if (this.stopping) return;
      if (run.pauseReason === "usage_limit") {
        summary.active.push({
          itemId: record.itemId,
          taskKey: record.taskKey,
          runId: run.runId,
          status: run.status,
          worktree: record.path,
        });
        return;
      }
      if (await manager.resume(run.runId)) {
        summary.resumed++;
        summary.active.push({
          itemId: record.itemId,
          taskKey: record.taskKey,
          runId: run.runId,
          status: "running",
          worktree: record.path,
        });
        this.deps.callback(`Resumed ${run.runId} for "${card.title}".`);
        return;
      }
      // A denied repair resume preserves its slot and persistent run. Only a
      // freshly authorized structural resume failure may be quarantined.
      if (!(await this.resumeAuthority(record.path, run.runId))) return;
      const raced = manager
        .list()
        .find((candidate) => candidate.runId === run.runId);
      if (raced?.status === "running") {
        summary.active.push({
          itemId: record.itemId,
          taskKey: record.taskKey,
          runId: run.runId,
          status: "running",
          worktree: record.path,
        });
        return;
      }
      if (record.schemaVersion === 4) return; // no replacement builder on an uncertain resume
      await this.moveToNeedsHuman(
        record,
        card,
        "paused workflow could not be resumed",
        run.runId,
        "resume-failed",
      );
      summary.needsHuman++;
      return;
    }

    if (run.status === "completed") {
      const outcome = completedOutcome;
      if (!outcome) {
        await this.moveToNeedsHuman(
          record,
          card,
          completedAgentTimeoutReason(run) ??
            "persisted builder result is malformed",
          run.runId,
          "malformed",
        );
        summary.needsHuman++;
        return;
      }
      if (outcome.status === "failure") {
        await this.moveToNeedsHuman(
          record,
          card,
          outcome.error ?? "builder reported failure",
          run.runId,
          "failure",
          outcome,
        );
        summary.needsHuman++;
        return;
      }
      const check = this.deps.worktrees.check(record, true);
      if (!check.ok || outcome.branch !== record.taskBranch) {
        await this.moveToNeedsHuman(
          record,
          card,
          check.ok
            ? "persisted builder result is malformed"
            : (check.reason ?? "completed worktree is unsafe"),
          run.runId,
          "malformed",
        );
        summary.needsHuman++;
        return;
      }
      if ((run.args as { repair?: unknown }).repair !== undefined) {
        let reason: string | undefined;
        const repair = (run.args as { repair: RepairRequest }).repair;
        let resultSha: string | undefined;
        try {
          resultSha = repairReviewInput(run)!.testEvidence.resultSha;
          await this.deps.worktrees.verifyRepairResult(
            record,
            repair,
            resultSha,
          );
        } catch (error) {
          reason = `Repair verification failed: ${String(error)}`;
        }
        // The remote Git check yields. Never settle against stale ownership,
        // requirements, execution identity or a later human lane.
        const current = await this.currentLaunchCard(record, card);
        if (!current) return;
        card = current;
        if (!reason) {
          try {
            this.deps.worktrees.checkRepairResult(record, repair, resultSha!);
          } catch (error) {
            reason = `Repair verification failed: ${String(error)}`;
          }
        }
        if (reason) {
          await this.moveToNeedsHuman(
            record,
            card,
            reason,
            run.runId,
            "repair-verification",
          );
          summary.needsHuman++;
          return;
        }
      }
      await this.complete(record, card, run.runId, outcome);
      return;
    }

    await this.moveToNeedsHuman(
      record,
      card,
      run.error ?? `workflow ended as ${run.status}`,
      run.runId,
      run.status,
    );
    summary.needsHuman++;
  }

  private async stopMissingCardRun(
    record: TicketExecutionRecord,
    summary: ReconcileSummary,
  ): Promise<void> {
    const manager = this.manager(record.path);
    const runs = record.activeRunId
      ? manager.list().filter((run) => run.runId === record.activeRunId)
      : this.matchingLaunchRuns(record, manager);
    for (const run of runs) {
      if (
        run.status === "pending" ||
        run.status === "running" ||
        run.status === "paused"
      ) {
        await manager.stopAndWait(run.runId);
      }
    }
    this.deps.worktrees.clearExecution(
      record.itemId,
      record.activeRunId ?? (runs.length === 1 ? runs[0].runId : undefined),
    );
    this.conflicts.abandon(record);
    summary.orphans++;
    this.deps.callback(
      `Stopped orphaned ticket run ${record.activeRunId ?? record.itemId}; its Project item is gone or no longer matches the ticket and worktree was preserved.`,
      "warn",
    );
  }

  async reconcile(
    cards: Card[],
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true,
  ): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      active: [],
      resumed: 0,
      adopted: 0,
      needsHuman: 0,
      orphans: 0,
      errors: 0,
    };
    if (this.stopping) return summary;
    this.canResume = canStartWork;
    this.canResumeNow = canStartWorkNow;
    this.resumeRevision++;
    for (const card of cards) {
      if (this.legacyBlocked(card.itemId) && !this.conflicts.pendingDesign.has(card.itemId)) continue;
      try { await this.conflicts.mapDesign(card); }
      catch (error) {
        summary.errors++;
        this.deps.callback(`Legacy lane migration failed for ${card.itemId}: ${String(error)}`, "warn");
      }
    }
    const repairBlockers = await this.conflicts.reconcile(
      async () => !this.stopping && (await canStartWork()),
      () => !this.stopping && canStartWorkNow(),
    );
    if (repairBlockers.length) summary.repairBlockers = repairBlockers;
    summary.errors += repairBlockers.length;
    const cardsById = new Map(cards.map((card) => [card.itemId, card]));
    const records = this.deps.worktrees.list();
    const recordIds = new Set(records.map((record) => record.itemId));

    for (const original of records) {
      if (this.stopping) break;
      if (this.legacyBlocked(original.itemId)) continue;
      const snapshot = cardsById.get(original.itemId);
      try {
        // A failed read preserves recovery evidence; confirmed absence or a
        // replacement target stops only the local run, never mutates a snapshot.
        const card = await this.deps.board.getCard(original.itemId);
        if (this.stopping) break;
        if (
          !card ||
          !isTargetIssue(
            card,
            this.deps.repoOwner,
            this.deps.repoName,
            "Task",
          ) ||
          card.itemId !== original.itemId ||
          card.number !== original.issueNumber
        ) {
          if (original.activeRunId || original.launchingAt !== undefined)
            await this.stopMissingCardRun(original, summary);
          continue;
        }
        if (snapshot) {
          snapshot.status = card.status;
          snapshot.plan = card.plan;
          snapshot.assignees = card.assignees;
          snapshot.closed = card.closed;
        }

        // A valid finalization journal owns the ticket until cleanup finishes.
        // Mixed execution/finalization files are unsupported, never migrated here.
        if (
          original.finalization || original.integration ||
          this.deps.worktrees.hasCleanupReceipt(original.itemId)
        )
          continue;

        let record: TicketExecutionRecord | undefined = original;
        const authorized = await this.conflicts.executionCard(record, card);
        if (!authorized) {
          await this.stopMissingCardRun(record, summary);
          continue;
        }
        if (this.conflicts.isUnstarted(record)) {
          await this.moveToNeedsHuman(
            record,
            authorized,
            "Consumed repair launch was interrupted before a persistent run existed.",
          );
          summary.needsHuman++;
          continue;
        }
        if (
          (record.activeRunId || record.launchingAt !== undefined) &&
          !statusIs(card, this.deps.cfg.columns.building) &&
          !statusIs(card, this.deps.cfg.columns.ready)
        ) {
          // Review/Needs Human may already have been written before release
          // failed. Preserve those (and later human states), even if the run or
          // worktree is now unreadable/mismatched. Only drain and release; Ready
          // retries still pass the existing structural/dirty recovery gates.
          await this.stopForManualState(
            record,
            card,
            this.manager(record.path),
          );
          continue;
        }
        if (record.launchingAt !== undefined && !record.activeRunId)
          record = await this.recoverLaunching(record, card, summary);
        if (record?.activeRunId)
          await this.reconcileActive(record, card, summary);
        else if (record && !record.retry && statusIs(card, this.deps.cfg.columns.building)) {
          await this.moveToNeedsHuman(
            record,
            card,
            "In Progress ticket has no active workflow run",
          );
          summary.needsHuman++;
        }
      } catch (error: any) {
        this.resumeRevision++; // revoke any resume admitted before this failed fresh read
        summary.errors++;
        // This idle handoff's blocker is already returned to the loop. Its
        // ordinary record read still runs, but must not emit a second wrapper.
        if (
          !repairBlockers.some((blocker) => blocker.itemId === original.itemId)
        )
          this.deps.callback(
            `Reconcile failed for ${original.itemId}: ${error.message}`,
            "warn",
          );
      }
    }

    for (const snapshot of cards) {
      if (this.stopping) break;
      if (
        !isTargetIssue(
          snapshot,
          this.deps.repoOwner,
          this.deps.repoName,
          "Task",
        ) ||
        !statusIs(snapshot, this.deps.cfg.columns.building) ||
        recordIds.has(snapshot.itemId) ||
        this.legacyBlocked(snapshot.itemId) ||
        this.deps.worktrees.hasCleanupReceipt(snapshot.itemId)
      )
        continue;
      try {
        const card = await this.deps.board.getCard(snapshot.itemId);
        if (this.stopping) break;
        if (
          !card ||
          !isTargetIssue(
            card,
            this.deps.repoOwner,
            this.deps.repoName,
            "Task",
          ) ||
          card.itemId !== snapshot.itemId ||
          card.number !== snapshot.number ||
          !statusIs(card, this.deps.cfg.columns.building)
        )
          continue;
        const uniqueMarker = `<!-- board-agent-orphan:${card.itemId} -->`;
        await this.commentOnce(
          card,
          uniqueMarker,
          "⚠️ This ticket is In Progress but has no execution record. It was quarantined without retrying.",
        );
        await this.deps.board.setStatus(
          card.itemId,
          this.deps.cfg.columns.needs_human,
        );
        card.status = this.deps.cfg.columns.needs_human;
        snapshot.status = card.status;
        await this.deps.board.release(card);
        summary.orphans++;
        summary.needsHuman++;
        this.deps.callback(
          `Orphaned ticket "${card.title}" → ${this.deps.cfg.columns.needs_human}.`,
          "warn",
        );
      } catch (error: any) {
        summary.errors++;
        this.deps.callback(
          `Orphan recovery failed for ${snapshot.itemId}: ${error.message}`,
          "warn",
        );
      }
    }

    this.activeCount();
    return summary;
  }

  private eligible(
    card: Card,
    expectedPlan: string,
    requireClaim = false,
  ): string | undefined {
    if (this.stopping) return "executor is stopping";
    if (!isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task"))
      return "card is not a Task Issue in the configured repository";
    if (card.closed) return "issue is closed";
    if (!statusIs(card, this.deps.cfg.columns.ready))
      return `status is ${card.status ?? "unset"}`;
    if (!card.plan || planSlug(card.plan) !== expectedPlan)
      return "Plan changed";
    if (card.assignees.some((assignee) => assignee !== this.deps.botLogin))
      return "another assignee is present";
    if (requireClaim && !card.assignees.includes(this.deps.botLogin))
      return "claim was not retained";
    const record = this.deps.worktrees.read(card.itemId);
    if (
      record?.finalization || record?.integration ||
      (record?.retry && record.retry.stage !== "build") ||
      this.deps.worktrees.hasCleanupReceipt(card.itemId)
    )
      return "ticket has a pending finalization; recover it before starting another builder";
    if (record && (record.activeRunId || record.launchingAt !== undefined))
      return "ticket already has an active run";
    return undefined;
  }

  /** Shared by preparation, actual invocation and failed/stopped cleanup. A
   * failed read/release throws before clearing any launch recovery evidence. */
  private async currentLaunchCard(
    record: TicketExecutionRecord | undefined,
    expected: Card,
    expectedStatus = this.deps.cfg.columns.building,
  ): Promise<Card | undefined> {
    const itemId = record?.itemId ?? expected.itemId;
    const issueNumber = record?.issueNumber ?? expected.number;
    const card = await this.deps.board.getCard(itemId);
    // Never settle a replaced/unreadable local association from the old record.
    // JSON persistence omits optional undefined fields on both sides.
    if (
      record &&
      JSON.stringify(this.deps.worktrees.read(itemId)) !==
        JSON.stringify(record)
    )
      throw new Error(
        `Ticket execution record changed during launch: ${itemId}`,
      );
    const sameTarget =
      card &&
      isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
      card.itemId === itemId &&
      card.number === issueNumber;
    if (
      sameTarget &&
      !card.closed &&
      statusIs(card, expectedStatus) &&
      card.plan === expected.plan &&
      card.title === expected.title &&
      card.body === expected.body &&
      card.assignees.includes(this.deps.botLogin) &&
      card.assignees.every((login) => login === this.deps.botLogin)
    )
      return card;

    // Only fresh identity/ownership can authorize releasing our claim. Never
    // restore Ready or post a blocker against a changed contract/human state.
    if (sameTarget && card.assignees.includes(this.deps.botLogin))
      await this.deps.board.release(card);
    // Failed ensure may have left partial/unreadable recovery artifacts. It
    // supplied no verified record, so even confirmed staleness cannot clear it.
    if (record) this.deps.worktrees.clearExecution(record.itemId);
    this.deps.callback(
      `Skipped stale launch for #${issueNumber}; preserved card status and worktree.` +
        (sameTarget
          ? ""
          : " Original issue claim requires manual verification/cleanup; no remote writes attempted."),
      "warn",
    );
    return undefined;
  }

  private async resetUnstarted(
    record: TicketExecutionRecord,
    expected: Card,
    reason: string,
  ): Promise<LaunchResult> {
    let card = await this.currentLaunchCard(record, expected);
    if (!card)
      return { status: "skipped", reason: "card changed before builder start" };
    let check = this.deps.worktrees.check(record, true);
    const delta = check.ok
      ? await this.deps.worktrees.hasTaskDelta(record)
      : true;
    card = await this.currentLaunchCard(record, expected);
    if (!card)
      return { status: "skipped", reason: "card changed during launch reset" };
    check = this.deps.worktrees.check(record, true);
    if (check.ok && !delta && !this.deps.worktrees.hasLocalTaskDelta(record)) {
      if (!statusIs(card, this.deps.cfg.columns.ready)) {
        await this.deps.board.setStatus(
          card.itemId,
          this.deps.cfg.columns.ready,
        );
        card.status = this.deps.cfg.columns.ready;
      }
      await this.deps.board.release(card);
      this.deps.worktrees.clearExecution(record.itemId);
      this.deps.callback(
        `Launch preparation failed for "${card.title}": ${reason}. Returned to ${this.deps.cfg.columns.ready}.`,
        "warn",
      );
      return { status: "skipped", reason };
    }
    await this.moveToNeedsHuman(record, card, reason);
    return { status: "needs-human", reason };
  }

  async launch(
    snapshot: Card,
    expectedPlan: string,
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true,
    repair?: RepairRequest,
  ): Promise<LaunchResult> {
    // Keep the designated input stable across preparation awaits.
    this.canResume = canStartWork;
    this.canResumeNow = canStartWorkNow;
    if (repair) repair = { ...repair };
    if (this.stopping)
      return { status: "skipped", reason: "executor is stopping" };
    let card = await this.deps.board.getCard(snapshot.itemId);
    if (!card) return { status: "skipped", reason: "card no longer exists" };
    if (card.itemId !== snapshot.itemId || card.number !== snapshot.number)
      return { status: "skipped", reason: "issue identity changed" };
    try {
      this.conflicts.assertLaunch(card.itemId, repair);
    } catch (error) {
      return { status: "skipped", reason: String(error) };
    }
    const preClaim = this.eligible(card, expectedPlan);
    if (preClaim) return { status: "skipped", reason: preClaim };

    if (!(await this.deps.board.claim(card)))
      return { status: "skipped", reason: "claim lost" };
    const claimed = card;
    card = await this.deps.board.getCard(snapshot.itemId);
    if (
      !card ||
      card.itemId !== snapshot.itemId ||
      card.number !== snapshot.number
    ) {
      await this.deps.board.release(claimed);
      return {
        status: "skipped",
        reason: "issue identity changed after claim",
      };
    }
    const postClaim = this.eligible(card, expectedPlan, true);
    if (postClaim) {
      await this.deps.board.release(card);
      return { status: "skipped", reason: postClaim };
    }

    const task = buildTasksForWave(this.deps.cfg, expectedPlan, [card])[0];

    let record: TicketExecutionRecord;
    try {
      if (
        repair !== undefined &&
        (!isRepairRequest(repair) || !this.deps.worktrees.read(task.itemId))
      )
        throw new Error(
          "Repair requires a valid request and the original ticket worktree record.",
        );
      record = await this.deps.worktrees.ensure(task, expectedPlan);
      if (repair) await this.deps.worktrees.prepareRepair(record, repair);
    } catch (error: any) {
      return this.quarantineWithoutRecord(
        card,
        `worktree preparation failed: ${error.message}`,
      );
    }
    // Fetch/worktree preparation now yields. Do not overwrite a human state
    // with In Progress before the later actual-start checkpoint can see it.
    const prepared = await this.currentLaunchCard(
      record,
      card,
      this.deps.cfg.columns.ready,
    );
    if (!prepared)
      return { status: "skipped", reason: "card changed during preparation" };
    card = prepared;
    // The persistent worktree belongs to the ticket, not to a previous run ID.
    const check = this.deps.worktrees.check(record, false);
    if (!check.ok) {
      await this.moveToNeedsHuman(
        record,
        card,
        check.reason ?? "worktree is unsafe",
      );
      return {
        status: "needs-human",
        reason: check.reason ?? "worktree is unsafe",
      };
    }

    if (repair) {
      try {
        await this.conflicts.consume(
          repair,
          async () => !this.stopping && (await canStartWork()),
          () => !this.stopping && canStartWorkNow(),
        );
      } catch (error) {
        return { status: "skipped", reason: String(error) };
      }
    }
    record = this.deps.worktrees.beginLaunch(record.itemId);
    this.activeCount();
    try {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.building,
      );
      card.status = this.deps.cfg.columns.building;
    } catch (error: any) {
      if (!repair) {
        await this.deps.board.release(card);
        this.deps.worktrees.clearExecution(record.itemId);
      }
      return {
        status: "skipped",
        reason: `could not move ticket to ${this.deps.cfg.columns.building}: ${error.message}`,
      };
    }

    let context: string | undefined;
    try {
      context = await this.deps.context?.(record);
    } catch (error: any) {
      this.deps.callback(`Context generation failed: ${error.message}`, "warn");
    }

    if (record.retry?.stage === "build")
      context = [context, record.retry.reason].filter(Boolean).join("\n\n");

    let script: string;
    try {
      script = renderWorkflowSource({
        cfg: this.deps.cfg,
        planSlug: expectedPlan,
        baseBranch: this.deps.cfg.branches.base,
        tasks: [{ ...task, baseBranch: record.baseBranch }],
        skillName: "board-agent",
        context,
        ...(repair ? { repair } : {}),
      });
    } catch (error: any) {
      return this.resetUnstarted(record, card, error.message);
    }

    let manager: TicketWorkflowManager;
    try {
      manager = this.manager(record.path);
    } catch (error: any) {
      return this.resetUnstarted(
        record,
        card,
        `workflow manager failed: ${error.message}`,
      );
    }
    // Keep the pre-observation gate: it rejects withdrawn work before revision
    // I/O, and preserves callers whose revision changes during this first read.
    const beforeRevision = await this.currentLaunchCard(record, card);
    if (!beforeRevision)
      return { status: "skipped", reason: "card changed before builder start" };
    const admission = await canStartWork();
    if (!(await this.conflicts.executionCard(record, beforeRevision)))
      return {
        status: "skipped",
        reason: "repair authorization changed before start",
      };
    const current = await this.currentLaunchCard(record, beforeRevision);
    if (!current)
      return { status: "skipped", reason: "card changed before builder start" };
    card = current;
    // No await after fresh remote authority: the local revision/admission latch
    // and stop may have changed during that read. Do not reserve a second slot.
    if (!admission || !canStartWorkNow() || this.stopping)
      return this.resetUnstarted(record, card, "builder admissions stopped");

    if (repair) {
      try {
        this.deps.worktrees.checkRepairStart(record, repair);
      } catch (error) {
        const reason = `Repair admission failed: ${String(error)}`;
        await this.moveToNeedsHuman(record, card, reason);
        return { status: "needs-human", reason };
      }
    }
    let runId: string;
    try {
      runId = manager.start(
        script,
        {
          itemId: record.itemId,
          issueNumber: record.issueNumber,
          taskKey: record.taskKey,
          ...(repair ? { repair } : {}),
        },
        {
          maxAgents: 1,
          concurrency: 1,
          agentRetries: this.deps.cfg.builder_retries,
          ...(this.deps.cfg.builder_timeout_ms === undefined
            ? {}
            : { agentTimeoutMs: this.deps.cfg.builder_timeout_ms }),
        },
      );
    } catch (error: any) {
      const matches = this.matchingLaunchRuns(record, manager);
      if (matches.length === 1) {
        runId = matches[0].runId;
      } else {
        return this.resetUnstarted(
          record,
          card,
          `workflow launch failed: ${error.message}`,
        );
      }
    }

    try {
      const active = this.deps.worktrees.setActiveRun(record.itemId, runId);
      this.conflicts.bind(active, runId, { repair });
    } catch (error: any) {
      this.deps.callback(
        `Run ${runId} persisted but its ticket record was not updated: ${error.message}`,
        "warn",
      );
    }
    this.activeCount();
    this.deps.callback(
      `Launched ${record.taskKey} as ${runId} in ${record.path}.`,
    );
    return { status: "launched", runId, worktree: record.path };
  }

  async finalizeClosed(
    snapshot: Card,
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true,
  ): Promise<FinalizeOutcome> {
    const blocked = this.legacyBlocked(snapshot.itemId);
    if (blocked) return { status: "blocked", reason: blocked };
    let card: Card | undefined;
    try {
      card = await this.deps.board.getCard(snapshot.itemId);
    } catch (error) {
      return {
        status: "blocked",
        reason: `fresh card read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!card) return { status: "skipped", reason: "card no longer exists" };
    if (!isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task"))
      return {
        status: "skipped",
        reason: "card is not a Task Issue in the configured repository",
      };
    if (card.itemId !== snapshot.itemId || card.number !== snapshot.number)
      return { status: "skipped", reason: "issue changed" };
    if (!card.closed || !statusIs(card, this.deps.cfg.columns.done))
      return {
        status: "skipped",
        reason: "ticket is no longer closed and Done",
      };

    try {
      const task = buildTasksForWave(this.deps.cfg, "", [card])[0];
      const resultSha = await this.deps.worktrees.finalizeAccepted(
        task,
        this.deps.cfg.task_merge_strategy,
      );
      if (!resultSha)
        return { status: "skipped", reason: "no local task branch" };
      this.deps.callback(
        `Finalized #${card.number} "${card.title}" at ${resultSha} in ${task.baseBranch}. Deleted local/remote branch ${task.taskBranch} and removed its worktree.`,
      );
      return { status: "finalized", resultSha };
    } catch (error) {
      if (error instanceof MergeConflictError) {
        if (this.deps.board.conflict) {
          const repair: RepairRequest = {
            requestKey: conflictRequestKey(
              card.itemId,
              error.baseSha,
              error.taskSha,
            ),
            baseSha: error.baseSha,
            taskSha: error.taskSha,
          };
          try {
            if (this.deps.worktrees.read(card.itemId)?.finalization) {
              await this.deps.worktrees.clearPrePushConflict(
                buildTasksForWave(this.deps.cfg, "", [card])[0],
                error,
                async () => {
                  if (this.stopping || !(await canStartWork()))
                    throw new Error("Repair admissions stopped.");
                  const fresh = await this.deps.board.getCard(card!.itemId);
                  if (
                    !fresh ||
                    JSON.stringify({
                      ...fresh,
                      assignees: [],
                      status: undefined,
                      closed: undefined,
                    }) !==
                      JSON.stringify({
                        ...card,
                        assignees: [],
                        status: undefined,
                        closed: undefined,
                      }) ||
                    !fresh.closed ||
                    !statusIs(fresh, this.deps.cfg.columns.done) ||
                    fresh.assignees.length > 1 ||
                    fresh.assignees.some(
                      (a) =>
                        a.toLowerCase() !== this.deps.botLogin.toLowerCase(),
                    ) ||
                    this.stopping ||
                    !canStartWorkNow()
                  )
                    throw new Error(
                      "Legacy repair approval/ownership changed.",
                    );
                },
              );
            }
            await this.conflicts.request(
              card,
              repair,
              async () => !this.stopping && (await canStartWork()),
              () => !this.stopping && canStartWorkNow(),
            );
            return {
              status: "skipped",
              repair,
              reason:
                "Conflict repair queued for the existing Ready scheduler.",
            };
          } catch (handoffError) {
            return {
              status: "blocked",
              repair,
              reason:
                handoffError instanceof Error
                  ? handoffError.message
                  : String(handoffError),
            };
          }
        }
        return {
          status: "conflict",
          baseSha: error.baseSha,
          taskSha: error.taskSha,
          reason: error.diagnostic,
        };
      }
      return {
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  activeCount(): number {
    let count = 0;
    const active: ActiveTicketRun[] = [];
    for (const record of this.deps.worktrees.list()) {
      let status: string;
      if (record.launchingAt !== undefined && !record.activeRunId) {
        status = "launching";
        count++;
      } else if (record.activeRunId) {
        try {
          const blocked = this.legacyBlocked(record.itemId);
          if (blocked) throw new Error(blocked);
          status =
            this.manager(record.path)
              .list()
              .find((candidate) => candidate.runId === record.activeRunId)
              ?.status ?? "missing";
        } catch {
          status = "unreadable";
        }
        if (
          ["missing", "unreadable", "pending", "running", "paused"].includes(
            status,
          )
        )
          count++;
      } else continue;
      active.push({
        itemId: record.itemId,
        taskKey: record.taskKey,
        runId: record.activeRunId ?? "launching",
        status,
        worktree: record.path,
      });
    }
    // Refresh UI from the live admission observation, never the reverse.
    this.observation = { active, occupiedSlots: count };
    return count;
  }

  stopScheduling(): void {
    this.stopping = true;
    for (const manager of this.managers.values()) manager.stopScheduling?.();
  }

  async shutdown(): Promise<void> {
    this.stopScheduling();
    const errors: string[] = [];
    for (const [path, manager] of this.managers) {
      const before = errors.length;
      try {
        for (const run of manager.list()) {
          // Paused is a request, not proof that the agent's finally settled.
          if (!["running", "pending", "paused"].includes(run.status)) continue;
          try {
            await manager.pauseAndWait(run.runId);
          } catch (error: any) {
            errors.push(`${run.runId}: ${error.message}`);
          }
        }
        if (errors.length === before) {
          manager.dispose();
          this.managers.delete(path);
        }
      } catch (error: any) {
        errors.push(`${path}: ${error.message}`);
      }
    }
    if (errors.length > 0)
      throw new Error(`Could not pause workflow run(s): ${errors.join("; ")}`);
  }
}

export function createProductionTicketExecutor(options: {
  cwd: string;
  worktrees?: TicketWorktrees;
  cfg: Config;
  meta: ProjectMetadata;
  botLogin: string;
  repoOwner: string;
  repoName: string;
  callback: ExecutorStatusCallback;
  modelRegistry?: ModelRegistry;
  mainModel?: string;
  sessionId?: string;
}): ManagedTicketExecutor {
  const board: TicketBoardAdapter = {
    conflict: {
      listComments: (card) =>
        listIssueComments(card.repoOwner!, card.repoName!, card.number!),
      createComment: async (card, body) =>
        createComment(
          await resolveIssueId(card.repoOwner!, card.repoName!, card.number!),
          body,
        ),
      updateComment: (_card, id, body) => updateIssueComment(id, body),
      reopen: async (card) =>
        reopenIssue(
          await resolveIssueId(card.repoOwner!, card.repoName!, card.number!),
        ),
    },
    getCard: (itemId) =>
      getCard(
        itemId,
        options.cfg.status_field,
        options.cfg.plan_field,
        options.cfg.type_field,
      ),
    setStatus: (itemId, status) => setStatus(options.meta, itemId, status),
    claim: (card) => tryClaim(card, options.botLogin),
    release: (card) => release(card, options.botLogin),
    async listComments(card) {
      if (!card.number || !card.repoOwner || !card.repoName) return [];
      return (
        await listIssueComments(card.repoOwner, card.repoName, card.number)
      ).map((comment) => comment.body);
    },
    async comment(card, body) {
      if (!card.number || !card.repoOwner || !card.repoName)
        throw new Error("Ticket is not backed by a GitHub issue");
      const issueId = await resolveIssueId(
        card.repoOwner,
        card.repoName,
        card.number,
      );
      await createComment(issueId, body);
    },
  };
  const worktrees = options.worktrees ?? new TicketWorktrees(options.cwd);
  return new ManagedTicketExecutor({
    cwd: options.cwd,
    cfg: options.cfg,
    botLogin: options.botLogin,
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    board,
    callback: options.callback,
    worktrees,
    createManager: (cwd) =>
      createWorkflowManagerAdapter({
        cwd,
        modelRegistry: options.modelRegistry,
        mainModel: options.mainModel,
        sessionId: options.sessionId,
        defaultAgentTimeoutMs: options.cfg.builder_timeout_ms,
        defaultAgentRetries: options.cfg.builder_retries,
        deferScheduling: true,
        callback: options.callback,
      }),
    context: options.cfg.context.enabled
      ? async (record) => {
          const { renderContext } = await import("./context.js");
          return renderContext({
            cwd: record.path,
            maxChars: options.cfg.context.max_chars,
            exclude: options.cfg.context.exclude,
          });
        }
      : undefined,
  });
}

export function inspectTicketExecutions(
  cwd: string,
  cards: Card[],
  cfg: Config,
  worktrees = new TicketWorktrees(cwd),
): {
  active: ActiveTicketRun[];
  orphans: number;
  needsHuman: number;
} {
  const records = worktrees.list();
  const active = records.flatMap((record): ActiveTicketRun[] => {
    if (!record.activeRunId) return [];
    let status = "missing";
    try {
      status =
        createRunPersistence(record.path).load(record.activeRunId)?.status ??
        "missing";
    } catch {
      status = "unreadable";
    }
    return [
      {
        itemId: record.itemId,
        taskKey: record.taskKey,
        runId: record.activeRunId,
        status,
        worktree: record.path,
      },
    ];
  });
  const recordIds = new Set(records.map((record) => record.itemId));
  const cardIds = new Set(cards.map((card) => card.itemId));
  const orphanIds = new Set<string>();
  for (const card of cards) {
    if (
      card.type?.toLowerCase() !== "story" &&
      statusIs(card, cfg.columns.building) &&
      !recordIds.has(card.itemId)
    )
      orphanIds.add(card.itemId);
  }
  for (const record of records)
    if (!cardIds.has(record.itemId)) orphanIds.add(record.itemId);
  for (const run of active)
    if (run.status === "missing" || run.status === "unreadable")
      orphanIds.add(run.itemId);
  return {
    active,
    orphans: orphanIds.size,
    needsHuman: cards.filter((card) => statusIs(card, cfg.columns.needs_human))
      .length,
  };
}
