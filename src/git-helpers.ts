/** Main-worktree safety checks. */
import { runProcessSync } from "./process-runner.js";

/** Ignore only untracked Board Agent runtime, never index/tracked changes. */
export function isClean(cwd: string): boolean {
  const result = runProcessSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd },
  );
  if (!result.ok) return false;
  // Porcelain -z is repository-root relative and does not quote odd filenames.
  // A tracked rename's first entry already fails, so its second path cannot be
  // mistaken for runtime noise. Do not exclude these directories via pathspec:
  // that also hides tracked source and staged additions within them.
  return result.stdout
    .split("\0")
    .every(
      (entry) =>
        !entry ||
        entry.startsWith("?? .pi/board-agent/") ||
        entry.startsWith("?? .pi/worktrees/"),
    );
}
