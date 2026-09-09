/** Core polling loop: reconcile durable ticket runs, then fill global worker slots. */
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import {
  type Card,
  type IssueComment,
  type ProjectMetadata,
  createComment,
  getCard,
  listCards,
  listIssueComments,
  release,
  setStatus,
  tryClaim,
  updateIssueBody,
} from "./gh.js";
import { ensurePlanBranch, isClean } from "./git-helpers.js";
import { makeNotifier } from "./notify.js";
import {
  type DesignOutput,
  type DesignRunInput,
  RefineStateStore,
  createTasksFromRefine,
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

function trustedMaintainerComments(comments: IssueComment[]): IssueComment[] {
  return comments.filter(
    (comment) =>
      !!comment.author &&
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

  const trusted = trustedMaintainerComments(comments.slice(requestIndex + 1));
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
    !!card?.number &&
    !!card.repoOwner &&
    !!card.repoName &&
    !card.closed &&
    (card.type ?? "").toLowerCase() !== "story" &&
    (card.status ?? "").toLowerCase() === cfg.columns.needs_design.toLowerCase()
  );
}

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

    claimed = await ops.claim(card);
    if (!claimed) return "skipped";

    const fresh = await ops.refresh(card);
    if (!isNeedsDesignTask(fresh, cfg) || !ownsTaskDesignClaim(fresh, botLogin))
      return "skipped";

    const request = taskDesignRequest(
      await ops.listComments(fresh),
      card.number,
      botLogin,
    );
    if (needsGate) {
      if (request.active) return "waiting";
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
    await ops.updateBody(latest, design.body);
    await ops.setReady(latest);
    callback(`Task "${latest.title}" designed → ${cfg.columns.ready}.`);
    return "ready";
  } catch (error) {
    callback(
      `Task design failed for "${card.title}": ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return "error";
  } finally {
    if (claimed) await ops.release(card);
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
      await this.executor.shutdown();
    } finally {
      this.ownerLock?.release();
    }
    this.deps.callback("Loop stopped.", "info");
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
    try {
      const { cfg, callback, repoOwner, repoName, meta } = this.deps;
      const cards = await this.fetchCards();
      await this.executor.reconcile(cards);
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
          }).tick();
        } catch (error: any) {
          callback(`Watchdog tick failed: ${error.message}`, "warn");
        }
      }

      await this.processClosedDoneCards(cards);

      if (!this.admitNewWork) return;
      const reviewCandidates = cards.filter(
        (card) =>
          (card.status ?? "").toLowerCase() ===
            cfg.columns.review.toLowerCase() &&
          card.plan &&
          (card.type ?? "").toLowerCase() !== "story",
      );
      const readyCandidates = cards.filter(
        (card) =>
          (card.type ?? "").toLowerCase() !== "story" &&
          (card.status ?? "").toLowerCase() ===
            cfg.columns.ready.toLowerCase() &&
          Boolean(card.plan) &&
          (!cfg.safety.skip_closed_issues || !card.closed),
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

  /**
   * Story lifecycle (Phase C):
   *  - Ready stories  → refine (1 cheap pass) → sub-issue tasks on the board,
   *    or Needs Design if open questions remain
   *  - Needs Design   → re-refine when the human replies on the issue thread
   *  - In Progress    → Done when every task is merged into branches.base
   */
  private async processStories(cards: Card[]): Promise<void> {
    const { cfg, meta, botLogin, callback } = this.deps;
    const stories = cards.filter(
      (c) => (c.type ?? "").toLowerCase() === "story",
    );
    if (stories.length === 0) return;

    const refineState = new RefineStateStore(this.deps.cwd);
    const readyStatus = cfg.columns.ready.toLowerCase();
    const needsDesign = cfg.columns.needs_design.toLowerCase();
    const inProgress = cfg.columns.building.toLowerCase();
    const contextDigest = await this.getContextDigest();

    const story =
      stories.find(
        (candidate) => (candidate.status ?? "").toLowerCase() === needsDesign,
      ) ??
      stories.find(
        (candidate) => (candidate.status ?? "").toLowerCase() === readyStatus,
      ) ??
      stories.find(
        (candidate) => (candidate.status ?? "").toLowerCase() === inProgress,
      );
    if (!story) return;
    const status = (story.status ?? "").toLowerCase();
    const slug = story.plan ?? "";
    if (!slug) return;

    if (status === needsDesign) {
      if (!story.number || !story.repoOwner || !story.repoName) return;
      const state = refineState.get(story.number);
      const comments = await listIssueComments(
        story.repoOwner,
        story.repoName,
        story.number,
      ).catch(() => []);
      const lastSeenIndex = state?.lastSeenCommentId
        ? comments.findIndex(
            (comment) => comment.id === state.lastSeenCommentId,
          )
        : -1;
      const fresh =
        lastSeenIndex >= 0 ? comments.slice(lastSeenIndex + 1) : comments;
      const humanReplies = trustedMaintainerComments(fresh);
      if (humanReplies.length === 0) return;
      callback(
        `Story #${story.number} has ${humanReplies.length} new human reply/replies — re-refining…`,
      );
      await this.refineStory(
        story,
        slug,
        contextDigest,
        humanReplies.map((comment) => `- ${comment.body}`).join("\n"),
        refineState,
      );
      return;
    }

    if (status === inProgress) {
      const state = refineState.get(story.number ?? 0);
      const sluggedPlan = planSlug(slug);
      const planTasks = cards.filter(
        (candidate) =>
          (candidate.type ?? "").toLowerCase() !== "story" &&
          Boolean(candidate.plan) &&
          planSlug(candidate.plan!) === sluggedPlan,
      );
      const tasksFinalized =
        planTasks.length > 0 &&
        planTasks.every((candidate) => {
          if (
            !candidate.closed ||
            (candidate.status ?? "").toLowerCase() !==
              cfg.columns.done.toLowerCase() ||
            this.ticketWorktrees.has(candidate.itemId)
          )
            return false;
          const task = buildTasksForWave(cfg, sluggedPlan, [candidate])[0];
          return this.ticketWorktrees.isMerged(
            candidate.itemId,
            cfg.branches.base,
            task.taskBranch,
          );
        });
      if (state?.refined && tasksFinalized) {
        await setStatus(meta, story.itemId, cfg.columns.done).catch(
          () => undefined,
        );
        callback(
          `Story "${story.title}" → ${cfg.columns.done} (all tasks merged into ${cfg.branches.base})`,
        );
      }
      return;
    }

    if (status !== readyStatus) return;
    if (!story.number) {
      callback(
        `Story "${story.title}" is a draft item — convert it to an issue to refine it.`,
        "warn",
      );
      return;
    }
    if (!(await tryClaim(story, botLogin))) {
      callback(
        `Story "${story.title}" already claimed by someone else.`,
        "warn",
      );
      return;
    }
    try {
      await setStatus(meta, story.itemId, cfg.columns.building);
    } catch (error: any) {
      callback(
        `Failed to move story to ${cfg.columns.building}: ${error.message}`,
        "warn",
      );
      await release(story, botLogin);
      return;
    }
    await this.refineStory(story, slug, contextDigest, "", refineState);
    await release(story, botLogin);
  }

  private async processTaskDesignCards(cards: Card[]): Promise<void> {
    const { cfg, meta, botLogin, callback } = this.deps;
    if (this.executor.activeCount() >= cfg.max_workers) return;

    const candidates = cards.filter(
      (card) =>
        (card.type ?? "").toLowerCase() !== "story" &&
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
          design: async (designInput) => {
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
    slug: string,
    contextDigest: string,
    extraContext: string,
    refineState: RefineStateStore,
  ): Promise<void> {
    const { cfg, meta, repoOwner, repoName, callback } = this.deps;
    if (!story.number) return;
    const number = story.number;
    try {
      const refine = await runRefine({
        cwd: this.deps.cwd,
        storyTitle: story.title,
        storyBody: story.body,
        extraContext,
        contextDigest,
        model: cfg.models.refine,
        timeoutMs: cfg.refine.timeout_ms,
      });

      if (refine.openQuestions.length > 0) {
        const questionId = await this.createCommentWithId(
          number,
          repoOwner,
          repoName,
          renderQuestionsComment(slug, refine),
        );
        await setStatus(meta, story.itemId, cfg.columns.needs_design).catch(
          () => undefined,
        );
        refineState.update(number, {
          refined: false,
          lastSeenCommentId: questionId,
        });
        callback(
          `Story "${story.title}" → ${cfg.columns.needs_design}: ${refine.openQuestions.length} domanda/e aperta/e.`,
        );
        await makeNotifier(cfg)(
          "refine_questions",
          `Domande di design: ${story.title}`,
          refine.openQuestions.join("\n"),
        );
        return;
      }

      const created = await createTasksFromRefine({
        cfg,
        meta,
        repoOwner,
        repoName,
        storyCard: story,
        planSlug: slug,
        refine,
        existingTaskCount: await this.countPlanTasks(slug),
        projectId: meta.projectId,
      });
      await this.createCommentWithId(
        number,
        repoOwner,
        repoName,
        renderRefineComment(slug, refine, created),
      );
      await setStatus(meta, story.itemId, cfg.columns.building).catch(
        () => undefined,
      );
      refineState.update(number, { refined: true });
      callback(
        `Story "${story.title}" raffinata: ${created.length} task creati (${created.map((item) => item.taskKey).join(", ")}).`,
      );
      await makeNotifier(cfg)(
        "refine_done",
        `Storia raffinata: ${story.title}`,
        `${created.length} task creati: ${created.map((item) => item.taskKey).join(", ")}`,
        created.map((item) => item.url),
      );
    } catch (error: any) {
      await setStatus(meta, story.itemId, cfg.columns.ready).catch(
        () => undefined,
      );
      await this.createCommentWithId(
        number,
        repoOwner,
        repoName,
        `❌ Refine fallito per la storia: ${error.message}`,
      ).catch(() => undefined);
      callback(
        `Refine della storia "${story.title}" fallito: ${error.message}`,
        "error",
      );
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
    return (await this.fetchCards().catch(() => [])).filter(
      (card) =>
        card.plan === slug && (card.type ?? "").toLowerCase() === "task",
    ).length;
  }

  private async processReviewCards(reviewCards: Card[]): Promise<void> {
    const { cfg, meta, callback } = this.deps;

    for (const card of reviewCards) {
      const rawPlan = card.plan;
      if (!rawPlan || !(await tryClaim(card, this.deps.botLogin))) continue;
      try {
        const task = buildTasksForWave(cfg, planSlug(rawPlan), [card])[0];
        this.state.reviewingTask = task.taskKey;
        callback(`AI reviewing task "${card.title}" on ${task.taskBranch}…`);
        const review = await runReview({
          cwd: this.deps.cwd,
          taskKey: task.taskKey,
          title: card.title,
          body: card.body,
          issueNumber: card.number,
          baseBranch: cfg.branches.base,
          planBranch:
            this.ticketWorktrees.read(card.itemId)?.planBranch ??
            task.planBranch,
          taskBranch: task.taskBranch,
          model: cfg.models.review,
          timeoutMs: cfg.review.timeout_ms,
        });
        this.state.reviewingTask = null;

        if (review.verdict === "pass") {
          if (!card.number || !card.repoOwner || !card.repoName) {
            throw new Error(
              "A manually validated task must be backed by a GitHub issue.",
            );
          }
          await setStatus(meta, card.itemId, cfg.columns.done);
          const worktree = this.ticketWorktrees.read(card.itemId);
          callback(
            `AI review passed for "${card.title}" → ${cfg.columns.done}. Validate ${worktree?.path ?? task.taskBranch}, then close issue #${card.number} to merge.`,
          );
          return;
        }

        if (!card.number || !card.repoOwner || !card.repoName)
          throw new Error("Cannot post AI review findings for a draft card.");
        const commentId = await this.createCommentWithId(
          card.number,
          card.repoOwner,
          card.repoName,
          renderReviewComment(review),
        );
        if (!commentId) throw new Error("Failed to post AI review findings.");
        await setStatus(meta, card.itemId, cfg.columns.ready);
        callback(
          `AI review found ${review.findings.length} blocking issue(s) in "${card.title}". → ${cfg.columns.ready}`,
          "warn",
        );
      } catch (error: any) {
        this.state.reviewingTask = null;
        callback(
          `AI review failed for "${card.title}": ${error.message}. Leaving in ${cfg.columns.review}.`,
          "warn",
        );
      } finally {
        await release(card, this.deps.botLogin);
      }
      return;
    }
  }

  private async processClosedDoneCards(cards: Card[]): Promise<void> {
    const { cfg, callback } = this.deps;
    const closed = cards.filter(
      (card) =>
        card.closed &&
        card.plan &&
        (card.status ?? "").toLowerCase() === cfg.columns.done.toLowerCase() &&
        (card.type ?? "").toLowerCase() !== "story",
    );

    for (const card of closed) {
      const slug = planSlug(card.plan!);
      const task = buildTasksForWave(cfg, slug, [card])[0];
      const alreadyMerged = this.ticketWorktrees.isMerged(
        card.itemId,
        cfg.branches.base,
        task.taskBranch,
      );
      if (alreadyMerged && !this.ticketWorktrees.has(card.itemId)) continue;
      if (!card.number || !card.repoOwner || !card.repoName) {
        callback(
          `Cannot finalize draft card "${card.title}"; a closed GitHub issue is required.`,
          "warn",
        );
        continue;
      }

      let claimed = false;
      try {
        claimed = await tryClaim(card, this.deps.botLogin);
        if (!claimed) continue;
        ensurePlanBranch(task.planBranch, cfg.branches.base, this.deps.cwd);
        const worktree = alreadyMerged
          ? this.ticketWorktrees.read(card.itemId)
          : this.ticketWorktrees.ensure(task, slug);
        if (!worktree)
          throw new Error(`Ticket execution record is corrupt: ${card.itemId}`);

        if (alreadyMerged) {
          callback(
            `Issue #${card.number} is already merged. Finishing cleanup for ${task.taskBranch}…`,
          );
          this.ticketWorktrees.removeMerged(worktree, cfg.branches.base);
        } else {
          callback(
            `Issue #${card.number} is closed. Merging ${task.taskBranch} → ${cfg.branches.base}…`,
          );
          this.ticketWorktrees.mergeAndRemove(
            worktree,
            cfg.task_merge_strategy,
            card.number,
            card.title,
            cfg.branches.base,
          );
        }
        callback(
          `Finalized "${card.title}" in ${cfg.branches.base}; removed ${worktree.path} and deleted ${task.taskBranch} locally and from origin`,
        );
      } catch (error: any) {
        callback(
          `Finalization failed for "${card.title}": ${error.message}`,
          "warn",
        );
      } finally {
        if (claimed) await release(card, this.deps.botLogin);
      }
    }
  }
}
