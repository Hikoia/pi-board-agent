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
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { loadConfig, validateConfig, resolveOwner } from "./config.js";
import { getProjectMetadata, validateStatusOptions, whoami } from "./gh.js";
import { createLoopState, BoardLoop, type LoopDeps } from "./loop.js";
import { Inflight } from "./inflight.js";
import { acquireOwnerLock } from "./owner-lock.js";
import { createProductionTicketExecutor, inspectTicketExecutions } from "./ticket-executor.js";
import { TicketWorktrees } from "./ticket-worktree.js";

let loop: BoardLoop | null = null;
let loopState = createLoopState();

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
  return new TicketWorktrees(cwd).list().some((record) =>
    record.schemaVersion === 2 && Boolean(record.activeRunId || record.launchingAt)
  ) || new Inflight(cwd).list().length > 0;
}

function statusPrefix(level: "info" | "warn" | "error"): string {
  if (level === "error") return "❌";
  if (level === "warn") return "⚠️";
  return "✓";
}

// Start the autonomous loop (shared by /board-agent run, auto_start, and recovery).
async function startBoardLoop(ctx: ExtensionContext, admitNewWork = true): Promise<void> {
  if (loop?.isRunning()) {
    if (admitNewWork && !loop.isAdmittingNewWork()) {
      loop.enableAdmissions();
      await loop.tickNow();
      await loop.tickNow();
      ctx.ui.notify(`[board-agent] Recovery loop promoted to autonomous mode.`, "info");
    } else {
      ctx.ui.notify(`[board-agent] Loop already running (tick=${loopState.tickCount}, active recovery preserved).`, "info");
    }
    return;
  }

  const cwd = ctx.cwd;
  const cfg = loadConfig(cwd);
  validateConfig(cfg);
  const { owner, repoName } = resolveOwner(cfg, cwd);
  const botLogin = cfg.bot_identity || (await whoami());
  const meta = await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field, cfg.type_field);
  validateStatusOptions(meta, configuredStatuses(cfg));
  const ownerLock = acquireOwnerLock(cwd, botLogin);

  const callback = (msg: string, level: "info" | "warn" | "error" = "info") => {
    ctx.ui.notify(`[board-agent] ${statusPrefix(level)} ${msg}`, level === "warn" ? "warning" : level);
  };

  try {
    const executor = createProductionTicketExecutor({
      cwd,
      cfg,
      meta,
      botLogin,
      callback,
      modelRegistry: ctx.modelRegistry,
      mainModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    const deps: LoopDeps = { cwd, cfg, repoOwner: owner, repoName, botLogin, meta, callback };
    loopState = createLoopState();
    const nextLoop = new BoardLoop(deps, loopState, executor, new TicketWorktrees(cwd), ownerLock, admitNewWork);
    loop = nextLoop;
    await nextLoop.start();
    ctx.ui.notify(
      `[board-agent] ${admitNewWork ? "Loop" : "Recovery loop"} started. Ticking every ${cfg.tick_seconds}s. Project: ${owner}/#${cfg.project.number}.`,
      "info",
    );
  } catch (error) {
    ownerLock.release();
    loop = null;
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  const subcommands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  let watchdogInterval: ReturnType<typeof setInterval> | undefined;

  // Resume durable ticket runs on every startup/reload; auto_start also admits new work.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const cfg = loadConfig(ctx.cwd);
      if (cfg.auto_start && !loop?.isRunning()) {
        await startBoardLoop(ctx, true);
      } else if (hasRecoveryState(ctx.cwd) && !loop?.isRunning()) {
        await startBoardLoop(ctx, false);
      }
    } catch (error: any) {
      ctx.ui.notify(`[board-agent] Startup/recovery failed: ${error.message}`, "error");
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
      ctx.ui.notify(`Wrote: ${dest} (edit project.number + plan_field)`, "info");
    },
  });

  // ----------- /board-agent lint -----------
  subcommands.set("lint", {
    description: "Check preconditions: config, gh auth, project exists, plan field present",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        ctx.ui.notify("config: valid ✓", "info");

        const login = await whoami();
        ctx.ui.notify(`gh user: ${login} ✓`, "info");

        try {
          const meta = await getProjectMetadata(cfg.project.owner || login, cfg.project.number, cfg.status_field, cfg.plan_field, cfg.type_field);
          validateStatusOptions(meta, configuredStatuses(cfg));
          ctx.ui.notify(`Project #${cfg.project.number}: accessible with all configured statuses ✓`, "info");
        } catch {
          const { owner } = resolveOwner(cfg, cwd);
          const meta = await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field, cfg.type_field);
          validateStatusOptions(meta, configuredStatuses(cfg));
          ctx.ui.notify(`Project #${cfg.project.number} (owner ${owner}): accessible with all configured statuses ✓`, "info");
        }
        ctx.ui.notify("All checks passed.", "info");
      } catch (err: any) {
        ctx.ui.notify(`Lint failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent init-project -----------
  subcommands.set("init-project", {
    description: "Initialize the GitHub Project with the standard board (columns, Type, Plan, Board view)",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const { initProject } = await import("./init-project.js");
        const res = await initProject(owner, cfg.project.number, cfg);
        const created = res.created.length ? `creati: ${res.created.join(", ")}` : "nessuno (già presenti)";
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
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const botLogin = cfg.bot_identity || (await whoami());
        const meta = await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field, cfg.type_field);
        const { Watchdog } = await import("./watchdog.js");
        const wd = new Watchdog({
          cwd,
          cfg,
          repoOwner: owner,
          repoName,
          botLogin,
          meta,
          callback: (msg, level = "info") => {
            ctx.ui.notify(`[watchdog] ${statusPrefix(level)} ${msg}`, level === "warn" ? "warning" : level);
          },
        });
        const tick = () =>
          wd.tick().catch((err: Error) => ctx.ui.notify(`[watchdog] ${err.message}`, "error"));
        await tick();
        watchdogInterval = setInterval(tick, cfg.watchdog.interval_seconds * 1000);
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
    description: "Generate/show the repo context digest injected into builder missions",
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
    description: "Show board snapshot and loop stats",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const meta = await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field, cfg.type_field);
        validateStatusOptions(meta, configuredStatuses(cfg));
        const { listCards } = await import("./gh.js");
        const cards = await listCards(meta.projectId, cfg.status_field, cfg.plan_field, cfg.type_field);
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
          `  columns: ${Object.entries(colCounts).map(([k,v])=>`${k}(${v})`).join("  ")}`,
          `  plans: ${plans.size}`,
          ...Array.from(plans.values()).flatMap((s) => [
            `    ${s.rawName}: ${s.doneCards}/${s.totalCards} done  ready=${s.readyCards} building=${s.buildingCards} review=${s.reviewCards}`,
          ]),
        ];
        lines.push(
          `  execution: active=${execution.active.length} legacy=${execution.legacy} orphan=${execution.orphans} needs-human=${execution.needsHuman}`,
          ...execution.active.map((run) => `    ${run.taskKey}: ${run.runId} [${run.status}] ${run.worktree}`),
        );
        if (loopState.running) {
          lines.push(`Loop: RUNNING (${loop?.isAdmittingNewWork() ? "autonomous" : "recovery-only"})  tick=${loopState.tickCount}  launches=${loopState.wavesLaunched}  prs=${loopState.prsOpened}`);
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
    description: "Start the autonomous loop (picks Ready cards from the GitHub Project)",
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
        ctx.ui.notify("No loop is running.", "warning");
        return;
      }
      const current = loop;
      loop = null;
      try {
        await current.stop();
        ctx.ui.notify("Loop stopped.", "info");
      } catch (error: any) {
        ctx.ui.notify(`Loop stopped with recovery warning: ${error.message}`, "warning");
      }
    },
  });

  pi.registerCommand("board-agent", {
    description: "Manage the autonomous GitHub Project board agent",
    handler: async (args, ctx) => {
      const [name = "", ...rest] = args.trim().split(/\s+/);
      const command = subcommands.get(name);
      if (!command) {
        ctx.ui.notify(`Usage: /board-agent <${Array.from(subcommands.keys()).join("|")}>`, "warning");
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
    if (!current) return;
    try {
      await current.stop();
    } catch (error: any) {
      ctx.ui.notify(`[board-agent] Shutdown recovery failed: ${error.message}`, "error");
    }
  });
}