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
  isRepairRequest,
  type LegacyMigrationReport,
} from "./legacy-tickets.js";
import { assertOwnerLock, type OwnerLock } from "./owner-lock.js";
import { checkOperation, type OperationControl } from "./operation.js";
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import {
  normalizeWaveResults,
  parseDecision,
  renderDecisionComment,
  trustedMissionComments,
  type WaveOutcome,
} from "./dispatch.js";
import {
  pendingTicketWrite,
  queueTicketWrite,
  settleTicketWrite,
  sameTicketContract,
} from "./ticket-retry.js";
import {
  createComment,
  findPullRequests,
  createPullRequest,
  getPullRequest,
  type PullRequestInfo,
  type PullRequestScope,
  getCard,
  isTargetIssue,
  listIssueComments,
  release,
  resolveIssueId,
  setStatus,
  tryClaim,
  reopenIssue,
  type Card,
  type IssueComment,
  type ProjectMetadata,
} from "./gh.js";
import {
  MergeConflictError,
  TicketStateChangedError,
  TicketWorktrees,
  type TicketExecutionRecordV5 as TicketExecutionRecord,
  type StoredTicketExecutionRecord,
  type TicketPullRequestIntegration,
  isTicketIntegrationStateV5,
  type TicketWorktreeRecord,
} from "./ticket-worktree.js";
import { buildTasksForWave, renderWorkflowSource } from "./workflow-prompt.js";
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
  attemptedItemIds?: string[];
}

export type LaunchResult =
  | { status: "launched"; runId: string; worktree: string }
  | { status: "skipped"; reason: string }
  | { status: "needs-human"; reason: string };

export type FinalizeOutcome =
  | { status: "finalized"; resultSha: string }
  | { status: "backlogged" }
  | { status: "waiting"; prNumber: number; prUrl: string; reason: string }
  | { status: "conflict"; baseSha: string; taskSha: string; reason: string }
  | { status: "skipped" | "blocked"; reason: string };

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
    excludedItemId?: string,
  ): Promise<ReconcileSummary>;
  hasPendingRecovery?(itemId: string): boolean;
  migrateLegacy?(
    owner: OwnerLock,
    canMigrate?: () => boolean,
    control?: OperationControl,
  ): Promise<LegacyMigrationReport>;
  /** Migration failures are isolated from all model/board mutations. */
  legacyBlocked?(itemId: string): string | undefined;
  /** Observe admission before the final card await, then check local admission
   * synchronously at start. The prepared launch already owns its worker slot. */
  launch(
    card: Card,
    planSlug: string | undefined,
    canStartWork?: () => boolean | Promise<boolean>,
    canStartWorkNow?: () => boolean,
  ): Promise<LaunchResult>;
  finalizeClosed(
    card: Card,
    canStartWork?: () => boolean | Promise<boolean>,
    canStartWorkNow?: () => boolean,
    control?: OperationControl,
  ): Promise<FinalizeOutcome>;
  activeCount(): number;
  /** Close launches/recovery immediately, before BoardLoop waits for its tick. */
  stopScheduling?(): void;
  shutdown(): Promise<void>;
}

export interface TicketBoardAdapter {
  decisionComments?(card: Card): Promise<IssueComment[]>;
  reopen?(card: Card): Promise<void>;
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
  owner: OwnerLock;
  pullRequests: {
    findPullRequests: typeof findPullRequests;
    createPullRequest: typeof createPullRequest;
    getPullRequest: typeof getPullRequest;
  };
  createManager(worktree: string): TicketWorkflowManager;
  context?(record: TicketExecutionRecord): Promise<string | undefined>;
}

class FinalizationWithdrawn extends Error {}

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
    // raw resume path around the host's fresh ticket authority.
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
  private readonly busy = new Set<string>();
  constructor(private readonly deps: TicketExecutorDeps) {
    if (!deps.owner) throw new Error("Explicit owner injection is required.");
    if (!["findPullRequests", "createPullRequest", "getPullRequest"].every(
      (key) => typeof deps.pullRequests?.[key as keyof TicketExecutorDeps["pullRequests"]] === "function"))
      throw new Error("Explicit pullRequests injection is required; no implicit GitHub fallback.");
    this.conflicts = new LegacyTickets(deps);
  }

  migrateLegacy(owner: OwnerLock, canMigrate?: () => boolean, control?: OperationControl) {
    return this.conflicts.migrateV5(owner, canMigrate, control);
  }

  legacyBlocked(itemId: string): string | undefined {
    return this.conflicts.blockedReason(itemId);
  }

  private assertWritable = () => {
    if (this.stopping) throw new FinalizationWithdrawn("Executor stopping; work retained.");
    assertOwnerLock(this.deps.owner, this.deps.worktrees.repoRoot);
  };

  private queue(record: TicketExecutionRecord, stage: Parameters<typeof queueTicketWrite>[2], write: Parameters<typeof queueTicketWrite>[3]) {
    return queueTicketWrite(this.deps.worktrees, record, stage, write, this.deps.owner, this.assertWritable);
  }

  private update(record: TicketExecutionRecord, mutate: (r: TicketExecutionRecord) => TicketExecutionRecord) {
    return this.deps.worktrees.updateV5(record, mutate, this.deps.owner, this.assertWritable);
  }

  private clear(record: TicketExecutionRecord, lastRunId = record.lastRunId) {
    return this.update(record, (r) => ({ ...r, activeRunId: undefined,
      activeRunStartedAt: undefined, launchingAt: undefined, lastRunId }));
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
      let record = this.deps.worktrees
        .list()
        .find((r) => r.path === path && r.activeRunId === runId);
      if (
        !record ||
        this.stopping ||
        pendingTicketWrite(record) ||
        !(await this.canResume())
      )
        return undefined;
      record = await this.observeWithdrawn(record);
      if (record.integration?.kind === "pr" && record.integration.phase === "merged") return undefined;
      this.assertWritable();
      const card = await this.deps.board.getCard(record.itemId);
      if (
        !card ||
        !this.ownsExecutionCard(record, card) ||
        !statusIs(card, this.deps.cfg.columns.building)
      )
        return undefined;
      const canNow = () => {
        try {
          return (
            (this.assertWritable(), true) &&
            !this.busy.has(record!.itemId) &&
            !this.stopping &&
            revision === this.resumeRevision &&
            this.canResumeNow() &&
            JSON.stringify(this.deps.worktrees.read(record.itemId)) ===
              JSON.stringify(record) &&
            !this.deps.worktrees.hasCleanupReceipt(record.itemId) &&
            this.deps.worktrees.check(record, false).ok &&
            this.manager(path)
              .list()
              .some((run) => run.runId === runId && runArgsMatch(run, record))
          );
        } catch {
          return false;
        }
      };
      return canNow() ? canNow : undefined;
    } catch (error) {
      this.deps.callback(`Resume ${runId} blocked: ${String(error)}`, "warn");
      return undefined;
    }
  }

  private ownsExecutionCard(
    record: TicketExecutionRecord,
    card: Card,
  ): boolean {
    return (
      isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
      card.itemId === record.itemId &&
      card.number === record.issueNumber &&
      !card.closed &&
      (card.plan ? planSlug(card.plan) : undefined) === record.plan &&
      card.assignees.length === 1 &&
      card.assignees[0].toLowerCase() === this.deps.botLogin.toLowerCase()
    );
  }

  private matchingLaunchRuns(
    record: TicketExecutionRecord,
    manager: TicketWorkflowManager,
  ): PersistedRunState[] {
    return manager
      .list()
      .filter(
        (run) =>
          run.runId !== record.lastRunId &&
          runArgsMatch(run, record) &&
          Date.parse(run.startedAt) >= (record.launchingAt ?? 0) - 1000,
      );
  }

  private async stopActiveRun(record: TicketExecutionRecord): Promise<void> {
    const manager = this.manager(record.path);
    const run = manager.list().find((r) => r.runId === record.activeRunId);
    // A no-op stop for a missing run is not proof that the original drained.
    if (!run || !runArgsMatch(run, record))
      throw new Error(
        "Original workflow is missing/mismatched; retained before drain.",
      );
    await manager.stopAndWait(run.runId);
    this.assertWritable();
    if (
      JSON.stringify(this.deps.worktrees.read(record.itemId)) !==
      JSON.stringify(record)
    )
      throw new Error("Execution record changed while draining.");
  }

  private async settle(record: TicketExecutionRecord, control?: OperationControl): Promise<void> {
    const write = pendingTicketWrite(record);
    const releaseOnly = write && !write.comment && !write.reopen && write.status === write.card.status;
    await settleTicketWrite(
      this.deps.worktrees,
      record,
      this.deps.board,
      this.deps.botLogin,
      async () => {
        if (record.activeRunId) await this.stopActiveRun(record);
      },
      { ...control, check: () => {
        checkOperation(control);
        assertOwnerLock(this.deps.owner, this.deps.worktrees.repoRoot);
        if (this.stopping && !releaseOnly) throw new Error("Executor stopping; pending writeback retained.");
      } },
      this.deps.owner,
    );
  }

  private async outcome(
    record: TicketExecutionRecord,
    card: Card,
    outcome: WaveOutcome,
  ): Promise<void> {
    const decision =
      outcome.status === "needs_decision" ? parseDecision(outcome) : undefined;
    const success = outcome.status === "success";
    const reason = success
      ? outcome.summary || "Builder completed."
      : decision
        ? decision.question
        : [
            outcome.error || "Builder failed.",
            outcome.attempted,
            outcome.limitations,
            outcome.workaround,
            outcome.humanAction,
          ]
            .filter(Boolean)
            .join("\n\n");
    record = this.queue(
      record,
      success ? "review" : "build",
      {
        card,
        reason,
        retry: !success,
        status: success
          ? this.deps.cfg.columns.review
          : decision
            ? this.deps.cfg.columns.needs_human
            : this.deps.cfg.columns.ready,
        comment: decision
          ? renderDecisionComment(decision)
          : success
            ? `✅ Builder completed on \`${record.taskBranch}\`.\n\n${reason}`
            : `## Builder failed\n\n${reason}\n\nThe next build continues the original branch/worktree, preserving partial changes.`,
      },
    );
    await this.settle(record);
    this.deps.callback(`"${card.title}": ${reason}`, success ? "info" : "warn");
  }

  private async stopForManualState(
    record: TicketExecutionRecord,
    card: Card,
  ): Promise<void> {
    await this.stopActiveRun(record);
    // Drain yields: release only a freshly matching Issue, never a replacement.
    const fresh = await this.deps.board.getCard(record.itemId);
    this.assertWritable();
    if (
      JSON.stringify(this.deps.worktrees.read(record.itemId)) !==
      JSON.stringify(record)
    )
      throw new Error("Execution record changed while draining.");
    if (
      fresh &&
      isTargetIssue(fresh, this.deps.repoOwner, this.deps.repoName, "Task") &&
      fresh.itemId === record.itemId &&
      fresh.number === record.issueNumber &&
      fresh.assignees.some(
        (a) => a.toLowerCase() === this.deps.botLogin.toLowerCase(),
      )
    )
      await this.deps.board.release(fresh);
    if (
      JSON.stringify(this.deps.worktrees.read(record.itemId)) !==
      JSON.stringify(record)
    )
      throw new Error("Execution record changed while releasing.");
    this.clear(record, record.activeRunId);
    this.deps.callback(
      `Stopped stale execution ${record.itemId}; preserved manual status ${card.status ?? "unknown"}.`,
      "warn",
    );
  }

  private async reconcileActive(
    record: TicketExecutionRecord,
    card: Card,
    summary: ReconcileSummary,
  ): Promise<void> {
    record = await this.observeWithdrawn(record);
    if (record.integration?.kind === "pr" && record.integration.phase === "merged") return;
    const manager = this.manager(record.path);
    if (
      !this.ownsExecutionCard(record, card) ||
      !statusIs(card, this.deps.cfg.columns.building)
    ) {
      await this.stopForManualState(record, card);
      return;
    }
    const run = manager.list().find((r) => r.runId === record.activeRunId);
    if (!run || !runArgsMatch(run, record))
      throw new Error(
        "Original workflow is missing/mismatched; retained for re-observation.",
      );
    const results =
      run.status === "completed" ? normalizeWaveResults(run.result) : [];
    const result =
      results.length === 1 &&
      results[0].itemId === record.itemId &&
      results[0].taskKey === record.taskKey
        ? results[0]
        : undefined;
    const structural = this.deps.worktrees.check(record, false);
    if (!structural.ok) {
      const failure = result?.status === "failure" ? result : undefined;
      await this.outcome(record, card, {
        ...failure,
        taskKey: record.taskKey,
        itemId: record.itemId,
        status: "failure",
        error: [failure?.error, structural.reason].filter(Boolean).join("; "),
      });
      return;
    }
    manager.startScheduling?.();
    if (["running", "pending", "paused"].includes(run.status)) {
      if (
        run.status === "paused" &&
        run.pauseReason !== "usage_limit" &&
        !this.stopping
      ) {
        const allowed = await this.resumeAuthority(record.path, run.runId);
        if (allowed?.() && (await manager.resume(run.runId))) summary.resumed++;
      }
      summary.active.push({
        itemId: record.itemId,
        taskKey: record.taskKey,
        runId: run.runId,
        status: run.status,
        worktree: record.path,
      });
      return;
    }
    let outcome: WaveOutcome = result ?? {
      itemId: record.itemId,
      taskKey: record.taskKey,
      status: "failure",
      error:
        completedAgentTimeoutReason(run) ??
        run.error ??
        (run.status === "completed"
          ? "persisted builder result is malformed"
          : `workflow ended as ${run.status}`),
    };
    if (outcome.status === "success") {
      const check = this.deps.worktrees.check(record, true);
      if (!check.ok || outcome.branch !== record.taskBranch)
        outcome = {
          ...outcome,
          status: "failure",
          error: check.reason ?? "Builder returned the wrong branch.",
        };
    }
    await this.outcome(record, card, outcome);
    if (outcome.status === "needs_decision") summary.needsHuman++;
  }

  private async stopMissingCardRun(
    record: TicketExecutionRecord,
    summary: ReconcileSummary,
  ): Promise<void> {
    if (!record.activeRunId) {
      const observed = this.conflicts.observeLaunchV5(record, this.deps.owner, this.assertWritable);
      if (!observed) {
        this.deps.callback(
          `Retained uncertain launch for withdrawn ticket ${record.itemId}; re-observing.`,
          "warn",
        );
        return;
      }
      record = observed;
      summary.adopted++;
    }
    await this.stopActiveRun(record);
    this.clear(record, record.activeRunId);
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
    excludedItemId?: string,
  ): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      active: [],
      resumed: 0,
      adopted: 0,
      needsHuman: 0,
      orphans: 0,
      errors: 0,
      attemptedItemIds: [],
    };
    if (this.stopping) return summary;
    this.canResume = canStartWork;
    this.canResumeNow = canStartWorkNow;
    this.resumeRevision++;
    for (const card of cards) {
      if (card.itemId === excludedItemId) continue;
      if (
        this.legacyBlocked(card.itemId) &&
        !this.conflicts.pendingDesign.has(card.itemId)
      )
        continue;
      try {
        await this.conflicts.mapDesign(card);
      } catch (error) {
        summary.errors++;
        this.deps.callback(
          `Legacy lane migration failed for ${card.itemId}: ${String(error)}`,
          "warn",
        );
      }
    }
    const cardsById = new Map(cards.map((card) => [card.itemId, card]));
    const records = this.deps.worktrees.list();
    const recordIds = new Set(records.map((record) => record.itemId));

    for (const original of records) {
      if (this.stopping) break;
      if (original.itemId === excludedItemId || this.busy.has(original.itemId) || this.legacyBlocked(original.itemId)) continue;
      const snapshot = cardsById.get(original.itemId);
      try {
        // Pure maintenance owns its fresh reads/writeback in the finalizer, not
        // the admission prefix. Open/manual lanes remain paused there as well.
        const pending = pendingTicketWrite(original);
        const maintenance = pending
          ? pending.card.closed && ["integrate", "cleanup"].includes(original.retry!.stage)
          : original.integration && !(original.integration.kind === "pr" && original.integration.phase === "suspended") ||
            (snapshot?.closed && statusIs(snapshot, this.deps.cfg.columns.done)) ||
            ["integrate", "cleanup"].includes(original.retry?.stage ?? "") ||
            this.deps.worktrees.hasCleanupReceipt(original.itemId);
        if (!original.activeRunId && original.launchingAt === undefined && maintenance)
          continue;
        if (
          snapshot?.closed &&
          statusIs(snapshot, this.deps.cfg.columns.backlog) &&
          isTargetIssue(snapshot, this.deps.repoOwner, this.deps.repoName) &&
          snapshot.number === original.issueNumber &&
          !this.hasPendingRecovery(original.itemId)
        )
          continue;
        // A failed read preserves recovery evidence; confirmed absence or a
        // replacement target stops only the local run, never mutates a snapshot.
        const card = await this.deps.board.getCard(original.itemId);
        if (this.stopping) break;
        if (
          original.activeRunId ||
          original.launchingAt !== undefined ||
          pendingTicketWrite(original)
        )
          summary.attemptedItemIds!.push(original.itemId);
        if (
          card &&
          isTargetIssue(card, this.deps.repoOwner, this.deps.repoName) &&
          card.itemId === original.itemId &&
          card.number === original.issueNumber &&
          card.closed &&
          !original.activeRunId &&
          original.launchingAt === undefined &&
          pendingTicketWrite(original)
        ) {
          await this.settle(original);
          continue;
        }
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
          !pendingTicketWrite(original) &&
          ((original.integration && !(original.integration.kind === "pr" && original.integration.phase === "suspended")) ||
            this.deps.worktrees.hasCleanupReceipt(original.itemId))
        )
          continue;

        if (pendingTicketWrite(original)) {
          await this.settle(original);
          continue;
        }
        let record: TicketExecutionRecord | undefined = original;
        if (record.activeRunId)
          await this.reconcileActive(record, card, summary);
        else if (record.launchingAt !== undefined) {
          // Strict persisted matching: absence/ambiguity cannot authorize a new builder.
          record = this.conflicts.observeLaunchV5(record, this.deps.owner, this.assertWritable);
          if (record) {
            summary.adopted++;
            await this.reconcileActive(record, card, summary);
          } else
            this.deps.callback(
              `Retained uncertain launch for ${original.itemId}; re-observing.`,
              "warn",
            );
        } else if (
          this.ownsExecutionCard(record, card) &&
          statusIs(card, this.deps.cfg.columns.building)
        ) {
          summary.attemptedItemIds!.push(record.itemId);
          await this.outcome(record, card, {
            itemId: record.itemId,
            taskKey: record.taskKey,
            status: "failure",
            error: "In Progress ticket has no active workflow run.",
          });
        }
      } catch (error: any) {
        this.resumeRevision++; // revoke any resume admitted before this failed fresh read
        summary.attemptedItemIds!.push(original.itemId);
        summary.errors++;
        this.deps.callback(
          `Reconcile failed for ${original.itemId}: ${error.message}`,
          "warn",
        );
      }
    }

    for (const snapshot of cards) {
      if (this.stopping) break;
      if (snapshot.itemId === excludedItemId) continue;
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
        // Missing identity is a technical observation, not a product decision.
        summary.orphans++;
        this.deps.callback(
          `Orphaned In Progress ticket ${card.itemId}; execution record missing, state preserved.`,
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
    expectedPlan: string | undefined,
    requireClaim = false,
  ): string | undefined {
    if (this.stopping) return "executor is stopping";
    if (!isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task"))
      return "card is not a Task Issue in the configured repository";
    if (card.closed) return "issue is closed";
    if (!statusIs(card, this.deps.cfg.columns.ready))
      return `status is ${card.status ?? "unset"}`;
    if ((card.plan ? planSlug(card.plan) : undefined) !== expectedPlan)
      return "Plan changed";
    if (card.assignees.some((assignee) => assignee !== this.deps.botLogin))
      return "another assignee is present";
    if (requireClaim && !card.assignees.includes(this.deps.botLogin))
      return "claim was not retained";
    const record = this.deps.worktrees.read(card.itemId);
    if (record && pendingTicketWrite(record))
      return "ticket writeback is pending";
    if (
      (record?.integration && !(record.integration.kind === "pr" && record.integration.phase === "suspended")) ||
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
    let card: Card | undefined;
    try {
      card = await this.deps.board.getCard(itemId);
    } catch (error) {
      // This checkpoint is before start(), so its failure is an I/O settlement,
      // not an uncertain invocation. Persist that fact before yielding control.
      if (record && !record.activeRunId)
        this.queue(record, "build", {
          card: expected,
          status: this.deps.cfg.columns.ready,
          retry: true,
          reason: `Launch observation failed: ${String(error)}`,
        });
      throw error;
    }
    assertOwnerLock(this.deps.owner, this.deps.worktrees.repoRoot);
    if (this.stopping) {
      // Before start() there is no uncertain invocation. Retain only local
      // settlement intent; stop forbids the remote reset/release until recovery.
      if (record && !record.activeRunId)
        queueTicketWrite(this.deps.worktrees, record, "build", {
          card: expected, status: this.deps.cfg.columns.ready, retry: true,
          reason: record.retry?.reason ?? "builder admissions stopped",
        }, this.deps.owner, () => assertOwnerLock(this.deps.owner, this.deps.worktrees.repoRoot));
      throw new FinalizationWithdrawn("Executor stopping; unstarted work retained.");
    }
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
      card &&
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
    if (record?.activeRunId) await this.stopActiveRun(record);
    if (card && sameTarget && card.assignees.includes(this.deps.botLogin)) {
      try {
        await this.deps.board.release(card);
      } catch (error) {
        if (record && !record.activeRunId)
          this.queue(record, "build", {
            card: expected,
            status: this.deps.cfg.columns.ready,
            retry: true,
            reason: `Launch release failed: ${String(error)}`,
          });
        throw error;
      }
    }
    // Failed ensure may have left partial/unreadable recovery artifacts. It
    // supplied no verified record, so even confirmed staleness cannot clear it.
    if (record) this.clear(record);
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
    const card = await this.currentLaunchCard(
      record,
      expected,
      expected.status ?? this.deps.cfg.columns.building,
    );
    if (!card)
      return { status: "skipped", reason: "card changed before builder start" };
    // Only before start() is invoked. Admission withdrawal is not a failure.
    if (reason === "builder admissions stopped") {
      const pending = this.queue(record, "build", {
        card,
        status: this.deps.cfg.columns.ready,
        retry: true,
        reason: record.retry?.reason ?? reason,
      });
      try { await this.settle(pending); }
      catch (error) { if (!this.stopping) throw error; } // Stop retains a status-changing reset for recovery.
    } else
      await this.outcome(record, card, {
        taskKey: record.taskKey,
        itemId: record.itemId,
        status: "failure",
        error: reason,
      });
    return { status: "skipped", reason };
  }

  async launch(snapshot: Card, expectedPlan: string | undefined,
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true): Promise<LaunchResult> {
    if (this.busy.has(snapshot.itemId)) return { status: "skipped", reason: "Ticket operation already active." };
    this.busy.add(snapshot.itemId);
    try { return await this.launchTicket(snapshot, expectedPlan, canStartWork, canStartWorkNow); }
    catch (error) {
      if (error instanceof FinalizationWithdrawn) return { status: "skipped", reason: error.message };
      throw error;
    } finally { this.busy.delete(snapshot.itemId); }
  }

  private async launchTicket(
    snapshot: Card,
    expectedPlan: string | undefined,
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true,
  ): Promise<LaunchResult> {
    this.canResume = canStartWork;
    this.canResumeNow = canStartWorkNow;
    if (this.stopping)
      return { status: "skipped", reason: "executor is stopping" };
    const blocked = this.legacyBlocked(snapshot.itemId);
    if (blocked) return { status: "skipped", reason: blocked };
    let card = await this.deps.board.getCard(snapshot.itemId);
    if (!card || !sameTicketContract(card, snapshot))
      return { status: "skipped", reason: "ticket contract changed" };
    let missionComments: string | undefined;
    if (this.deps.board.decisionComments) {
      const comments = await this.deps.board.decisionComments(card);
      // Ready is the human resume signal; comments supply context, never admission.
      missionComments = trustedMissionComments(comments);
      const fresh = await this.deps.board.getCard(snapshot.itemId);
      if (!fresh || !sameTicketContract(fresh, card))
        return { status: "skipped", reason: "ticket contract changed" };
      card = fresh;
    }
    this.assertWritable();
    if (card.closed || !statusIs(card, this.deps.cfg.columns.ready))
      return { status: "skipped", reason: "builder requires open Ready" };
    let retained = this.deps.worktrees.read(card.itemId);
    if (retained?.integration?.kind === "pr" && retained.integration.phase !== "merged") {
      if (retained.integration.phase !== "suspended") {
        // Reopening suspends approval before any builder admission. No sources are replaced.
        retained = this.rememberPr(retained, undefined, true);
      }
      await this.observeWithdrawn(retained);
      const fresh = await this.deps.board.getCard(card.itemId);
      this.assertWritable();
      if (!fresh || !sameTicketContract(fresh, card) || fresh.closed !== card.closed || fresh.status !== card.status)
        return { status: "skipped", reason: "approval changed before builder claim" };
      card = fresh;
    }
    const preClaim = this.eligible(card, expectedPlan);
    if (preClaim) return { status: "skipped", reason: preClaim };

    this.assertWritable();
    if (!(await this.deps.board.claim(card)))
      return { status: "skipped", reason: "claim lost" };
    this.assertWritable();
    card = await this.deps.board.getCard(snapshot.itemId);
    this.assertWritable();
    if (
      !card ||
      !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") ||
      card.itemId !== snapshot.itemId ||
      card.number !== snapshot.number
    ) {
      // A changed/missing Project identity cannot authorize even claim release.
      // Preserve the original claim for a fresh matching observation/manual cleanup.
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

    const task = buildTasksForWave(this.deps.cfg, expectedPlan ?? "", [
      card,
    ])[0];

    let record: TicketExecutionRecord;
    try {
      record = await this.deps.worktrees.ensure(task, expectedPlan, this.deps.owner, async () => {
        this.assertWritable();
        const fresh = await this.deps.board.getCard(card!.itemId);
        this.assertWritable();
        if (!fresh || !sameTicketContract(fresh, card!) || fresh.closed || fresh.status !== card!.status ||
            fresh.assignees.length !== 1 || fresh.assignees[0] !== this.deps.botLogin)
          throw new FinalizationWithdrawn("Approval changed during preparation.");
      }, { check: this.assertWritable });
      if (record.schemaVersion !== 5)
        throw new Error("Migrate legacy ticket before launching new work.");
    } catch (error: any) {
      // ensure may have left partial ownership artifacts. Never guess a record.
      const reason = `Worktree preparation failed: ${error.message}`;
      this.deps.callback(reason, "warn");
      const current = await this.currentLaunchCard(
        undefined,
        card,
        this.deps.cfg.columns.ready,
      );
      if (current) await this.deps.board.release(current);
      return { status: "skipped", reason };
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
    if (this.stopping || !canStartWorkNow())
      return this.resetUnstarted(record, card, "builder admissions stopped");
    // The persistent worktree belongs to the ticket, not to a previous run ID.
    const check = this.deps.worktrees.check(record, false);
    if (!check.ok) {
      await this.outcome(record, card, {
        taskKey: record.taskKey,
        itemId: record.itemId,
        status: "failure",
        error: check.reason,
      });
      return { status: "skipped", reason: check.reason ?? "worktree unsafe" };
    }
    record = await this.observeWithdrawn(record);
    if (record.integration?.kind === "pr" && record.integration.phase === "merged")
      return { status: "skipped", reason: "PR merged before builder reservation; work retained." };
    this.deps.worktrees.assertNoFinalization(record);
    const beforeReservation = await this.currentLaunchCard(record, card, this.deps.cfg.columns.ready);
    if (!beforeReservation) return { status: "skipped", reason: "approval changed before builder reservation" };
    card = beforeReservation;
    record = this.deps.worktrees.beginLaunch(record.itemId, undefined, this.deps.owner, () => {
      this.assertWritable();
      if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record))
        throw new TicketStateChangedError("Execution changed before builder reservation.");
    });
    this.activeCount();
    try {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.building,
      );
      card.status = this.deps.cfg.columns.building;
    } catch (error: any) {
      const reason = `Could not move ticket to ${this.deps.cfg.columns.building}: ${error.message}`;
      // No invocation yet. Retain an I/O-only reset, not an uncertain launch.
      await this.outcome(
        record,
        { ...card, status: this.deps.cfg.columns.building },
        {
          taskKey: record.taskKey,
          itemId: record.itemId,
          status: "failure",
          error: reason,
        },
      );
      return { status: "skipped", reason };
    }

    let context: string | undefined;
    try {
      context = await this.deps.context?.(record);
    } catch (error: any) {
      this.deps.callback(`Context generation failed: ${error.message}`, "warn");
    }

    context =
      [
        context,
        missionComments,
        record.retry?.stage === "build" ? record.retry.reason : undefined,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;

    let script: string;
    try {
      script = renderWorkflowSource({
        cfg: this.deps.cfg,
        planSlug: expectedPlan,
        baseBranch: this.deps.cfg.branches.base,
        tasks: [{ ...task, baseBranch: record.baseBranch }],
        skillName: "board-agent",
        context,
      });
    } catch (error: any) {
      return this.resetUnstarted(record, card, error.message);
    }

    // Keep the pre-observation gate: it rejects withdrawn work before revision
    // I/O, and preserves callers whose revision changes during this first read.
    const beforeRevision = await this.currentLaunchCard(record, card);
    if (!beforeRevision)
      return { status: "skipped", reason: "card changed before builder start" };
    const admission = await canStartWork();
    record = await this.observeWithdrawn(record, true);
    if (record.integration?.kind === "pr" && record.integration.phase === "merged")
      return { status: "skipped", reason: "PR merged before builder invocation; cleanup-only proof and work retained." };
    this.deps.worktrees.assertNoFinalization(record);
    const current = await this.currentLaunchCard(record, beforeRevision);
    if (!current)
      return { status: "skipped", reason: "card changed before builder start" };
    card = current;
    // No await after fresh remote authority: the local revision/admission latch
    // and stop may have changed during that read. Do not reserve a second slot.
    if (!admission || !canStartWorkNow() || this.stopping)
      return this.resetUnstarted(record, card, "builder admissions stopped");

    const actualCheck = this.deps.worktrees.check(record, false);
    if (!actualCheck.ok)
      return this.resetUnstarted(
        record,
        card,
        actualCheck.reason ?? "worktree unsafe",
      );
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
    let runId: string;
    try {
      this.assertWritable();
      runId = manager.start(
        script,
        {
          itemId: record.itemId,
          issueNumber: record.issueNumber,
          taskKey: record.taskKey,
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
        const reason = `Workflow start uncertain: ${error.message}; retained launch window without another builder.`;
        this.deps.callback(reason, "warn");
        return { status: "skipped", reason };
      }
    }

    try {
      this.deps.worktrees.setActiveRun(record.itemId, runId, undefined, this.deps.owner, () => {
        this.assertWritable();
        if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record))
          throw new TicketStateChangedError("Execution changed before binding the original builder.");
      });
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

  hasPendingRecovery(itemId: string): boolean {
    return (
      this.deps.worktrees.hasPendingRecovery(itemId) ||
      !!this.legacyBlocked(itemId)
    );
  }

  /** Marker addresses recovery only. Scope and source ancestry still authorize adoption. */
  private marker(record: TicketExecutionRecord): string {
    const pr = record.integration;
    if (pr?.kind !== "pr") throw new Error("Missing prepared PR identity.");
    return `<!-- board-agent-pr:${JSON.stringify([record.itemId, record.createdAt, pr.initialPreparedHeadSha])} -->`;
  }

  private scope(record: Pick<TicketExecutionRecord, "taskBranch" | "baseBranch">): PullRequestScope {
    return { owner: this.deps.repoOwner, repo: this.deps.repoName, base: record.baseBranch, head: record.taskBranch };
  }

  private validatePr(record: TicketExecutionRecord, pr: PullRequestInfo, recovering = false): void {
    const saved = record.integration;
    if (saved?.kind !== "pr" || !pr || JSON.stringify(pr.scope) !== JSON.stringify(saved.scope) ||
        JSON.stringify(saved.scope) !== JSON.stringify(this.scope(record)) ||
        typeof pr.body !== "string" || !["open", "closed"].includes(pr.state) ||
        typeof pr.merged !== "boolean" || (pr.merged && pr.state !== "closed") ||
        typeof pr.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(pr.headSha) ||
        !(pr.mergeCommitSha === null || typeof pr.mergeCommitSha === "string" && /^[0-9a-f]{40}$/i.test(pr.mergeCommitSha)) ||
        (pr.merged && !pr.mergeCommitSha) ||
        (saved.prNumber !== undefined && (saved.prNumber !== pr.number || saved.prUrl !== pr.url)) ||
        !isTicketIntegrationStateV5({ kind: "pr", phase: "open", scope: saved.scope,
          baseSha: saved.baseSha, taskSha: saved.taskSha, remoteTaskSha: saved.remoteTaskSha,
          preparedHeadSha: saved.preparedHeadSha, initialPreparedHeadSha: saved.initialPreparedHeadSha,
          prNumber: pr.number, prUrl: pr.url }))
      throw new Error("Managed PR scope, number, URL or state mismatch; work retained.");
    if (saved.phase === "merged" && (!pr.merged || pr.state !== "closed" ||
        pr.headSha !== saved.mergedHeadSha || pr.mergeCommitSha !== saved.mergeCommitSha))
      throw new Error("Merged PR evidence cannot be downgraded or replaced; work retained.");
    if (recovering && !pr.body.split(String.fromCharCode(10)).map((line) => line.trim()).includes(this.marker(record)))
      throw new Error("PR marker does not identify this execution; no adoption or duplicate creation.");
  }

  private async observePr(record: TicketExecutionRecord, guard: () => Promise<void>): Promise<PullRequestInfo | undefined> {
    const saved = record.integration;
    if (saved?.kind !== "pr") throw new Error("Missing prepared PR identity.");
    await guard();
    let pr: PullRequestInfo | undefined;
    if (saved.prNumber !== undefined) {
      pr = await this.deps.pullRequests.getPullRequest(saved.scope, saved.prNumber);
      await guard();
      this.validatePr(record, pr);
    } else {
      const candidates = await this.deps.pullRequests.findPullRequests(saved.scope);
      await guard();
      if (!Array.isArray(candidates) || candidates.length > 1)
        throw new Error("Ambiguous managed PR candidates; no adoption or duplicate creation.");
      pr = candidates[0];
      if (pr) this.validatePr(record, pr, true);
    }
    // A known PR's explicit merge is irreversible even if a rewrite or later
    // local work prevents cleanup. Unknown marker adoption still needs ancestry.
    if (pr && (!pr.merged || saved.prNumber === undefined))
      await this.deps.worktrees.verifyPullRequestSources(record, pr, guard, false);
    return pr;
  }

  /** Withdrawal is reversible; merge evidence is not. Never change a human PR body. */
  private rememberPr(record: TicketExecutionRecord, pr: PullRequestInfo | undefined, suspended: boolean,
    check: () => void = this.assertWritable): TicketExecutionRecord {
    const saved = record.integration;
    if (saved?.kind !== "pr") throw new Error("Missing prepared PR identity.");
    let integration: TicketPullRequestIntegration = saved;
    if (pr?.merged) integration = { ...saved, phase: "merged", prNumber: pr.number, prUrl: pr.url,
      mergedHeadSha: pr.headSha, mergeCommitSha: pr.mergeCommitSha! };
    else if (saved.phase !== "merged") {
      if (pr) integration = { ...saved, phase: "open", prNumber: pr.number, prUrl: pr.url };
      if (suspended || saved.phase === "suspended") integration = { ...integration, phase: "suspended" };
    }
    const retry = integration.phase === "merged"
      ? { stage: "cleanup" as const, reason: "Human PR merge confirmed; cleanup only. Uncovered later work requires a new submission/PR." }
      : record.retry?.stage === "integrate" ? undefined : record.retry;
    if (JSON.stringify({ integration, retry }) === JSON.stringify({ integration: saved, retry: record.retry })) return record;
    return this.deps.worktrees.progressPullRequest(record, integration, retry, this.deps.owner, check);
  }

  /** Before builder admission/resume, observe the retained PR. A merge while
   * withdrawn drains the original run and persists cleanup-only proof, never deletes. */
  private async observeWithdrawn(record: TicketExecutionRecord, unstarted = false): Promise<TicketExecutionRecord> {
    if (record.integration?.kind !== "pr" || record.integration.phase !== "suspended") return record;
    const guard = async () => {
      this.assertWritable();
      if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record))
        throw new TicketStateChangedError("Execution changed during withdrawn PR observation.");
    };
    const pr = await this.observePr(record, guard);
    if (pr?.merged && (record.activeRunId || record.launchingAt !== undefined)) {
      if (!record.activeRunId && !unstarted) {
        const observed = this.conflicts.observeLaunchV5(record, this.deps.owner, this.assertWritable);
        if (!observed) throw new Error("Merged PR has an uncertain builder; retain work until the original run is observed and drained.");
        record = observed;
      }
      if (record.activeRunId) await this.stopActiveRun(record);
      await guard();
      record = this.clear(record, record.activeRunId);
    }
    return this.rememberPr(record, pr, true);
  }

  async finalizeClosed(
    snapshot: Card,
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true,
    control?: OperationControl,
  ): Promise<FinalizeOutcome> {
    if (this.busy.has(snapshot.itemId)) return { status: "skipped", reason: "Ticket operation already active." };
    this.busy.add(snapshot.itemId);
    try { return await this.finalize(snapshot, canStartWork, canStartWorkNow, control); }
    finally { this.busy.delete(snapshot.itemId); }
  }

  private async finalize(
    snapshot: Card,
    canStartWork: () => boolean | Promise<boolean>,
    canStartWorkNow: () => boolean,
    external?: OperationControl,
  ): Promise<FinalizeOutcome> {
    const control: OperationControl = { ...external, check: () => {
      checkOperation(external);
      this.assertWritable();
      if (!canStartWorkNow()) throw new FinalizationWithdrawn("Finalization stopped or ownership lost; work retained.");
    } };
    const { worktrees, board, cfg, owner } = this.deps;
    let card: Card | undefined, record: TicketExecutionRecord | undefined;
    let original: StoredTicketExecutionRecord | undefined;
    const sameExecution = (r: StoredTicketExecutionRecord | undefined) =>
      original === undefined ? r === undefined : !!r &&
      ["itemId", "issueNumber", "createdAt", "path", "taskBranch", "baseBranch", "taskKey", "plan"].every(
        (key) => r[key as keyof StoredTicketExecutionRecord] === original![key as keyof StoredTicketExecutionRecord]) &&
      !r.activeRunId && r.launchingAt === undefined;
    const assertLocal = () => {
      checkOperation(control);
      if (!sameExecution(worktrees.readStored(snapshot.itemId)))
        throw new TicketStateChangedError("Finalization execution changed; work retained.");
    };
    const assertCard = async (backlog = false) => {
      assertLocal();
      const fresh = await board.getCard(snapshot.itemId);
      assertLocal();
      if (!fresh || !card || !sameTicketContract(fresh, card) || fresh.closed !== card.closed ||
          (backlog ? !statusIs(fresh, cfg.columns.backlog) : fresh.status !== card.status) ||
          JSON.stringify([...fresh.assignees].map((a) => a.toLowerCase()).sort()) !==
            JSON.stringify([...card.assignees].map((a) => a.toLowerCase()).sort()))
        throw new FinalizationWithdrawn("Fresh ticket approval or claim changed; work retained.");
    };
    const guard = async (backlog = false) => {
      await assertCard(backlog);
      if (JSON.stringify(worktrees.readStored(snapshot.itemId)) !== JSON.stringify(record ?? original))
        throw new TicketStateChangedError("PR execution changed during observation.");
    };
    try {
      checkOperation(control);
      const blocked = this.legacyBlocked(snapshot.itemId);
      if (blocked) return { status: "blocked", reason: blocked };
      original = worktrees.readStored(snapshot.itemId);
      if (!original && worktrees.has(snapshot.itemId)) throw new Error("Corrupt or unsupported ticket record; work retained.");
      card = await board.getCard(snapshot.itemId);
      checkOperation(control);
      if (!card || !sameTicketContract(card, snapshot) || card.closed !== snapshot.closed || card.status !== snapshot.status ||
          !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName))
        return { status: "skipped", reason: "ticket identity or approval changed" };
      if (original?.activeRunId || original?.launchingAt !== undefined)
        return { status: "blocked", reason: "Builder execution is still active." };
      assertLocal();
      record = original?.schemaVersion === 5 ? original : undefined;
      if (record && pendingTicketWrite(record)) {
        await this.settle(record, control);
        return { status: "skipped", reason: "pending writeback settled or retired" };
      }
      const task = { ...buildTasksForWave(cfg, "", [card])[0], ...(original ? { taskKey: original.taskKey } : {}) };
      const completed = record?.integration?.kind === "legacy-completed" ||
        (record?.integration?.kind === "pr" && record.integration.phase === "merged");
      const approved = card.closed && (statusIs(card, cfg.columns.done) || (completed && statusIs(card, cfg.columns.backlog))) &&
        card.assignees.every((a) => a.toLowerCase() === this.deps.botLogin.toLowerCase());
      if (!approved && record?.integration?.kind !== "pr")
        return { status: "skipped", reason: "approval, claim or execution changed" };
      if (record?.retry?.stage === "build" && approved) throw new Error(record.retry.reason);
      let pr: PullRequestInfo | undefined;
      if (record?.integration?.kind === "pr") {
        control.onProgress?.({ phase: "observe-pr" });
        pr = await this.observePr(record, guard); // known number always wins, even on restart/withdrawal
        await guard();
        record = this.rememberPr(record, pr, !approved, assertLocal);
        if (!approved) return pr ? { status: "waiting", prNumber: pr.number, prUrl: pr.url,
          reason: pr.merged ? "PR merged while approval was withdrawn. Proof and work retained; renewed closed Done is required for safe cleanup."
            : "Approval withdrawn; PR and sources retained. Open Ready permits the original builder; review and closed Done renew submission." }
          : { status: "skipped", reason: "Approval suspended; sources retained." };
      }
      if (!approved) return { status: "skipped", reason: "approval withdrawn" };
      let resultSha: string | undefined;
      if (record?.integration?.kind === "legacy-completed") {
        resultSha = await worktrees.cleanupLegacyCompleted(task, owner, assertCard,
          (r, operation) => this.conflicts.cleanupResidual(r, operation), control);
      } else {
        if (!record?.integration) {
          const local = worktrees.localBranchSha(task.taskBranch), remote = await worktrees.remoteSha(task.taskBranch);
          await assertCard();
          const historical = !local && !remote && !this.hasPendingRecovery(task.itemId);
          const receipt = !original && await this.conflicts.completedReceipt(task, card, control);
          if (!historical && !receipt) {
            if (original && !record) throw new Error("Owner-held v5 migration is required.");
            if (!record) {
              worktrees.cleanupRecordV5(task); // never adopt an unknown worktree/path
              await assertCard();
              record = worktrees.createV5({ schemaVersion: 5, itemId: task.itemId, issueNumber: task.issueNumber,
                taskKey: task.taskKey, taskBranch: task.taskBranch, baseBranch: task.baseBranch,
                path: worktrees.pathFor(task.itemId, task.issueNumber), createdAt: Date.now() }, owner, assertLocal);
              original = record;
            }
            if (record.retry?.stage === "review") record = worktrees.updateV5(record, (r) => ({ ...r, retry: undefined }), owner, assertLocal);
            const candidates = await this.deps.pullRequests.findPullRequests(this.scope(record));
            await guard();
            if (!Array.isArray(candidates) || candidates.length)
              throw new Error("Existing PR without this execution's preparation; no adoption or duplicate creation.");
          }
        }
        if (record && (record.integration?.kind === "pr" || worktrees.localBranchSha(task.taskBranch) || await worktrees.remoteSha(task.taskBranch))) {
          let saved = record.integration;
          if (!saved || (saved.kind === "pr" && ["prepared", "suspended"].includes(saved.phase) && !pr?.merged)) {
            if (pr && pr.state !== "open") return { status: "waiting", prNumber: pr.number, prUrl: pr.url,
              reason: "Managed PR is closed without merge. Work retained; a human must resolve it. No automatic reopen or replacement PR." };
            // The Git module renews owner/card/source guards and saves preparation before its normal task push.
            const previous = record;
            const prepareGuard = async () => {
              await assertCard();
              if (previous.integration?.kind === "pr" && previous.integration.prNumber !== undefined) {
                const current = await this.deps.pullRequests.getPullRequest(this.scope(previous), previous.integration.prNumber);
                await assertCard();
                this.validatePr(previous, current);
                if (current.merged || current.state !== "open")
                  throw new FinalizationWithdrawn("Managed PR changed during preparation; re-observe before any publication.");
                await worktrees.verifyPullRequestSources(previous, current, assertCard, false);
                const remote = await worktrees.remoteSha(task.taskBranch);
                await assertCard();
                if (!remote) throw new Error("Open PR task head is missing; restore its sources before renewing approval.");
                const renewed = worktrees.read(task.itemId)?.integration;
                if (renewed?.kind === "pr" && renewed.phase === "prepared" &&
                    !worktrees.isAncestor(previous.integration.preparedHeadSha, renewed.preparedHeadSha))
                  throw new Error("Renewed preparation lost the original PR sources; publication withheld.");
              }
            };
            record = await worktrees.preparePullRequest(task, this.scope(record), owner, prepareGuard, control);
            await guard();
            pr = await this.observePr(record, guard);
            if (!pr) {
              const saved = record.integration;
              if (saved?.kind !== "pr") throw new Error("Missing preparation before PR creation.");
              const remote = await worktrees.remoteSha(task.taskBranch);
              await guard();
              await worktrees.fetchRequired(task.taskBranch);
              await guard();
              const local = worktrees.localBranchSha(task.taskBranch);
              if (!remote || worktrees.fetchedSha(task.taskBranch) !== remote ||
                  !worktrees.isAncestor(saved.preparedHeadSha, remote) || !local || !worktrees.isAncestor(local, remote))
                throw new Error("Prepared PR no longer covers current sources; work retained.");
              control.onProgress?.({ phase: "create-pr" });
              pr = await this.deps.pullRequests.createPullRequest(this.scope(record), card.title,
                `${this.marker(record)}\n\nRefs #${card.number}\n\nPrepared for human review and manual merge (Squash and merge recommended).`, async () => {
                  await guard();
                  if (worktrees.localBranchSha(task.taskBranch) !== local || worktrees.fetchedSha(task.taskBranch) !== remote)
                    throw new Error("Prepared PR creation sources changed; work retained.");
                  worktrees.cleanupRecordV5(task);
                  if (worktrees.worktreeEntries().some((e) => e.branch === task.taskBranch) && !worktrees.check(record!, true).ok)
                    throw new Error("Unsafe worktree before PR creation.");
                });
              await guard();
              this.validatePr(record, pr, true);
              await worktrees.verifyPullRequestSources(record, pr, guard);
            }
            await guard();
            record = this.rememberPr(record, pr, false, assertLocal);
            saved = record.integration;
          }
          if (!pr) throw new Error("Managed PR observation is unavailable; sources retained.");
          if (!pr.merged) return { status: "waiting", prNumber: pr.number, prUrl: pr.url,
            reason: pr.state === "closed" ? "Managed PR is closed without merge. Work retained; a human must resolve it. No automatic reopen or replacement PR."
              : "Awaiting human PR merge. Worktree and refs retained; CI/review remain under human control." };
          const mergedGuard = async (backlog = false) => {
            await guard(backlog);
            const observed = await this.deps.pullRequests.getPullRequest(this.scope(record!), pr!.number);
            await guard(backlog);
            this.validatePr(record!, observed);
          };
          resultSha = await worktrees.cleanupMergedPullRequest(task, pr, owner, mergedGuard, control);
        }
      }
      const assertAbsent = async () => {
        if (await worktrees.remoteSha(task.taskBranch)) throw new Error("Remote task branch reappeared before Backlog write.");
        await guard(statusIs(card!, cfg.columns.backlog));
        if (worktrees.localBranchSha(task.taskBranch) || (!resultSha && this.hasPendingRecovery(task.itemId) &&
            !(await this.conflicts.completedReceipt(task, card!, control))))
          throw new Error("Task ref or pending recovery remains before Backlog write.");
      };
      control.onProgress?.({ phase: "writeback" });
      await assertAbsent();
      if (!statusIs(card, cfg.columns.backlog)) await board.setStatus(card.itemId, cfg.columns.backlog);
      await guard(true);
      if (resultSha) await worktrees.completeFinalization(task, resultSha, async () => {
        await guard(true);
        if (record?.integration?.kind === "pr") {
          const observed = await this.deps.pullRequests.getPullRequest(this.scope(record), record.integration.prNumber!);
          await guard(true);
          this.validatePr(record, observed);
        }
      }, control, owner);
      snapshot.status = cfg.columns.backlog;
      snapshot.closed = true;
      this.deps.callback(resultSha
        ? `Finalized #${card.number} "${card.title}" at ${resultSha} in ${task.baseBranch}. Deleted local/remote branch ${task.taskBranch} and removed its worktree → ${cfg.columns.backlog}.`
        : `Backlogged #${card.number} "${card.title}" → ${cfg.columns.backlog} (closed; no task branches).`);
      return resultSha ? { status: "finalized", resultSha } : { status: "backlogged" };
    } catch (error) {
      return this.finalizationFailure(error, snapshot, card, original, control, canStartWork, canStartWorkNow);
    }
  }
  private async finalizationFailure(
    error: unknown, snapshot: Card, card: Card | undefined, original: StoredTicketExecutionRecord | undefined,
    control: OperationControl, canStartWork: () => boolean | Promise<boolean>, canStartWorkNow: () => boolean,
  ): Promise<FinalizeOutcome> {
    if (error instanceof FinalizationWithdrawn || error instanceof TicketStateChangedError)
      return { status: "skipped", reason: error.message };
    try { checkOperation(control); }
    catch { return { status: "skipped", reason: "finalization stopped or ownership lost" }; }
    const diagnostic = error instanceof Error ? error.message : String(error);
    const reason = card ? diagnostic : `fresh card read failed: ${diagnostic}`;
    try {
      let record = this.deps.worktrees.read(snapshot.itemId);
      if (!record || !original || record.createdAt !== original.createdAt || record.path !== original.path ||
          record.taskBranch !== original.taskBranch || record.taskKey !== original.taskKey ||
          record.activeRunId || record.launchingAt !== undefined || pendingTicketWrite(record))
        return { status: "blocked", reason };
      const conflict = error instanceof MergeConflictError;
      if (conflict && (!error.repairable || !card ||
          !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") ||
          !this.deps.worktrees.check(record, true).ok))
        return { status: "conflict", baseSha: error.baseSha, taskSha: error.taskSha, reason };
      const buildRetry = conflict || record.retry?.stage === "build";
      if (buildRetry && record.integration && !(record.integration.kind === "pr" && record.integration.phase === "suspended"))
        return { status: "blocked", reason: "Prepared/merged PR must be observed before any build retry; sources retained." };
      const stage = buildRetry ? "build" : record.integration?.kind === "legacy-completed" ||
        (record.integration?.kind === "pr" && record.integration.phase === "merged") ? "cleanup" : "integrate";
      const detail = conflict
        ? `Merge conflict: merge base ${error.baseSha} into the original task branch (original task ${error.taskSha}). Inspect status, diff and MERGE_HEAD; continue interrupted work. Preserve both sides, resolve, run relevant tests, commit and push. Review and Done require renewed manual close approval.\n\n${reason}`
        : buildRetry ? record.retry!.reason : reason;
      record = this.deps.worktrees.updateV5(record, (r) => ({ ...r, retry: { stage, reason: detail } }),
        this.deps.owner, () => checkOperation(control));
      if (!buildRetry || !card) return { status: "blocked", reason: detail };
      if (!(await canStartWork()) || !canStartWorkNow()) return { status: "blocked", reason: detail };
      const fresh = await this.deps.board.getCard(card.itemId);
      checkOperation(control);
      if (!fresh || !sameTicketContract(fresh, card) || fresh.closed !== card.closed || fresh.status !== card.status ||
          fresh.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
        return { status: "skipped", reason: "human approval changed" };
      this.deps.worktrees.cleanupRecordV5({ ...record, title: fresh.title, body: fresh.body });
      if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record))
        throw new TicketStateChangedError("Conflict execution changed before claim.");
      if (!(await this.deps.board.claim(fresh))) return { status: "skipped", reason: "claim lost" };
      const current = await this.deps.board.getCard(card.itemId);
      checkOperation(control);
      if (!current || !sameTicketContract(current, fresh) || current.closed !== fresh.closed || current.status !== fresh.status ||
          current.assignees.length !== 1 || current.assignees[0].toLowerCase() !== this.deps.botLogin.toLowerCase())
        return { status: "skipped", reason: "approval changed after claim" };
      record = queueTicketWrite(this.deps.worktrees, record, "build", {
        card: current, status: this.deps.cfg.columns.ready, reason: detail, retry: true, reopen: true,
        comment: `## Merge conflict — build retry\n\n${detail}`,
      }, this.deps.owner, () => checkOperation(control));
      await this.settle(record, control);
      return { status: "blocked", reason: detail };
    } catch (writeError) {
      try { checkOperation(control); }
      catch { return { status: "skipped", reason: "finalization stopped or ownership lost" }; }
      return { status: "blocked", reason: `${reason}; writeback: ${String(writeError)}` };
    }
  }

  activeCount(): number {
    let count = 0;
    const active: ActiveTicketRun[] = [];
    for (const record of this.deps.worktrees.listStored()) {
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
        // Terminal status can precede cooperative drain or failed writeback.
        // Only clearing the association after safe drain/release lends its slot.
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
  owner: OwnerLock;
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
    decisionComments: (card) =>
      listIssueComments(card.repoOwner!, card.repoName!, card.number!),
    reopen: async (card) =>
      reopenIssue(
        await resolveIssueId(card.repoOwner!, card.repoName!, card.number!),
      ),
    getCard: (itemId) =>
      getCard(
        itemId,
        options.cfg.status_field,
        options.cfg.plan_field,
        options.cfg.type_field,
      ),
    setStatus: (itemId, status) => setStatus(options.meta, itemId, status),
    // Only finalization receives a freshly approved closed card; builders still require open Ready.
    claim: (card) => tryClaim(card, options.botLogin, card.closed === true),
    release: (card) => release(card, options.botLogin),
    async listComments(card) {
      if (!card.number || !card.repoOwner || !card.repoName) return [];
      return (
        await listIssueComments(card.repoOwner, card.repoName, card.number)
      )
        .filter(
          (comment) =>
            comment.author?.toLowerCase() === options.botLogin.toLowerCase(),
        )
        .map((comment) => comment.body);
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
  const worktrees = options.worktrees ?? new TicketWorktrees(options.cwd, options.owner);
  return new ManagedTicketExecutor({
    cwd: options.cwd,
    cfg: options.cfg,
    botLogin: options.botLogin,
    repoOwner: options.repoOwner,
    repoName: options.repoName,
    board,
    owner: options.owner,
    pullRequests: { findPullRequests, createPullRequest, getPullRequest },
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
  const records = worktrees.listStored();
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
