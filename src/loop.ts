/**
 * Core polling loop.
 *
 * Responsibilities:
 *  - Tick every `cfg.tick_seconds` seconds
 *  - Fetch all cards from the configured project
 *  - For each plan: detect completions → open PR
 *  - For cards in `ready`: claim, then hand them to a pi-dynamic-workflows wave
 *  - For cards in `building` past timeout: attempt recovery (re-assign)
 *  - For cards in `review` → independent AI review when enabled
 *
 * The loop does NOT spawn subagents directly — it delegates to the
 * pi-dynamic-workflows `workflow` tool via `dx.workflow.run()`.
 */

import type { Config } from "./config.js";
import {
  type Card,
  type ProjectMetadata,
  getProjectMetadata,
  listCards,
  setStatus,
  tryClaim,
  release,
  closeIssue,
} from "./gh.js";
import { Inflight } from "./inflight.js";
import { summarizePlans, isPlanComplete, openPlanPr } from "./plan.js";
import { buildTasksForWave, renderWorkflowSource, type BuilderTask } from "./workflow-prompt.js";
import { isClean, ensurePlanBranch } from "./git-helpers.js";
import { planSlug } from "./config.js";
import {
  runRefine,
  createTasksFromRefine,
  RefineStateStore,
  renderRefineComment,
  renderQuestionsComment,
  type RefineOutput,
} from "./refine.js";
import { listIssueComments, createComment, isPrMerged } from "./gh.js";
import { makeNotifier } from "./notify.js";
import { renderReviewComment, runReview } from "./review.js";

export type StatusCallback = (msg: string, level?: "info" | "warn" | "error") => void;

export interface LoopState {
  running: boolean;
  /** pi-dynamic-workflows run ID of the currently active wave, if any. */
  activeWorkflowRunId?: string;
  tickCount: number;
  wavesLaunched: number;
  prsOpened: number;
  cardsCompleted: number;
  lastTickMs: number;
}

/**
 * Dependencies the loop needs from the outside world (injected so we can test
 * offline). `Dx` is short for "dynamic execution".
 */
export interface LoopDeps {
  cwd: string;
  cfg: Config;
  repoOwner: string;
  repoName: string;
  botLogin: string;
  meta: ProjectMetadata;
  callback: StatusCallback;

  /** Run a pi-dynamic-workflows script and return the run id. */
  dxRun: (script: string) => Promise<string>;

  /** Wait for a pi-dynamic-workflows run to finish, then return its result. */
  dxResult: (runId: string) => Promise<any[]>;
}

export function createLoopState(): LoopState {
  return {
    running: false,
    tickCount: 0,
    wavesLaunched: 0,
    prsOpened: 0,
    cardsCompleted: 0,
    lastTickMs: 0,
  };
}

export class BoardLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private deps: LoopDeps,
    private state: LoopState,
    private inflight: Inflight,
  ) {}

  start(): void {
    if (this.state.running) return;
    this.state.running = true;
    const ms = this.deps.cfg.tick_seconds * 1000;
    this.tick().catch(
      (err) => this.deps.callback(`start tick failed: ${err.message}`, "error"),
    );
    this.intervalId = setInterval(() => {
      if (!this.busy) {
        this.tick().catch(
          (err) => this.deps.callback(`tick failed: ${err.message}`, "error"),
        );
      }
    }, ms);
    this.deps.callback(`Loop started (tick=${this.deps.cfg.tick_seconds}s)`);
  }

  isRunning(): boolean {
    return this.state.running;
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.state.running = false;
    this.deps.callback("Loop stopped.", "info");
  }

  private async tick(): Promise<void> {
    this.busy = true;
    try {
      const { cfg, callback, repoOwner, repoName, meta } = this.deps;
      const cards = await listCards(meta.projectId, cfg.status_field, cfg.plan_field, cfg.type_field);
      if (cards.length === 0) {
        callback("No cards on the board yet.");
        return;
      }

      // Safety check: too many stuck in building?
      const stuckBuilding = cards.filter(
        (c) => (c.status ?? "").toLowerCase() === cfg.columns.building.toLowerCase(),
      );
      if (stuckBuilding.length > cfg.safety.max_stuck_building) {
        callback(
          `${stuckBuilding.length} cards stuck in ${cfg.columns.building} (max ${cfg.safety.max_stuck_building}). Pausing — please unstick manually.`,
          "warn",
        );
        return;
      }

      // Safety: require clean worktree?
      if (cfg.safety.require_clean_worktree && !isClean(this.deps.cwd)) {
        callback("Working tree is dirty. Skipping tick.", "warn");
        return;
      }

      // --- Stories: refine Ready stories / re-refine Needs Design / Done on merge ---
      if (cfg.refine.enabled) {
        await this.processStories(cards);
      }

      // --- Watchdog: healthy bot PRs (CI fixes + mentions) ---
      if (cfg.watchdog.enabled) {
        try {
          const { Watchdog } = await import("./watchdog.js");
          const wd = new Watchdog({
            cwd: this.deps.cwd,
            cfg,
            repoOwner,
            repoName,
            botLogin: this.deps.botLogin,
            meta,
            callback,
          });
          await wd.tick();
        } catch (err: any) {
          callback(`Watchdog tick failed: ${err.message}`, "warn");
        }
      }

      // --- Review gate: independent AI review → Done or back to Ready ---
      if (cfg.review.enabled) {
        await this.processReviewCards(cards);
      }

      // --- Plan-level: detect completions → open PR ---
      const plans = summarizePlans(cfg, cards);
      for (const [, summary] of plans) {
        if (isPlanComplete(summary)) {
          // Ensure the plan branch exists so there is something to PR.
          ensurePlanBranch(
            `plan/${summary.slug}`,
            cfg.branches.base,
            this.deps.cwd,
          );
          const result = await openPlanPr({
            cwd: this.deps.cwd,
            cfg,
            repoOwner,
            repoName,
            summary,
          });
          if (result.status === "opened" || result.status === "exists") {
            this.state.prsOpened++;
            callback(
              `Plan PR ${result.status === "opened" ? "opened" : "exists"}: ${result.url ?? summary.slug}`,
            );
            if (result.status === "opened") {
              await makeNotifier(cfg)(
                "pr_opened",
                `PR aperta: ${summary.rawName}`,
                `#${result.number} — ${result.url}`,
                [result.url ?? ""],
              );
            }
          }
        }
      }

      // --- Card-level: pick ready cards, claim, dispatch wave ---
      const readyCards = cards.filter(
        (c) =>
          (c.status ?? "").toLowerCase() === cfg.columns.ready.toLowerCase() &&
          c.plan &&
          (!cfg.safety.skip_closed_issues || !c.closed),
      );

      // Group by plan — we can only dispatch ONE wave per plan at a time
      // (otherwise two parallel waves would clobber the same plan branch).
      for (const [, summary] of plans) {
        if (summary.readyCards === 0) continue;
        // Any existing inflight cards for this plan? Skip.
        const inflightCards = this.inflight.listByPlan(summary.slug);
        if (inflightCards.length > 0) continue;

        const planReadyCards = summary.cards.filter(
          (c) => (c.status ?? "").toLowerCase() === cfg.columns.ready.toLowerCase(),
        );
        const batch = planReadyCards.slice(0, cfg.max_workers);
        if (batch.length === 0) continue;

        // Claim each card atomically (assignee mutex).
        const claimed: { card: Card; task: BuilderTask }[] = [];
        for (const card of batch) {
          const claimed_ = await tryClaim(card, this.deps.botLogin);
          if (!claimed_) {
            callback(`Card "${card.title}" could not be claimed — another worker holds it.`, "warn");
            continue;
          }
          // Ensure the plan branch exists on origin before the wave runs.
          try {
            ensurePlanBranch(
              `plan/${summary.slug}`,
              cfg.branches.base,
              this.deps.cwd,
            );
          } catch (err: any) {
            callback(`Failed to ensure plan branch: ${err.message}`, "error");
            await release(card, this.deps.botLogin);
            continue;
          }
          const task = buildTasksForWave(cfg, summary.slug, [card])[0];
          claimed.push({ card, task });

          // Write inflight record immediately (before dispatch).
          this.inflight.write({
            itemId: card.itemId,
            issueNumber: card.number,
            cardTitle: card.title,
            plan: summary.slug,
            taskBranch: task.taskBranch,
            planBranch: task.planBranch,
            startedAt: Date.now(),
          });

          // Move card to Building.
          try {
            await setStatus(meta, card.itemId, cfg.columns.building);
          } catch (err: any) {
            callback(`Failed to move card to ${cfg.columns.building}: ${err.message}`, "warn");
            this.inflight.clear(card.itemId);
            await release(card, this.deps.botLogin);
          }
        }

        if (claimed.length === 0) continue;

        // Dispatch the wave.
        const tasks = claimed.map((x) => x.task);
        let context: string | undefined;
        if (cfg.context.enabled) {
          try {
            const { generateContext } = await import("./context.js");
            context = generateContext({
              cwd: this.deps.cwd,
              maxChars: cfg.context.max_chars,
              exclude: cfg.context.exclude,
            });
            callback(
              `Repo context digest: ${context.length} chars injected into the wave`,
            );
          } catch (err: any) {
            callback(`Context generation failed: ${err.message}`, "warn");
          }
        }
        const script = renderWorkflowSource({
          cfg,
          planSlug: summary.slug,
          baseBranch: cfg.branches.base,
          tasks,
          skillName: "board-agent",
          context,
        });

        this.state.wavesLaunched++;
        callback(
          `Launching wave for plan ${summary.slug}: ${claimed.length} builder(s) → ${cfg.columns.ready}→${cfg.columns.building}→(merge)→${cfg.columns.review}`,
        );

        let runId: string;
        try {
          runId = await this.deps.dxRun(script);
        } catch (err: any) {
          callback(`Failed to launch workflow: ${err.message}`, "error");
          // Clean up: release all claimed cards.
          for (const { card } of claimed) {
            this.inflight.clear(card.itemId);
            await setStatus(meta, card.itemId, cfg.columns.ready)
              .catch(() => {});
            await release(card, this.deps.botLogin);
          }
          continue;
        }

        // Wait for the wave to finish (this blocks the tick, but only
        // one wave per plan is active, so it's fine).
        try {
          const outcomes = await this.deps.dxResult(runId);
          await this.handleWaveResults(outcomes ?? [], claimed);
        } catch (err: any) {
          callback(`Wave failed: ${err.message}`, "error");
          // Leave inflight records — the next tick will see them and let the
          // user manually unstick.
        }
      }

      this.state.tickCount++;
      this.state.lastTickMs = Date.now();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Story lifecycle (Phase C):
   *  - Ready stories  → refine (1 cheap pass) → sub-issue tasks on the board,
   *    or Needs Design if open questions remain
   *  - Needs Design   → re-refine when the human replies on the issue thread
   *  - In Progress    → Done when the plan PR is merged
   */
  private async processStories(cards: import("./gh.js").Card[]): Promise<void> {
    const { cfg, meta, repoOwner, repoName, botLogin, callback } = this.deps;
    const stories = cards.filter(
      (c) => (c.type ?? "").toLowerCase() === "story",
    );
    if (stories.length === 0) return;

    const refineState = new RefineStateStore(this.deps.cwd);
    const readyStatus = cfg.columns.ready.toLowerCase();
    const needsDesign = cfg.columns.needs_design.toLowerCase();
    const inProgress = cfg.columns.building.toLowerCase();
    const doneStatus = cfg.columns.done.toLowerCase();

    const contextDigest = await this.getContextDigest();

    // One story per tick (refine is sequential and can be slow).
    const story = stories[0];
    const status = (story.status ?? "").toLowerCase();
    const slug = story.plan ?? "";
    if (!slug) return;

    // Needs Design: wait for human replies, then re-refine.
    if (status === needsDesign) {
      if (!story.number || !story.repoOwner || !story.repoName) return;
      const state = refineState.get(story.number);
      const comments = await listIssueComments(story.repoOwner, story.repoName, story.number).catch(() => []);
      const lastSeen = state?.lastSeenCommentId;
      const fresh = lastSeen
        ? comments.filter((c) => c.id !== lastSeen)
        : comments;
      const humanReplies = fresh.filter((c) => c.author && c.author !== botLogin);
      if (humanReplies.length === 0) return;

      callback(`Story #${story.number} has ${humanReplies.length} new human reply/replies — re-refining…`);
      const answers = humanReplies.map((c) => `- ${c.body}`).join("\n");
      await this.refineStory(story, slug, contextDigest, answers, refineState, true);
      return;
    }

    // Done when the plan PR is merged.
    if (status === inProgress) {
      const state = refineState.get(story.number ?? 0);
      if (state?.refined) {
        const merged = await isPrMerged(repoOwner, repoName, `plan/${planSlug(slug)}`);
        if (merged) {
          await setStatus(meta, story.itemId, cfg.columns.done).catch(() => undefined);
          callback(`Story "${story.title}" → ${cfg.columns.done} (plan PR merged)`);
        }
      }
      return;
    }

    // Ready → refine (once, guarded by the claim).
    if (status === readyStatus) {
      if (!story.number) {
        callback(`Story "${story.title}" is a draft item — convert it to an issue to refine it.`, "warn");
        return;
      }
      const claimed = await tryClaim(story, botLogin);
      if (!claimed) {
        callback(`Story "${story.title}" already claimed by someone else.`, "warn");
        return;
      }
      try {
        await setStatus(meta, story.itemId, cfg.columns.building);
      } catch (err: any) {
        callback(`Failed to move story to ${cfg.columns.building}: ${err.message}`, "warn");
        await release(story, botLogin);
        return;
      }
      await this.refineStory(story, slug, contextDigest, "", refineState, false);
      await release(story, botLogin);
    }
  }

  private async refineStory(
    story: import("./gh.js").Card,
    slug: string,
    contextDigest: string,
    extraContext: string,
    refineState: RefineStateStore,
    isReRefine: boolean,
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
        await makeNotifier(cfg)(
          "refine_questions",
          `Domande di design: ${story.title}`,
          refine.openQuestions.join("\n"),
        );
        return;
      }

      const existing = await this.countPlanTasks(slug);
      const created = await createTasksFromRefine({
        cfg,
        meta,
        repoOwner,
        repoName,
        storyCard: story,
        planSlug: slug,
        refine,
        existingTaskCount: existing,
        projectId: meta.projectId,
      });
      await this.createCommentWithId(number, repoOwner, repoName, renderRefineComment(slug, refine, created));
      await setStatus(meta, story.itemId, cfg.columns.building).catch(() => undefined);
      refineState.update(number, { refined: true });
      callback(
        `Story "${story.title}" raffinata: ${created.length} task creati (${created.map((c) => c.taskKey).join(", ")}).`,
      );
      await makeNotifier(cfg)(
        "refine_done",
        `Storia raffinata: ${story.title}`,
        `${created.length} task creati: ${created.map((c) => c.taskKey).join(", ")}`,
        created.map((c) => c.url),
      );
    } catch (err: any) {
      // Revert to Ready so the next tick retries (or a human can inspect).
      await setStatus(meta, story.itemId, cfg.columns.ready).catch(() => undefined);
      await this.createCommentWithId(number, repoOwner, repoName, `❌ Refine fallito per la storia: ${err.message}`).catch(() => undefined);
      callback(`Refine della storia "${story.title}" fallito: ${err.message}`, "error");
    }
  }

  /** Post a comment on the story issue, returning its node id (best-effort). */
  private async createCommentWithId(
    issueNumber: number,
    repoOwner: string,
    repoName: string,
    body: string,
  ): Promise<string | undefined> {
    try {
      const { resolveIssueId } = await import("./gh.js");
      const issueId = await resolveIssueId(repoOwner, repoName, issueNumber);
      return await createComment(issueId, body);
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

  /** Count task cards already in this plan (for T-numbering). */
  private async countPlanTasks(slug: string): Promise<number> {
    const { cfg, meta } = this.deps;
    const cards = await listCards(meta.projectId, cfg.status_field, cfg.plan_field, cfg.type_field).catch(() => []);
    return cards.filter(
      (c) => c.plan === slug && (c.type ?? "").toLowerCase() === "task",
    ).length;
  }

  private async processReviewCards(cards: Card[]): Promise<void> {
    const { cfg, meta, callback } = this.deps;
    const reviewCards = cards.filter(
      (card) =>
        (card.status ?? "").toLowerCase() === cfg.columns.review.toLowerCase() &&
        card.plan &&
        (card.type ?? "").toLowerCase() !== "story",
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
          await closeIssue(card.repoOwner!, card.repoName!, card.number!);
          await setStatus(meta, card.itemId, cfg.columns.done);
          callback(`AI review passed for "${card.title}". Issue closed → ${cfg.columns.done}`);
          continue;
        }

        if (!card.number || !card.repoOwner || !card.repoName) {
          throw new Error("Cannot post AI review findings for a draft card.");
        }
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
      } catch (err: any) {
        callback(`AI review failed for "${card.title}": ${err.message}. Leaving in ${cfg.columns.review}.`, "warn");
      } finally {
        await release(card, this.deps.botLogin);
      }
    }
  }

  /**
   * After a wave finishes, update card statuses based on outcomes.
   */
  private async handleWaveResults(
    outcomes: any[],
    claimed: Array<{ card: Card; task: BuilderTask }>,
  ): Promise<void> {
    const { cfg, meta } = this.deps;
    for (const item of claimed) {
      const outcome = outcomes?.find(
        (o) => o?.itemId === item.card.itemId,
      );
      this.inflight.clear(item.card.itemId);

      if (!outcome || outcome.status === "failure") {
        // Move back to Ready so a future wave retries.
        await setStatus(meta, item.card.itemId, cfg.columns.ready)
          .catch(() => {});
        await release(item.card, this.deps.botLogin);
        this.deps.callback(
          `Task "${item.card.title}" failed: ${outcome?.error ?? "unknown"}. Returned to ${cfg.columns.ready}.`,
          "warn",
        );
        await makeNotifier(cfg)(
          "task_failed",
          `Task fallito: ${item.card.title}`,
          `${outcome?.error ?? "unknown"} — rimesso in ${cfg.columns.ready} per riprovare.`,
        );
        continue;
      }

      // Success → move to Review.
      await setStatus(meta, item.card.itemId, cfg.columns.review)
        .catch(() => {});
      await release(item.card, this.deps.botLogin);
      this.state.cardsCompleted++;
      this.deps.callback(
        `Task "${item.card.title}" succeeded (branch=${outcome.branch ?? item.task.taskBranch}). → ${cfg.columns.review}`,
      );
    }
  }
}