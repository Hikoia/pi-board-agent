import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runProcessSync } from "./process-runner.js";
import { isTicketExecutionRecord } from "./ticket-worktree.js";

export function resolveStateRepoRoot(cwd: string): string {
  const result = runProcessSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.ok ? result.stdout.trim() : resolve(cwd);
}

function stateDirectory(path: string, unsupported: string[]): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  unsupported.push(path);
  return false;
}

function stateFiles(path: string, unsupported: string[]): string[] {
  if (!stateDirectory(path, unsupported)) return [];
  try {
    return readdirSync(path).map((name) => join(path, name));
  } catch {
    unsupported.push(path);
    return [];
  }
}

/** Read-only inventory of state that 0.2.0 deliberately refuses to migrate. */
export function findUnsupportedState(
  cwd: string,
  root = resolveStateRepoRoot(cwd),
): string[] {
  const dotpi = join(root, ".pi");
  const state = join(dotpi, "board-agent");
  const unsupported: string[] = [];
  // Do not follow symlinks (including dangling links), or treat unreadable state as absent.
  if (
    stateDirectory(dotpi, unsupported) &&
    stateDirectory(state, unsupported)
  ) {
    unsupported.push(...stateFiles(join(state, "inflight"), unsupported));
    for (const path of stateFiles(
      join(state, "ticket-worktrees"),
      unsupported,
    )) {
      if (!path.toLowerCase().endsWith(".json")) continue;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Not a regular state file");
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isTicketExecutionRecord(value)) unsupported.push(path);
      } catch {
        unsupported.push(path);
      }
    }
  }
  return unsupported
    .sort()
    .map((path) => relative(root, path).replaceAll("\\", "/"));
}

export function assertSupportedState(cwd: string, root?: string): void {
  const files = findUnsupportedState(cwd, root);
  if (!files.length) return;
  throw new Error(
    [
      "Unsupported pre-0.2.0 Board Agent state detected:",
      ...files.map((path) => `- ${path}`),
      "Stop Board Agent, back up these paths, then remove or migrate unsupported records manually before /board-agent lint or run. Symlinked or unreadable state paths must be repaired first.",
      "No files were moved or deleted.",
    ].join("\n"),
  );
}

/** Startup may isolate unsupported tickets, but never traverse unsafe state
 * directories. The strict read-only lint inventory above remains available. */
export function assertSafeStateDirectories(cwd: string, root = resolveStateRepoRoot(cwd)): void {
  const errors: string[] = [];
  const dotpi = join(root, ".pi"), state = join(dotpi, "board-agent");
  if (stateDirectory(dotpi, errors) && stateDirectory(state, errors))
    for (const name of ["ticket-worktrees", "cleanup", "repair", "inflight"])
      stateDirectory(join(state, name), errors);
  if (errors.length) throw new Error(`Unsafe Board Agent state directories: ${errors.join(", ")}. No files changed.`);
}
