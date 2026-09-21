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
import { parseReviewOutput, renderReviewComment, runReview } from "./review.js";
import { parseDecision, renderDecisionComment } from "./dispatch.js";
import {
  pendingTicketWrite,
  queueTicketWrite,
  settleTicketWrite,
} from "./ticket-retry.js";
import type { TicketExecutor } from "./ticket-executor.js";
import {
  TicketWorktrees,
  type TicketExecutionRecordV5 as TicketExecutionRecord,
} from "./ticket-worktree.js";
import { buildTasksForWave } from "./workflow-prompt.js";
import { ownerLockIsHeld, type OwnerLock } from "./owner-lock.js";
import { assertSupportedState } from "./unsupported-state.js";
import { observeOperation, type OperationObservation } from "./operation.js";

export type StatusCallback = (
  msg: string,
  level?: "info" | "warn" | "error",
) => void;

export interface LoopState extends OperationObservation {
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
  /** Cached display/runtime publication only; no Git, board or capacity scans. */
  onActivity?: () => void;
  revisionCheck?: () =>
    | { ok: boolean; reason?: string }
    | Promise<{ ok: boolean; reason?: string }>;
  /** Synchronous startup/lint admission latch check after the last awaited observation.
   * Must not initiate async Git or reuse a display/capacity observation. */
  revisionCheckNow?: () => { ok: boolean; reason?: string };
  /** Offline adapters; production uses gh.ts and runReview. */
  listCards?: () => Promise<Card[]>;
  boardOps?: LoopBoardOps;
  review?: typeof runReview;
}

/** Board I/O seam for review integration checks. */
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

export class BoardLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentTick: Promise<void> | null = null;
  private heartbeat: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly foreground = new AbortController();
  private readonly finalizationBlockers = new Map<string, string>();
  private finalization?: { itemId: string; promise: Promise<void>; controller: AbortController };
  private finalizationCursor?: string;
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
    void this.tickNow().catch((error: Error) =>
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
      (!this.ownerLock || ownerLockIsHeld(this.ownerLock)) &&
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
    const tick = this.currentTick;
    const heartbeat = this.heartbeat;
    // Publish the barrier before abort listeners can re-enter stop(). A failed
    // tick still propagates, but only an incomplete drain is retryable.
    this.stopPromise = Promise.resolve()
      .then(async () => {
        const settled = await Promise.allSettled([tick, heartbeat, this.finalization?.promise]);
        await this.executor.shutdown();
        this.ownerLock?.release();
        this.stopped = true;
        this.deps.callback("Loop stopped.", "info");
        const failed = settled.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })
      .finally(() => {
        if (!this.stopped) this.stopPromise = null;
      });
    this.requestStop();
    return this.stopPromise;
  }

  /** Immediate veto; the owner is released only by the awaited stop barrier. */
  requestStop(): void {
    this.admitNewWork = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.state.running = false;
    this.executor.stopScheduling?.();
    this.foreground.abort();
    this.finalization?.controller.abort();
    this.deps.onActivity?.();
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
      // Handle an early model rejection immediately, including during UI updates,
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
    assertSupportedState(
      this.deps.cwd,
      this.deps.repoRoot ?? this.ticketWorktrees.repoRoot,
      true,
    );
    try {
      const { cfg, callback, repoOwner, repoName } = this.deps;
      let cards = await this.fetchCards();
      if (this.foreground.signal.aborted) return;
      const excludedItemId = this.finalization?.itemId;
      const summary = await this.executor.reconcile(
        cards,
        async () => (await this.revisionAllowsNewWork()) && this.admitNewWork,
        () => this.admissionStillAllowed(),
        excludedItemId,
      );
      cards = cards.filter(
        (card) => !this.executor.legacyBlocked?.(card.itemId),
      );
      if (this.foreground.signal.aborted) return;
      // Closed/Done is durable recovery, not a new admission (also on dirty/revision latch).
      const attemptedItemIds = new Set(summary.attemptedItemIds ?? []);
      if (excludedItemId) attemptedItemIds.add(excludedItemId);
      this.processClosedDoneCards(cards, attemptedItemIds);
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
          !attemptedItemIds.has(card.itemId) &&
          card.closed === false &&
          isTargetIssue(card, repoOwner, repoName, "Task") &&
          (card.status?.toLowerCase() === cfg.columns.review.toLowerCase() ||
            (card.status?.toLowerCase() === cfg.columns.ready.toLowerCase() &&
              this.ticketWorktrees.readStored(card.itemId)?.retry?.stage ===
                "review")),
      );
      const readyCandidates = cards.filter(
        (card) =>
          isTargetIssue(card, repoOwner, repoName, "Task") &&
          card.status?.toLowerCase() === cfg.columns.ready.toLowerCase() &&
          card.closed === false &&
          (!this.ticketWorktrees.readStored(card.itemId)?.retry ||
            this.ticketWorktrees.readStored(card.itemId)?.retry?.stage === "build"),
      );
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
          this.finalizationBlockers.delete(card.itemId);
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
        await this.processReviewCards(reviewCandidates, attemptedItemIds);
      await launchReady(
        Math.max(0, cfg.max_workers - this.executor.activeCount()),
      );
    } finally {
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

  private async processReviewCards(
    reviewCards: Card[],
    attemptedItemIds: Set<string>,
  ): Promise<void> {
    const { cfg, callback, repoOwner, repoName, botLogin } = this.deps;
    const board = this.boardOps();
    const writeBoard = {
      getCard: async (itemId: string) =>
        board.refresh(reviewCards.find((c) => c.itemId === itemId)!),
      setStatus: async (itemId: string, status: string) =>
        board.setStatus(reviewCards.find((c) => c.itemId === itemId)!, status),
      listComments: async (card: Card) =>
        (await board.listComments(card))
          .filter((c) => c.author?.toLowerCase() === botLogin.toLowerCase())
          .map((c) => c.body),
      comment: async (card: Card, body: string) => {
        if (!(await board.comment(card, body)))
          throw new Error("Failed to post review result.");
      },
      release: (card: Card) => board.release(card),
    };
    for (const card of reviewCards) {
      if (
        card.closed ||
        attemptedItemIds.has(card.itemId) ||
        !isTargetIssue(card, repoOwner, repoName, "Task")
      )
        continue;
      let claimed = false;
      let record: TicketExecutionRecord | undefined;
      try {
        await this.currentCard(card, false);
        claimed = true;
        if (!(await board.claim(card))) continue;
        const fresh = await this.currentCard(card);
        const task = buildTasksForWave(
          cfg,
          card.plan ? planSlug(card.plan) : "",
          [fresh],
        )[0];
        record = this.ticketWorktrees.read(card.itemId);
        if (
          !record ||
          record.schemaVersion !== 5 ||
          record.issueNumber !== fresh.number ||
          record.plan !== (card.plan ? planSlug(card.plan) : undefined) ||
          record.taskBranch !== task.taskBranch ||
          record.activeRunId ||
          record.launchingAt !== undefined ||
          (record.integration && !(record.integration.kind === "pr" && record.integration.phase === "suspended")) ||
          pendingTicketWrite(record) ||
          this.ticketWorktrees.hasCleanupReceipt(card.itemId)
        )
          throw new StaleCardError(
            "Missing matching idle v5 ticket before review.",
          );
        const assertRecord = () => {
          if (
            JSON.stringify(this.ticketWorktrees.read(card.itemId)) !==
            JSON.stringify(record)
          )
            throw new StaleCardError("Execution record changed during review.");
        };
        attemptedItemIds.add(card.itemId);
        callback(`AI reviewing task "${fresh.title}" on ${task.taskBranch}…`);
        const review = await this.runForeground(
          { kind: "review", label: task.taskKey },
          () =>
            (this.deps.review ?? runReview)({
              cwd: this.deps.cwd,
              taskKey: task.taskKey,
              title: fresh.title,
              body: fresh.body,
              issueNumber: task.issueNumber,
              baseBranch: record!.baseBranch,
              taskBranch: task.taskBranch,
              model: cfg.models.review,
              timeoutMs: cfg.review.timeout_ms,
              taskSha:
                record!.retry?.stage === "review"
                  ? record!.reviewedTaskSha
                  : undefined,
              onPinnedTaskSha: async (sha) => {
                await this.currentCard(fresh);
                assertRecord();
                if (!this.admissionStillAllowed())
                  throw new StaleCardError("Review admissions stopped.");
                record = this.ticketWorktrees.setReviewedTaskSha(
                  card.itemId,
                  sha,
                  this.ownerLock ?? this.ticketWorktrees.owner,
                  () => { assertRecord(); if (!this.admissionStillAllowed()) throw new StaleCardError("Review stopped."); },
                );
              },
              signal: this.foreground.signal,
              canStartWork: async () => {
                await this.currentCard(fresh);
                assertRecord();
                return true;
              },
              canStartWorkNow: () => this.admissionStillAllowed(),
            }),
        );
        if (!review) return;
        const latest = await this.currentCard(fresh);
        assertRecord();
        const parsed = parseReviewOutput(review);
        if (!parsed) throw new Error("Review returned malformed output.");
        record = this.ticketWorktrees.setReviewedTaskSha(
          latest.itemId,
          review.taskSha,
          this.ownerLock ?? this.ticketWorktrees.owner,
          () => { assertRecord(); if (!this.admissionStillAllowed()) throw new StaleCardError("Review stopped."); },
        );
        const decision =
          parsed.verdict === "needs_decision"
            ? parseDecision(parsed)
            : undefined;
        const pass = parsed.verdict === "pass";
        record = queueTicketWrite(
          this.ticketWorktrees,
          record,
          pass ? "review" : "build",
          {
            card: latest,
            retry: !pass,
            reason: decision
              ? decision.question
              : pass
                ? parsed.summary || "Review passed"
                : renderReviewComment(parsed),
            status: pass
              ? cfg.columns.done
              : decision
                ? cfg.columns.needs_human
                : cfg.columns.ready,
            ...(pass
              ? {}
              : {
                  comment: decision
                    ? renderDecisionComment(decision)
                    : renderReviewComment(parsed),
                }),
          },
          this.ownerLock ?? this.ticketWorktrees.owner,
          () => { assertRecord(); if (!this.admissionStillAllowed()) throw new StaleCardError("Review stopped."); },
        );
        await settleTicketWrite(
          this.ticketWorktrees,
          record,
          writeBoard,
          botLogin,
          undefined,
          { signal: this.foreground.signal },
          this.ownerLock ?? this.ticketWorktrees.owner,
        );
        claimed = false;
        callback(
          pass
            ? `AI review passed for "${latest.title}" at ${review.taskSha} → ${cfg.columns.done}. Validate ${record.path}, then close issue #${latest.number} to submit a PR for manual merge.`
            : `AI review ${parsed.verdict} for "${latest.title}" at ${review.taskSha}.`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A model/setup failure retries review, not a successful build. Once
        // output is recorded, only its I/O is retried, never the model.
        if (
          record &&
          !(error instanceof StaleCardError) &&
          !pendingTicketWrite(record)
        ) {
          try {
            const current = await this.currentCard(card);
            if (
              JSON.stringify(this.ticketWorktrees.read(card.itemId)) !==
              JSON.stringify(record)
            )
              throw new StaleCardError("Review record changed.");
            record = queueTicketWrite(this.ticketWorktrees, record, "review", {
              card: current,
              status: cfg.columns.ready,
              retry: true,
              reason,
              comment: `## Review infrastructure failure\n\n${reason}\n\nRetry review of the original commit; no new builder is needed.`,
            });
            await settleTicketWrite(
              this.ticketWorktrees,
              record,
              writeBoard,
              botLogin,
              undefined,
              { signal: this.foreground.signal },
              this.ownerLock ?? this.ticketWorktrees.owner,
            );
            claimed = false;
          } catch (writeError) {
            callback(
              `Review writeback deferred: ${String(writeError)}`,
              "warn",
            );
          }
        }
        callback(
          `AI review failed for "${card.title}": ${reason}. State retained.`,
          "warn",
        );
      } finally {
        // Pending writeback owns release until its drain and preceding I/O finish.
        if (claimed && !(record && pendingTicketWrite(record))) {
          try {
            if (record) {
              record = queueTicketWrite(
                this.ticketWorktrees,
                record,
                "review",
                {
                  card,
                  status: card.status!,
                  retry: !!record.retry,
                  reason:
                    record.retry?.reason ??
                    "Review admission deferred; release the stopped invocation's claim.",
                },
                this.ownerLock ?? this.ticketWorktrees.owner,
              );
              await settleTicketWrite(
                this.ticketWorktrees,
                record,
                writeBoard,
                botLogin,
                undefined, undefined, this.ownerLock ?? this.ticketWorktrees.owner,
              );
            } else {
              const fresh = await board.refresh(card);
              if (
                fresh &&
                isTargetIssue(fresh, repoOwner, repoName, "Task") &&
                fresh.itemId === card.itemId &&
                fresh.number === card.number &&
                fresh.assignees.some(
                  (a) => a.toLowerCase() === botLogin.toLowerCase(),
                )
              )
                await board.release(fresh);
            }
          } catch (error) {
            callback(`Review claim release deferred: ${String(error)}`, "warn");
          }
        }
      }
      return;
    }
  }

  private processClosedDoneCards(
    cards: Card[],
    attemptedItemIds: Set<string>,
  ): void {
    const { cfg, repoOwner, repoName } = this.deps;
    const candidates = cards.filter((card) => {
      if (attemptedItemIds.has(card.itemId) || !isTargetIssue(card, repoOwner, repoName)) return false;
      const record = this.ticketWorktrees.readStored(card.itemId);
      if (record?.activeRunId || record?.launchingAt !== undefined) return false;
      const stage = record?.retry?.stage;
      // Retire historical closed technical writes even after a manual lane change.
      if (record && (stage === "integrate" || stage === "cleanup") && pendingTicketWrite(record)?.card.closed) return true;
      if (record?.schemaVersion === 5 && record.integration?.kind === "pr") {
        // Open Ready with suspended approval belongs to ordinary builder admission.
        if (!card.closed && card.status?.toLowerCase() === cfg.columns.ready.toLowerCase() && record.integration.phase === "suspended") return false;
        return true;
      }
      if (!card.closed) return false;
      const status = card.status?.toLowerCase();
      return status === cfg.columns.done.toLowerCase() ||
        // A closed build retry only finishes its interrupted reopen/Ready handoff.
        (status === cfg.columns.ready.toLowerCase() && !!stage && ["build", "integrate", "cleanup"].includes(stage)) ||
        (status === cfg.columns.backlog.toLowerCase() && !!record?.integration);
    });
    for (const itemId of this.finalizationBlockers.keys())
      if (itemId !== this.finalization?.itemId && !candidates.some((c) => c.itemId === itemId))
        this.finalizationBlockers.delete(itemId);
    if (this.finalization || !candidates.length || this.foreground.signal.aborted) return;
    candidates.sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
    const card = candidates.find((c) => !this.finalizationCursor || c.itemId > this.finalizationCursor) ?? candidates[0];
    this.finalizationCursor = card.itemId;
    attemptedItemIds.add(card.itemId);
    const controller = new AbortController();
    const observer = observeOperation(this.state, "finalization", () => this.deps.onActivity?.(), { itemId: card.itemId, issueNumber: card.number ?? undefined });
    let blocker: string | undefined;
    const warn = (fingerprint: string, message: string) => {
      if (this.finalizationBlockers.get(card.itemId) === fingerprint) return;
      this.finalizationBlockers.set(card.itemId, fingerprint);
      this.deps.callback(message, "warn");
    };
    // Both handlers are attached before the executor can run/reject. Exclusion
    // lasts through failure writeback AND observation settlement, not UI state.
    const promise = Promise.resolve().then(() => this.executor.finalizeClosed(
      card,
      async () => (await this.revisionAllowsNewWork()) && this.admissionStillAllowed(),
      () => !controller.signal.aborted && !this.foreground.signal.aborted &&
        (!this.ownerLock || ownerLockIsHeld(this.ownerLock)),
      { signal: controller.signal, onProgress: observer.onProgress },
    )).then((outcome) => {
      if (outcome.status === "finalized" || outcome.status === "backlogged") {
        this.finalizationBlockers.delete(card.itemId);
        if (this.state.waiting?.itemId === card.itemId) this.state.waiting = undefined;
      }
      if (outcome.status === "waiting") {
        this.state.lastBlocker = undefined;
        this.state.waiting = { itemId: card.itemId, prNumber: outcome.prNumber, prUrl: outcome.prUrl, reason: outcome.reason };
        const fingerprint = JSON.stringify(outcome);
        if (this.finalizationBlockers.get(card.itemId) !== fingerprint) {
          this.finalizationBlockers.set(card.itemId, fingerprint);
          this.deps.callback(`PR #${outcome.prNumber}: ${outcome.prUrl} — ${outcome.reason}`, "info");
        }
        return;
      }
      if (outcome.status !== "conflict" && outcome.status !== "blocked") return;
      blocker = `#${card.number}: ${outcome.reason}`;
      warn(JSON.stringify(outcome), outcome.status === "conflict"
        ? `Finalization conflict for #${card.number} "${card.title}": ${taskBranch(cfg.branches.task_prefix, card.number!)} at ${outcome.taskSha} conflicts with ${cfg.branches.base} at ${outcome.baseSha}. Ticket status, branches and worktree preserved; no integration commit or push. Resolve the conflict before retrying.\n${outcome.reason}`
        : `Finalization blocked for "${card.title}": ${outcome.reason}`);
    }, (error) => {
      if (controller.signal.aborted) return;
      blocker = `#${card.number}: ${String(error)}`;
      warn(blocker, `Finalization blocked for "${card.title}": ${String(error)}`);
    }).finally(() => {
      try { observer.finish(blocker); }
      finally { this.finalization = undefined; }
    });
    this.finalization = { itemId: card.itemId, promise, controller };
    void promise.catch(() => undefined); // Also handle a failed UI callback before stop drains it.
  }
}
