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
import { getProjectMetadata, whoami } from "./gh.js";
import { createLoopState, BoardLoop, type LoopDeps } from "./loop.js";
import { Inflight } from "./inflight.js";
import { dispatchWave, type WaveOutcome } from "./dispatch.js";

let loop: BoardLoop | null = null;
let loopState = createLoopState();

export default function (pi: ExtensionAPI) {
  // ----------- /board-agent init -----------
  pi.registerCommand("board-agent init", {
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
  pi.registerCommand("board-agent lint", {
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
          await getProjectMetadata(cfg.project.owner || login, cfg.project.number, cfg.status_field, cfg.plan_field);
          ctx.ui.notify(`Project #${cfg.project.number}: accessible ✓`, "info");
        } catch (err: any) {
          const { owner } = resolveOwner(cfg, cwd);
          await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field);
          ctx.ui.notify(`Project #${cfg.project.number} (owner ${owner}): accessible ✓`, "info");
        }
        ctx.ui.notify("All checks passed.", "info");
      } catch (err: any) {
        ctx.ui.notify(`Lint failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent status -----------
  pi.registerCommand("board-agent status", {
    description: "Show board snapshot and loop stats",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);
        const login = await whoami();
        const meta = await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field);
        const { listCards } = await import("./gh.js");
        const cards = await listCards(meta.projectId, cfg.status_field, cfg.plan_field);
        const { summarizePlans } = await import("./plan.js");
        const plans = summarizePlans(cfg, cards);

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
        if (loopState.running) {
          lines.push(`Loop: RUNNING  tick=${loopState.tickCount}  waves=${loopState.wavesLaunched}  prs=${loopState.prsOpened}  cards=${loopState.cardsCompleted}`);
        }
        const output = lines.join("\n");
        ctx.ui.notify(output, "info");
      } catch (err: any) {
        ctx.ui.notify(`Status failed: ${err.message}`, "error");
      }
    },
  });

  // ----------- /board-agent run -----------
  pi.registerCommand("board-agent run", {
    description: "Start the autonomous loop (picks Ready cards from the GitHub Project)",
    handler: async (args, ctx) => {
      try {
        const cwd = ctx.cwd;
        const cfg = loadConfig(cwd);
        validateConfig(cfg);
        const { owner, repoName } = resolveOwner(cfg, cwd);

        const botLogin = cfg.bot_identity || (await whoami());
        const meta = await getProjectMetadata(owner, cfg.project.number, cfg.status_field, cfg.plan_field);

        // Check that board-agent skill is discoverable.
        // It ships with the package; pi should have it loaded already via
        // package.json `pi.skills`.

        const callback = (msg: string, level: "info" | "warn" | "error" = "info") => {
          const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : "✓";
          ctx.ui.notify(`[board-agent] ${prefix} ${msg}`, level === "warn" ? "warning" : level);
        };

        // pi-dynamic-workflows integration:
        // The extension registers a custom tool "board_agent_launch_wave" that
        // the LLM calls; but we need direct API access. pi-dynamic-workflows
        // exposes CMD commands: `dx.workflow.run()` hooks into them.
        // For now we use a simpler path: we inject the workflow script into
        // the session via pi.sendMessage + triggerTurn, and pray. BUT that's
        // fragile.
        //
        // THE BETTER PATH (v0.2): expose a `board_agent_workflow` tool that
        // the loop invokes directly. pi-dynamic-workflows registers its own
        // `workflow` tool, which we could call — but tools are callable only
        // by the LLM, not by extensions.
        //
        // PRACTICAL PATH (v0.1): The loop delegates to pi-dynamic-workflows
        // through its `workflow` tool. The extension calls it by injecting a
        // user message with the workflow script. Ugly? Yes. But it works today
        // without forking pi-dynamic-workflows.
        //
        // We expose a simple mockable interface: LoopDeps.dxRun / dxResult.
        // In the real extension, we implement them via the workflow tool.

        const inflight = new Inflight(cwd);

        // Real dispatch (v0.2): pi-dynamic-workflows exposes a programmatic
        // API (runWorkflow) usable directly from the extension — no LLM
        // round-trip needed. dxRun starts the wave (stored by runId), dxResult
        // awaits it and returns the normalized per-card outcomes.
        const pendingWaves = new Map<string, Promise<WaveOutcome[]>>();

        const deps: LoopDeps = {
          cwd,
          cfg,
          repoOwner: owner,
          repoName,
          botLogin,
          meta,
          callback,
          dxRun: async (script: string): Promise<string> => {
            const runId = `wave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            callback(`Dispatching wave ${runId} (pi-dynamic-workflows)…`);
            const wave = dispatchWave({
              cwd,
              script,
              maxAgents: cfg.max_workers,
              agentTimeoutMs: cfg.builder_timeout_ms,
              runId,
              onLog: (line) => callback(`[wave] ${line}`, "info"),
            }).catch((err: Error) => {
              callback(`Wave ${runId} failed to run: ${err.message}`, "error");
              return [];
            });
            pendingWaves.set(runId, wave);
            return runId;
          },
          dxResult: async (runId: string): Promise<any[]> => {
            const wave = pendingWaves.get(runId);
            if (!wave) {
              callback(`No pending wave for ${runId}`, "warn");
              return [];
            }
            pendingWaves.delete(runId);
            const outcomes = await wave;
            for (const o of outcomes) {
              if (o.status === "success") {
                callback(`Task ${o.taskKey} → ${o.status} (${o.summary ?? ""})`);
              } else {
                callback(`Task ${o.taskKey} → ${o.status}: ${o.error ?? "unknown"}`, "warn");
              }
            }
            return outcomes;
          },
        };

        loopState = createLoopState();
        loop = new BoardLoop(deps, loopState, inflight);
        loop.start();
        ctx.ui.notify(
          `[board-agent] Loop started. Ticking every ${cfg.tick_seconds}s. Project: ${owner}/#${cfg.project.number}. Use /board-agent stop to stop.`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(
          `[board-agent] Failed to start: ${err.message}`,
          "error",
        );
      }
    },
  });

  // ----------- /board-agent stop -----------
  pi.registerCommand("board-agent stop", {
    description: "Stop the autonomous loop gracefully",
    handler: async (_args, ctx) => {
      if (!loop) {
        ctx.ui.notify("No loop is running.", "warning");
        return;
      }
      loop.stop();
      loop = null;
      ctx.ui.notify("Loop stopped.", "info");
    },
  });

  // ----------- Cleanup on shutdown -----------
  pi.on("session_shutdown", async () => {
    loop?.stop();
    loop = null;
  });
}