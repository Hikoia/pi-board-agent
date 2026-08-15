/**
 * Real dispatch for builder waves via pi-dynamic-workflows.
 *
 * v0.1 had a placeholder dxRun/dxResult because the `workflow` tool is
 * LLM-callable only. pi-dynamic-workflows also exports a plain programmatic
 * API (`runWorkflow`) that extensions can call directly: it executes the same
 * workflow script the LLM would run — parallel `agent()` fan-out with
 * git-worktree isolation, per-phase/per-agent model routing, token/cost
 * accounting and resume — and returns the script's return value (our
 * per-card outcomes).
 */
import { runWorkflow } from "@quintinshaw/pi-dynamic-workflows";

/** Outcome shape the builder agents return (schema in workflow-prompt.ts). */
export interface WaveOutcome {
  taskKey: string;
  itemId: string;
  status: "success" | "failure";
  branch?: string;
  commits?: number;
  summary?: string;
  error?: string;
}

export interface DispatchOptions {
  cwd: string;
  script: string;
  maxAgents: number;
  agentTimeoutMs?: number;
  runId: string;
  onLog?: (line: string) => void;
}

/**
 * Normalize the raw workflow result to WaveOutcome[].
 * The script returns an array (one entry per agent); entries can be null
 * when a parallel thunk threw, and defensive parsing keeps malformed items
 * out without failing the whole wave.
 */
export function normalizeWaveResults(raw: unknown): WaveOutcome[] {
  if (!Array.isArray(raw)) return [];
  const out: WaveOutcome[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.taskKey !== "string" || typeof r.itemId !== "string") continue;
    out.push({
      taskKey: r.taskKey,
      itemId: r.itemId,
      status: r.status === "success" ? "success" : "failure",
      branch: typeof r.branch === "string" ? r.branch : undefined,
      commits: typeof r.commits === "number" ? r.commits : undefined,
      summary: typeof r.summary === "string" ? r.summary : undefined,
      error: typeof r.error === "string" ? r.error : undefined,
    });
  }
  return out;
}

/** Run a builder wave with pi-dynamic-workflows and return normalized outcomes. */
export async function dispatchWave(opts: DispatchOptions): Promise<WaveOutcome[]> {
  const res = await runWorkflow(opts.script, {
    cwd: opts.cwd,
    runId: opts.runId,
    maxAgents: opts.maxAgents,
    ...(opts.agentTimeoutMs !== undefined
      ? { agentTimeoutMs: opts.agentTimeoutMs }
      : {}),
    persistLogs: true,
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
  });
  return normalizeWaveResults(res.result);
}
