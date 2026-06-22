/**
 * Core polling loop.
 *
 * Responsibilities:
 *  - Tick every `cfg.tick_seconds` seconds
 *  - Fetch all cards from the configured project
 *  - For each plan: detect completions → open PR
 *  - For cards in `ready`: claim, then hand them to a pi-dynamic-workflows wave
 *  - For cards in `building` past timeout: attempt recovery (re-assign)
 *  - For cards in `review` → no-op (manual approval gate)
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
} from "./gh.js";
import { Inflight } from "./inflight.js";
import { summarizePlans, isPlanComplete, openPlanPr } from "./plan.js";
import { buildTasksForWave, renderWorkflowSource, type BuilderTask } from "./workflow-prompt.js";
import { isClean, ensurePlanBranch } from "./git-helpers.js";

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
      const cards = await listCards(meta.projectId, cfg.status_field, cfg.plan_field);
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
        const script = renderWorkflowSource({
          cfg,
          planSlug: summary.slug,
          baseBranch: cfg.branches.base,
          tasks,
          skillName: "board-agent",
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