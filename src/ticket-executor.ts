import { LegacyTicketAdapter, isRepairRequest } from "./legacy-adapter.js";
import { cleanupTicketReview } from "./review.js";
import type { OwnerLock } from "./owner-lock.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  UsageLimitScheduler,
  WorkflowManager,
  createRunPersistence,
  type PersistedRunState,
  type WorkflowManagerOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import {
  normalizeWaveResults, isDecision, decisionComment, failureComment, trustedMissionComments,
  persistTicketNotice, readTicketNotice, settleTicketNotice, TicketChangedError, ticketCardKey,
  type TicketSettlementBoard,
} from "./dispatch.js";
import {
  createComment,
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
  TicketWorktrees,
  type TicketExecutionRecord,
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
  /** Tickets observed/settled this tick cannot enter another lane in that tick. */
  handledItemIds?: string[];
}

export type LaunchResult =
  | { status: "launched"; runId: string; worktree: string }
  | { status: "skipped"; reason: string };

export type FinalizeOutcome =
  | { status: "finalized"; resultSha: string }
  | { status: "conflict"; baseSha: string; taskSha: string; reason: string }
  | { status: "skipped" | "blocked"; reason: string };

export interface TicketExecutor {
  readonly isolatesLegacyState?: boolean;
  preservesLegacyLane?(lane: "story" | "watchdog"): boolean;
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
  recoveryBlocker?(itemId: string): string | undefined;
  /** Observe revision before the final card await, then check local admission
   * synchronously at start. The prepared launch already owns its worker slot. */
  launch(
    card: Card,
    planSlug: string,
    canStartWork?: () => boolean | Promise<boolean>,
    canStartWorkNow?: () => boolean,
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
  getCard(itemId: string): Promise<Card | undefined>;
  setStatus(itemId: string, status: string): Promise<void>;
  claim(card: Card): Promise<boolean>;
  release(card: Card): Promise<void>;
  listComments(card: Card): Promise<string[] | IssueComment[]>;
  missionComments?(card: Card): Promise<IssueComment[]>;
  reopen?(card: Card): Promise<void>;
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
  /** Supplied only after exclusive acquisition; the previous owner must be drained. */
  ownerLock?: OwnerLock;
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
    // raw resume path around the host's ticket authorization.
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
  private readonly legacy?: LegacyTicketAdapter;
  observation: NonNullable<TicketExecutor["observation"]> = { active: [], occupiedSlots: 0 };

  constructor(private readonly deps: TicketExecutorDeps) {
    if (deps.ownerLock) this.legacy = new LegacyTicketAdapter(deps);
  }
  get isolatesLegacyState(): boolean { return !!this.legacy; }
  preservesLegacyLane(lane: "story" | "watchdog"): boolean { return this.legacy?.preservesLane(lane) ?? false; }

  recoveryBlocker(itemId: string): string | undefined {
    const record = this.deps.worktrees.read(itemId);
    return this.legacy?.blocker(itemId) ??
      (record?.schemaVersion === 3 ? "Legacy conversion pending." : undefined) ??
      (record?.integration || record?.retry?.stage === "integrate" || record?.retry?.stage === "cleanup" || record?.finalization
        ? "pending finalization/integration/cleanup is reserved for resumable finalization." : undefined);
  }

  private matches(record: TicketExecutionRecord, run: PersistedRunState): boolean {
    return runArgsMatch(run, record) && (!this.legacy?.owns(record.itemId) || this.legacy.matches(record, run.args, run.runId));
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
  private owned(card: Card): boolean {
    return card.assignees.length === 1 && card.assignees[0].toLowerCase() === this.deps.botLogin.toLowerCase();
  }
  private target(card: Card | undefined, record: TicketExecutionRecord): card is Card {
    return !!card && isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
      card.itemId === record.itemId && card.number === record.issueNumber &&
      (card.plan ? planSlug(card.plan) : undefined) === record.plan;
  }
  private async resumeAuthority(path: string, runId: string): Promise<(() => boolean) | undefined> {
    try {
      const revision = this.resumeRevision;
      const record = this.deps.worktrees.list().find((r) => r.path === path && r.activeRunId === runId);
      if (!record || this.stopping || readTicketNotice(record.retry?.reason) || this.recoveryBlocker(record.itemId)) return;
      const manager = this.manager(path);
      const run = manager.list().find((r) => r.runId === runId);
      const legacy = this.legacy?.owns(record.itemId);
      if (!run || !this.matches(record, run) || (!legacy && !(await this.canResume()))) return;
      const card = await this.deps.board.getCard(record.itemId);
      if (!this.target(card, record) || card.closed || !statusIs(card, this.deps.cfg.columns.building) || !this.owned(card) ||
          (legacy && !(await this.legacy!.executionCard(record, card)))) return;
      const canNow = () => {
        try {
          const current = manager.list().find((r) => r.runId === runId);
          return !this.stopping && revision === this.resumeRevision &&
            (legacy ? this.legacy!.authorityHeld() : this.canResumeNow()) &&
            JSON.stringify(this.deps.worktrees.read(record.itemId)) === JSON.stringify(record) &&
            !this.deps.worktrees.hasCleanupReceipt(record.itemId) && this.deps.worktrees.check(record, false).ok &&
            !!current && this.matches(record, current);
        } catch { return false; }
      };
      return canNow() ? canNow : undefined;
    } catch (error) {
      this.deps.callback(`Resume ${runId} blocked: ${String(error)}`, "warn");
      return undefined;
    }
  }

  private board(): TicketSettlementBoard {
    return { ...this.deps.board, reopen: this.deps.board.reopen,
      // Class-based offline adapters must retain their receiver.
      getCard: (id) => this.deps.board.getCard(id),
      listComments: (c) => this.deps.board.listComments(c),
      comment: (c, body) => this.deps.board.comment(c, body),
      setStatus: (id, status) => this.deps.board.setStatus(id, status),
      release: (c) => this.deps.board.release(c) };
  }

  private matchingLaunchRuns(record: TicketExecutionRecord, manager: TicketWorkflowManager): PersistedRunState[] {
    return manager.list().filter((run) => run.runId !== record.lastRunId && this.matches(record, run) &&
      new Date(run.startedAt).getTime() >= (record.launchingAt ?? 0) - 1000);
  }

  private async drain(record: TicketExecutionRecord): Promise<void> {
    if (!record.activeRunId && (record.launchingAt === undefined || readTicketNotice(record.retry?.reason))) return;
    const check = this.deps.worktrees.check(record, false);
    if (!check.ok) throw new Error(check.reason); // never open a manager on an external/changed worktree
    const manager = this.manager(record.path);
    const runs = record.activeRunId ? manager.list().filter((r) => r.runId === record.activeRunId) : this.matchingLaunchRuns(record, manager);
    if (record.activeRunId && !runs.length) throw new Error("Persisted workflow is missing; retain its binding and retry observation.");
    for (const run of runs) await manager.stopAndWait(run.runId);
    if (!record.activeRunId && runs.length !== 1)
      throw new Error("Ambiguous launch binding retained after draining known runs; retry observation before any new builder.");
  }

  /** Human withdrawal is not a failure. Only release our freshly observed claim,
   * after drain; never restore a lane, edit the issue, or replace its identity. */
  private async withdraw(record: TicketExecutionRecord, expected?: Card): Promise<void> {
    if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record)) throw new Error("Record changed before withdrawal.");
    await this.drain(record);
    const fresh = await this.deps.board.getCard(record.itemId);
    if (fresh && expected && isTargetIssue(fresh, this.deps.repoOwner, this.deps.repoName, "Task") &&
      fresh.itemId === record.itemId && fresh.number === record.issueNumber &&
      fresh.assignees.some((a) => a.toLowerCase() === this.deps.botLogin.toLowerCase())) {
      await this.deps.board.release(fresh);
      const observed = await this.deps.board.getCard(record.itemId);
      if (observed && this.target(observed, record) && this.owned(observed)) throw new Error("Claim release not yet observed.");
    }
    if (!fresh || !isTargetIssue(fresh, this.deps.repoOwner, this.deps.repoName, "Task") ||
      fresh.itemId !== record.itemId || fresh.number !== record.issueNumber)
      this.deps.callback(`Original Issue claim for ${record.itemId} requires manual verification/cleanup; no remote writes attempted.`, "warn");
    this.deps.worktrees.update(record.itemId, (current) => {
      if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Execution changed before withdrawal acknowledgement.");
      return { ...current,
      lastRunId: record.activeRunId ?? current.lastRunId,
      activeRunId: undefined, activeRunStartedAt: undefined, launchingAt: undefined,
      // Withdrawal cancels writeback, not the diagnostic or original work.
      retry: current.retry && readTicketNotice(current.retry.reason)
        ? { ...current.retry, reason: current.retry.reason.slice(current.retry.reason.indexOf("\n") + 1) }
        : current.retry };
    });
  }

  private async settle(record: TicketExecutionRecord): Promise<boolean> {
    const occupied = !!record.activeRunId || record.launchingAt !== undefined;
    await this.drain(record);
    const notice = readTicketNotice(record.retry?.reason);
    if (!occupied && (record.retry?.stage === "review" || notice?.from === this.deps.cfg.columns.review))
      await cleanupTicketReview(this.deps.cwd, record);
    const result = await settleTicketNotice(this.deps.worktrees, record, this.board(), this.deps.botLogin);
    this.deps.worktrees.update(record.itemId, (current) => {
      if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Execution changed before settlement acknowledgement.");
      return { ...current, lastRunId: record.activeRunId ?? current.lastRunId,
        activeRunId: undefined, activeRunStartedAt: undefined, launchingAt: undefined,
        // Review remains an obligation until the independent verdict settles.
        retry: statusIs(result.card, this.deps.cfg.columns.ready) || statusIs(result.card, this.deps.cfg.columns.review)
          ? current.retry : undefined };
    });
    if (occupied || result.changed)
      this.deps.callback(`"${result.card.title}" → ${result.card.status}; previous execution drained and claim released.`);
    return occupied || result.changed;
  }

  private async terminal(record: TicketExecutionRecord, card: Card, run: PersistedRunState): Promise<boolean> {
    const { worktrees, cfg } = this.deps;
    const timeout = completedAgentTimeoutReason(run);
    const outcomes = run.status === "completed" && !timeout ? normalizeWaveResults(run.result) : [];
    const outcome = outcomes.length === 1 && outcomes[0].itemId === record.itemId && outcomes[0].taskKey === record.taskKey ? outcomes[0] : undefined;
    let target = cfg.columns.ready, stage: "build" | "review" = "build", body: string;
    if (outcome?.status === "needs_decision" && isDecision(outcome)) {
      target = cfg.columns.needs_human;
      body = decisionComment(outcome);
    } else if (outcome?.status === "success") {
      // A terminal journal can precede cooperative teardown. Pin/check the
      // completed work only after the original lease has drained.
      await this.drain(record);
      const check = worktrees.check(record, true);
      if (!check.ok || outcome.branch !== record.taskBranch) {
        body = failureComment(check.reason ?? "Builder result branch does not match the original task branch.");
      } else {
        const sha = worktrees.localBranchSha(record.taskBranch);
        if (!sha) throw new Error("Successful build SHA is unavailable; retry Git observation, not the builder.");
        record = worktrees.update(record.itemId, (r) => {
          if (JSON.stringify(r) !== JSON.stringify(record)) throw new Error("Execution changed while draining the successful builder.");
          return { ...r, reviewedTaskSha: sha };
        });
        target = cfg.columns.review; stage = "review";
        body = `## Builder completed\n\n${outcome.summary ?? "Ready for independent review."}\n\nTask branch: \`${record.taskBranch}\` at \`${sha}\`. Review must verify this exact pushed SHA.`;
      }
    } else {
      body = failureComment(outcome?.error ?? timeout ?? run.error ??
        (run.status === "completed" ? "Persisted builder result is malformed or missing." : `Workflow ended as ${run.status}.`), outcome);
    }
    if (target === cfg.columns.ready && record.retry?.reason && !readTicketNotice(record.retry.reason))
      body += `\n\nPrior recovery context:\n${record.retry.reason}`;
    record = persistTicketNotice(worktrees, record, card, stage, target, body);
    await this.settle(record);
    return target === cfg.columns.needs_human;
  }

  async reconcile(cards: Card[], canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0, handledItemIds: [] };
    if (this.stopping) return summary;
    this.canResume = canStartWork; this.canResumeNow = canStartWorkNow; this.resumeRevision++;
    const errors = await this.legacy?.reconcile(cards, () => !this.stopping) ?? [];
    for (const error of errors) this.deps.callback(`Legacy recovery ${error.itemId}: ${error.reason}`, "warn");
    summary.errors += errors.length;
    for (let record of this.deps.worktrees.list()) {
      if (this.stopping) break;
      if (this.recoveryBlocker(record.itemId) || this.deps.worktrees.hasCleanupReceipt(record.itemId)) continue;
      let card: Card | undefined;
      const handled = () => { if (!summary.handledItemIds!.includes(record.itemId)) summary.handledItemIds!.push(record.itemId); };
      try {
        card = await this.deps.board.getCard(record.itemId);
        if (this.stopping) break;
        const snapshot = cards.find((c) => c.itemId === record.itemId);
        if (snapshot && card) Object.assign(snapshot, card);
        if (!this.target(card, record)) {
          if (record.activeRunId || record.launchingAt !== undefined) { handled(); await this.withdraw(record); summary.orphans++; }
          continue;
        }
        // Cold queued repairs carry only ordinary retry context. The adapter
        // verifies old identity/evidence; no requested/queued/consumed writes.
        if (record.retry?.reason.startsWith("Legacy merge conflict:")) {
          handled();
          await this.legacy?.assertRetryCard(record, card);
          if (!this.owned(card)) {
            if (card.assignees.length || !(await this.deps.board.claim(card))) continue;
            card = (await this.deps.board.getCard(record.itemId))!;
            await this.legacy?.assertRetryCard(record, card);
          }
          if (!this.target(card, record) || !this.owned(card)) continue;
          record = persistTicketNotice(this.deps.worktrees, record, card, "build", this.deps.cfg.columns.ready, failureComment(record.retry.reason));
        }
        const notice = readTicketNotice(record.retry?.reason);
        if (notice && notice.from !== this.deps.cfg.columns.ready && statusIs(card, this.deps.cfg.columns.ready) && !card.closed &&
          (notice.to !== this.deps.cfg.columns.ready || notice.key !== ticketCardKey(card, record))) {
          if (record.activeRunId || record.launchingAt !== undefined || this.owned(card)) {
            handled(); await this.withdraw(record, notice.key === ticketCardKey(card, record) ? card : undefined);
          }
          // Explicit manual Ready is the only override. Comments alone never
          // reach this branch. Preserve original worktree identity and diagnostics.
          if (notice.to === this.deps.cfg.columns.needs_human &&
            !card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
            this.deps.worktrees.update(record.itemId, (r) => ({ ...r, retry: undefined }));
          continue;
        }
        if (notice) {
          try { if (await this.settle(record)) handled(); }
          catch (error) { handled(); throw error; }
          continue;
        }
        if (!record.activeRunId && record.launchingAt === undefined) {
          if (statusIs(card, this.deps.cfg.columns.building) && this.owned(card)) {
            handled();
            record = persistTicketNotice(this.deps.worktrees, record, card, "build", this.deps.cfg.columns.ready,
              failureComment("In Progress ticket has no active workflow run."));
            await this.settle(record);
          }
          continue;
        }
        handled();
        if (card.closed || !statusIs(card, this.deps.cfg.columns.building) || !this.owned(card)) { await this.withdraw(record, card); continue; }
        const check = this.deps.worktrees.check(record, false);
        if (!check.ok) throw new Error(check.reason);
        const manager = this.manager(record.path);
        if (!record.activeRunId) {
          const matches = this.matchingLaunchRuns(record, manager);
          if (matches.length !== 1) throw new Error(`Interrupted launch has ${matches.length} matching runs; retain launch window and retry observation.`);
          record = this.deps.worktrees.setActiveRun(record.itemId, matches[0].runId, Date.parse(matches[0].startedAt));
          summary.adopted++;
        }
        const run = manager.list().find((r) => r.runId === record.activeRunId);
        if (!run || !this.matches(record, run)) throw new Error("Persisted workflow is missing or mismatched; original run/script/args retained.");
        if (this.legacy?.owns(record.itemId) && !(await this.legacy.executionCard(record, card))) { await this.withdraw(record); continue; }
        if (["pending", "running"].includes(run.status)) {
          manager.startScheduling?.();
          summary.active.push({ itemId: record.itemId, taskKey: record.taskKey, runId: run.runId, status: run.status, worktree: record.path });
        } else if (run.status === "paused") {
          manager.startScheduling?.();
          if (run.pauseReason !== "usage_limit" && !this.stopping && await this.resumeAuthority(record.path, run.runId) && await manager.resume(run.runId)) summary.resumed++;
          summary.active.push({ itemId: record.itemId, taskKey: record.taskKey, runId: run.runId, status: run.status, worktree: record.path });
        } else if (await this.terminal(record, card, run)) summary.needsHuman++;
      } catch (error) {
        const current = this.deps.worktrees.read(record.itemId);
        handled(); this.resumeRevision++;
        if (!current || ["issueNumber", "createdAt", "path", "taskBranch", "baseBranch", "activeRunId", "launchingAt", "lastRunId"].some(
          (key) => (current as any)[key] !== (record as any)[key])) {
          summary.errors++;
          this.deps.callback(`Execution association changed for ${record.itemId}; preserving the newer record. ${String(error)}`, "warn");
          continue;
        }
        record = current;
        if (error instanceof TicketChangedError) {
          await this.withdraw(record, card).catch((e) => this.deps.callback(`Withdrawal drain pending: ${String(e)}`, "warn"));
        } else {
          summary.errors++;
          if (!record.retry && !record.finalization && !record.integration)
            this.deps.worktrees.update(record.itemId, (r) => ({ ...r, retry: { stage: "build", reason: String(error) } }));
        }
        this.deps.callback(`Reconcile ${record.itemId}: ${String(error)}`, "warn");
      }
    }
    // Unknown/corrupt evidence is not a product decision or permission to invent
    // ownership. Keep diagnostics and do not mutate GitHub.
    for (const card of cards) if (isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
      statusIs(card, this.deps.cfg.columns.building) && !this.deps.worktrees.read(card.itemId)) {
      summary.orphans++; summary.handledItemIds!.push(card.itemId);
      this.deps.callback(`Ticket ${card.itemId} has no readable execution record; preserved for retry observation.`, "warn");
    }
    this.activeCount();
    return summary;
  }

  private eligible(card: Card, expectedPlan: string, requireClaim = false): string | undefined {
    if (this.stopping) return "executor is stopping";
    const blocked = this.recoveryBlocker(card.itemId); if (blocked) return blocked;
    if (!isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task")) return "not a target Task Issue";
    if (card.closed || !statusIs(card, this.deps.cfg.columns.ready)) return "ticket is not open Ready";
    if (!card.plan || planSlug(card.plan) !== expectedPlan) return "Plan changed";
    if (card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase())) return "another assignee is present";
    if (requireClaim && !this.owned(card)) return "claim was not retained";
    const record = this.deps.worktrees.read(card.itemId);
    if (record?.activeRunId || record?.launchingAt !== undefined) return "ticket already has an active run";
    if (record?.retry?.reason.startsWith("Legacy merge conflict:")) return "Legacy board settlement must be observed before launch.";
    if (record?.retry?.stage === "review") return "retry the original SHA review, not a builder";
    if (this.deps.worktrees.hasCleanupReceipt(card.itemId)) return "pending cleanup receipt";
    return undefined;
  }

  private async currentLaunchCard(record: TicketExecutionRecord, expected: Card): Promise<Card> {
    const fresh = await this.deps.board.getCard(record.itemId);
    if (JSON.stringify(this.deps.worktrees.read(record.itemId)) !== JSON.stringify(record)) throw new Error("Execution record changed during launch.");
    if (!this.target(fresh, record) || ticketCardKey(fresh, record) !== ticketCardKey(expected, record) ||
      fresh.closed !== expected.closed || fresh.status !== expected.status || !this.owned(fresh))
      throw new TicketChangedError("Card changed during builder preparation.");
    return fresh;
  }

  async launch(snapshot: Card, expectedPlan: string, canStartWork: () => boolean | Promise<boolean> = () => true,
    canStartWorkNow: () => boolean = () => true): Promise<LaunchResult> {
    if (this.stopping) return { status: "skipped", reason: "executor is stopping" };
    this.canResume = canStartWork; this.canResumeNow = canStartWorkNow;
    let card = await this.deps.board.getCard(snapshot.itemId);
    if (!card || card.itemId !== snapshot.itemId || card.number !== snapshot.number) return { status: "skipped", reason: "issue identity changed" };
    const reason = this.eligible(card, expectedPlan); if (reason) return { status: "skipped", reason };
    let record = this.deps.worktrees.read(card.itemId);
    if (readTicketNotice(record?.retry?.reason)) {
      try { if (await this.settle(record!)) return { status: "skipped", reason: "retry settlement completed; defer builder until next tick" }; }
      catch (error) {
        if (!(error instanceof TicketChangedError) || record?.activeRunId || card.assignees.length) throw error;
      }
      record = this.deps.worktrees.read(card.itemId);
    }
    if (!(await this.deps.board.claim(card))) return { status: "skipped", reason: "claim lost" };
    const claimed = card;
    card = await this.deps.board.getCard(snapshot.itemId);
    if (!card || card.itemId !== claimed.itemId || card.number !== snapshot.number || this.eligible(card, expectedPlan, true)) {
      if (card && card.number === claimed.number && isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") && this.owned(card)) await this.deps.board.release(card);
      return { status: "skipped", reason: "card changed after claim" };
    }
    const task = buildTasksForWave(this.deps.cfg, expectedPlan, [card])[0];
    let started = false;
    try {
      record = await this.deps.worktrees.ensure(task, expectedPlan);
      task.taskKey = record.taskKey;
      card = await this.currentLaunchCard(record, card);
      const priorRetry = record.retry?.reason;
      const retryContext = readTicketNotice(priorRetry) ? priorRetry!.slice(priorRetry!.indexOf("\n") + 1) : priorRetry;
      record = this.deps.worktrees.beginLaunch(record.itemId);
      // Known-unstarted preparation. Removed synchronously before start(); a
      // later launch window is observation-only, never guessed or re-launched.
      record = persistTicketNotice(this.deps.worktrees, record, { ...card, status: this.deps.cfg.columns.building }, "build",
        this.deps.cfg.columns.ready, failureComment("Builder preparation was interrupted before invocation."));
      this.activeCount();
      await this.deps.board.setStatus(card.itemId, this.deps.cfg.columns.building);
      card = { ...card, status: this.deps.cfg.columns.building };
      const comments = this.deps.board.missionComments ? await this.deps.board.missionComments(card) : [];
      let context: string | undefined;
      try { context = await this.deps.context?.(record); }
      catch (error) { this.deps.callback(`Context generation failed: ${String(error)}`, "warn"); }
      const script = renderWorkflowSource({ cfg: this.deps.cfg, planSlug: expectedPlan, baseBranch: record.baseBranch,
        tasks: [{ ...task, baseBranch: record.baseBranch }], skillName: "board-agent", context,
        retry: retryContext, decisions: trustedMissionComments(comments, this.deps.botLogin) });
      const manager = this.manager(record.path);
      card = await this.currentLaunchCard(record, card);
      const admission = await canStartWork();
      card = await this.currentLaunchCard(record, card);
      const check = this.deps.worktrees.check(record, false);
      if (!check.ok) throw new Error(check.reason);
      if (!admission || !canStartWorkNow() || this.stopping) throw new Error("Builder admissions stopped.");
      record = this.deps.worktrees.update(record.itemId, (r) => {
        if (JSON.stringify(r) !== JSON.stringify(record)) throw new Error("Execution changed before builder start.");
        return { ...r, retry: retryContext ? { stage: "build", reason: retryContext } : undefined };
      });
      started = true;
      const runId = manager.start(script, { itemId: record.itemId, issueNumber: record.issueNumber, taskKey: record.taskKey },
        { maxAgents: 1, concurrency: 1, agentRetries: this.deps.cfg.builder_retries,
          ...(this.deps.cfg.builder_timeout_ms === undefined ? {} : { agentTimeoutMs: this.deps.cfg.builder_timeout_ms }) });
      try { this.deps.worktrees.setActiveRun(record.itemId, runId); }
      catch (error) { this.deps.callback(`Run ${runId} persisted; ticket binding pending: ${String(error)}`, "warn"); }
      this.activeCount();
      this.deps.callback(`Launched ${record.taskKey} as ${runId} in ${record.path}.`);
      return { status: "launched", runId, worktree: record.path };
    } catch (error) {
      const reason = String(error);
      if (record && !started) {
        if (error instanceof TicketChangedError) await this.withdraw(record, card);
        else {
          if (!readTicketNotice(record.retry?.reason)) record = persistTicketNotice(this.deps.worktrees, record, card, "build", this.deps.cfg.columns.ready, failureComment(reason));
          try { await this.settle(record); }
          catch (e) {
            if (e instanceof TicketChangedError) await this.withdraw(record, card);
            else this.deps.callback(`Launch settlement pending: ${String(e)}`, "warn");
          }
        }
      }
      if (!record) {
        // No verified record was returned: never fabricate ownership or erase
        // ensure's possible partial evidence. Only the original Issue's bot
        // claim can be freshly released; technical diagnostics remain local.
        const fresh = await this.deps.board.getCard(snapshot.itemId);
        if (fresh && isTargetIssue(fresh, this.deps.repoOwner, this.deps.repoName, "Task") &&
          fresh.itemId === snapshot.itemId && fresh.number === snapshot.number && this.owned(fresh))
          await this.deps.board.release(fresh);
      }
      this.deps.callback(`Builder launch ${snapshot.itemId}: ${reason}; original worktree/evidence retained.`, "warn");
      return { status: "skipped", reason };
    }
  }

  /** Ordinary builder retry seam for T004's verified pre-push conflicts. */
  async retryConflict(card: Card, conflict: MergeConflictError): Promise<void> {
    let record = this.deps.worktrees.read(card.itemId);
    if (!record || this.legacy?.blocker(card.itemId) || record.integration || record.finalization || record.activeRunId || record.launchingAt !== undefined ||
      this.deps.worktrees.hasCleanupReceipt(card.itemId)) throw new Error("Conflict requires the idle original ticket record.");
    const fresh = await this.deps.board.getCard(card.itemId);
    if (!this.target(fresh, record) || ticketCardKey(fresh, record) !== ticketCardKey(card, record) || !fresh.closed ||
      !(statusIs(fresh, this.deps.cfg.columns.done) || (record.retry?.stage === "integrate" && statusIs(fresh, this.deps.cfg.columns.ready))) || fresh.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
      throw new TicketChangedError("Conflict approval/identity/claim changed.");
    if (!this.owned(fresh) && !(await this.deps.board.claim(fresh))) throw new Error("Conflict claim lost.");
    card = await this.currentLaunchCard(record, { ...fresh, assignees: [this.deps.botLogin] });
    record = persistTicketNotice(this.deps.worktrees, record, card, "build", this.deps.cfg.columns.ready,
      failureComment(`Merge conflict after manual close.\nBase commit: ${conflict.baseSha}\nOriginal task commit: ${conflict.taskSha}\n${conflict.diagnostic}\n\nMerge this base into the ORIGINAL task branch, resolve conflicts preserving both sides' requirements, and run the existing relevant tests. Continue MERGE_HEAD if already present. Independent Review, Done and a NEW manual close are required.`));
    await this.settle(record);
  }

  /** Finalization failure settlement is closed-destination I/O, not the open
   * build/review helper. The reason carries the identity-bound pending notice. */
  private async settleFinalizationFailure(record: TicketExecutionRecord): Promise<boolean> {
    const match = /^<!-- board-agent-finalize:([a-f0-9]+):([^\n]+) -->\n/.exec(record.retry?.reason ?? "");
    if (!match) return false;
    const { board, cfg, worktrees } = this.deps;
    let changed = false;
    const fresh = async () => {
      const card = await board.getCard(record.itemId);
      if (this.stopping || (this.legacy && !this.legacy.authorityHeld()) || !this.target(card, record) || !card.closed ||
          ticketCardKey(card, record) !== match[1] ||
          ![decodeURIComponent(match[2]), cfg.columns.ready, ...(record.retry?.stage === "cleanup" ? [cfg.columns.done] : [])].some((s) => statusIs(card, s)) ||
          card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()) ||
          JSON.stringify(worktrees.read(record.itemId)) !== JSON.stringify(record))
        throw new TicketChangedError("Finalization failure settlement identity/claim/lane changed.");
      return card;
    };
    let card = await fresh();
    const body = record.retry!.reason;
    const comments = await board.listComments(card);
    const posted = comments.some((c) => typeof c === "string" ? c === body :
      c.body === body && c.author?.toLowerCase() === this.deps.botLogin.toLowerCase());
    if (!posted) {
      await board.comment(await fresh(), body); changed = true;
      const observed = await board.listComments(await fresh());
      if (!observed.some((c) => typeof c === "string" ? c === body : c.body === body && c.author?.toLowerCase() === this.deps.botLogin.toLowerCase()))
        throw new Error("Finalization diagnostic comment not yet observed.");
    }
    card = await fresh();
    if (!statusIs(card, cfg.columns.ready)) {
      await board.setStatus(card.itemId, cfg.columns.ready); changed = true;
      if (!statusIs(await fresh(), cfg.columns.ready)) throw new Error("Finalization Ready write not yet observed.");
    }
    card = await fresh();
    if (this.owned(card)) {
      await board.release(card); changed = true;
      if ((await fresh()).assignees.length) throw new Error("Finalization claim release not yet observed.");
    }
    return changed;
  }

  async finalizeClosed(snapshot: Card, _canStartWork: () => boolean | Promise<boolean> = () => true,
    _canStartWorkNow: () => boolean = () => true): Promise<FinalizeOutcome> {
    const { worktrees, board, cfg } = this.deps;
    let expected: Card | undefined, initial: TicketExecutionRecord | undefined;
    try {
      if (this.stopping || (this.legacy && !this.legacy.authorityHeld())) return { status: "blocked", reason: "Finalization owner is stopping or lost." };
      let card = await board.getCard(snapshot.itemId);
      initial = worktrees.read(snapshot.itemId);
      const retrying = initial?.retry && ["integrate", "cleanup"].includes(initial.retry.stage);
      if (!card || card.itemId !== snapshot.itemId || !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") ||
          card.number !== snapshot.number || !card.closed ||
          !(statusIs(card, cfg.columns.done) || (retrying && statusIs(card, cfg.columns.ready))) ||
          card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
        return { status: "skipped", reason: "Ticket is no longer the same approved closed Task or its retry lane." };
      if (initial && !this.target(card, initial)) return { status: "blocked", reason: "Original ticket identity/Plan changed." };
      const blocked = this.legacy?.blocker(card.itemId);
      if (blocked) return { status: "blocked", reason: blocked };
      if (initial?.retry && !retrying)
        return { status: "blocked", reason: "Ordinary build/review retry must finish before renewed Review, Done and manual close." };
      expected = card;
      if (initial && await this.settleFinalizationFailure(initial))
        return { status: "blocked", reason: "Finalization failure settled; retry integration/cleanup next tick." };
      if (initial?.retry?.reason.startsWith("<!-- board-agent-finalize:")) {
        initial = worktrees.update(initial.itemId, (r) => ({ ...r,
          retry: { ...r.retry!, reason: r.retry!.reason.slice(r.retry!.reason.indexOf("\n") + 1) } }));
      }
      const assertCurrent = async (done = false) => {
        const fresh = await board.getCard(snapshot.itemId);
        // An admitted finalization drains under the existing owner even when
        // scheduling stops; BoardLoop awaits this I/O before releasing the lock.
        if ((this.legacy && !this.legacy.authorityHeld()) || !fresh || !fresh.closed ||
            (initial ? ticketCardKey(fresh, initial) !== ticketCardKey(expected!, initial) :
              JSON.stringify(fresh) !== JSON.stringify(expected)) ||
            !statusIs(fresh, done ? cfg.columns.done : expected!.status!) ||
            fresh.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
          throw new TicketChangedError("Finalization approval, identity, claim or lane changed.");
      };
      const task = buildTasksForWave(cfg, "", [card])[0];
      if (initial) task.taskKey = initial.taskKey;
      const resultSha = await worktrees.finalizeAccepted(task, cfg.task_merge_strategy, assertCurrent,
        this.legacy ? { paths: (r) => this.legacy!.residualPaths(r), remove: (r, guard) => this.legacy!.removeResidual(r, guard) } : undefined);
      if (!resultSha) return { status: "skipped", reason: "No recorded task work remains." };
      await assertCurrent();
      if (!statusIs(card, cfg.columns.done)) await board.setStatus(card.itemId, cfg.columns.done);
      await assertCurrent(true); // a lost Project response keeps the same cleanup record
      await worktrees.completeFinalization(task, () => assertCurrent(true));
      this.deps.callback(`Finalized #${card.number} "${card.title}" at ${resultSha} in ${task.baseBranch}. Deleted local/remote branch ${task.taskBranch}, removed its worktree and observed Project Done.`);
      return { status: "finalized", resultSha };
    } catch (error) {
      if (error instanceof MergeConflictError && expected) {
        try {
          await this.retryConflict(expected, error);
          return { status: "conflict", baseSha: error.baseSha, taskSha: error.taskSha, reason: error.diagnostic };
        } catch (settlementError) {
          this.deps.callback(`Conflict Ready settlement pending: ${String(settlementError)}`, "warn");
          return { status: "blocked", reason: String(settlementError) };
        }
      }
      const current = worktrees.read(snapshot.itemId);
      if (!(error instanceof TicketChangedError) && initial && expected && current &&
          (["itemId", "issueNumber", "taskKey", "plan", "taskBranch", "baseBranch", "path", "createdAt", "lastRunId", "reviewedTaskSha"] as const)
            .every((key) => current[key] === initial![key]) &&
          !current.activeRunId && current.launchingAt === undefined &&
          (!current.retry || ["integrate", "cleanup"].includes(current.retry.stage))) {
        try {
          // Reuse unfinished settlement verbatim. Lost comment/status responses
          // are observed before another integration or cleanup attempt.
          const record = current.retry?.reason.startsWith("<!-- board-agent-finalize:") ? current :
            worktrees.update(current.itemId, (r) => ({ ...r, retry: {
              stage: r.retry?.stage === "cleanup" ? "cleanup" : "integrate",
              reason: `<!-- board-agent-finalize:${ticketCardKey(expected!, current)}:${encodeURIComponent(cfg.columns.done)} -->\nFinalization ${r.retry?.stage === "cleanup" ? "cleanup" : "integration"} failed: ${String(error)}\n\nIssue remains CLOSED (approval retained). Retry only integration/cleanup I/O, not a builder or review.`,
            } }));
          await this.settleFinalizationFailure(record);
        } catch (settlementError) {
          this.deps.callback(`Finalization Ready settlement pending: ${String(settlementError)}; retained retry record.`, "warn");
        }
      }
      return { status: "blocked", reason: String(error) };
    }
  }

  activeCount(): number {
    const active: ActiveTicketRun[] = [];
    for (const record of this.deps.worktrees.list()) {
      if (!record.activeRunId && record.launchingAt === undefined) continue;
      let status = "launching";
      if (record.activeRunId) {
        try {
          if (!this.deps.worktrees.check(record, false).ok) throw new Error("Unsafe worktree.");
          status = this.manager(record.path).list().find((r) => r.runId === record.activeRunId)?.status ?? "missing";
        } catch { status = "unreadable"; }
      }
      active.push({ itemId: record.itemId, taskKey: record.taskKey, runId: record.activeRunId ?? "launching", status, worktree: record.path });
    }
    // Terminal status isn't drain/release proof. Keep the slot until settlement.
    this.observation = { active, occupiedSlots: active.length };
    return active.length;
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
          if (!["running", "pending", "paused"].includes(run.status)) continue;
          try { await manager.pauseAndWait(run.runId); }
          catch (error) { errors.push(`${run.runId}: ${String(error)}`); }
        }
        if (errors.length === before) { manager.dispose(); this.managers.delete(path); }
      } catch (error) { errors.push(`${path}: ${String(error)}`); }
    }
    if (errors.length) throw new Error(`Could not pause workflow run(s): ${errors.join("; ")}`);
  }
}


export function createProductionTicketExecutor(options: {
  ownerLock?: OwnerLock;
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
    reopen: async (card) => reopenIssue(await resolveIssueId(card.repoOwner!, card.repoName!, card.number!)),
    missionComments: (card) => listIssueComments(card.repoOwner!, card.repoName!, card.number!),
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
      return listIssueComments(card.repoOwner, card.repoName, card.number);
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
    ownerLock: options.ownerLock,
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
