import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { normalizeWaveResults } from "./dispatch.js";

/** A conflict repair is an input to the existing builder, never a new v3 state. */
export interface RepairRequest {
  requestKey: string;
  baseSha: string;
  taskSha: string;
}

export interface RepairReview extends RepairRequest {
  testEvidence: { resultSha: string; command: string; output: string };
}

/** One ordinary bash tool call, so the existing durable agent history carries
 * execution evidence, not just a model's success/exit-code assertion. No host
 * test discovery or execution: the builder selects the repo's existing tests. */
export function repairTestCommand(resultSha: string, command: string): string {
  const check = [
    'head=$(git rev-parse HEAD)',
    'status=$(git status --porcelain=v1 --untracked-files=all)',
    `test "$head" = '${resultSha}'`,
    'test -z "$status"',
  ];
  return [
    "set -euo pipefail",
    "export GIT_NO_REPLACE_OBJECTS=1",
    ...check,
    `printf '%s\\n' 'BOARD_AGENT_REPAIR_TEST_BEGIN ${resultSha}'`,
    "(", command, ")",
    ...check,
    `printf '%s\\n' 'BOARD_AGENT_REPAIR_TEST_PASS ${resultSha}'`,
  ].join("\n");
}

/** Missing/truncated/failed telemetry is ambiguous, even with status=success.
 * This is execution evidence, not a sandbox against a malicious local builder;
 * the existing independent Review assesses the test command's adequacy. */
export function repairReviewInput(run: PersistedRunState): RepairReview | undefined {
  const args = run.args as Record<string, unknown> | undefined;
  if (!args || !Object.hasOwn(args, "repair")) return undefined;
  if (!isRepairRequest(args.repair)) throw new Error("Invalid persisted repair request.");
  const outcomes = normalizeWaveResults(run.result);
  const outcome = outcomes[0];
  if (run.status !== "completed" || outcomes.length !== 1 || outcome.status !== "success" ||
      outcome.itemId !== args.itemId || outcome.taskKey !== args.taskKey)
    throw new Error("Repair result is missing, failed, or mismatched.");
  const e = outcome.testEvidence as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).length !== 2 ||
      typeof e.resultSha !== "string" || !/^[0-9a-f]{40}$/.test(e.resultSha) ||
      typeof e.command !== "string" || !e.command.trim() || e.command.length > 1000 || e.command.includes("\0"))
    throw new Error("Repair passing test evidence is missing or malformed.");
  const agents = run.agents.filter((a) => a.status === "done" &&
    JSON.stringify(a.result) === JSON.stringify(Array.isArray(run.result) ? run.result[0] : undefined));
  if (agents.length !== 1) throw new Error("Repair test evidence has no unique completed builder.");
  const command = repairTestCommand(e.resultSha, e.command);
  const history = agents[0].history ?? [];
  const outputs: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const call = history[i], result = history[i + 1];
    if (call.role !== "assistant" || call.kind !== "toolCall" || call.toolName !== "bash") continue;
    let toolArgs: any;
    try { toolArgs = JSON.parse(call.text); } catch { continue; }
    if (toolArgs?.command !== command) continue;
    // A later failed/ambiguous execution of the same check invalidates an earlier pass.
    if (!result || result.role !== "tool" || result.kind !== "toolResult" || result.toolName !== "bash" || result.isError !== false)
      throw new Error("Repair test execution failed or is ambiguous.");
    const text = result.text.replace(/\r\n/g, "\n").trim();
    const begin = `BOARD_AGENT_REPAIR_TEST_BEGIN ${e.resultSha}\n`;
    const end = `\nBOARD_AGENT_REPAIR_TEST_PASS ${e.resultSha}`;
    if (!text.startsWith(begin) || !text.endsWith(end) || text.includes("[truncated]"))
      throw new Error("Repair test execution evidence is incomplete.");
    const output = text.slice(begin.length, -end.length).trim();
    if (!output) throw new Error("Repair test execution has no test output.");
    outputs.push(output);
  }
  if (!outputs.length) throw new Error("Repair has no recorded passing test execution at the result SHA.");
  return { ...args.repair, testEvidence: { resultSha: e.resultSha, command: e.command, output: outputs.at(-1)! } };
}

export function isRepairRequest(value: unknown): value is RepairRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 3 &&
    typeof r.requestKey === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(r.requestKey) &&
    typeof r.baseSha === "string" && /^[0-9a-f]{40}$/.test(r.baseSha) &&
    typeof r.taskSha === "string" && /^[0-9a-f]{40}$/.test(r.taskSha);
}
