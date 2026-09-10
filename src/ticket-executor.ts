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
  type Card,
  type ProjectMetadata,
} from "./gh.js";
import {
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
}

export type LaunchResult =
  | { status: "launched"; runId: string; worktree: string }
  | { status: "skipped"; reason: string }
  | { status: "needs-human"; reason: string };

export type FinalizeOutcome =
  | { status: "finalized"; resultSha: string }
  | { status: "skipped"; reason: string }
  | { status: "blocked"; reason: string };

export interface TicketExecutor {
  reconcile(cards: Card[]): Promise<ReconcileSummary>;
  launch(card: Card, planSlug: string): Promise<LaunchResult>;
  finalizeClosed(card: Card): Promise<FinalizeOutcome>;
  activeCount(): number;
  shutdown(): Promise<void>;
}

export interface TicketBoardAdapter {
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
    args: { itemId: string; issueNumber: number; taskKey: string },
    options: {
      maxAgents: number;
      concurrency: number;
      agentRetries: number;
      agentTimeoutMs?: number;
    },
  ): string;
  list(): PersistedRunState[];
  resume(runId: string): Promise<boolean>;
  pauseAndWait(runId: string): Promise<void>;
  stopAndWait(runId: string): Promise<void>;
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
  context?(): Promise<string | undefined>;
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
    args.issueNumber === record.issueNumber
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
  const scheduler = new UsageLimitScheduler(manager, {
    onDiagnostic: (message) =>
      options.callback(`Workflow scheduler: ${message}`, "warn"),
  });

  const waitForSettlement = async (runId: string) => {
    while (manager.getRun(runId)?.lease) await delay(25);
  };

  return {
    start(script, args, exec) {
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
    resume: (runId) => manager.resume(runId),
    async pauseAndWait(runId) {
      manager.pause(runId);
      await waitForSettlement(runId);
    },
    async stopAndWait(runId) {
      manager.stop(runId);
      await waitForSettlement(runId);
    },
    dispose() {
      scheduler.dispose();
      manager.off("error", onError);
    },
  };
}

export class ManagedTicketExecutor implements TicketExecutor {
  private readonly managers = new Map<string, TicketWorkflowManager>();

  constructor(private readonly deps: TicketExecutorDeps) {}

  private manager(path: string): TicketWorkflowManager {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    let manager = this.managers.get(key);
    if (!manager) {
      manager = this.deps.createManager(path);
      this.managers.set(key, manager);
    }
    return manager;
  }

  private async commentOnce(
    card: Card,
    uniqueMarker: string,
    body: string,
  ): Promise<void> {
    const comments = await this.deps.board.listComments(card);
    if (!comments.some((comment) => comment.includes(uniqueMarker))) {
      await this.deps.board.comment(card, `${uniqueMarker}\n${body}`);
    }
  }

  private async quarantineWithoutRecord(
    card: Card,
    reason: string,
  ): Promise<LaunchResult> {
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
    );
    if (!statusIs(card, this.deps.cfg.columns.needs_human)) {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.needs_human,
      );
      card.status = this.deps.cfg.columns.needs_human;
    }
    await this.deps.board.release(card);
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
    );
    if (!statusIs(card, this.deps.cfg.columns.review)) {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.review,
      );
      card.status = this.deps.cfg.columns.review;
    }
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
          new Date(run.startedAt).getTime() >= cutoff,
      );
  }

  private async recoverLaunching(
    record: TicketExecutionRecord,
    card: Card,
    summary: ReconcileSummary,
  ): Promise<TicketExecutionRecord | undefined> {
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

    const check = this.deps.worktrees.check(record, true);
    if (check.ok && !this.deps.worktrees.hasTaskDelta(record)) {
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
    await manager.stopAndWait(record.activeRunId!);
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
    this.deps.worktrees.clearExecution(record.itemId, record.activeRunId);
    this.deps.callback(
      `Stopped stale run ${record.activeRunId}; preserved manual status ${card.status ?? "unknown"}.`,
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
    if (!run || !runArgsMatch(run, record)) {
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
    summary.orphans++;
    this.deps.callback(
      `Stopped orphaned ticket run ${record.activeRunId ?? record.itemId}; its Project item is gone and worktree was preserved.`,
      "warn",
    );
  }

  async reconcile(cards: Card[]): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      active: [],
      resumed: 0,
      adopted: 0,
      needsHuman: 0,
      orphans: 0,
      errors: 0,
    };
    const cardsById = new Map(cards.map((card) => [card.itemId, card]));
    const records = this.deps.worktrees.list();
    const recordIds = new Set(records.map((record) => record.itemId));

    for (const original of records) {
      let snapshot = cardsById.get(original.itemId);
      if (!snapshot) {
        try {
          snapshot = await this.deps.board.getCard(original.itemId);
        } catch (error: any) {
          summary.errors++;
          this.deps.callback(
            `Could not verify missing board card ${original.itemId}: ${error.message}`,
            "warn",
          );
          continue;
        }
        if (!snapshot) {
          if (original.activeRunId || original.launchingAt !== undefined) {
            try {
              await this.stopMissingCardRun(original, summary);
            } catch (error: any) {
              summary.errors++;
              this.deps.callback(
                `Could not stop orphaned ticket ${original.itemId}: ${error.message}`,
                "warn",
              );
            }
          }
          continue;
        }
      }
      if (
        !isTargetIssue(
          snapshot,
          this.deps.repoOwner,
          this.deps.repoName,
          "Task",
        )
      )
        continue;
      try {
        const card =
          (await this.deps.board.getCard(original.itemId)) ?? snapshot;
        if (
          !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task")
        )
          continue;
        snapshot.status = card.status;
        snapshot.plan = card.plan;
        snapshot.assignees = card.assignees;
        snapshot.closed = card.closed;

        // A valid finalization journal owns the ticket until cleanup finishes.
        // Mixed execution/finalization files are unsupported, never migrated here.
        if (original.finalization) continue;

        let record: TicketExecutionRecord | undefined = original;
        if (record.launchingAt !== undefined && !record.activeRunId)
          record = await this.recoverLaunching(record, card, summary);
        if (record?.activeRunId)
          await this.reconcileActive(record, card, summary);
        else if (record && statusIs(card, this.deps.cfg.columns.building)) {
          await this.moveToNeedsHuman(
            record,
            card,
            "In Progress ticket has no active workflow run",
          );
          summary.needsHuman++;
        }
      } catch (error: any) {
        summary.errors++;
        this.deps.callback(
          `Reconcile failed for ${original.itemId}: ${error.message}`,
          "warn",
        );
      }
    }

    for (const snapshot of cards) {
      if (
        !isTargetIssue(
          snapshot,
          this.deps.repoOwner,
          this.deps.repoName,
          "Task",
        ) ||
        !statusIs(snapshot, this.deps.cfg.columns.building) ||
        recordIds.has(snapshot.itemId)
      )
        continue;
      try {
        const card =
          (await this.deps.board.getCard(snapshot.itemId)) ?? snapshot;
        if (!statusIs(card, this.deps.cfg.columns.building)) continue;
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

    return summary;
  }

  private eligible(
    card: Card,
    expectedPlan: string,
    requireClaim = false,
  ): string | undefined {
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
    if (record?.finalization)
      return "ticket has a pending finalization; recover it before starting another builder";
    if (record && (record.activeRunId || record.launchingAt !== undefined))
      return "ticket already has an active run";
    return undefined;
  }

  private async resetUnstarted(
    record: TicketExecutionRecord,
    card: Card,
    reason: string,
  ): Promise<LaunchResult> {
    const check = this.deps.worktrees.check(record, true);
    if (check.ok && !this.deps.worktrees.hasTaskDelta(record)) {
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

  async launch(snapshot: Card, expectedPlan: string): Promise<LaunchResult> {
    let card = await this.deps.board.getCard(snapshot.itemId);
    if (!card) return { status: "skipped", reason: "card no longer exists" };
    if (card.itemId !== snapshot.itemId || card.number !== snapshot.number)
      return { status: "skipped", reason: "issue identity changed" };
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
      record = this.deps.worktrees.ensure(task, expectedPlan);
    } catch (error: any) {
      return this.quarantineWithoutRecord(
        card,
        `worktree preparation failed: ${error.message}`,
      );
    }
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

    record = this.deps.worktrees.beginLaunch(record.itemId);
    try {
      await this.deps.board.setStatus(
        card.itemId,
        this.deps.cfg.columns.building,
      );
      card.status = this.deps.cfg.columns.building;
    } catch (error: any) {
      await this.deps.board.release(card);
      this.deps.worktrees.clearExecution(record.itemId);
      return {
        status: "skipped",
        reason: `could not move ticket to ${this.deps.cfg.columns.building}: ${error.message}`,
      };
    }

    let context: string | undefined;
    try {
      context = await this.deps.context?.();
    } catch (error: any) {
      this.deps.callback(`Context generation failed: ${error.message}`, "warn");
    }

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
        return this.resetUnstarted(
          record,
          card,
          `workflow launch failed: ${error.message}`,
        );
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
    this.deps.callback(
      `Launched ${record.taskKey} as ${runId} in ${record.path}.`,
    );
    return { status: "launched", runId, worktree: record.path };
  }

  async finalizeClosed(snapshot: Card): Promise<FinalizeOutcome> {
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
    if (
      card.itemId !== snapshot.itemId ||
      card.number !== snapshot.number ||
      !card.plan ||
      !snapshot.plan ||
      planSlug(card.plan) !== planSlug(snapshot.plan)
    )
      return { status: "skipped", reason: "issue or Plan changed" };
    if (!card.closed || !statusIs(card, this.deps.cfg.columns.done))
      return {
        status: "skipped",
        reason: "ticket is no longer closed and Done",
      };

    const target = this.deps.cfg.branches.base;
    try {
      if (
        !this.deps.worktrees.has(card.itemId) &&
        this.deps.worktrees.isMerged(card.itemId, target)
      )
        return { status: "skipped", reason: "already finalized" };
      const record = this.deps.worktrees.read(card.itemId);
      if (!record)
        return {
          status: "blocked",
          reason: "missing or unsupported v3 execution record",
        };
      const task = buildTasksForWave(this.deps.cfg, planSlug(card.plan), [
        card,
      ])[0];
      if (
        record.itemId !== card.itemId ||
        record.issueNumber !== card.number ||
        record.plan !== planSlug(card.plan) ||
        record.taskBranch !== task.taskBranch ||
        record.baseBranch !== target
      )
        return {
          status: "blocked",
          reason: "execution record does not match the fresh ticket",
        };
      if (record.activeRunId || record.launchingAt !== undefined)
        return {
          status: "blocked",
          reason: "builder execution is still active",
        };
      if (this.deps.cfg.review.enabled && !record.reviewedTaskSha)
        return {
          status: "blocked",
          reason:
            "AI review is enabled but the ticket has no persisted reviewed task SHA",
        };

      const result = this.deps.worktrees.finalizeAccepted(
        record,
        this.deps.cfg.task_merge_strategy,
        card.title,
        target,
      );
      this.deps.callback(
        `Finalized #${card.number} "${card.title}" at ${result.resultSha} in ${target}. Deleted local/remote branch ${record.taskBranch} and removed its worktree.`,
      );
      return { status: "finalized", resultSha: result.resultSha };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.callback(
        `Finalization blocked for "${card.title}": ${reason}`,
        "warn",
      );
      return { status: "blocked", reason };
    }
  }

  activeCount(): number {
    let count = 0;
    for (const record of this.deps.worktrees.list()) {
      if (record.launchingAt !== undefined && !record.activeRunId) {
        count++;
        continue;
      }
      if (!record.activeRunId) continue;
      try {
        const run = this.manager(record.path)
          .list()
          .find((candidate) => candidate.runId === record.activeRunId);
        if (
          !run ||
          run.status === "pending" ||
          run.status === "running" ||
          run.status === "paused"
        )
          count++;
      } catch {
        count++;
      }
    }
    return count;
  }

  async shutdown(): Promise<void> {
    const errors: string[] = [];
    for (const manager of this.managers.values()) {
      for (const run of manager.list()) {
        if (run.status !== "running" && run.status !== "pending") continue;
        try {
          await manager.pauseAndWait(run.runId);
        } catch (error: any) {
          errors.push(`${run.runId}: ${error.message}`);
        }
      }
      manager.dispose();
    }
    this.managers.clear();
    if (errors.length > 0)
      throw new Error(`Could not pause workflow run(s): ${errors.join("; ")}`);
  }
}

export function createProductionTicketExecutor(options: {
  cwd: string;
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
  const worktrees = new TicketWorktrees(options.cwd);
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
        callback: options.callback,
      }),
    context: options.cfg.context.enabled
      ? async () => {
          const { generateContext } = await import("./context.js");
          return generateContext({
            cwd: options.cwd,
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
): {
  active: ActiveTicketRun[];
  orphans: number;
  needsHuman: number;
} {
  const worktrees = new TicketWorktrees(cwd);
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
