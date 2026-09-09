/**
 * pi-board-agent — Extension entry point.
 *
 * Registers commands: /board-agent run | status | stop | init | lint
 *
 * Requirements:
 *   pi install npm:@quintinshaw/pi-dynamic-workflows
 *   gh auth refresh -s project (for ProjectsV2 GraphQL + assignee mutations)
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  CONFIG_DIR_NAME,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, validateConfig, resolveOwner } from "./config.js";
import { getProjectMetadata, validateStatusOptions, whoami } from "./gh.js";
import { createLoopState, BoardLoop, type LoopDeps } from "./loop.js";
import { Inflight } from "./inflight.js";
import { acquireOwnerLock, ownerLockHeldByOther } from "./owner-lock.js";
import {
  createProductionTicketExecutor,
  inspectTicketExecutions,
} from "./ticket-executor.js";
import { TicketWorktrees } from "./ticket-worktree.js";
import {
  captureRuntimeIdentity,
  checkRuntimeRevision,
  formatRevisionFailure,
  readRuntimeStatus,
  writeRuntimeStatus,
  type RevisionCheck,
  type RuntimeState,
} from "./runtime.js";

let loop: BoardLoop | null = null;
let loopState = createLoopState();
const BOARD_WIDGET_ID = "board-agent-active";
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const loadedRuntimeIdentity = captureRuntimeIdentity(
  PACKAGE_ROOT,
  process.cwd(),
);
const REVISION_LATCH = Symbol.for("Hikoia.pi-board-agent.revision-mismatch");
const processRevisionState = globalThis as typeof globalThis & {
  [REVISION_LATCH]?: { mismatch: boolean };
};
const revisionLatch = (processRevisionState[REVISION_LATCH] ??= {
  mismatch: false,
});
let runtimeStartedAt = new Date().toISOString();
let lastRevisionCheck: RevisionCheck | undefined;

function clearBoardWidget(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(BOARD_WIDGET_ID, undefined);
}

function configuredStatuses(cfg: ReturnType<typeof loadConfig>): string[] {
  return [
    cfg.columns.backlog,
    cfg.columns.ready,
    cfg.columns.building,
    cfg.columns.needs_design,
    cfg.columns.needs_human,
    cfg.columns.review,
    cfg.columns.done,
  ];
}

function hasRecoveryState(cwd: string): boolean {
  const stateDir = resolve(cwd, CONFIG_DIR_NAME, "board-agent");
  if (!existsSync(stateDir)) return false;
  return (
    new TicketWorktrees(cwd)
      .list()
      .some(
        (record) =>
          record.schemaVersion === 2 &&
          Boolean(record.activeRunId || record.launchingAt),
      ) || new Inflight(cwd).list().length > 0
  );
}

function statusPrefix(level: "info" | "warn" | "error"): string {
  if (level === "error") return "❌";
  if (level === "warn") return "⚠️";
  return "✓";
}

function currentRevision(cwd: string): RevisionCheck {
  const check = checkRuntimeRevision(
    cwd,
    loadedRuntimeIdentity,
    undefined,
    revisionLatch.mismatch,
  );
  if (!check.ok) revisionLatch.mismatch = true;
  lastRevisionCheck = check;
  return check;
}

function saveRuntime(
  ctx: ExtensionContext,
  state: RuntimeState,
  check = lastRevisionCheck ?? currentRevision(ctx.cwd),
): void {
  if (ownerLockHeldByOther(ctx.cwd)) return;
  writeRuntimeStatus(ctx.cwd, {
    expectedRevision: check.expectedRevision,
    loadedRevision: check.loadedRevision,
    diskRevision: check.diskRevision,
    dirty: check.dirty,
    pid: process.pid,
    sessionId: ctx.sessionManager.getSessionId() || undefined,
    state,
    startedAt: runtimeStartedAt,
  });
}

function liveRuntimeState(check: RevisionCheck): RuntimeState {
  if (!check.ok)
    return loop?.isRunning() ? "recovery-only" : "version-mismatch";
  if (!loop?.isRunning()) return "stopped";
  return loop.isAdmittingNewWork() ? "running" : "recovery-only";
}

function requireCurrentRevision(ctx: ExtensionContext): RevisionCheck {
  const check = currentRevision(ctx.cwd);
  saveRuntime(ctx, liveRuntimeState(check), check);
  if (!check.ok) throw new Error(formatRevisionFailure(check));
  return check;
}

// Start the autonomous loop (shared by /board-agent run, auto_start, and recovery).
async function startBoardLoop(
  ctx: ExtensionContext,
  admitNewWork = true,
): Promise<void> {
  const cwd = ctx.cwd;
  const preflight = currentRevision(cwd);
  if (!preflight.ok && admitNewWork) {
    saveRuntime(
      ctx,
      loop?.isRunning() ? "recovery-only" : "version-mismatch",
      preflight,
    );
    throw new Error(formatRevisionFailure(preflight));
  }
  saveRuntime(
    ctx,
    preflight.ok ? liveRuntimeState(preflight) : "recovery-only",
    preflight,
  );
  if (!preflight.ok)
    ctx.ui.notify(
      `[board-agent] ${formatRevisionFailure(preflight)} Recovery only.`,
      "warning",
    );

  if (loop?.isRunning()) {
    if (admitNewWork && !loop.isAdmittingNewWork()) {
      loop.enableAdmissions();
      await loop.tickNow();
      await loop.tickNow();
      ctx.ui.notify(
        `[board-agent] Recovery loop promoted to autonomous mode.`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `[board-agent] Loop already running (tick=${loopState.tickCount}, active recovery preserved).`,
        "info",
      );
    }
    return;
  }

  let ownerLock: ReturnType<typeof acquireOwnerLock> | undefined;
  try {
    const cfg = loadConfig(cwd);
    validateConfig(cfg);
    const { owner, repoName } = resolveOwner(cfg, cwd);
    const botLogin = cfg.bot_identity || (await whoami());
    const meta = await getProjectMetadata(
      owner,
      cfg.project.number,
      cfg.status_field,
      cfg.plan_field,
      cfg.type_field,
    );
    validateStatusOptions(meta, configuredStatuses(cfg));
    ownerLock = acquireOwnerLock(cwd, botLogin);

    const updateWidget = () => {
      if (!ctx.hasUI) return;
      if (!loop?.isRunning()) {
        clearBoardWidget(ctx);
        return;
      }
      const active = inspectTicketExecutions(cwd, [], cfg).active;
      const reviewing = loopState.reviewingTask;
      const totalActive = active.length + (reviewing ? 1 : 0);
      const widgetStatus = totalActive
        ? `${totalActive}/${cfg.max_workers} active`
        : "idle";
      ctx.ui.setWidget(
        BOARD_WIDGET_ID,
        [
          `Board Agent ● ${widgetStatus}`,
          ...active.map((run) => `  ${run.taskKey} [${run.status}]`),
          ...(reviewing ? [`  ${reviewing} [reviewing]`] : []),
        ],
        { placement: "belowEditor" },
      );
    };

    const callback = (
      msg: string,
      level: "info" | "warn" | "error" = "info",
    ) => {
      ctx.ui.notify(
        `[board-agent] ${statusPrefix(level)} ${msg}`,
        level === "warn" ? "warning" : level,
      );
      updateWidget();
    };
    const revisionCheck = () => {
      const check = currentRevision(cwd);
      saveRuntime(
        ctx,
        check.ok && loop?.isAdmittingNewWork() ? "running" : "recovery-only",
        check,
      );
      return {
        ok: check.ok,
        reason: check.ok ? undefined : formatRevisionFailure(check),
      };
    };
    const onTick = () => {
      updateWidget();
      const check = currentRevision(cwd);
      saveRuntime(
        ctx,
        check.ok && loop?.isAdmittingNewWork() ? "running" : "recovery-only",
        check,
      );
    };

    const executor = createProductionTicketExecutor({
      cwd,
      cfg,
      meta,
      botLogin,
      callback,
      modelRegistry: ctx.modelRegistry,
      mainModel: ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    const deps: LoopDeps = {
      cwd,
      cfg,
      repoOwner: owner,
      repoName,
      botLogin,
      meta,
      callback,
      revisionCheck,
      onTick,
    };
    loopState = createLoopState();
    const nextLoop = new BoardLoop(
      deps,
      loopState,
      executor,
      new TicketWorktrees(cwd),
      ownerLock,
      admitNewWork,
    );
    loop = nextLoop;
    await nextLoop.start();
    saveRuntime(
      ctx,
      nextLoop.isAdmittingNewWork() ? "running" : "recovery-only",
    );
    ctx.ui.notify(
      `[board-agent] ${admitNewWork ? "Loop" : "Recovery loop"} started. Ticking every ${cfg.tick_seconds}s. Project: ${owner}/#${cfg.project.number}.`,
      "info",
    );
  } catch (error) {
    ownerLock?.release();
    loop = null;
    clearBoardWidget(ctx);
    saveRuntime(ctx, preflight.ok ? "stopped" : "version-mismatch");
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  const subcommands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  let watchdogInterval: ReturnType<typeof setInterval> | undefined;

  // Resume durable ticket runs on every startup/reload; auto_start also admits new work.
  pi.on("session_start", async (_event, ctx) => {
    clearBoardWidget(ctx);
    runtimeStartedAt = new Date().toISOString();
    try {
      const previous = readRuntimeStatus(ctx.cwd);
      if (
        previous?.pid === process.pid &&
        previous.loadedRevision !== loadedRuntimeIdentity.loadedRevision
      ) {
        revisionLatch.mismatch = true;
      }
      const revision = currentRevision(ctx.cwd);
      saveRuntime(ctx, revision.ok ? "stopped" : "version-mismatch", revision);
      const cfg = loadConfig(ctx.cwd);
      const recovery = hasRecoveryState(ctx.cwd);
      if (cfg.auto_start && revision.ok && !loop?.isRunning()) {
        await startBoardLoop(ctx, true);
      } else if (recovery && !loop?.isRunning()) {
        await startBoardLoop(ctx, false);
      } else if (!revision.ok) {
        throw new Error(formatRevisionFailure(revision));
      }
    } catch (error: any) {
      ctx.ui.notify(
        `[board-agent] Startup/recovery failed: ${error.message}`,
        "error",
      );
    }
  });
  // ----------- /board-agent init -----------
  subcommands.set("init", {
    description: "Write a default .pi/board-agent.yml for this project",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const dest = resolve(cwd, CONFIG_DIR_NAME, "board-agent.yml");
      if (existsSync(dest)) {
        ctx.ui.notify(`Already exists: ${dest}`, "warning");
        return;
      }
      const { readConfigTemplate } = await import("./config.js");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(resolve(cwd, CONFIG_DIR_NAME), { recursive: true });
      writeFileSync(dest, readConfigTemplate(), "utf-8");
      ctx.ui.notify(
        `Wrote: ${dest} (edit project.number + plan_field)`,
        "info",
      );
    },
  });

  // ----------- /board-agent lint -----------
  subcommands.set("lint", {
    description:
      "Check preconditions: revision, config, gh auth, project exists, plan field present",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const revision = requireCurrentRevision(ctx);
        ctx.ui.notify(`revision: ${revision.loadedRevision} ✓`, "info");
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        ctx.ui.notify("config: valid ✓", "info");

        const login = await whoami();
        ctx.ui.notify(`gh user: ${login} ✓`, "info");

        try {
          const meta = await getProjectMetadata(
            cfg.project.owner || login,
            cfg.project.number,
            cfg.status_field,
            cfg.plan_field,
            cfg.type_field,
          );
          validateStatusOptions(meta, configuredStatuses(cfg));
          ctx.ui.notify(
            `Project #${cfg.project.number}: accessible with all configured statuses ✓`,
            "info",
          );
        } catch {
          const { owner } = resolveOwner(cfg, cwd);
          const meta = await getProjectMetadata(
            owner,
            cfg.project.number,
            cfg.status_field,
            cfg.plan_field,
            cfg.type_field,
          );
          validateStatusOptions(meta, configuredStatuses(cfg));
          ctx.ui.notify(
            `Project #${cfg.project.number} (owner ${owner}): accessible with all configured statuses ✓`,
            "info",
          );
        }
        ctx.ui.notify("All checks passed.", "info");
      } catch (err: any) {
        ctx.ui.notify(`Lint failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent init-project -----------
  subcommands.set("init-project", {
    description:
      "Initialize the GitHub Project with the standard board (columns, Type, Plan, Board view)",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        requireCurrentRevision(ctx);
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const { initProject } = await import("./init-project.js");
        const res = await initProject(owner, cfg.project.number, cfg);
        const created = res.created.length
          ? `creati: ${res.created.join(", ")}`
          : "nessuno (già presenti)";
        ctx.ui.notify(
          `Project #${cfg.project.number} (${owner}/${repoName}) — campi ${created}; vista "${res.view}" pronta.`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`init-project failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent watchdog -----------
  subcommands.set("watchdog", {
    description: "Run the standalone watchdog loop (PR CI fixes + mentions)",
    handler: async (_args, ctx) => {
      if (watchdogInterval) {
        ctx.ui.notify("Watchdog loop is already running.", "info");
        return;
      }
      try {
        const cwd = ctx.cwd;
        requireCurrentRevision(ctx);
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const botLogin = cfg.bot_identity || (await whoami());
        const meta = await getProjectMetadata(
          owner,
          cfg.project.number,
          cfg.status_field,
          cfg.plan_field,
          cfg.type_field,
        );
        const { Watchdog } = await import("./watchdog.js");
        const wd = new Watchdog({
          cwd,
          cfg,
          repoOwner: owner,
          repoName,
          botLogin,
          meta,
          callback: (msg, level = "info") => {
            ctx.ui.notify(
              `[watchdog] ${statusPrefix(level)} ${msg}`,
              level === "warn" ? "warning" : level,
            );
          },
        });
        const tick = async () => {
          try {
            requireCurrentRevision(ctx);
            await wd.tick();
          } catch (err) {
            ctx.ui.notify(
              `[watchdog] ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        };
        await tick();
        watchdogInterval = setInterval(
          tick,
          cfg.watchdog.interval_seconds * 1000,
        );
        ctx.ui.notify(
          `Watchdog loop started (every ${cfg.watchdog.interval_seconds}s). /board-agent stop-watchdog to stop.`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`Watchdog failed to start: ${err.message}`, "error");
      }
    },
  });

  subcommands.set("stop-watchdog", {
    description: "Stop the standalone watchdog loop",
    handler: async (_args, ctx) => {
      if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = undefined;
        ctx.ui.notify("Watchdog loop stopped.", "info");
      } else {
        ctx.ui.notify("No watchdog loop is running.", "warning");
      }
    },
  });

  // ----------- /board-agent context -----------
  subcommands.set("context", {
    description:
      "Generate/show the repo context digest injected into builder missions",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { generateContext } = await import("./context.js");
        const text = generateContext({
          cwd,
          maxChars: cfg.context.max_chars,
          exclude: cfg.context.exclude,
        });
        const lines = text.split("\n").length;
        ctx.ui.notify(
          `Repo context digest: ${text.length} chars, ${lines} lines → .pi/board-agent/context.md`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`Context failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent status -----------
  subcommands.set("status", {
    description: "Show board snapshot, revision identity, and loop stats",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const revision = currentRevision(cwd);
        const runtimeState = liveRuntimeState(revision);
        saveRuntime(ctx, runtimeState, revision);
        const runtime = readRuntimeStatus(cwd);
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const meta = await getProjectMetadata(
          owner,
          cfg.project.number,
          cfg.status_field,
          cfg.plan_field,
          cfg.type_field,
        );
        validateStatusOptions(meta, configuredStatuses(cfg));
        const { listCards } = await import("./gh.js");
        const cards = await listCards(
          meta.projectId,
          cfg.status_field,
          cfg.plan_field,
          cfg.type_field,
        );
        const { summarizePlans } = await import("./plan.js");
        const plans = summarizePlans(cfg, cards);
        const execution = inspectTicketExecutions(cwd, cards, cfg);

        const colCounts: Record<string, number> = {};
        for (const c of cards) {
          const k = c.status ?? "unknown";
          colCounts[k] = (colCounts[k] ?? 0) + 1;
        }

        const lines = [
          `Board ${owner}/#${cfg.project.number}  (repo=${owner}/${repoName})`,
          `Revision: state=${runtime?.state ?? runtimeState} pid=${runtime?.pid ?? process.pid}`,
          `  expected=${revision.expectedRevision ?? "missing"}`,
          `  loaded=${revision.loadedRevision ?? "unknown"}`,
          `  disk=${revision.diskRevision ?? "unknown"} dirty=${revision.dirty ? "yes" : "no"}`,
          `  columns: ${Object.entries(colCounts)
            .map(([k, v]) => `${k}(${v})`)
            .join("  ")}`,
          `  plans: ${plans.size}`,
          ...Array.from(plans.values()).flatMap((s) => [
            `    ${s.rawName}: ${s.doneCards}/${s.totalCards} done  ready=${s.readyCards} building=${s.buildingCards} review=${s.reviewCards}`,
          ]),
        ];
        lines.push(
          `  execution: active=${execution.active.length} legacy=${execution.legacy} orphan=${execution.orphans} needs-human=${execution.needsHuman}`,
          ...execution.active.map(
            (run) =>
              `    ${run.taskKey}: ${run.runId} [${run.status}] ${run.worktree}`,
          ),
        );
        if (loopState.running) {
          lines.push(
            `Loop: RUNNING (${loop?.isAdmittingNewWork() ? "autonomous" : "recovery-only"})  tick=${loopState.tickCount}  launches=${loopState.wavesLaunched}`,
          );
        } else {
          lines.push("Loop: STOPPED");
        }
        const output = lines.join("\n");
        ctx.ui.notify(output, "info");
      } catch (err: any) {
        ctx.ui.notify(`Status failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent run -----------
  subcommands.set("run", {
    description:
      "Start the autonomous loop (picks Ready cards from the GitHub Project)",
    handler: async (_args, ctx) => {
      try {
        await startBoardLoop(ctx);
      } catch (err: any) {
        ctx.ui.notify(`[board-agent] Failed to start: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent stop -----------
  subcommands.set("stop", {
    description: "Stop the autonomous loop gracefully",
    handler: async (_args, ctx) => {
      if (!loop) {
        clearBoardWidget(ctx);
        saveRuntime(ctx, "stopped", currentRevision(ctx.cwd));
        ctx.ui.notify("No loop is running.", "warning");
        return;
      }
      const current = loop;
      loop = null;
      clearBoardWidget(ctx);
      try {
        await current.stop();
        ctx.ui.notify("Loop stopped.", "info");
      } catch (error: any) {
        ctx.ui.notify(
          `Loop stopped with recovery warning: ${error.message}`,
          "warning",
        );
      } finally {
        saveRuntime(ctx, "stopped", currentRevision(ctx.cwd));
      }
    },
  });

  pi.registerCommand("board-agent", {
    description: "Manage the autonomous GitHub Project board agent",
    handler: async (args, ctx) => {
      const [name = "", ...rest] = args.trim().split(/\s+/);
      const command = subcommands.get(name);
      if (!command) {
        ctx.ui.notify(
          `Usage: /board-agent <${Array.from(subcommands.keys()).join("|")}>`,
          "warning",
        );
        return;
      }
      await command.handler(rest.join(" "), ctx);
    },
  });

  // ----------- Cleanup on shutdown -----------
  pi.on("session_shutdown", async (_event, ctx) => {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = undefined;
    const current = loop;
    loop = null;
    clearBoardWidget(ctx);
    try {
      if (current) await current.stop();
    } catch (error: any) {
      ctx.ui.notify(
        `[board-agent] Shutdown recovery failed: ${error.message}`,
        "error",
      );
    } finally {
      try {
        saveRuntime(ctx, "stopped", currentRevision(ctx.cwd));
      } catch (error: any) {
        ctx.ui.notify(
          `[board-agent] Runtime status update failed: ${error.message}`,
          "error",
        );
      }
    }
  });
}
