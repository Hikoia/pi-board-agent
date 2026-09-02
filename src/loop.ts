/** Core polling loop: reconcile durable ticket runs, then fill global worker slots. */
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import {
  type Card,
  type ProjectMetadata,
  createComment,
  isPrMerged,
  listCards,
  listIssueComments,
  release,
  setStatus,
  tryClaim,
} from "./gh.js";
import { ensurePlanBranch, isClean } from "./git-helpers.js";
import { makeNotifier } from "./notify.js";
import { isPlanComplete, openPlanPr, summarizePlans } from "./plan.js";
import {
  RefineStateStore,
  createTasksFromRefine,
  renderQuestionsComment,
  renderRefineComment,
  runRefine,
} from "./refine.js";
import { renderReviewComment, runReview } from "./review.js";
import type { TicketExecutor } from "./ticket-executor.js";
import { TicketWorktrees } from "./ticket-worktree.js";
import { buildTasksForWave } from "./workflow-prompt.js";
import type { OwnerLock } from "./owner-lock.js";

export type StatusCallback = (msg: string, level?: "info" | "warn" | "error") => void;

export interface LoopState {
  running: boolean;
  tickCount: number;
  wavesLaunched: number;
  prsOpened: number;
  lastTickMs: number;
}

export interface LoopDeps {
  cwd: string;
  cfg: Config;
  repoOwner: string;
  repoName: string;
  botLogin: string;
  meta: ProjectMetadata;
  callback: StatusCallback;
  /** Offline adapter; production uses gh.ts. */
  listCards?: () => Promise<Card[]>;
}

export function createLoopState(): LoopState {
  return {
    running: false,
    tickCount: 0,
    wavesLaunched: 0,
    prsOpened: 0,
    lastTickMs: 0,
  };
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
    await this.tickNow().catch((error: Error) => this.deps.callback(`start tick failed: ${error.message}`, "error"));
    if (!this.state.running || this.stopped) return;
    this.intervalId = setInterval(() => {
      void this.tickNow().catch((error: Error) => this.deps.callback(`tick failed: ${error.message}`, "error"));
    }, this.deps.cfg.tick_seconds * 1000);
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
    return this.deps.listCards?.() ?? listCards(meta.projectId, cfg.status_field, cfg.plan_field, cfg.type_field);
  }

  private async tick(): Promise<void> {
    try {
      const { cfg, callback, repoOwner, repoName, meta } = this.deps;
      const cards = await this.fetchCards();
      await this.executor.reconcile(cards);
      if (!this.admitNewWork) return;
      if (cards.length === 0) {
        callback("No cards on the board yet.");
        return;
      }

      // Recovery must run even when the main checkout is dirty; only new launches stop here.
      if (cfg.safety.require_clean_worktree && !isClean(this.deps.cwd)) {
        callback("Working tree is dirty. Reconciled existing runs but skipped new work.", "warn");
        return;
      }

      if (cfg.refine.enabled) await this.processStories(cards);

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

      if (cfg.review.enabled) await this.processReviewCards(cards);
      const finalizationFailures = await this.processClosedDoneCards(cards);

      const plans = summarizePlans(cfg, cards);
      for (const [, summary] of plans) {
        const tasksFinalized = summary.cards
          .filter((card) => (card.type ?? "").toLowerCase() !== "story")
          .every((card) => card.closed && !this.ticketWorktrees.has(card.itemId));
        if (!isPlanComplete(summary) || !tasksFinalized || finalizationFailures.has(summary.slug)) continue;

        ensurePlanBranch(`${cfg.branches.plan_prefix}${summary.slug}`, cfg.branches.base, this.deps.cwd);
        const result = await openPlanPr({ cwd: this.deps.cwd, cfg, repoOwner, repoName, summary });
        if (result.status !== "opened" && result.status !== "exists") continue;
        this.state.prsOpened++;
        callback(`Plan PR ${result.status}: ${result.url ?? summary.slug}`);
        if (result.status === "opened") {
          await makeNotifier(cfg)(
            "pr_opened",
            `PR aperta: ${summary.rawName}`,
            `#${result.number} — ${result.url}`,
            [result.url ?? ""],
          );
        }
      }

      if (!this.admitNewWork) return;
      let slots = Math.max(0, cfg.max_workers - this.executor.activeCount());
      if (slots <= 0) return;
      const ready = cards.filter((card) =>
        (card.type ?? "").toLowerCase() !== "story" &&
        (card.status ?? "").toLowerCase() === cfg.columns.ready.toLowerCase() &&
        !!card.plan &&
        (!cfg.safety.skip_closed_issues || !card.closed)
      );

      for (const card of ready) {
        if (!this.admitNewWork || slots <= 0) break;
        const result = await this.executor.launch(card, planSlug(card.plan!));
        if (result.status !== "launched") continue;
        slots--;
        this.state.wavesLaunched++;
      }
    } finally {
      this.state.tickCount++;
      this.state.lastTickMs = Date.now();
    }
  }

  /**
   * Story lifecycle (Phase C):
   *  - Ready stories  → refine (1 cheap pass) → sub-issue tasks on the board,
   *    or Needs Design if open questions remain
   *  - Needs Design   → re-refine when the human replies on the issue thread
   *  - In Progress    → Done when the plan PR is merged
   */
  private async processStories(cards: Card[]): Promise<void> {
    const { cfg, meta, repoOwner, repoName, botLogin, callback } = this.deps;
    const stories = cards.filter((c) => (c.type ?? "").toLowerCase() === "story");
    if (stories.length === 0) return;

    const refineState = new RefineStateStore(this.deps.cwd);
    const readyStatus = cfg.columns.ready.toLowerCase();
    const needsDesign = cfg.columns.needs_design.toLowerCase();
    const inProgress = cfg.columns.building.toLowerCase();
    const contextDigest = await this.getContextDigest();

    const story = stories[0];
    const status = (story.status ?? "").toLowerCase();
    const slug = story.plan ?? "";
    if (!slug) return;

    if (status === needsDesign) {
      if (!story.number || !story.repoOwner || !story.repoName) return;
      const state = refineState.get(story.number);
      const comments = await listIssueComments(story.repoOwner, story.repoName, story.number).catch(() => []);
      const fresh = state?.lastSeenCommentId
        ? comments.filter((comment) => comment.id !== state.lastSeenCommentId)
        : comments;
      const humanReplies = fresh.filter((comment) => comment.author && comment.author !== botLogin);
      if (humanReplies.length === 0) return;
      callback(`Story #${story.number} has ${humanReplies.length} new human reply/replies — re-refining…`);
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
      if (state?.refined && await isPrMerged(repoOwner, repoName, `${cfg.branches.plan_prefix}${planSlug(slug)}`)) {
        await setStatus(meta, story.itemId, cfg.columns.done).catch(() => undefined);
        callback(`Story "${story.title}" → ${cfg.columns.done} (plan PR merged)`);
      }
      return;
    }

    if (status !== readyStatus) return;
    if (!story.number) {
      callback(`Story "${story.title}" is a draft item — convert it to an issue to refine it.`, "warn");
      return;
    }
    if (!(await tryClaim(story, botLogin))) {
      callback(`Story "${story.title}" already claimed by someone else.`, "warn");
      return;
    }
    try {
      await setStatus(meta, story.itemId, cfg.columns.building);
    } catch (error: any) {
      callback(`Failed to move story to ${cfg.columns.building}: ${error.message}`, "warn");
      await release(story, botLogin);
      return;
    }
    await this.refineStory(story, slug, contextDigest, "", refineState);
    await release(story, botLogin);
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
        const questionId = await this.createCommentWithId(number, repoOwner, repoName, renderQuestionsComment(slug, refine));
        await setStatus(meta, story.itemId, cfg.columns.needs_design).catch(() => undefined);
        refineState.update(number, { refined: false, lastSeenCommentId: questionId });
        callback(`Story "${story.title}" → ${cfg.columns.needs_design}: ${refine.openQuestions.length} domanda/e aperta/e.`);
        await makeNotifier(cfg)("refine_questions", `Domande di design: ${story.title}`, refine.openQuestions.join("\n"));
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
      await this.createCommentWithId(number, repoOwner, repoName, renderRefineComment(slug, refine, created));
      await setStatus(meta, story.itemId, cfg.columns.building).catch(() => undefined);
      refineState.update(number, { refined: true });
      callback(`Story "${story.title}" raffinata: ${created.length} task creati (${created.map((item) => item.taskKey).join(", ")}).`);
      await makeNotifier(
        cfg,
      )("refine_done", `Storia raffinata: ${story.title}`, `${created.length} task creati: ${created.map((item) => item.taskKey).join(", ")}`, created.map((item) => item.url));
    } catch (error: any) {
      await setStatus(meta, story.itemId, cfg.columns.ready).catch(() => undefined);
      await this.createCommentWithId(number, repoOwner, repoName, `❌ Refine fallito per la storia: ${error.message}`).catch(() => undefined);
      callback(`Refine della storia "${story.title}" fallito: ${error.message}`, "error");
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
      return await createComment(await resolveIssueId(repoOwner, repoName, issueNumber), body);
    } catch {
      return undefined;
    }
  }

  private async getContextDigest(): Promise<string> {
    const { cfg } = this.deps;
    if (!cfg.context.enabled) return "";
    try {
      const { generateContext } = await import("./context.js");
      return generateContext({ cwd: this.deps.cwd, maxChars: cfg.context.max_chars, exclude: cfg.context.exclude });
    } catch {
      return "";
    }
  }

  private async countPlanTasks(slug: string): Promise<number> {
    return (await this.fetchCards().catch(() => [])).filter(
      (card) => card.plan === slug && (card.type ?? "").toLowerCase() === "task",
    ).length;
  }

  private async processReviewCards(cards: Card[]): Promise<void> {
    const { cfg, meta, callback } = this.deps;
    const reviewCards = cards.filter((card) =>
      (card.status ?? "").toLowerCase() === cfg.columns.review.toLowerCase() &&
      card.plan &&
      (card.type ?? "").toLowerCase() !== "story"
    ).slice(0, cfg.max_workers);

    for (const card of reviewCards) {
      const rawPlan = card.plan;
      if (!rawPlan || !(await tryClaim(card, this.deps.botLogin))) continue;
      try {
        const task = buildTasksForWave(cfg, planSlug(rawPlan), [card])[0];
        callback(`AI reviewing task "${card.title}" on ${task.taskBranch}…`);
        const review = await runReview({
          cwd: this.deps.cwd,
          taskKey: task.taskKey,
          title: card.title,
          body: card.body,
          issueNumber: card.number,
          baseBranch: cfg.branches.base,
          planBranch: task.planBranch,
          taskBranch: task.taskBranch,
          model: cfg.models.review,
          timeoutMs: cfg.review.timeout_ms,
        });

        if (review.verdict === "pass") {
          if (!card.number || !card.repoOwner || !card.repoName) {
            throw new Error("A manually validated task must be backed by a GitHub issue.");
          }
          await setStatus(meta, card.itemId, cfg.columns.done);
          const worktree = this.ticketWorktrees.read(card.itemId);
          callback(`AI review passed for "${card.title}" → ${cfg.columns.done}. Validate ${worktree?.path ?? task.taskBranch}, then close issue #${card.number} to merge.`);
          continue;
        }

        if (!card.number || !card.repoOwner || !card.repoName) throw new Error("Cannot post AI review findings for a draft card.");
        const commentId = await this.createCommentWithId(card.number, card.repoOwner, card.repoName, renderReviewComment(review));
        if (!commentId) throw new Error("Failed to post AI review findings.");
        await setStatus(meta, card.itemId, cfg.columns.ready);
        callback(`AI review found ${review.findings.length} blocking issue(s) in "${card.title}". → ${cfg.columns.ready}`, "warn");
      } catch (error: any) {
        callback(`AI review failed for "${card.title}": ${error.message}. Leaving in ${cfg.columns.review}.`, "warn");
      } finally {
        await release(card, this.deps.botLogin);
      }
    }
  }

  private async processClosedDoneCards(cards: Card[]): Promise<Set<string>> {
    const { cfg, callback } = this.deps;
    const failedPlans = new Set<string>();
    const closed = cards.filter((card) =>
      card.closed &&
      card.plan &&
      (card.status ?? "").toLowerCase() === cfg.columns.done.toLowerCase() &&
      (card.type ?? "").toLowerCase() !== "story"
    );

    for (const card of closed) {
      const slug = planSlug(card.plan!);
      const task = buildTasksForWave(cfg, slug, [card])[0];
      if (this.ticketWorktrees.isMerged(card.itemId, task.planBranch, task.taskBranch) && !this.ticketWorktrees.has(card.itemId)) continue;
      if (!card.number || !card.repoOwner || !card.repoName) {
        failedPlans.add(slug);
        callback(`Cannot finalize draft card "${card.title}"; a closed GitHub issue is required.`, "warn");
        continue;
      }

      let claimed = false;
      try {
        claimed = await tryClaim(card, this.deps.botLogin);
        if (!claimed) {
          failedPlans.add(slug);
          continue;
        }
        ensurePlanBranch(task.planBranch, cfg.branches.base, this.deps.cwd);
        const worktree = this.ticketWorktrees.ensure(task, slug);
        callback(`Issue #${card.number} is closed. Merging ${task.taskBranch} → ${task.planBranch}…`);
        this.ticketWorktrees.mergeAndRemove(worktree, cfg.task_merge_strategy, card.number, card.title);
        callback(`Merged "${card.title}" and removed ${worktree.path}`);
      } catch (error: any) {
        failedPlans.add(slug);
        callback(`Finalization failed for "${card.title}": ${error.message}`, "warn");
      } finally {
        if (claimed) await release(card, this.deps.botLogin);
      }
    }
    return failedPlans;
  }
}
