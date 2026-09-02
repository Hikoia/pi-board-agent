/** Outcome shape returned by one persisted builder workflow. */
export interface WaveOutcome {
  taskKey: string;
  itemId: string;
  status: "success" | "failure";
  branch?: string;
  commits?: number;
  summary?: string;
  error?: string;
}

/** Strictly normalize a persisted workflow result; malformed entries are not guessed. */
export function normalizeWaveResults(raw: unknown): WaveOutcome[] {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) && "result" in raw
    ? (raw as { result?: unknown }).result
    : raw;
  if (!Array.isArray(value)) return [];

  const outcomes: WaveOutcome[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return [];
    const result = item as Record<string, unknown>;
    if (
      typeof result.taskKey !== "string" ||
      typeof result.itemId !== "string" ||
      (result.status !== "success" && result.status !== "failure")
    ) return [];
    outcomes.push({
      taskKey: result.taskKey,
      itemId: result.itemId,
      status: result.status,
      branch: typeof result.branch === "string" ? result.branch : undefined,
      commits: typeof result.commits === "number" ? result.commits : undefined,
      summary: typeof result.summary === "string" ? result.summary : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
    });
  }
  return outcomes;
}
