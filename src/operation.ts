import { setImmediate as yieldTurn } from "node:timers/promises";

export type OperationPhase =
  | "read-evidence"
  | "verify-backup"
  | "verify-source"
  | "integrate"
  | "observe-pr"
  | "create-pr"
  | "remove"
  | "writeback";
export interface OperationProgress {
  phase: OperationPhase;
  itemId?: string;
  issueNumber?: number;
  completed?: number;
  total?: number;
  unit?: "bytes" | "items";
}
export interface OperationControl {
  signal?: AbortSignal;
  onProgress?: (progress: OperationProgress) => void;
  /** Local ownership veto, including between chunks. Never a remote authorization. */
  check?: () => void;
}
export function checkOperation(control?: OperationControl): void {
  control?.signal?.throwIfAborted();
  control?.check?.();
}

/** One cooperative budget per traversal, shared across its files and chunks. */
export function operationCheckpoint(control?: OperationControl) {
  let yieldedAt = performance.now();
  return async () => {
    checkOperation(control);
    if (performance.now() - yieldedAt >= 50) {
      await yieldTurn();
      yieldedAt = performance.now();
      checkOperation(control);
    }
  };
}

export interface OperationActivity extends OperationProgress {
  kind: "migration" | "finalization";
  startedAt: number;
  lastProgressAt: number;
}
export interface OperationObservation {
  activity?: OperationActivity;
  lastBlocker?: string;
  waiting?: { itemId: string; prNumber: number; prUrl: string; reason: string };
}

/** Display only. Neither throttling nor a stale observation grants authority. */
export function observeOperation(
  state: OperationObservation,
  kind: OperationActivity["kind"],
  publish: () => void,
  identity: { itemId?: string; issueNumber?: number } = {},
  now = Date.now,
) {
  const startedAt = now();
  let publishedAt = startedAt;
  state.lastBlocker = undefined;
  state.activity = { kind, ...identity, phase: "read-evidence", startedAt, lastProgressAt: startedAt };
  publish();
  return {
    onProgress(progress: OperationProgress) {
      const previous = state.activity;
      if (!previous) return;
      const changed = previous.phase !== progress.phase ||
        (progress.itemId !== undefined && progress.itemId !== previous.itemId);
      const advanced = changed || (progress.completed ?? 0) > (previous.completed ?? 0);
      state.activity = {
        kind, ...identity, itemId: previous.itemId, issueNumber: previous.issueNumber,
        ...progress, startedAt, lastProgressAt: advanced ? now() : previous.lastProgressAt,
      };
      if (changed || now() - publishedAt >= 1000) {
        publishedAt = now();
        publish();
      }
    },
    finish(blocker?: string) {
      state.activity = undefined;
      if (blocker) state.lastBlocker = blocker;
      publish();
    },
  };
}

export function activityLines(state: OperationObservation, tickSeconds: number, now = Date.now()): string[] {
  const a = state.activity;
  if (!a) return state.lastBlocker ? [`Maintenance blocked: ${state.lastBlocker}`] :
    state.waiting ? [`PR #${state.waiting.prNumber} · ${state.waiting.prUrl}`, state.waiting.reason] : [];
  const count = (n: number) => a.unit === "bytes" ? (n / 1024 / 1024).toFixed(1) : String(n);
  const progress = a.completed === undefined ? "" :
    ` · ${count(a.completed)}${a.total === undefined ? "" : ` / ${count(a.total)}`} ${a.unit === "bytes" ? "MiB" : "items"}`;
  const idle = Math.max(0, Math.floor((now - a.lastProgressAt) / 1000));
  return [
    `${a.kind === "migration" ? "Migration" : "Cleanup"}${a.issueNumber ? ` #${a.issueNumber}` : a.itemId ? ` ${a.itemId}` : ""} · ${a.phase}${progress}`,
    `Last progress ${idle}s ago · elapsed ${Math.max(0, Math.floor((now - a.startedAt) / 1000))}s${now - a.lastProgressAt > Math.max(3 * tickSeconds, 300) * 1000 ? ` · STALE PROGRESS (${idle}s)` : ""}`,
  ];
}
