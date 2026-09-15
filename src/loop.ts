/** Core polling loop: reconcile durable ticket runs, then fill global worker slots. */
import type { Config } from "./config.js";
import { planSlug, taskBranch } from "./config.js";
import {
  type Card,
  type IssueComment,
  type ProjectMetadata,
  createComment,
  getCard,
  isTargetIssue,
  listCards,
  listIssueComments,
  release,
  setStatus,
  tryClaim,
} from "./gh.js";
import { isClean } from "./git-helpers.js";
import { renderReviewComment, runReview, parseReviewOutput, ticketReviewKey, cleanupTicketReview, type CompletedReview } from "./review.js";
import { persistTicketNotice, settleTicketNotice, ticketCardKey, TicketChangedError, failureComment } from "./dispatch.js";
import type { TicketExecutor } from "./ticket-executor.js";
import { TicketWorktrees } from "./ticket-worktree.js";
import { buildTasksForWave } from "./workflow-prompt.js";
import type { OwnerLock } from "./owner-lock.js";
import { assertSafeStateDirectories, assertSupportedState } from "./unsupported-state.js";

export type StatusCallback = (
  msg: string,
  level?: "info" | "warn" | "error",
) => void;

export interface LoopState {
  running: boolean;
  tickCount: number;
  wavesLaunched: number;
  lastTickMs: number;
  /** One loop-owned model invocation; never persisted or used as recovery evidence. */
  foreground: {
    kind: "review";
    label: string;
  } | null;
  /** Existing review observation, derived from the one foreground state. */
  readonly reviewingTask: string | null;
}

export interface LoopDeps {
  cwd: string;
  repoRoot?: string;
  cfg: Config;
  repoOwner: string;
  repoName: string;
  botLogin: string;
  meta: ProjectMetadata;
  callback: StatusCallback;
  onTick?: () => void | Promise<void>;
  revisionCheck?: () =>
    | { ok: boolean; reason?: string }
    | Promise<{ ok: boolean; reason?: string }>;
  /** Synchronous local settings/latch check after the last awaited observation.
   * Must not initiate async Git or reuse a display/capacity observation. */
  revisionCheckNow?: () => { ok: boolean; reason?: string };
  /** Offline adapters; production uses gh.ts and runReview. */
  listCards?: () => Promise<Card[]>;
  boardOps?: LoopBoardOps;
  review?: typeof runReview;
}

/** Board I/O seam for review and its settlement. */
export interface LoopBoardOps {
  claim(card: Card): Promise<boolean>;
  refresh(card: Card): Promise<Card | undefined>;
  release(card: Card): Promise<void>;
  listComments(card: Card): Promise<IssueComment[]>;
  comment(card: Card, body: string): Promise<string | undefined>;
  setStatus(card: Card, status: string): Promise<void>;
}

export function createLoopState(): LoopState {
  return {
    running: false,
    tickCount: 0,
    wavesLaunched: 0,
    lastTickMs: 0,
    foreground: null,
    get reviewingTask() {
      return this.foreground?.kind === "review" ? this.foreground.label : null;
    },
  };
}

export function allocateWorkerSlots(
  maxWorkers: number,
  occupiedSlots: number,
  foregroundPending: boolean,
): { builderSlots: number; foregroundSlots: number } {
  const available = Math.max(0, maxWorkers - occupiedSlots);
  const foregroundSlots = foregroundPending && available > 0 ? 1 : 0;
  return { builderSlots: available - foregroundSlots, foregroundSlots };
}

/** Includes the issue contract and lane: a fresh read of a different card is not freshness. */
function sameOpenCard(fresh: Card | undefined, expected: Card): fresh is Card {
  return (
    !!fresh &&
    fresh.closed === false &&
    expected.closed === false &&
    fresh.contentType === "Issue" &&
    fresh.itemId === expected.itemId &&
    fresh.number === expected.number &&
    fresh.repoOwner?.toLowerCase() === expected.repoOwner?.toLowerCase() &&
    fresh.repoName?.toLowerCase() === expected.repoName?.toLowerCase() &&
    fresh.type?.toLowerCase() === expected.type?.toLowerCase() &&
    fresh.plan === expected.plan &&
    fresh.title === expected.title &&
    fresh.body === expected.body &&
    fresh.status?.toLowerCase() === expected.status?.toLowerCase()
  );
}

class StaleCardError extends Error {}

function ownsClaim(card: Card, botLogin: string): boolean {
  const bot = botLogin.toLowerCase();
  return card.assignees.length === 1 && card.assignees[0].toLowerCase() === bot;
}

type BlockerNotice = { fingerprint: string; message: string };

export class BoardLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentTick: Promise<void> | null = null;
  private heartbeat: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly foreground = new AbortController();
  private readonly finalizationBlockers = new Map<string, string>();
  private stopped = false; // Cleanup complete, not merely cancellation requested.

  constructor(
    private readonly deps: LoopDeps,
    private readonly state: LoopState,
    private readonly executor: TicketExecutor,
    private readonly ticketWorktrees = new TicketWorktrees(deps.cwd),
    private readonly ownerLock?: OwnerLock,
    private admitNewWork = true,
  ) {}

  async start(): Promise<void> {
    if (this.state.running || this.foreground.signal.aborted) return;
    this.state.running = true;
    this.deps.callback(`Loop started (tick=${this.deps.cfg.tick_seconds}s)`);
    this.intervalId = setInterval(() => {
      const failed = (error: Error) =>
        this.deps.callback(`tick failed: ${error.message}`, "error");
      if (this.currentTick) {
        if (this.heartbeat) return;
        this.heartbeat = this.revisionAllowsNewWork()
          .then(() => undefined)
          .catch(failed)
          .finally(() => {
            this.heartbeat = null;
          });
      } else {
        void this.tickNow().catch(failed);
      }
    }, this.deps.cfg.tick_seconds * 1000);
    await this.tickNow().catch((error: Error) =>
      this.deps.callback(`start tick failed: ${error.message}`, "error"),
    );
  }

  isRunning(): boolean {
    return this.state.running;
  }

  isAdmittingNewWork(): boolean {
    return this.admitNewWork;
  }

  isStopping(): boolean {
    return this.foreground.signal.aborted && !this.stopped;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  enableAdmissions(): void {
    if (!this.foreground.signal.aborted) this.admitNewWork = true;
  }

  private async revisionAllowsNewWork(): Promise<boolean> {
    if (this.foreground.signal.aborted) return false;
    return this.applyRevisionCheck(await this.deps.revisionCheck?.());
  }

  private admissionStillAllowed(): boolean {
    return (
      this.applyRevisionCheck(this.deps.revisionCheckNow?.()) &&
      this.admitNewWork
    );
  }

  private applyRevisionCheck(revision?: {
    ok: boolean;
    reason?: string;
  }): boolean {
    if (this.foreground.signal.aborted) return false;
    if (!revision || revision.ok) return true;
    const wasAdmitting = this.admitNewWork;
    this.admitNewWork = false;
    if (wasAdmitting)
      this.deps.callback(
        revision.reason ??
          "Package revision changed; continuing recovery without new work.",
        "error",
      );
    return false;
  }

  async tickNow(): Promise<void> {
    if (this.currentTick) return this.currentTick;
    if (this.foreground.signal.aborted) return;
    const running = this.tick().finally(() => {
      if (this.currentTick === running) this.currentTick = null;
    });
    this.currentTick = running;
    return running;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.admitNewWork = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.state.running = false;
    const tick = this.currentTick;
    const heartbeat = this.heartbeat;
    // Publish the barrier before abort listeners can re-enter stop(). A failed
    // tick still propagates, but only an incomplete drain is retryable.
    this.stopPromise = Promise.resolve()
      .then(async () => {
        try {
          try {
            await tick;
          } finally {
            await heartbeat;
          }
        } finally {
          await this.executor.shutdown();
          this.ownerLock?.release();
          this.stopped = true;
          this.deps.callback("Loop stopped.", "info");
        }
      })
      .finally(() => {
        if (!this.stopped) this.stopPromise = null;
      });
    this.executor.stopScheduling?.();
    this.foreground.abort();
    return this.stopPromise;
  }

  private boardOps(): LoopBoardOps {
    const { cfg, meta, botLogin } = this.deps;
    return (
      this.deps.boardOps ?? {
        claim: (card) => tryClaim(card, botLogin),
        refresh: (card) =>
          getCard(
            card.itemId,
            cfg.status_field,
            cfg.plan_field,
            cfg.type_field,
          ),
        release: (card) => release(card, botLogin),
        listComments: (card) =>
          listIssueComments(card.repoOwner!, card.repoName!, card.number!),
        comment: (card, body) =>
          this.createCommentWithId(
            card.number!,
            card.repoOwner!,
            card.repoName!,
            body,
          ),
        setStatus: (card, status) => setStatus(meta, card.itemId, status),
      }
    );
  }

  private async currentCard(expected: Card, claimed = true): Promise<Card> {
    if (!(await this.revisionAllowsNewWork()) || !this.admitNewWork)
      throw new StaleCardError("Admissions stopped; preserving pending work.");
    const fresh = await this.boardOps().refresh(expected);
    if (
      !sameOpenCard(fresh, expected) ||
      fresh.assignees.some(
        (assignee) =>
          assignee.toLowerCase() !== this.deps.botLogin.toLowerCase(),
      ) ||
      (claimed && !ownsClaim(fresh, this.deps.botLogin))
    )
      throw new StaleCardError(
        `Card ${expected.itemId} changed; discarded stale work.`,
      );
    return fresh;
  }

  private fetchCards(): Promise<Card[]> {
    const { cfg, meta } = this.deps;
    return (
      this.deps.listCards?.() ??
      listCards(
        meta.projectId,
        cfg.status_field,
        cfg.plan_field,
        cfg.type_field,
      )
    );
  }

  private hasModelSlot(reserved = 0): boolean {
    return (
      this.executor.activeCount() + (this.state.foreground ? 1 : 0) + reserved <
      this.deps.cfg.max_workers
    );
  }

  /** Check at invocation, not candidate selection. Paused builders keep their
   * slots so automatic resume cannot add uncounted work during this await. */
  private async runForeground<T>(
    foreground: NonNullable<LoopState["foreground"]>,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    if (
      !(await this.revisionAllowsNewWork()) ||
      !this.admitNewWork ||
      this.state.foreground ||
      !this.hasModelSlot()
    )
      return undefined;
    this.state.foreground = foreground;
    try {
      const pending = run();
      // onTick can now await Git: handle an early model rejection immediately,
      // but still propagate it through the awaited drain below.
      void pending.catch(() => undefined);
      let result: T;
      // Even a failed UI update must drain the invocation before freeing its slot.
      try {
        await this.deps.onTick?.();
      } finally {
        result = await pending;
      }
      return result;
    } finally {
      this.state.foreground = null;
      await this.deps.onTick?.();
    }
  }

  private async tick(): Promise<void> {
    // Keep unsupported state read-only, including when introduced after startup.
    (this.executor.isolatesLegacyState ? assertSafeStateDirectories : assertSupportedState)(
      this.deps.cwd,
      this.deps.repoRoot ?? this.ticketWorktrees.repoRoot,
    );
    const blockers = new Map<string, BlockerNotice>();
    try {
      const { cfg, callback, repoOwner, repoName } = this.deps;
      const cards = await this.fetchCards();
      if (this.foreground.signal.aborted) return;
      const summary = await this.executor.reconcile(
        cards,
        async () => (await this.revisionAllowsNewWork()) && this.admitNewWork,
        () => this.admissionStillAllowed(),
      );
      if (this.foreground.signal.aborted) return;
      // Closed/Done is durable recovery, not a new admission (also on dirty/revision latch).
      const handledItemIds = new Set(summary.handledItemIds ?? []);
      await this.processClosedDoneCards(cards.filter((card) => !handledItemIds.has(card.itemId)), blockers);
      if (!(await this.revisionAllowsNewWork()) || !this.admitNewWork) return;
      if (cards.length === 0) {
        callback("No cards on the board yet.");
        return;
      }

      // Recovery must run even when the main checkout is dirty; only new launches stop here.
      if (cfg.safety.require_clean_worktree && !isClean(this.deps.cwd)) {
        callback(
          "Working tree is dirty. Reconciled existing runs but skipped new work.",
          "warn",
        );
        return;
      }

      const reviewCandidates = cards.filter(
        (card) =>
          !handledItemIds.has(card.itemId) &&
          ((card.status ?? "").toLowerCase() === cfg.columns.review.toLowerCase() ||
            ((card.status ?? "").toLowerCase() === cfg.columns.ready.toLowerCase() && this.ticketWorktrees.read(card.itemId)?.retry?.stage === "review")) &&
          card.closed === false &&
          isTargetIssue(card, repoOwner, repoName, "Task"),
      );
      const readyCandidates = cards.filter(
        (card) =>
          !handledItemIds.has(card.itemId) &&
          this.ticketWorktrees.read(card.itemId)?.retry?.stage !== "review" &&
          isTargetIssue(card, repoOwner, repoName, "Task") &&
          (card.status ?? "").toLowerCase() === cfg.columns.ready.toLowerCase() &&
          card.closed === false,
      );
      const attemptedItemIds = new Set<string>();
      const launchReady = async (
        limit: number,
        reserved = 0,
      ): Promise<void> => {
        let launched = 0;
        for (const card of readyCandidates) {
          if (
            launched >= limit ||
            !(await this.revisionAllowsNewWork()) ||
            !this.admitNewWork
          )
            break;
          if (!this.hasModelSlot(reserved)) break;
          if (attemptedItemIds.has(card.itemId)) continue;
          attemptedItemIds.add(card.itemId);
          const result = await this.executor.launch(
            card,
            card.plan ? planSlug(card.plan) : undefined,
            async () =>
              (await this.revisionAllowsNewWork()) && this.admitNewWork,
            () => this.admissionStillAllowed(),
          );
          if (result.status !== "launched") continue;
          blockers.delete(card.itemId);
          launched++;
          this.state.wavesLaunched++;
        }
      };

      const initialSlots = allocateWorkerSlots(
        cfg.max_workers,
        this.executor.activeCount(),
        reviewCandidates.length > 0,
      );
      // Reserve only for primary foreground work, and fill other slots FIRST.
      await launchReady(
        initialSlots.builderSlots,
        initialSlots.foregroundSlots,
      );

      if (initialSlots.foregroundSlots > 0 && this.admitNewWork)
        await this.processReviewCards(reviewCandidates);
      await launchReady(
        Math.max(0, cfg.max_workers - this.executor.activeCount()),
      );
    } finally {
      // One incident per ticket across reconcile, closed-Done and Ready wrappers.
      // The tick-local notices never authorize or suppress any fresh check/retry.
      for (const [itemId, notice] of blockers) {
        if (this.finalizationBlockers.get(itemId) === notice.fingerprint)
          continue;
        this.finalizationBlockers.set(itemId, notice.fingerprint);
        this.deps.callback(notice.message, "warn");
      }
      for (const itemId of this.finalizationBlockers.keys())
        if (!blockers.has(itemId)) this.finalizationBlockers.delete(itemId);
      this.state.tickCount++;
      this.state.lastTickMs = Date.now();
      await this.deps.onTick?.();
    }
  }

  private async createCommentWithId(
    issueNumber: number,
    repoOwner: string,
    repoName: string,
    body: string,
  ): Promise<string | undefined> {
    try {
      const { resolveIssueId } = await import("./gh.js");
      return await createComment(
        await resolveIssueId(repoOwner, repoName, issueNumber),
        body,
      );
    } catch {
      return undefined;
    }
  }

  private async processReviewCards(reviewCards: Card[]): Promise<void> {
    const { cfg, callback, repoOwner, repoName, botLogin } = this.deps;
    const board = this.boardOps();
    const settlementBoard = {
      getCard: (itemId: string) => board.refresh(reviewCards.find((c) => c.itemId === itemId)!),
      listComments: (card: Card) => board.listComments(card),
      comment: async (card: Card, body: string) => {
        const id = await board.comment(card, body);
        if (!id) throw new Error("Failed to post AI review result.");
      },
      setStatus: (itemId: string, status: string) => board.setStatus(reviewCards.find((c) => c.itemId === itemId)!, status),
      release: (card: Card) => board.release(card),
    };
    for (const card of reviewCards) {
      if (card.closed || !isTargetIssue(card, repoOwner, repoName, "Task") || this.executor.recoveryBlocker?.(card.itemId)) continue;
      let record = this.ticketWorktrees.read(card.itemId);
      // Missing/mismatched evidence is not a human decision or permission to
      // invent ownership. Active builder settlement keeps its claim and slot.
      if (!record || record.issueNumber !== card.number || record.plan !== (card.plan ? planSlug(card.plan) : undefined) ||
        record.activeRunId || record.launchingAt !== undefined || record.finalization || record.integration ||
        this.ticketWorktrees.hasCleanupReceipt(card.itemId)) {
        callback(`AI review ${card.itemId}: matching idle ticket evidence unavailable; retry observation.`, "warn");
        continue;
      }
      let claimed = false, persisted = false;
      try {
        await this.currentCard(card, false);
        claimed = true;
        if (!(await board.claim(card))) continue;
        const fresh = await this.currentCard(card);
        const task = buildTasksForWave(cfg, record.plan, [fresh])[0];
        if (record.taskBranch !== task.taskBranch || JSON.stringify(this.ticketWorktrees.read(record.itemId)) !== JSON.stringify(record))
          throw new TicketChangedError("Review branch/execution identity changed.");
        const check = this.ticketWorktrees.check(record, true);
        if (!check.ok) throw new Error(check.reason);
        if (!record.reviewedTaskSha) {
          const sha = this.ticketWorktrees.localBranchSha(record.taskBranch);
          if (!sha) throw new Error("Original successful build SHA unavailable.");
          record = this.ticketWorktrees.setReviewedTaskSha(record.itemId, sha);
        }
        const accept = async (review: CompletedReview) => {
          if (JSON.stringify(this.ticketWorktrees.read(record!.itemId)) !== JSON.stringify(record))
            throw new TicketChangedError("Execution changed while reviewing; preserve the new owner/run.");
          if (!parseReviewOutput(review) || review.taskSha !== record!.reviewedTaskSha)
            throw new Error("Review result is malformed or differs from the pinned successful build.");
          const target = review.verdict === "pass" ? cfg.columns.done : review.verdict === "needs_decision" ? cfg.columns.needs_human : cfg.columns.ready;
          const body = review.verdict === "pass"
            ? `## AI review passed\n\n${review.summary}\n\nReviewed SHA: ${review.taskSha}. Validate ${record!.path}, then manually close issue #${fresh.number}.`
            : renderReviewComment(review);
          record = persistTicketNotice(this.ticketWorktrees, record!, fresh, review.verdict === "fail" ? "build" : "review", target, body);
          persisted = true;
        };
        callback(`AI reviewing task "${fresh.title}" at ${record.reviewedTaskSha}…`);
        const review = await this.runForeground({ kind: "review", label: task.taskKey }, () =>
          (this.deps.review ?? runReview)({ cwd: this.deps.cwd, taskKey: task.taskKey, title: fresh.title, body: fresh.body,
            issueNumber: task.issueNumber, baseBranch: record!.baseBranch, taskBranch: record!.taskBranch,
            taskSha: record!.reviewedTaskSha, executionKey: ticketReviewKey(record!), onResult: accept,
            model: cfg.models.review, timeoutMs: cfg.review.timeout_ms, signal: this.foreground.signal,
            canStartWork: async () => { await this.currentCard(fresh); return true; },
            canStartWorkNow: () => this.admissionStillAllowed() && JSON.stringify(this.ticketWorktrees.read(record!.itemId)) === JSON.stringify(record) }));
        if (!review) return;
        if (!persisted) await accept(review); // injected offline reviewer uses the same settlement path
        await settleTicketNotice(this.ticketWorktrees, record, settlementBoard, botLogin);
        if (review.verdict !== "fail") this.ticketWorktrees.update(record.itemId, (r) => {
          if (JSON.stringify(r) !== JSON.stringify(record)) throw new TicketChangedError("Execution changed before review acknowledgement.");
          return { ...r, retry: undefined };
        });
        callback(review.verdict === "pass"
          ? `AI review passed for "${fresh.title}" at ${review.taskSha} → ${cfg.columns.done}. Validate ${record.path}, then close issue #${fresh.number} to merge.`
          : `AI review ${review.verdict} for "${fresh.title}"; result settled without another model invocation.`);
      } catch (error) {
        if (!persisted && !this.foreground.signal.aborted && !(error instanceof StaleCardError) && !(error instanceof TicketChangedError) &&
          JSON.stringify(this.ticketWorktrees.read(record.itemId)) === JSON.stringify(record)) {
          // Execution/tool/timeout failures retain this SHA and review stage.
          // Persist BEFORE GitHub I/O, even if a later read/status/release fails.
          record = persistTicketNotice(this.ticketWorktrees, record, card, "review", cfg.columns.ready, failureComment(`AI review execution failed: ${String(error)}`));
          persisted = true;
          if (!this.foreground.signal.aborted) {
            try { await cleanupTicketReview(this.deps.cwd, record); await settleTicketNotice(this.ticketWorktrees, record, settlementBoard, botLogin); }
            catch (settlementError) { callback(`Review retry settlement pending: ${String(settlementError)}`, "warn"); }
          }
        }
        callback(`AI review ${card.itemId}: ${String(error)}. Preserving result/SHA and pending I/O.`, "warn");
      } finally {
        if (claimed && !persisted && JSON.stringify(this.ticketWorktrees.read(record.itemId)) === JSON.stringify(record)) {
          try {
            const fresh = await board.refresh(card);
            if (fresh && ticketCardKey(fresh, record) === ticketCardKey(card, record) && ownsClaim(fresh, botLogin)) await board.release(fresh);
          } catch (error) {
            // No new review until this unfinished release has been observed.
            persistTicketNotice(this.ticketWorktrees, record, card, "review", cfg.columns.ready, failureComment(`Review claim release failed: ${String(error)}`));
            callback(`Review claim release pending: ${String(error)}`, "warn");
          }
        }
      }
      return;
    }
  }

  private async processClosedDoneCards(
    cards: Card[],
    blockers: Map<string, BlockerNotice>,
  ): Promise<void> {
    const { cfg, callback, repoOwner, repoName } = this.deps;
    const candidates = cards.filter(
      (card) =>
        card.closed === true &&
        ((card.status ?? "").toLowerCase() === cfg.columns.done.toLowerCase() ||
          ((card.status ?? "").toLowerCase() === cfg.columns.ready.toLowerCase() &&
            ["integrate", "cleanup"].includes(this.ticketWorktrees.read(card.itemId)?.retry?.stage ?? ""))) &&
        isTargetIssue(card, repoOwner, repoName, "Task"),
    );
    if (!candidates.length || this.foreground.signal.aborted) return;
    let refs: Set<string>;
    try {
      refs = await this.ticketWorktrees.localTaskRefs(cfg.branches.task_prefix);
    } catch (error) {
      callback(
        `Closed-Done finalization blocked: local task refs query failed: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      return;
    }
    for (const card of candidates) {
      if (this.foreground.signal.aborted) return;
      // Absence only defers this tick. Presence still requires all fresh checks.
      if (
        !refs.has(
          `refs/heads/${taskBranch(cfg.branches.task_prefix, card.number!)}`,
        ) &&
        !this.ticketWorktrees.read(card.itemId)?.integration &&
        !this.ticketWorktrees.read(card.itemId)?.retry
      ) {
        continue;
      }
      const outcome = await this.executor.finalizeClosed(
        card,
        async () => (await this.revisionAllowsNewWork()) && this.admitNewWork,
        () => this.admissionStillAllowed(),
      );
      if (outcome.status === "finalized" || outcome.status === "skipped")
        blockers.delete(card.itemId);
      if (outcome.status !== "conflict" && outcome.status !== "blocked")
        continue;
      if (blockers.has(card.itemId)) continue;
      // Suppress only the notification, never the fresh check/retry above.
      const fingerprint = JSON.stringify([
        outcome.status,
        outcome.status === "conflict" ? outcome.baseSha : null,
        outcome.status === "conflict" ? outcome.taskSha : null,
        outcome.reason,
      ]);
      blockers.set(card.itemId, {
        fingerprint,
        message:
          outcome.status === "conflict"
            ? `Finalization conflict for #${card.number} "${card.title}": ${taskBranch(cfg.branches.task_prefix, card.number!)} at ${outcome.taskSha} conflicts with ${cfg.branches.base} at ${outcome.baseSha}. Original branches/worktree preserved; no integration commit or push. Reopen/Ready settlement routes the conflict through the ordinary builder, then Review/Done and a new manual close.\n${outcome.reason}`
            : `Finalization blocked for "${card.title}": ${outcome.reason}`,
      });
    }
  }
}
