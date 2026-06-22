/**
 * Thin git wrappers. We use them only for plan-branch lifecycle (create / push /
 * detect dirty). Per-task branches and worktrees are entirely managed by
 * pi-dynamic-workflows when the builder agent runs with `isolation: "worktree"`.
 */
import { spawnSync } from "node:child_process";

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function isClean(cwd: string): boolean {
  const res = git(["status", "--porcelain"], cwd);
  return res.ok && res.stdout.trim().length === 0;
}

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.trim();
}

export function localBranchExists(branch: string, cwd: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd).ok;
}

export function remoteBranchExists(branch: string, cwd: string): boolean {
  const r = git(["ls-remote", "--exit-code", "--heads", "origin", branch], cwd);
  return r.ok;
}

export function commitsAhead(branch: string, base: string, cwd: string): number {
  const r = git(["rev-list", "--count", `${base}..${branch}`], cwd);
  if (!r.ok) return 0;
  return Number(r.stdout.trim() || "0");
}

/** Ensure a `plan/<slug>` branch exists locally + on origin, based on `base`. */
export function ensurePlanBranch(planBranch: string, baseBranch: string, cwd: string): void {
  // Fetch latest base.
  let r = git(["fetch", "origin", baseBranch], cwd);
  if (!r.ok) throw new Error(`git fetch origin ${baseBranch} failed: ${r.stderr}`);
  if (!localBranchExists(planBranch, cwd)) {
    r = git(["branch", planBranch, `origin/${baseBranch}`], cwd);
    if (!r.ok) throw new Error(`git branch ${planBranch} failed: ${r.stderr}`);
  }
  if (!remoteBranchExists(planBranch, cwd)) {
    r = git(["push", "-u", "origin", planBranch], cwd);
    if (!r.ok) throw new Error(`git push -u origin ${planBranch} failed: ${r.stderr}`);
  }
}
