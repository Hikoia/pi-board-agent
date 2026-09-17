/** Core polling loop: reconcile durable ticket runs, then fill global worker slots. */
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
import { repairReviewInput } from "./repair.js";
import type { RepairBlocker } from "./conflict-recovery.js";
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
  updateIssueBody,
  validateProjectMetadata,
  validatePlanOption,
} from "./gh.js";
import { isClean } from "./git-helpers.js";
import { makeNotifier } from "./notify.js";
import {
  type DesignOutput,
  type DesignRunInput,
  type StoryCreationOps,
  type StoryCreationPlan,
  RefineStateStore,
  storyIdentity,
  matchesStoryIdentity,
  createStoryCreationPlan,
  reconcileStoryCreation,
  renderQuestionsComment,
  renderRefineComment,
  runDesign,
  runRefine,
} from "./refine.js";
import { renderReviewComment, runReview } from "./review.js";
import type { TicketExecutor } from "./ticket-executor.js";
import {
  TicketWorktrees,
  type TicketExecutionRecord,
} from "./ticket-worktree.js";
import { buildTasksForWave } from "./workflow-prompt.js";
import type { OwnerLock } from "./owner-lock.js";
import { assertSupportedState } from "./unsupported-state.js";

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
    kind: "design" | "refine" | "review" | "watchdog";
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
  /** Offline adapters; production uses gh.ts and runDesign. */
  listCards?: () => Promise<Card[]>;
  taskDesignOps?: TaskDesignOps;
  boardOps?: LoopBoardOps;
  storyCreationOps?: StoryCreationOps;
  refine?: typeof runRefine;
  review?: typeof runReview;
}

/** Board I/O seam shared by Story and review integration checks. */
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

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function trustedMaintainerComments(
  comments: IssueComment[],
  botLogin = "",
): IssueComment[] {
  return comments.filter(
    (comment) =>
      !!comment.author &&
      comment.author.toLowerCase() !== botLogin.toLowerCase() &&
      TRUSTED_ASSOCIATIONS.has(comment.authorAssociation ?? "") &&
      !comment.body.trimStart().startsWith("<!-- board-agent-"),
  );
}

interface TaskDesignRequest {
  active: boolean;
  decision?: {
    source: IssueComment;
    trustedComments: string[];
    completedMarker: string;
  };
}

function taskDesignRequest(
  comments: IssueComment[],
  issueNumber: number,
  botLogin: string,
): TaskDesignRequest {
  const gateMarker = new RegExp(
    `^<!-- board-agent-requirements-gate:${issueNumber} -->(?:\\r?\\n|$)`,
  );
  const questionMarker = new RegExp(
    `^<!-- board-agent-task-design-questions:${issueNumber}:[^\\s>]+ -->(?:\\r?\\n|$)`,
  );
  const completedMarker = new RegExp(
    `^<!-- board-agent-task-design:${issueNumber}:[^\\s>]+ -->(?:\\r?\\n|$)`,
  );
  const bot = botLogin.toLowerCase();
  let latestGate = -1;
  let latestQuestion = -1;
  let latestCompleted = -1;
  comments.forEach((comment, index) => {
    if (comment.author?.toLowerCase() !== bot) return;
    const body = comment.body.trimStart();
    if (gateMarker.test(body)) latestGate = index;
    if (questionMarker.test(body)) latestQuestion = index;
    if (completedMarker.test(body)) latestCompleted = index;
  });

  const requestIndex = Math.max(latestGate, latestQuestion);
  if (requestIndex < 0 || requestIndex < latestCompleted)
    return { active: false };

  const trusted = trustedMaintainerComments(
    comments.slice(requestIndex + 1),
    botLogin,
  );
  const source = trusted.at(-1);
  return {
    active: true,
    decision: source
      ? {
          source,
          trustedComments: trusted.map(
            (comment) =>
              `${comment.createdAt} ${comment.author}: ${comment.body}`,
          ),
          completedMarker: `<!-- board-agent-task-design:${issueNumber}:${source.id} -->`,
        }
      : undefined,
  };
}

function isNeedsDesignTask(
  card: Card | undefined,
  cfg: Config,
): card is Card & { number: number; repoOwner: string; repoName: string } {
  return (
    card?.contentType === "Issue" &&
    Number.isInteger(card.number) &&
    (card.number ?? 0) > 0 &&
    !!card.repoOwner &&
    !!card.repoName &&
    card.closed === false &&
    card.type?.toLowerCase() === "task" &&
    (card.status ?? "").toLowerCase() === cfg.columns.needs_design.toLowerCase()
  );
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

function ownsTaskDesignClaim(card: Card, botLogin: string): boolean {
  const bot = botLogin.toLowerCase();
  return card.assignees.length === 1 && card.assignees[0].toLowerCase() === bot;
}

export interface TaskDesignOps {
  claim(card: Card): Promise<boolean>;
  refresh(card: Card): Promise<Card | undefined>;
  release(card: Card): Promise<void>;
  listComments(card: Card): Promise<IssueComment[]>;
  design(input: DesignRunInput): Promise<DesignOutput>;
  updateBody(card: Card, body: string): Promise<void>;
  comment(card: Card, body: string): Promise<void>;
  setReady(card: Card): Promise<void>;
}

export type TaskDesignResult =
  | "ready"
  | "questioned"
  | "waiting"
  | "skipped"
  | "error";

/** Gate or refine one Needs Design task under the existing assignee mutex. */
export async function processNeedsDesignTask(
  input: {
    card: Card;
    cfg: Config;
    cwd: string;
    contextDigest: string;
    botLogin: string;
    callback: StatusCallback;
  },
  ops: TaskDesignOps,
): Promise<TaskDesignResult> {
  const { card, cfg, cwd, contextDigest, botLogin, callback } = input;
  if (!isNeedsDesignTask(card, cfg)) return "skipped";

  let claimed = false;
  try {
    const initialRequest = taskDesignRequest(
      await ops.listComments(card),
      card.number,
      botLogin,
    );
    const needsGate = !initialRequest.active;
    if (!needsGate && !initialRequest.decision) return "waiting";

    const beforeClaim = await ops.refresh(card);
    if (
      !sameOpenCard(beforeClaim, card) ||
      beforeClaim.assignees.some(
        (assignee) => assignee.toLowerCase() !== botLogin.toLowerCase(),
      )
    )
      return "skipped";
    claimed = true; // An ambiguous claim response still requires cleanup of the original issue.
    if (!(await ops.claim(card))) return "skipped";

    const fresh = await ops.refresh(card);
    if (
      !isNeedsDesignTask(fresh, cfg) ||
      !sameOpenCard(fresh, card) ||
      !ownsTaskDesignClaim(fresh, botLogin)
    )
      return "skipped";

    const comments = await ops.listComments(fresh);
    const request = taskDesignRequest(comments, card.number, botLogin);
    const trustedSnapshot = JSON.stringify(
      trustedMaintainerComments(comments, botLogin),
    );
    const guard = async (expected = fresh, consumed = false) => {
      const currentComments = await ops.listComments(expected);
      const currentRequest = taskDesignRequest(
        currentComments,
        card.number,
        botLogin,
      );
      const sameRequest = consumed
        ? !currentRequest.active &&
          currentComments.some(
            (comment) =>
              comment.author?.toLowerCase() === botLogin.toLowerCase() &&
              comment.body.split(/\r?\n/, 1)[0] ===
                request.decision?.completedMarker,
          )
        : currentRequest.active === request.active &&
          currentRequest.decision?.completedMarker ===
            request.decision?.completedMarker;
      const current = await ops.refresh(expected);
      return (
        sameRequest &&
        sameOpenCard(current, expected) &&
        ownsTaskDesignClaim(current, botLogin) &&
        JSON.stringify(trustedMaintainerComments(currentComments, botLogin)) ===
          trustedSnapshot
      );
    };
    if (needsGate) {
      if (request.active) return "waiting";
      if (!(await guard())) return "skipped";
      await ops.comment(
        fresh,
        [
          `<!-- board-agent-requirements-gate:${card.number} -->`,
          "## ❓ Design decision required",
          "",
          "Reply with the approved scope, constraints, and acceptance criteria.",
          "Board Agent will wait for a repository owner, member, or collaborator.",
        ].join("\n"),
      );
      callback(
        `Task "${fresh.title}" is waiting for a fresh maintainer design decision.`,
        "warn",
      );
      return "questioned";
    }

    const decision = request.decision;
    if (!request.active || !decision) return "waiting";
    const design = await ops.design({
      cwd,
      title: fresh.title,
      body: fresh.body,
      trustedComments: decision.trustedComments,
      contextDigest,
      model: cfg.models.refine,
      timeoutMs: cfg.refine.timeout_ms,
    });

    const latest = await ops.refresh(fresh);
    if (
      !isNeedsDesignTask(latest, cfg) ||
      !sameOpenCard(latest, fresh) ||
      !ownsTaskDesignClaim(latest, botLogin)
    )
      return "skipped";
    const latestDecision = taskDesignRequest(
      await ops.listComments(latest),
      card.number,
      botLogin,
    ).decision;
    if (
      latest.title !== fresh.title ||
      latest.body !== fresh.body ||
      !latestDecision ||
      latestDecision.source.id !== decision.source.id ||
      latestDecision.trustedComments.length !==
        decision.trustedComments.length ||
      latestDecision.trustedComments.some(
        (comment, index) => comment !== decision.trustedComments[index],
      )
    )
      return "skipped";

    if (!(await guard())) return "skipped";
    if (design.openQuestions.length > 0) {
      await ops.comment(
        latest,
        [
          `<!-- board-agent-task-design-questions:${card.number}:${decision.source.id} -->`,
          "## ❓ Needs design",
          "",
          ...design.openQuestions.map(
            (question, index) => `${index + 1}. ${question}`,
          ),
          "",
          "Reply below with the missing decision; board-agent will retry automatically.",
        ].join("\n"),
      );
      callback(
        `Task "${latest.title}" remains in ${cfg.columns.needs_design}: ${design.openQuestions.length} open question(s).`,
        "warn",
      );
      return "questioned";
    }

    // This authentic marker is the durable decision-consumption boundary.
    // GitHub writes are not transactional: later recovery requires a fresh gate.
    await ops.comment(
      latest,
      [
        decision.completedMarker,
        "## ✅ Ticket design decision recorded",
        "",
        design.summary,
        "",
        `This decision is consumed. The Task can enter \`${cfg.columns.ready}\` only after its issue contract is updated.`,
      ].join("\n"),
    );
    if (!(await guard(latest, true))) return "skipped";
    await ops.updateBody(latest, design.body);
    const updated = { ...latest, body: design.body };
    if (!(await guard(updated, true))) return "skipped";
    await ops.setReady(updated);
    callback(`Task "${latest.title}" designed → ${cfg.columns.ready}.`);
    return "ready";
  } catch (error) {
    callback(
      `Task design failed for "${card.title}": ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return "error";
  } finally {
    if (claimed)
      await ops
        .release(card)
        .catch((error) =>
          callback(
            `Task claim release failed for #${card.number}: ${String(error)}`,
            "warn",
          ),
        );
  }
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
      (claimed && !ownsTaskDesignClaim(fresh, this.deps.botLogin))
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
    assertSupportedState(
      this.deps.cwd,
      this.deps.repoRoot ?? this.ticketWorktrees.repoRoot,
    );
    const blockers = new Map<string, BlockerNotice>();
    try {
      const { cfg, callback, repoOwner, repoName, meta } = this.deps;
      const cards = await this.fetchCards();
      if (this.foreground.signal.aborted) return;
      const summary = await this.executor.reconcile(
        cards,
        async () => (await this.revisionAllowsNewWork()) && this.admitNewWork,
        () => this.admissionStillAllowed(),
      );
      for (const blocker of summary.repairBlockers ?? []) {
        if (
          cards.some(
            (card) =>
              card.itemId === blocker.itemId &&
              isTargetIssue(card, repoOwner, repoName, "Task") &&
              (card.status?.toLowerCase() === cfg.columns.ready.toLowerCase() ||
                (card.closed &&
                  card.status?.toLowerCase() ===
                    cfg.columns.done.toLowerCase())),
          )
        )
          this.recordRepairBlocker(blockers, blocker.itemId, blocker);
      }
      if (this.foreground.signal.aborted) return;
      // Closed/Done is durable recovery, not a new admission (also on dirty/revision latch).
      await this.processClosedDoneCards(cards, blockers);
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
          (card.status ?? "").toLowerCase() ===
            cfg.columns.review.toLowerCase() &&
          !!card.plan &&
          card.closed === false &&
          isTargetIssue(card, repoOwner, repoName, "Task"),
      );
      const readyCandidates = cards.filter(
        (card) =>
          isTargetIssue(card, repoOwner, repoName, "Task") &&
          (card.status ?? "").toLowerCase() ===
            cfg.columns.ready.toLowerCase() &&
          !!card.plan &&
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
          if (!card.plan) continue;
          let repair;
          try {
            repair = await this.executor.repairFor?.(card);
          } catch (error) {
            repair = {
              status: "blocked" as const,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          if (repair && "status" in repair) {
            this.recordRepairBlocker(blockers, card.itemId, repair);
            continue;
          }
          const result = await this.executor.launch(
            card,
            planSlug(card.plan),
            async () =>
              (await this.revisionAllowsNewWork()) && this.admitNewWork,
            () => this.admissionStillAllowed(),
            repair,
          );
          if (result.status !== "launched") continue;
          blockers.delete(card.itemId);
          launched++;
          this.state.wavesLaunched++;
        }
      };

      const primaryPending =
        (cfg.refine.enabled &&
          cards.some(
            (card) =>
              (isTargetIssue(card, repoOwner, repoName, "Task") &&
                isNeedsDesignTask(card, cfg)) ||
              (isTargetIssue(card, repoOwner, repoName, "Story") &&
                card.closed === false &&
                !!card.plan &&
                [
                  cfg.columns.ready,
                  cfg.columns.needs_design,
                  cfg.columns.building,
                ].some(
                  (status) =>
                    status.toLowerCase() === card.status?.toLowerCase(),
                ) &&
                !card.assignees.some(
                  (login) =>
                    login.toLowerCase() !== this.deps.botLogin.toLowerCase(),
                )),
          )) ||
        (cfg.review.enabled && reviewCandidates.length > 0);
      const initialSlots = allocateWorkerSlots(
        cfg.max_workers,
        this.executor.activeCount(),
        primaryPending,
      );
      // Reserve only for primary foreground work, and fill other slots FIRST.
      await launchReady(
        initialSlots.builderSlots,
        initialSlots.foregroundSlots,
      );

      if (initialSlots.foregroundSlots > 0 && this.admitNewWork) {
        const ranPrimary =
          cfg.refine.enabled &&
          ((await this.processTaskDesignCards(cards)) ||
            (await this.processStories(cards)));
        if (!ranPrimary && cfg.review.enabled)
          await this.processReviewCards(reviewCandidates);
      }
      await launchReady(
        Math.max(0, cfg.max_workers - this.executor.activeCount()),
      );

      // Maintenance never reserves capacity ahead of Ready builders.
      if (cfg.watchdog.enabled) {
        try {
          const { Watchdog } = await import("./watchdog.js");
          await new Watchdog({
            cwd: this.deps.cwd,
            cfg,
            repoOwner,
            repoName,
            botLogin: this.deps.botLogin,
            meta,
            callback,
            signal: this.foreground.signal,
            canStartWork: async () =>
              (await this.revisionAllowsNewWork()) && this.admitNewWork,
            runModel: (label, run) =>
              this.runForeground({ kind: "watchdog", label }, run),
          }).tick();
        } catch (error: any) {
          callback(`Watchdog tick failed: ${error.message}`, "warn");
        }
      }
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

  /** One actionable Story per tick; waiting/read-only candidates do not consume the turn. */
  private async processStories(cards: Card[]): Promise<boolean> {
    const { cfg, meta, botLogin, callback, repoOwner, repoName } = this.deps;
    if (!this.admitNewWork || !this.hasModelSlot()) return false;
    const stories = cards.filter(
      (card) =>
        isTargetIssue(card, repoOwner, repoName, "Story") &&
        card.closed === false &&
        !!card.plan &&
        !card.assignees.some(
          (assignee) => assignee.toLowerCase() !== botLogin.toLowerCase(),
        ),
    );
    if (!stories.length) return false;
    const store = new RefineStateStore(this.deps.cwd);
    const board = this.boardOps();
    const ready = cfg.columns.ready.toLowerCase();
    const needsDesign = cfg.columns.needs_design.toLowerCase();
    const building = cfg.columns.building.toLowerCase();
    const start = this.state.tickCount % stories.length;
    const ordered = [...stories.slice(start), ...stories.slice(0, start)];

    for (const snapshot of ordered) {
      let attempted = false;
      let ranRefine = false;
      let claimed = false;
      try {
        const status = snapshot.status?.toLowerCase();
        if (![ready, needsDesign, building].includes(status ?? "")) continue;
        const state = store.get(snapshot.number!);
        // In Progress alone is not proof that a model/creation should be replayed.
        if (status === building && !state?.creation && !state?.refined) {
          if (ownsTaskDesignClaim(snapshot, botLogin)) {
            await this.currentCard(snapshot);
            attempted = true;
            await board.release(snapshot);
            return false;
          }
          continue;
        }
        const story = await this.currentCard(snapshot, false);
        const identity = storyIdentity(story, meta.projectId);
        if (
          state &&
          !matchesStoryIdentity(story, state.identity, meta.projectId)
        )
          throw new StaleCardError(
            `Story #${identity.number} journal identity changed.`,
          );
        if (!state?.refined) {
          validateProjectMetadata(meta, cfg);
          validatePlanOption(meta, identity.plan);
        }
        let comments: IssueComment[] = [];
        let extraContext = "";
        let completed = false;
        const releaseWaitingClaim = async () => {
          if (!ownsTaskDesignClaim(story, botLogin)) return false;
          await this.currentCard(story);
          attempted = true;
          await board.release(story);
          return true;
        };

        if (state?.refined) {
          completed = await this.storyTasksFinalized(story, state.creation!);
          if (!completed && status === building) {
            // A crash after the completion write may leave only the old bot claim.
            if (await releaseWaitingClaim()) return false;
            continue;
          }
        } else if (!state?.creation && status === needsDesign) {
          comments = await board.listComments(story);
          const latest = comments.at(-1)?.id;
          const cursor = comments.findIndex(
            (comment) => comment.id === state?.lastSeenCommentId,
          );
          if (!state?.lastSeenCommentId || cursor < 0) {
            if (state?.lastSeenCommentId)
              callback(
                `Story #${story.number} comment cursor is missing; bootstrapped without replay.`,
                "warn",
              );
            store.update(identity.number, {
              identity,
              lastSeenCommentId: latest,
            });
            if (await releaseWaitingClaim()) return false;
            continue;
          }
          const replies = trustedMaintainerComments(
            comments.slice(cursor + 1),
            botLogin,
          );
          if (!replies.length) {
            if (latest !== state.lastSeenCommentId)
              store.update(identity.number, {
                identity,
                lastSeenCommentId: latest,
              });
            if (await releaseWaitingClaim()) return false;
            continue;
          }
          extraContext = replies
            .map((comment) => `- ${comment.body}`)
            .join("\n");
        }

        // Claim/revalidate in ALL lanes, including recovery and Needs Design.
        await this.currentCard(story, false);
        attempted = true;
        claimed = true;
        if (!(await board.claim(story))) return false;
        const fresh = await this.currentCard(story);
        if (state?.refined) {
          // Re-read children after claiming too; an old board snapshot cannot close a Story.
          completed = await this.storyTasksFinalized(fresh, state.creation!);
          await this.currentCard(fresh);
          await board.setStatus(
            fresh,
            completed ? cfg.columns.done : cfg.columns.building,
          );
          callback(
            `Story "${fresh.title}" → ${completed ? cfg.columns.done : cfg.columns.building} (recovered completed refinement).`,
          );
        } else {
          const latestComments = await board.listComments(fresh);
          if (
            status === needsDesign &&
            !state?.creation &&
            JSON.stringify(trustedMaintainerComments(comments, botLogin)) !==
              JSON.stringify(
                trustedMaintainerComments(latestComments, botLogin),
              )
          )
            throw new StaleCardError(
              "Story design replies changed while claiming.",
            );
          ranRefine = await this.refineStory(
            fresh,
            extraContext,
            store,
            latestComments,
          );
        }
      } catch (error) {
        callback(
          `Story #${snapshot.number}: ${error instanceof Error ? error.message : String(error)}`,
          "warn",
        );
      } finally {
        if (claimed)
          await board
            .release(snapshot)
            .catch((error) =>
              callback(
                `Story claim release failed for #${snapshot.number}: ${String(error)}`,
                "warn",
              ),
            );
      }
      if (attempted) return ranRefine;
    }
    return false;
  }

  private async storyTasksFinalized(
    story: Card,
    creation: StoryCreationPlan,
  ): Promise<boolean> {
    const { cfg, repoOwner, repoName } = this.deps;
    const cards = await this.fetchCards();
    const tasks = cards.filter(
      (card) =>
        isTargetIssue(card, repoOwner, repoName, "Task") &&
        card.plan === story.plan,
    );
    // Every journaled child must still exist; deleting a board card is not completion.
    if (
      !creation.tasks.length ||
      !creation.tasks.every((child) =>
        tasks.some(
          (task) =>
            task.itemId === child.itemId && task.number === child.number,
        ),
      )
    )
      return false;
    for (const task of tasks) {
      if (
        !task.closed ||
        task.number === undefined ||
        ![cfg.columns.done, cfg.columns.backlog].some(
          (status) => status.toLowerCase() === task.status?.toLowerCase(),
        ) ||
        (this.executor.hasPendingRecovery?.(task.itemId) ??
          this.ticketWorktrees.hasPendingRecovery(task.itemId))
      )
        return false;
      const branch = taskBranch(cfg.branches.task_prefix, task.number);
      if (
        (await this.ticketWorktrees.remoteBranchSha(branch)) ||
        this.ticketWorktrees.localBranchSha(branch)
      )
        return false;
    }
    return true;
  }

  private async processTaskDesignCards(cards: Card[]): Promise<boolean> {
    const { cfg, meta, botLogin, callback } = this.deps;
    if (!this.hasModelSlot()) return false;

    const candidates = cards.filter(
      (card) =>
        isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
        (card.status ?? "").toLowerCase() ===
          cfg.columns.needs_design.toLowerCase() &&
        !card.closed,
    );
    if (candidates.length === 0) return false;

    const start = this.state.tickCount % candidates.length;
    const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
    const contextDigest = await this.getContextDigest();
    const baseOps =
      this.deps.taskDesignOps ??
      ({
        claim: (candidate: Card) => tryClaim(candidate, botLogin),
        refresh: (candidate: Card) =>
          getCard(
            candidate.itemId,
            cfg.status_field,
            cfg.plan_field,
            cfg.type_field,
          ),
        release: (candidate: Card) => release(candidate, botLogin),
        listComments: (candidate: Card) => {
          if (!candidate.number || !candidate.repoOwner || !candidate.repoName)
            return Promise.resolve([]);
          return listIssueComments(
            candidate.repoOwner,
            candidate.repoName,
            candidate.number,
          );
        },
        design: runDesign,
        updateBody: async (candidate: Card, body: string) => {
          if (!candidate.number || !candidate.repoOwner || !candidate.repoName)
            throw new Error("Task has no linked GitHub issue.");
          await updateIssueBody(
            candidate.repoOwner,
            candidate.repoName,
            candidate.number,
            body,
          );
        },
        comment: async (candidate: Card, body: string) => {
          if (!candidate.number || !candidate.repoOwner || !candidate.repoName)
            throw new Error("Task has no linked GitHub issue.");
          const id = await this.createCommentWithId(
            candidate.number,
            candidate.repoOwner,
            candidate.repoName,
            body,
          );
          if (!id) throw new Error("Failed to post the task design comment.");
        },
        setReady: (candidate: Card) =>
          setStatus(meta, candidate.itemId, cfg.columns.ready),
      } satisfies TaskDesignOps);

    for (const card of ordered) {
      let ranDesign = false;
      const result = await processNeedsDesignTask(
        {
          card,
          cfg,
          cwd: this.deps.cwd,
          contextDigest,
          botLogin,
          callback,
        },
        {
          ...baseOps,
          refresh: async (candidate) => {
            if (!(await this.revisionAllowsNewWork()) || !this.admitNewWork)
              return undefined;
            return baseOps.refresh(candidate);
          },
          design: async (designInput) => {
            const result = await this.runForeground(
              { kind: "design", label: `Task #${card.number}` },
              () => {
                ranDesign = true;
                return baseOps.design({
                  ...designInput,
                  signal: this.foreground.signal,
                });
              },
            );
            if (!result)
              throw new StaleCardError("Task design admissions stopped.");
            return result;
          },
        },
      );
      if (ranDesign || (result !== "waiting" && result !== "skipped"))
        return ranDesign;
    }
    return false;
  }

  private async refineStory(
    story: Card,
    extraContext: string,
    store: RefineStateStore,
    comments: IssueComment[],
  ): Promise<boolean> {
    const { cfg, meta, repoOwner, repoName, botLogin, callback } = this.deps;
    const board = this.boardOps();
    const identity = storyIdentity(story, meta.projectId);
    const number = identity.number;
    let creation = store.get(number)?.creation;
    let ranRefine = false;
    const trusted = JSON.stringify(
      trustedMaintainerComments(comments, botLogin),
    );
    const assertCurrent = async () => {
      const latest = await board.listComments(story);
      if (
        JSON.stringify(trustedMaintainerComments(latest, botLogin)) !==
        (creation?.trustedComments ?? trusted)
      )
        throw new StaleCardError(
          "Story replies changed; preserved journal without stale write-back.",
        );
      await this.currentCard(story);
    };
    try {
      if (
        creation &&
        (creation.storyTitle !== story.title ||
          creation.storyBody !== story.body)
      )
        throw new StaleCardError(
          "Story contract changed since its journal was recorded; reconcile manually.",
        );
      if (!creation) {
        const contextDigest = await this.getContextDigest();
        await assertCurrent();
        const refine = await this.runForeground(
          { kind: "refine", label: `Story #${number}` },
          () => {
            ranRefine = true;
            return (this.deps.refine ?? runRefine)({
              cwd: this.deps.cwd,
              storyTitle: story.title,
              storyBody: story.body,
              signal: this.foreground.signal,
              maxTasks: cfg.refine.max_tasks,
              extraContext,
              contextDigest,
              model: cfg.models.refine,
              timeoutMs: cfg.refine.timeout_ms,
            });
          },
        );
        if (!refine) return false;
        await assertCurrent();
        const existingTaskCount = await this.countPlanTasks(identity.plan);
        await assertCurrent();
        creation = createStoryCreationPlan({
          cfg,
          meta,
          repoOwner,
          repoName,
          storyCard: story,
          planSlug: identity.plan,
          refine,
          existingTaskCount,
          projectId: meta.projectId,
        });
        creation.trustedComments = trusted;
        // Persist output before ANY comment, status, or child mutation.
        store.update(number, {
          identity,
          refined: false,
          creation,
          lastSeenCommentId: comments.at(-1)?.id,
        });
      }
      const persist = () =>
        store.update(number, { identity, refined: false, creation });
      const questions = creation.refine.openQuestions.length > 0;
      const created = questions
        ? []
        : await reconcileStoryCreation(
            {
              cfg,
              meta,
              repoOwner,
              repoName,
              storyCard: story,
              projectId: meta.projectId,
              assertCurrent,
            },
            creation,
            persist,
            this.deps.storyCreationOps,
          );
      const marker = `<!-- board-agent-story-${questions ? "questions" : "refined"}:${story.itemId}:${creation.id} -->`;
      const id = await this.commentOnce(
        story,
        marker,
        questions
          ? renderQuestionsComment(identity.plan, creation.refine)
          : renderRefineComment(identity.plan, creation.refine, created),
        assertCurrent,
        creation,
        persist,
      );
      await assertCurrent();
      if (!questions) store.update(number, { refined: true });
      await board.setStatus(
        story,
        questions ? cfg.columns.needs_design : cfg.columns.building,
      );
      if (questions)
        store.update(number, {
          refined: false,
          creation: undefined,
          lastSeenCommentId: id,
        });
      callback(
        `Story "${story.title}" ${questions ? "needs design" : `refined: ${created.length} task(s)`}.`,
      );
      // Notification failure must not undo a completed GitHub/journal transition.
      await makeNotifier(cfg)(
        questions ? "refine_questions" : "refine_done",
        `Story ${questions ? "questions" : "refined"}: ${story.title}`,
        questions
          ? creation.refine.openQuestions.join("\n")
          : `${created.length} task(s)`,
        created.map((task) => task.url),
      ).catch((error) =>
        callback(`Story notification failed: ${String(error)}`, "warn"),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A stale card never receives even a blocker comment or fallback status.
      if (!(error instanceof StaleCardError) && store.get(number)?.creation) {
        try {
          await this.commentOnce(
            story,
            `<!-- board-agent-story-blocked:${story.itemId}:${creation!.id} -->`,
            `## ⚠️ Story creation needs human input\n\n${reason}\n\nThe journal is preserved. Reconcile ambiguous operations before returning this Story to Ready; do not delete its journal.`,
            assertCurrent,
          );
          await assertCurrent();
          await board.setStatus(story, cfg.columns.needs_human);
        } catch {
          /* Preserve intent and leave changed/unreadable cards untouched. */
        }
      }
      callback(`Refine of story "${story.title}" failed: ${reason}`, "error");
    }
    return ranRefine;
  }

  private async commentOnce(
    card: Card,
    marker: string,
    body: string,
    assertCurrent: () => Promise<void>,
    creation?: StoryCreationPlan,
    persist?: () => void,
  ): Promise<string> {
    const board = this.boardOps();
    const comments = await board.listComments(card);
    const matches = comments.filter(
      (comment) =>
        comment.author?.toLowerCase() === this.deps.botLogin.toLowerCase() &&
        comment.body.split(/\r?\n/, 1)[0] === marker,
    );
    if (matches.length > 1)
      throw new Error(
        "Multiple authentic Story journal comments; reconcile manually.",
      );
    let id: string | undefined = matches[0]?.id;
    if (creation?.commentId && creation.commentId !== id)
      throw new Error(
        "Story journal comment was removed or replaced; reconcile manually.",
      );
    if (!id) {
      if (creation?.commentAttempted)
        throw new Error(
          "Cannot confirm prior Story comment; reconcile manually.",
        );
      await assertCurrent();
      if (creation) {
        creation.commentAttempted = true;
        persist!();
      }
      id = await board.comment(card, `${marker}\n${body}`);
      if (!id) throw new Error("Failed to post Story journal comment.");
    }
    if (creation) {
      creation.commentAttempted = true;
      creation.commentId = id;
      persist!();
    }
    return id;
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

  private async getContextDigest(): Promise<string> {
    const { cfg } = this.deps;
    if (!cfg.context.enabled) return "";
    try {
      const { generateContext } = await import("./context.js");
      return generateContext({
        cwd: this.deps.cwd,
        maxChars: cfg.context.max_chars,
        exclude: cfg.context.exclude,
      });
    } catch {
      return "";
    }
  }

  private async countPlanTasks(slug: string): Promise<number> {
    return (await this.fetchCards()).filter(
      (card) =>
        card.plan === slug &&
        isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task"),
    ).length;
  }

  private async processReviewCards(reviewCards: Card[]): Promise<void> {
    const { cfg, callback, repoOwner, repoName } = this.deps;
    const board = this.boardOps();
    for (const card of reviewCards) {
      if (
        !card.plan ||
        card.closed ||
        !isTargetIssue(card, repoOwner, repoName, "Task")
      )
        continue;
      let claimed = false;
      let record: TicketExecutionRecord | undefined;
      let evidenceBlocker: RepairBlocker | undefined;
      try {
        await this.currentCard(card, false);
        claimed = true;
        if (!(await board.claim(card))) continue;
        const fresh = await this.currentCard(card);
        const task = buildTasksForWave(cfg, planSlug(card.plan), [fresh])[0];
        record = this.ticketWorktrees.read(card.itemId);
        if (
          !record ||
          record.issueNumber !== fresh.number ||
          record.plan !== planSlug(card.plan) ||
          record.taskBranch !== task.taskBranch ||
          record.activeRunId ||
          record.launchingAt !== undefined ||
          record.finalization ||
          this.ticketWorktrees.hasCleanupReceipt(card.itemId)
        )
          throw new Error("Missing matching idle v3 record before review.");
        const readRepair = async (current: Card) => {
          if (this.executor.repairForReview) {
            const repair = await this.executor.repairForReview(
              record!,
              current,
            );
            if (repair && "status" in repair) {
              evidenceBlocker = repair;
              throw new Error(repair.reason);
            }
            return repair;
          }
          const run = record!.lastRunId
            ? createRunPersistence(record!.path).load(record!.lastRunId)
            : null;
          const repair = run ? repairReviewInput(run) : undefined;
          if (
            repair &&
            ((run!.args as any).itemId !== record!.itemId ||
              (run!.args as any).issueNumber !== record!.issueNumber ||
              (run!.args as any).taskKey !== record!.taskKey)
          )
            throw new Error(
              "Repair review run does not match the ticket record.",
            );
          return repair;
        };
        const repair = await readRepair(fresh);
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
              ...(repair ? { repair } : {}),
              signal: this.foreground.signal,
              canStartWork: () => this.revisionAllowsNewWork(),
              canStartWorkNow: () => this.admissionStillAllowed(),
            }),
        );
        if (!review) return;
        const latest = await this.currentCard(fresh);
        const current = this.ticketWorktrees.read(latest.itemId);
        if (
          !current ||
          current.issueNumber !== record.issueNumber ||
          current.plan !== record.plan ||
          current.path !== record.path ||
          current.baseBranch !== record.baseBranch ||
          current.taskBranch !== record.taskBranch ||
          current.createdAt !== record.createdAt ||
          current.lastRunId !== record.lastRunId ||
          current.reviewedTaskSha !== record.reviewedTaskSha ||
          current.activeRunId ||
          current.launchingAt !== undefined ||
          current.finalization ||
          this.ticketWorktrees.hasCleanupReceipt(latest.itemId)
        )
          throw new Error("Execution record changed during review.");
        if (JSON.stringify(await readRepair(latest)) !== JSON.stringify(repair))
          throw new Error("Repair evidence changed during review.");
        if (!this.admissionStillAllowed())
          throw new StaleCardError("Review admissions stopped.");
        if (review.verdict === "pass") {
          // Preserve the FIRST fresh origin task SHA returned by the isolated reviewer.
          // Never fetch/re-pin here: a newer commit was not reviewed.
          this.ticketWorktrees.setReviewedTaskSha(
            latest.itemId,
            review.taskSha,
          );
          await this.currentCard(latest);
          await board.setStatus(latest, cfg.columns.done);
          callback(
            `AI review passed for "${latest.title}" at ${review.taskSha} → ${cfg.columns.done}. Validate ${current.path}, then close issue #${latest.number} to merge.`,
          );
          return;
        }
        const retryStatus = repair
          ? cfg.columns.needs_human
          : cfg.columns.ready;
        const id = await board.comment(
          latest,
          renderReviewComment(review, !!repair),
        );
        if (!id) throw new Error("Failed to post AI review findings.");
        await this.currentCard(latest);
        await board.setStatus(latest, retryStatus);
        callback(
          `AI review found ${review.findings.length} blocking issue(s) in "${latest.title}". → ${retryStatus}`,
          "warn",
        );
      } catch (error) {
        let disposition = "Leaving status unchanged.";
        if (evidenceBlocker && record && this.executor.repairForReview) {
          try {
            const confirm = async () => {
              const fresh = await this.currentCard(card);
              const blocker = await this.executor.repairForReview!(
                record!,
                fresh,
              );
              if (
                !blocker ||
                !("status" in blocker) ||
                !this.admissionStillAllowed()
              )
                throw new Error("Repair Review quarantine authority changed.");
              return fresh;
            };
            const fresh = await confirm();
            const id = await board.comment(
              fresh,
              `## ⚠️ Needs human input\n\n${evidenceBlocker.reason}\n\nPreserve the repair run and worktree. Restore/inspect its evidence before retrying. Only an explicit maintainer move to Ready starts an ordinary retry.`,
            );
            if (!id)
              throw new Error("Failed to post repair Review evidence blocker.");
            await confirm();
            await board.setStatus(fresh, cfg.columns.needs_human);
            disposition = `→ ${cfg.columns.needs_human}.`;
          } catch {
            /* Unknown/changed authority never permits fallback writeback. */
          }
        }
        callback(
          `AI review failed for "${card.title}": ${error instanceof Error ? error.message : String(error)}. ${disposition}`,
          "warn",
        );
      } finally {
        if (claimed)
          await board
            .release(card)
            .catch((error) =>
              callback(`Review claim release failed: ${String(error)}`, "warn"),
            );
      }
      return;
    }
  }

  private recordRepairBlocker(
    blockers: Map<string, BlockerNotice>,
    itemId: string,
    blocker: RepairBlocker,
  ): void {
    // Reconciliation has the actual pending-step failure; Ready may only know
    // that the handoff is not queued. Keep the former, not the wrapper wording.
    if (blockers.has(itemId)) return;
    blockers.set(itemId, {
      fingerprint: JSON.stringify([
        "repair",
        blocker.repair?.baseSha ?? null,
        blocker.repair?.taskSha ?? null,
        blocker.reason,
      ]),
      message: `Repair handoff ${itemId} blocked: ${blocker.reason}`,
    });
  }

  private async processClosedDoneCards(
    cards: Card[],
    blockers: Map<string, BlockerNotice>,
  ): Promise<void> {
    const { cfg, repoOwner, repoName } = this.deps;
    const candidates = cards.filter(
      (card) =>
        card.closed === true &&
        (card.status ?? "").toLowerCase() === cfg.columns.done.toLowerCase() &&
        isTargetIssue(card, repoOwner, repoName),
    );
    if (!candidates.length || this.foreground.signal.aborted) return;
    for (const card of candidates) {
      if (this.foreground.signal.aborted) return;
      const outcome = await this.executor.finalizeClosed(
        card,
        async () => (await this.revisionAllowsNewWork()) && this.admitNewWork,
        () => this.admissionStillAllowed(),
      );
      if (
        outcome.status === "finalized" ||
        outcome.status === "backlogged" ||
        (outcome.status === "skipped" && outcome.repair)
      )
        blockers.delete(card.itemId);
      if (outcome.status !== "conflict" && outcome.status !== "blocked")
        continue;
      if (outcome.status === "blocked" && outcome.repair) {
        this.recordRepairBlocker(blockers, card.itemId, outcome);
        continue;
      }
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
            ? `Finalization conflict for #${card.number} "${card.title}": ${taskBranch(cfg.branches.task_prefix, card.number!)} could not be integrated into ${cfg.branches.base}. Conflicting commits: ${outcome.baseSha} / ${outcome.taskSha}. Ticket status, branches and worktree preserved; no integration push. Resolve the conflict before retrying.\n${outcome.reason}`
            : `Finalization blocked for "${card.title}": ${outcome.reason}`,
      });
    }
  }
}
