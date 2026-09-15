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
  type ConflictBoardOps,
  type RepairBlocker,
  type LegacyMigrationReport,
} from "./legacy-tickets.js";
import type { OwnerLock } from "./owner-lock.js";
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import { normalizeWaveResults, parseDecision, renderDecisionComment, type WaveOutcome } from "./dispatch.js";
import { pendingTicketWrite, queueTicketWrite, settleTicketWrite, sameTicketContract } from "./ticket-retry.js";
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
  type IssueComment,
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
  attemptedItemIds?: string[];
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
    planSlug: string | undefined,
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

  private async resumeAuthority(path: string, runId: string): Promise<(() => boolean) | undefined> {
    try {
      const revision = this.resumeRevision;
      const record = this.deps.worktrees.list().find((r) => r.path === path && r.activeRunId === runId);
      if (!record || this.stopping || pendingTicketWrite(record) || !(await this.canResume())) return undefined;
      const card = await this.deps.board.getCard(record.itemId);
      if (!card || !this.ownsExecutionCard(record, card) || !statusIs(card, this.deps.cfg.columns.building)) return undefined;
      const canNow = () => {
        try {
          return !this.stopping && revision === this.resumeRevision && this.canResumeNow() &&
            JSON.stringify(this.deps.worktrees.read(record.itemId)) === JSON.stringify(record) &&
            !this.deps.worktrees.hasCleanupReceipt(record.itemId) && this.deps.worktrees.check(record, false).ok &&
            this.manager(path).list().some((run) => run.runId === runId && runArgsMatch(run, record));
        } catch { return false; }
      };
      return canNow() ? canNow : undefined;
    } catch (error) {
      this.deps.callback(`Resume ${runId} blocked: ${String(error)}`, "warn");
      return undefined;
    }
  }

  private ownsExecutionCard(record: TicketExecutionRecord, card: Card): boolean {
    return isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
      card.itemId === record.itemId && card.number === record.issueNumber && !card.closed &&
      (card.plan ? planSlug(card.plan) : undefined) === record.plan &&
      card.assignees.length === 1 && card.assignees[0].toLowerCase() === this.deps.botLogin.toLowerCase();
  }

  private matchingLaunchRuns(record: TicketExecutionRecord, manager: TicketWorkflowManager): PersistedRunState[] {
    return manager.list().filter((run) => run.runId !== record.lastRunId && runArgsMatch(run, record) &&
      Date.parse(run.startedAt) >= (record.launchingAt ?? 0) - 1000);
  }

  private async settle(record: TicketExecutionRecord): Promise<void> {
    await settleTicketWrite(this.deps.worktrees, record, this.deps.board, this.deps.botLogin, async () => {
      if (record.activeRunId) {
        const manager = this.manager(record.path);
        const run = manager.list().find((r) => r.runId === record.activeRunId);
        if (run && !runArgsMatch(run, record)) throw new Error("Run arguments changed before drain; writeback retained.");
        await manager.stopAndWait(record.activeRunId);
      }
    });
  }

  private async outcome(record: TicketExecutionRecord, card: Card, outcome: WaveOutcome): Promise<void> {
    const decision = outcome.status === "needs_decision" ? parseDecision(outcome as unknown as Record<string, unknown>) : undefined;
    const success = outcome.status === "success";
    const reason = success ? (outcome.summary || "Builder completed.") :
      decision ? decision.question : [outcome.error || "Builder failed.", outcome.attempted,
        outcome.limitations, outcome.workaround, outcome.humanAction].filter(Boolean).join("\n\n");
    record = queueTicketWrite(this.deps.worktrees, record, success ? "review" : "build", {
      card, reason, retry: !success,
      status: success ? this.deps.cfg.columns.review : decision ? this.deps.cfg.columns.needs_human : this.deps.cfg.columns.ready,
      comment: decision ? renderDecisionComment(decision) : success ?
        `✅ Builder completed on \`${record.taskBranch}\`.\n\n${reason}` :
        `## Builder failed\n\n${reason}\n\nThe next build continues the original branch/worktree, preserving partial changes.`,
    });
    await this.settle(record);
    this.deps.callback(`"${card.title}": ${reason}`, success ? "info" : "warn");
  }

  private async stopForManualState(record: TicketExecutionRecord, card: Card, manager: TicketWorkflowManager): Promise<void> {
    const runs = record.activeRunId ? manager.list().filter((r) => r.runId === record.activeRunId) : this.matchingLaunchRuns(record, manager);
    if (record.activeRunId) await manager.stopAndWait(record.activeRunId);
    else for (const run of runs) await manager.stopAndWait(run.runId);
    // Drain yields: release only a freshly matching Issue, never a replacement.
    const fresh = await this.deps.board.getCard(record.itemId);
    if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record))
      throw new Error("Execution record changed while draining.");
    if (fresh && isTargetIssue(fresh, this.deps.repoOwner, this.deps.repoName, "Task") &&
        fresh.itemId === record.itemId && fresh.number === record.issueNumber &&
        fresh.assignees.some((a) => a.toLowerCase() === this.deps.botLogin.toLowerCase()))
      await this.deps.board.release(fresh);
    this.deps.worktrees.clearExecution(record.itemId, record.activeRunId ?? (runs.length === 1 ? runs[0].runId : undefined));
    this.deps.callback(`Stopped stale execution ${record.itemId}; preserved manual status ${card.status ?? "unknown"}.`, "warn");
  }

  private async reconcileActive(record: TicketExecutionRecord, card: Card, summary: ReconcileSummary): Promise<void> {
    const manager = this.manager(record.path);
    if (!this.ownsExecutionCard(record, card) || !statusIs(card, this.deps.cfg.columns.building)) {
      await this.stopForManualState(record, card, manager);
      return;
    }
    const run = manager.list().find((r) => r.runId === record.activeRunId);
    if (!run || !runArgsMatch(run, record))
      throw new Error("Original workflow is missing/mismatched; retained for re-observation.");
    const results = run.status === "completed" ? normalizeWaveResults(run.result) : [];
    const structural = this.deps.worktrees.check(record, false);
    if (!structural.ok) {
      const failure = results.length === 1 && results[0].status === "failure" ? results[0] : undefined;
      await this.outcome(record, card, { ...failure, taskKey: record.taskKey, itemId: record.itemId, status: "failure",
        error: [failure?.error, structural.reason].filter(Boolean).join("; ") });
      return;
    }
    manager.startScheduling?.();
    if (["running", "pending", "paused"].includes(run.status)) {
      if (run.status === "paused" && run.pauseReason !== "usage_limit" && !this.stopping) {
        const allowed = await this.resumeAuthority(record.path, run.runId);
        if (allowed?.() && await manager.resume(run.runId)) summary.resumed++;
      }
      summary.active.push({ itemId: record.itemId, taskKey: record.taskKey, runId: run.runId,
        status: run.status, worktree: record.path });
      return;
    }
    let outcome: WaveOutcome = results.length === 1 ? { ...results[0], itemId: record.itemId, taskKey: record.taskKey } : {
      itemId: record.itemId, taskKey: record.taskKey, status: "failure",
      error: completedAgentTimeoutReason(run) ?? run.error ?? (run.status === "completed" ? "persisted builder result is malformed" : `workflow ended as ${run.status}`),
    };
    if (outcome.status === "success") {
      const check = this.deps.worktrees.check(record, true);
      if (!check.ok || outcome.branch !== record.taskBranch)
        outcome = { ...outcome, status: "failure", error: check.reason ?? "Builder returned the wrong branch." };
    }
    await this.outcome(record, card, outcome);
    if (outcome.status === "needs_decision") summary.needsHuman++;
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
      if (!runArgsMatch(run, record)) throw new Error("Orphan run identity changed; retained before drain.");
      await manager.stopAndWait(run.runId);
    }
    this.deps.worktrees.clearExecution(
      record.itemId,
      record.activeRunId ?? (runs.length === 1 ? runs[0].runId : undefined),
    );
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
      attemptedItemIds: [],
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
          !pendingTicketWrite(original) && (original.finalization || original.integration ||
          this.deps.worktrees.hasCleanupReceipt(original.itemId))
        )
          continue;

        if (original.activeRunId || original.launchingAt !== undefined || pendingTicketWrite(original))
          summary.attemptedItemIds!.push(original.itemId);
        if (pendingTicketWrite(original)) {
          await this.settle(original);
          continue;
        }
        let record: TicketExecutionRecord | undefined = original;
        if (record.activeRunId) await this.reconcileActive(record, card, summary);
        else if (record.launchingAt !== undefined) {
          // Strict persisted matching: absence/ambiguity cannot authorize a new builder.
          record = this.conflicts.observeLaunch(record);
          if (record) { summary.adopted++; await this.reconcileActive(record, card, summary); }
          else this.deps.callback(`Retained uncertain launch for ${original.itemId}; re-observing.`, "warn");
        } else if (this.ownsExecutionCard(record, card) && statusIs(card, this.deps.cfg.columns.building)) {
          summary.attemptedItemIds!.push(record.itemId);
          await this.outcome(record, card, { itemId: record.itemId, taskKey: record.taskKey,
            status: "failure", error: "In Progress ticket has no active workflow run." });
        }
      } catch (error: any) {
        this.resumeRevision++; // revoke any resume admitted before this failed fresh read
        summary.attemptedItemIds!.push(original.itemId);
        summary.errors++;
        this.deps.callback(`Reconcile failed for ${original.itemId}: ${error.message}`, "warn");
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
        // Missing identity is a technical observation, not a product decision.
        summary.orphans++;
        this.deps.callback(`Orphaned In Progress ticket ${card.itemId}; execution record missing, state preserved.`, "warn");
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
    if (record && pendingTicketWrite(record)) return "ticket writeback is pending";
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
    let card: Card | undefined;
    try { card = await this.deps.board.getCard(itemId); }
    catch (error) {
      // This checkpoint is before start(), so its failure is an I/O settlement,
      // not an uncertain invocation. Persist that fact before yielding control.
      if (record && !record.activeRunId) queueTicketWrite(this.deps.worktrees, record, "build", {
        card: expected, status: this.deps.cfg.columns.ready, retry: true, reason: `Launch observation failed: ${String(error)}`,
      });
      throw error;
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
      card && sameTarget &&
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
    if (record?.activeRunId) await this.manager(record.path).stopAndWait(record.activeRunId);
    if (card && sameTarget && card.assignees.includes(this.deps.botLogin)) {
      try { await this.deps.board.release(card); }
      catch (error) {
        if (record && !record.activeRunId) queueTicketWrite(this.deps.worktrees, record, "build", {
          card: expected, status: this.deps.cfg.columns.ready, retry: true, reason: `Launch release failed: ${String(error)}`,
        });
        throw error;
      }
    }
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
    const card = await this.currentLaunchCard(record, expected);
    if (!card) return { status: "skipped", reason: "card changed before builder start" };
    // Only before start() is invoked. Admission withdrawal is not a failure.
    if (reason === "builder admissions stopped") {
      const pending = queueTicketWrite(this.deps.worktrees, record, "build", {
        card, status: this.deps.cfg.columns.ready, retry: true,
        reason: record.retry?.reason ?? reason,
      });
      await this.settle(pending);
    } else await this.outcome(record, card, { taskKey: record.taskKey, itemId: record.itemId, status: "failure", error: reason });
    return { status: "skipped", reason };
  }

  async launch(
    snapshot: Card,
    expectedPlan: string | undefined,
    canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true,
    repair?: RepairRequest,
  ): Promise<LaunchResult> {
    this.canResume = canStartWork;
    this.canResumeNow = canStartWorkNow;
    if (repair) return { status: "skipped", reason: "Legacy repair arguments cannot authorize a new run; migrate first." };
    if (this.stopping) return { status: "skipped", reason: "executor is stopping" };
    const blocked = this.legacyBlocked(snapshot.itemId);
    if (blocked) return { status: "skipped", reason: blocked };
    let card = await this.deps.board.getCard(snapshot.itemId);
    if (!card || !sameTicketContract(card, snapshot)) return { status: "skipped", reason: "ticket contract changed" };
    if (this.deps.board.decisionComments) {
      const comments = await this.deps.board.decisionComments(card);
      let question = -1;
      comments.forEach((c, index) => {
        if (c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() && c.body.includes("## ⚠️ Needs human input")) question = index;
      });
      if (question >= 0 && !comments.slice(question + 1).some((c) => c.author &&
          c.author.toLowerCase() !== this.deps.botLogin.toLowerCase() &&
          ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.authorAssociation ?? "") && c.body.trim()))
        return { status: "skipped", reason: "Ready requires a trusted maintainer decision reply" };
      const fresh = await this.deps.board.getCard(snapshot.itemId);
      if (!fresh || !sameTicketContract(fresh, card)) return { status: "skipped", reason: "ticket contract changed" };
      card = fresh;
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

    const task = buildTasksForWave(this.deps.cfg, expectedPlan ?? "", [card])[0];

    let record: TicketExecutionRecord;
    try {
      record = await this.deps.worktrees.ensure(task, expectedPlan);
      if (record.schemaVersion !== 4) throw new Error("Migrate legacy ticket before launching new work.");
    } catch (error: any) {
      // ensure may have left partial ownership artifacts. Never guess a record.
      const reason = `Worktree preparation failed: ${error.message}`;
      this.deps.callback(reason, "warn");
      const current = await this.currentLaunchCard(undefined, card, this.deps.cfg.columns.ready);
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
    // The persistent worktree belongs to the ticket, not to a previous run ID.
    const check = this.deps.worktrees.check(record, false);
    if (!check.ok) {
      await this.outcome(record, card, { taskKey: record.taskKey, itemId: record.itemId, status: "failure", error: check.reason });
      return { status: "skipped", reason: check.reason ?? "worktree unsafe" };
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
      const reason = `Could not move ticket to ${this.deps.cfg.columns.building}: ${error.message}`;
      // No invocation yet. Retain an I/O-only reset, not an uncertain launch.
      await this.outcome(record, { ...card, status: this.deps.cfg.columns.building }, {
        taskKey: record.taskKey, itemId: record.itemId, status: "failure", error: reason,
      });
      return { status: "skipped", reason };
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
    const current = await this.currentLaunchCard(record, beforeRevision);
    if (!current)
      return { status: "skipped", reason: "card changed before builder start" };
    card = current;
    // No await after fresh remote authority: the local revision/admission latch
    // and stop may have changed during that read. Do not reserve a second slot.
    if (!admission || !canStartWorkNow() || this.stopping)
      return this.resetUnstarted(record, card, "builder admissions stopped");

    const actualCheck = this.deps.worktrees.check(record, false);
    if (!actualCheck.ok) return this.resetUnstarted(record, card, actualCheck.reason ?? "worktree unsafe");
    let runId: string;
    try {
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
      this.deps.worktrees.setActiveRun(record.itemId, runId);
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
      if (!card || !sameTicketContract(card, snapshot) ||
          !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task"))
        return { status: "skipped", reason: "ticket identity changed" };
      const record = this.deps.worktrees.read(card.itemId);
      const retrying = record?.retry && ["integrate", "cleanup"].includes(record.retry.stage);
      if (record?.activeRunId || record?.launchingAt !== undefined)
        return { status: "blocked", reason: "Builder execution is still active." };
      if (!card.closed || !(statusIs(card, this.deps.cfg.columns.done) ||
          (retrying && statusIs(card, this.deps.cfg.columns.ready))) ||
          (record && pendingTicketWrite(record)) ||
          card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
        return { status: "skipped", reason: "approval, claim or execution changed" };
      const task = buildTasksForWave(this.deps.cfg, "", [card])[0];
      // T004 supplies native v4 integration and cleanup. Do not route v4 through
      // the old squash/receipt finalizer or infer acceptance from a prepared SHA.
      const resultSha = await this.deps.worktrees.finalizeAccepted(task, this.deps.cfg.task_merge_strategy);
      if (!resultSha) return { status: "skipped", reason: "no local task branch" };
      this.deps.callback(`Finalized #${card.number} "${card.title}" at ${resultSha} in ${task.baseBranch}. Deleted local/remote branch ${task.taskBranch} and removed its worktree.`);
      return { status: "finalized", resultSha };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      const reason = card ? diagnostic : `fresh card read failed: ${diagnostic}`;
      try {
        const record = card && this.deps.worktrees.read(card.itemId);
        if (!card || !record || record.schemaVersion !== 4)
          return error instanceof MergeConflictError
            ? { status: "conflict", baseSha: error.baseSha, taskSha: error.taskSha, reason: error.diagnostic }
            : { status: "blocked", reason };
        const conflict = error instanceof MergeConflictError;
        if (conflict && record.integration)
          return { status: "blocked", reason: "Prepared integration must be observed on fresh origin/base before a conflict can return to build." };
        if (conflict && (this.stopping || !(await canStartWork()) || !canStartWorkNow()))
          return { status: "blocked", reason };
        const fresh = await this.deps.board.getCard(card.itemId);
        if (!fresh || !sameTicketContract(fresh, card) || fresh.closed !== card.closed || fresh.status !== card.status ||
            fresh.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
          return { status: "skipped", reason: "human approval changed" };
        if (!(await this.deps.board.claim(fresh))) return { status: "skipped", reason: "claim lost" };
        const current = await this.deps.board.getCard(card.itemId);
        if (!current || !sameTicketContract(current, fresh) || current.closed !== fresh.closed || current.status !== fresh.status ||
            current.assignees.length !== 1 || current.assignees[0].toLowerCase() !== this.deps.botLogin.toLowerCase())
          return { status: "skipped", reason: "approval changed after claim" };
        const stage = conflict ? "build" : record.retry?.stage === "cleanup" ? "cleanup" : "integrate";
        const detail = conflict
          ? `Merge conflict: merge base ${error.baseSha} into the original task branch (original task ${error.taskSha}). Inspect status, diff and MERGE_HEAD; continue interrupted work. Preserve both sides, resolve, run relevant tests, commit and push. Review and Done require renewed manual close approval.\n\n${reason}`
          : reason;
        const pending = queueTicketWrite(this.deps.worktrees, record, stage, {
          card: current, status: this.deps.cfg.columns.ready, reason: detail, retry: true,
          ...(conflict ? { reopen: true as const } : {}),
          comment: `## ${conflict ? "Merge conflict — build retry" : `${stage} retry`}\n\n${detail}`,
        });
        await this.settle(pending);
        return { status: "skipped", reason: detail };
      } catch (writeError) {
        this.deps.callback(`Finalization writeback pending: ${String(writeError)}`, "warn");
        return { status: "blocked", reason: `${reason}; writeback: ${String(writeError)}` };
      }
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
    decisionComments: (card) => listIssueComments(card.repoOwner!, card.repoName!, card.number!),
    reopen: async (card) => reopenIssue(await resolveIssueId(card.repoOwner!, card.repoName!, card.number!)),
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
      ).filter((comment) => comment.author?.toLowerCase() === options.botLogin.toLowerCase()).map((comment) => comment.body);
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
