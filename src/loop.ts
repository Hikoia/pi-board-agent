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
  updateIssueBody,
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
import { TicketWorktrees } from "./ticket-worktree.js";
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
  reviewingTask: string | null;
}

export interface LoopDeps {
  cwd: string;
  cfg: Config;
  repoOwner: string;
  repoName: string;
  botLogin: string;
  meta: ProjectMetadata;
  callback: StatusCallback;
  onTick?: () => void;
  revisionCheck?: () =>
    | { ok: boolean; reason?: string }
    | Promise<{ ok: boolean; reason?: string }>;
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
    reviewingTask: null,
  };
}

export function allocateWorkerSlots(
  maxWorkers: number,
  activeBuilders: number,
  reviewPending: boolean,
): { builderSlots: number; reviewSlots: number } {
  const available = Math.max(0, maxWorkers - activeBuilders);
  const reviewSlots = reviewPending && available > 0 ? 1 : 0;
  return { builderSlots: available - reviewSlots, reviewSlots };
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

export class BoardLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentTick: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly deps: LoopDeps,
    private readonly state: LoopState,
    private readonly executor: TicketExecutor,
    private readonly ticketWorktrees = new TicketWorktrees(deps.cwd),
    private readonly ownerLock?: OwnerLock,
    private admitNewWork = true,
  ) {}

  async start(): Promise<void> {
    if (this.state.running) return;
    this.state.running = true;
    this.deps.callback(`Loop started (tick=${this.deps.cfg.tick_seconds}s)`);
    this.intervalId = setInterval(() => {
      const update = this.currentTick
        ? this.revisionAllowsNewWork()
        : this.tickNow();
      void update.catch((error: Error) =>
        this.deps.callback(`tick failed: ${error.message}`, "error"),
      );
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

  enableAdmissions(): void {
    this.admitNewWork = true;
  }

  private async revisionAllowsNewWork(): Promise<boolean> {
    const revision = await this.deps.revisionCheck?.();
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
    const running = this.tick().finally(() => {
      if (this.currentTick === running) this.currentTick = null;
    });
    this.currentTick = running;
    return running;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.admitNewWork = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.state.running = false;
    try {
      await this.currentTick;
    } finally {
      // A failed tick must still drain builders. Keep ownership if draining fails.
      await this.executor.shutdown();
      this.ownerLock?.release();
    }
    this.deps.callback("Loop stopped.", "info");
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

  private async tick(): Promise<void> {
    // Keep unsupported state read-only, including when introduced after startup.
    assertSupportedState(this.deps.cwd);
    try {
      const { cfg, callback, repoOwner, repoName, meta } = this.deps;
      const cards = await this.fetchCards();
      await this.executor.reconcile(cards);
      // Closed/Done is durable recovery, not a new admission (also on dirty/revision latch).
      await this.processClosedDoneCards(cards);
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

      if (cfg.refine.enabled) {
        await this.processTaskDesignCards(cards);
        await this.processStories(cards);
      }

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
            canStartWork: async () =>
              (await this.revisionAllowsNewWork()) &&
              !this.stopped &&
              this.admitNewWork,
          }).tick();
        } catch (error: any) {
          callback(`Watchdog tick failed: ${error.message}`, "warn");
        }
      }

      if (!this.admitNewWork) return;
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
      const launchReady = async (limit: number): Promise<void> => {
        let launched = 0;
        for (const card of readyCandidates) {
          if (!this.admitNewWork || launched >= limit) break;
          if (attemptedItemIds.has(card.itemId)) continue;
          attemptedItemIds.add(card.itemId);
          if (!card.plan) continue;
          const result = await this.executor.launch(card, planSlug(card.plan));
          if (result.status !== "launched") continue;
          launched++;
          this.state.wavesLaunched++;
        }
      };

      const initialSlots = allocateWorkerSlots(
        cfg.max_workers,
        this.executor.activeCount(),
        cfg.review.enabled && reviewCandidates.length > 0,
      );
      await launchReady(initialSlots.builderSlots);

      if (initialSlots.reviewSlots > 0 && this.admitNewWork) {
        await this.processReviewCards(reviewCandidates);
        if (!this.admitNewWork) return;
        const refillSlots = allocateWorkerSlots(
          cfg.max_workers,
          this.executor.activeCount(),
          false,
        );
        await launchReady(refillSlots.builderSlots);
      }
    } finally {
      this.state.tickCount++;
      this.state.lastTickMs = Date.now();
      this.deps.onTick?.();
    }
  }

  /** One actionable Story per tick; waiting/read-only candidates do not consume the turn. */
  private async processStories(cards: Card[]): Promise<void> {
    const { cfg, meta, botLogin, callback, repoOwner, repoName } = this.deps;
    if (!this.admitNewWork || this.executor.activeCount() >= cfg.max_workers)
      return;
    const stories = cards.filter(
      (card) =>
        isTargetIssue(card, repoOwner, repoName, "Story") &&
        card.closed === false &&
        !!card.plan &&
        !card.assignees.some(
          (assignee) => assignee.toLowerCase() !== botLogin.toLowerCase(),
        ),
    );
    if (!stories.length) return;
    const store = new RefineStateStore(this.deps.cwd);
    const board = this.boardOps();
    const ready = cfg.columns.ready.toLowerCase();
    const needsDesign = cfg.columns.needs_design.toLowerCase();
    const building = cfg.columns.building.toLowerCase();
    const start = this.state.tickCount % stories.length;
    const ordered = [...stories.slice(start), ...stories.slice(0, start)];

    for (const snapshot of ordered) {
      let attempted = false;
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
            return;
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
            if (await releaseWaitingClaim()) return;
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
            if (await releaseWaitingClaim()) return;
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
            if (await releaseWaitingClaim()) return;
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
        if (!(await board.claim(story))) return;
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
          await this.refineStory(fresh, extraContext, store, latestComments);
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
      if (attempted) return;
    }
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
    return (
      creation.tasks.length > 0 &&
      creation.tasks.every((child) =>
        tasks.some(
          (task) =>
            task.itemId === child.itemId && task.number === child.number,
        ),
      ) &&
      tasks.every(
        (task) =>
          task.closed &&
          task.status?.toLowerCase() === cfg.columns.done.toLowerCase() &&
          task.number !== undefined &&
          !this.ticketWorktrees.localBranchSha(
            taskBranch(cfg.branches.task_prefix, task.number),
          ),
      )
    );
  }

  private async processTaskDesignCards(cards: Card[]): Promise<void> {
    const { cfg, meta, botLogin, callback } = this.deps;
    if (this.executor.activeCount() >= cfg.max_workers) return;

    const candidates = cards.filter(
      (card) =>
        isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
        (card.status ?? "").toLowerCase() ===
          cfg.columns.needs_design.toLowerCase() &&
        !card.closed,
    );
    if (candidates.length === 0) return;

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
            if (
              !(await this.revisionAllowsNewWork()) ||
              !this.admitNewWork ||
              this.executor.activeCount() >= cfg.max_workers
            )
              throw new StaleCardError("Task design admissions stopped.");
            ranDesign = true;
            return baseOps.design(designInput);
          },
        },
      );
      if (ranDesign || (result !== "waiting" && result !== "skipped")) return;
    }
  }

  private async refineStory(
    story: Card,
    extraContext: string,
    store: RefineStateStore,
    comments: IssueComment[],
  ): Promise<void> {
    const { cfg, meta, repoOwner, repoName, botLogin, callback } = this.deps;
    const board = this.boardOps();
    const identity = storyIdentity(story, meta.projectId);
    const number = identity.number;
    let creation = store.get(number)?.creation;
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
        if (this.executor.activeCount() >= cfg.max_workers) return;
        const refine = await (this.deps.refine ?? runRefine)({
          cwd: this.deps.cwd,
          storyTitle: story.title,
          storyBody: story.body,
          extraContext,
          contextDigest,
          model: cfg.models.refine,
          timeoutMs: cfg.refine.timeout_ms,
        });
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
      try {
        await this.currentCard(card, false);
        claimed = true;
        if (!(await board.claim(card))) continue;
        const fresh = await this.currentCard(card);
        const task = buildTasksForWave(cfg, planSlug(card.plan), [fresh])[0];
        const record = this.ticketWorktrees.read(card.itemId);
        if (
          !record ||
          record.issueNumber !== fresh.number ||
          record.plan !== planSlug(card.plan) ||
          record.taskBranch !== task.taskBranch ||
          record.activeRunId ||
          record.launchingAt !== undefined ||
          record.finalization
        )
          throw new Error("Missing matching idle v3 record before review.");
        this.state.reviewingTask = task.taskKey;
        callback(`AI reviewing task "${fresh.title}" on ${task.taskBranch}…`);
        const review = await (this.deps.review ?? runReview)({
          cwd: this.deps.cwd,
          taskKey: task.taskKey,
          title: fresh.title,
          body: fresh.body,
          issueNumber: task.issueNumber,
          baseBranch: record.baseBranch,
          taskBranch: task.taskBranch,
          model: cfg.models.review,
          timeoutMs: cfg.review.timeout_ms,
        });
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
          current.finalization
        )
          throw new Error("Execution record changed during review.");
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
        const id = await board.comment(latest, renderReviewComment(review));
        if (!id) throw new Error("Failed to post AI review findings.");
        await this.currentCard(latest);
        await board.setStatus(latest, cfg.columns.ready);
        callback(
          `AI review found ${review.findings.length} blocking issue(s) in "${latest.title}". → ${cfg.columns.ready}`,
          "warn",
        );
      } catch (error) {
        callback(
          `AI review failed for "${card.title}": ${error instanceof Error ? error.message : String(error)}. Leaving status unchanged.`,
          "warn",
        );
      } finally {
        this.state.reviewingTask = null;
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

  private async processClosedDoneCards(cards: Card[]): Promise<void> {
    const { cfg, callback, repoOwner, repoName } = this.deps;
    const candidates = cards.filter(
      (card) =>
        card.closed === true &&
        (card.status ?? "").toLowerCase() === cfg.columns.done.toLowerCase() &&
        isTargetIssue(card, repoOwner, repoName, "Task"),
    );
    for (const card of candidates) {
      const outcome = await this.executor.finalizeClosed(card);
      if (outcome.status === "blocked")
        callback(
          `Finalization blocked for "${card.title}": ${outcome.reason}`,
          "warn",
        );
    }
  }
}
