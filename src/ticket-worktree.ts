import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import type { BuilderTask } from "./workflow-prompt.js";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface TicketExecutionRecord {
  schemaVersion: 2;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  plan: string;
  taskBranch: string;
  planBranch: string;
  path: string;
  createdAt: number;
  launchingAt?: number;
  activeRunId?: string;
  activeRunStartedAt?: number;
  lastRunId?: string;
}

export interface LegacyTicketWorktreeRecord {
  schemaVersion?: 1;
  itemId: string;
  issueNumber?: number;
  taskKey: string;
  plan: string;
  taskBranch: string;
  planBranch: string;
  path: string;
  createdAt: number;
}

export type TicketWorktreeRecord = TicketExecutionRecord | LegacyTicketWorktreeRecord;

export interface WorktreeCheck {
  ok: boolean;
  clean: boolean;
  reason?: string;
}

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function mustGit(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

function branchExists(branch: string, cwd: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd).ok;
}

function remoteBranchExists(branch: string, cwd: string): boolean {
  return git(["ls-remote", "--exit-code", "--heads", "origin", branch], cwd).ok;
}

function isRecord(value: unknown): value is TicketWorktreeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["itemId", "taskKey", "plan", "taskBranch", "planBranch", "path"].every(
    (key) => typeof record[key] === "string",
  ) && typeof record.createdAt === "number";
}

/** Persistent per-ticket worktrees and the ticket-to-workflow association. */
export class TicketWorktrees {
  private readonly repoRoot: string;
  private readonly recordsDir: string;
  private readonly worktreesDir: string;

  constructor(cwd: string) {
    const root = git(["rev-parse", "--show-toplevel"], cwd);
    this.repoRoot = root.ok ? root.stdout.trim() : resolve(cwd);
    this.recordsDir = join(this.repoRoot, ".pi", "board-agent", "ticket-worktrees");
    this.worktreesDir = join(this.repoRoot, ".pi", "worktrees");
    mkdirSync(this.recordsDir, { recursive: true });
    mkdirSync(this.worktreesDir, { recursive: true });
  }

  private recordPath(itemId: string): string {
    return join(this.recordsDir, `${safe(itemId)}.json`);
  }

  private parse(path: string): TicketWorktreeRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  read(itemId: string): TicketWorktreeRecord | undefined {
    const path = this.recordPath(itemId);
    return existsSync(path) ? this.parse(path) : undefined;
  }

  list(): TicketWorktreeRecord[] {
    if (!existsSync(this.recordsDir)) return [];
    return readdirSync(this.recordsDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const record = this.parse(join(this.recordsDir, name));
        return record ? [record] : [];
      });
  }

  has(itemId: string): boolean {
    return existsSync(this.recordPath(itemId));
  }

  private save(record: TicketExecutionRecord): void {
    const path = this.recordPath(record.itemId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  update(
    itemId: string,
    mutate: (record: TicketExecutionRecord) => TicketExecutionRecord,
  ): TicketExecutionRecord {
    const current = this.read(itemId);
    if (!current || current.schemaVersion !== 2) {
      throw new Error(`Ticket execution record is missing or legacy: ${itemId}`);
    }
    const next = mutate({ ...current });
    if (next.itemId !== itemId || next.schemaVersion !== 2) {
      throw new Error(`Invalid ticket execution update for ${itemId}`);
    }
    this.save(next);
    return next;
  }

  beginLaunch(itemId: string, launchingAt = Date.now()): TicketExecutionRecord {
    return this.update(itemId, (record) => ({
      ...record,
      launchingAt,
      activeRunId: undefined,
      activeRunStartedAt: undefined,
    }));
  }

  setActiveRun(itemId: string, runId: string, startedAt = Date.now()): TicketExecutionRecord {
    return this.update(itemId, (record) => ({
      ...record,
      launchingAt: undefined,
      activeRunId: runId,
      activeRunStartedAt: startedAt,
    }));
  }

  clearExecution(itemId: string, lastRunId?: string): TicketExecutionRecord {
    return this.update(itemId, (record) => ({
      ...record,
      launchingAt: undefined,
      activeRunId: undefined,
      activeRunStartedAt: undefined,
      lastRunId: lastRunId ?? record.lastRunId,
    }));
  }

  isMerged(itemId: string, planBranch: string, taskBranch?: string): boolean {
    git(["fetch", "origin", planBranch, ...(taskBranch ? [taskBranch] : [])], this.repoRoot);
    const remotePlan = `origin/${planBranch}`;
    const marked = git([
      "log", "-1", "--format=%H", "--fixed-strings",
      `--grep=Board-Agent-Item: ${itemId}`,
      remotePlan,
    ], this.repoRoot).stdout.trim().length > 0;
    return marked || !!taskBranch && this.isIntegrated(remotePlan, `origin/${taskBranch}`, this.repoRoot);
  }

  private isIntegrated(planRef: string, taskRef: string, cwd: string): boolean {
    if (git(["merge-base", "--is-ancestor", taskRef, planRef], cwd).ok) return true;
    const cherry = git(["cherry", planRef, taskRef], cwd);
    const patches = cherry.stdout.trim().split(/\r?\n/).filter(Boolean);
    return cherry.ok && patches.every((line) => line.startsWith("- "));
  }

  private clear(itemId: string): void {
    rmSync(this.recordPath(itemId), { force: true });
  }

  private isManagedPath(path: string): boolean {
    const root = resolve(this.worktreesDir);
    const target = resolve(path);
    return target.startsWith(`${root}${sep}`);
  }

  private registeredPathForBranch(branch: string): string | undefined {
    const result = git(["worktree", "list", "--porcelain"], this.repoRoot);
    if (!result.ok) return undefined;
    let path: string | undefined;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      if (line === `branch refs/heads/${branch}`) return path;
      if (line === "") path = undefined;
    }
    return undefined;
  }

  private isRegistered(path: string): boolean {
    const wanted = resolve(path).toLowerCase();
    const result = git(["worktree", "list", "--porcelain"], this.repoRoot);
    return result.ok && result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .some((line) => resolve(line.slice(9).trim()).toLowerCase() === wanted);
  }

  check(record: TicketWorktreeRecord, requireClean = true): WorktreeCheck {
    if (!this.isManagedPath(record.path)) return { ok: false, clean: false, reason: `unmanaged path: ${record.path}` };
    if (!existsSync(record.path)) return { ok: false, clean: false, reason: `missing worktree: ${record.path}` };
    if (!this.isRegistered(record.path)) return { ok: false, clean: false, reason: `unregistered worktree: ${record.path}` };
    const branch = git(["branch", "--show-current"], record.path);
    if (!branch.ok || branch.stdout.trim() !== record.taskBranch) {
      return { ok: false, clean: false, reason: `expected branch ${record.taskBranch}, found ${branch.stdout.trim() || "unknown"}` };
    }
    const clean = git(["status", "--porcelain"], record.path).stdout.trim() === "";
    if (requireClean && !clean) return { ok: false, clean: false, reason: `dirty worktree: ${record.path}` };
    return { ok: true, clean };
  }

  hasTaskDelta(record: TicketWorktreeRecord): boolean {
    const result = git(["rev-list", "--count", `${record.planBranch}..${record.taskBranch}`], record.path);
    return !result.ok || Number(result.stdout.trim()) > 0;
  }

  /** Create or resume the persistent worktree for one board item. */
  ensure(task: BuilderTask, plan: string): TicketExecutionRecord {
    const saved = this.read(task.itemId);
    if (!saved && this.has(task.itemId)) {
      throw new Error(`Ticket execution record is corrupt: ${this.recordPath(task.itemId)}`);
    }
    if (saved) {
      if (!existsSync(saved.path)) throw new Error(`Ticket worktree is missing: ${saved.path}`);
      if (!this.isManagedPath(saved.path)) throw new Error(`Refusing unmanaged worktree path: ${saved.path}`);
      if (saved.taskBranch !== task.taskBranch || saved.planBranch !== task.planBranch || saved.plan !== plan) {
        throw new Error(`Ticket worktree metadata no longer matches ${task.itemId}`);
      }
      if (saved.schemaVersion === 2) return saved;
      const upgraded: TicketExecutionRecord = {
        ...saved,
        schemaVersion: 2,
        issueNumber: task.issueNumber ?? saved.issueNumber ?? 0,
      };
      this.save(upgraded);
      return upgraded;
    }

    const branchOwner = this.list().find((record) =>
      record.itemId !== task.itemId && record.taskBranch === task.taskBranch
    );
    if (branchOwner) {
      throw new Error(`${task.taskBranch} is already owned by ticket ${branchOwner.itemId}`);
    }

    mustGit(["fetch", "origin", task.planBranch], this.repoRoot);

    const registered = this.registeredPathForBranch(task.taskBranch);
    if (registered) {
      throw new Error(`${task.taskBranch} is already checked out without a ticket record: ${registered}`);
    }

    const suffix = safe(task.itemId).slice(-10);
    const path = join(this.worktreesDir, `ticket-${safe(task.taskKey)}-${suffix}`.slice(0, 64));
    if (existsSync(path)) throw new Error(`Worktree path exists but is not registered: ${path}`);
    mkdirSync(dirname(path), { recursive: true });

    if (!branchExists(task.taskBranch, this.repoRoot) && remoteBranchExists(task.taskBranch, this.repoRoot)) {
      mustGit(["fetch", "origin", `${task.taskBranch}:refs/heads/${task.taskBranch}`], this.repoRoot);
    }
    if (branchExists(task.taskBranch, this.repoRoot)) {
      mustGit(["worktree", "add", path, task.taskBranch], this.repoRoot);
    } else {
      mustGit(["worktree", "add", "-b", task.taskBranch, path, `origin/${task.planBranch}`], this.repoRoot);
    }

    const record: TicketExecutionRecord = {
      schemaVersion: 2,
      itemId: task.itemId,
      issueNumber: task.issueNumber ?? 0,
      taskKey: task.taskKey,
      plan,
      taskBranch: task.taskBranch,
      planBranch: task.planBranch,
      path,
      createdAt: Date.now(),
    };
    this.save(record);
    return record;
  }

  /** Merge a manually accepted ticket into its plan branch, then remove its worktree. */
  mergeAndRemove(
    record: TicketWorktreeRecord,
    strategy: Config["task_merge_strategy"],
    issueNumber: number,
    title: string,
  ): void {
    if (!this.isManagedPath(record.path)) throw new Error(`Refusing unmanaged worktree path: ${record.path}`);
    if (!existsSync(record.path)) {
      this.clear(record.itemId);
      throw new Error(`Ticket worktree is missing: ${record.path}`);
    }
    if (git(["status", "--porcelain"], record.path).stdout.trim()) {
      throw new Error(`Ticket worktree has uncommitted changes: ${record.path}`);
    }

    mustGit(["fetch", "origin", record.planBranch, record.taskBranch], record.path);
    if (!remoteBranchExists(record.taskBranch, record.path)) {
      throw new Error(`Remote task branch does not exist: origin/${record.taskBranch}`);
    }
    mustGit(["checkout", record.taskBranch], record.path);
    mustGit(["pull", "--ff-only", "origin", record.taskBranch], record.path);
    const localTask = mustGit(["rev-parse", record.taskBranch], record.path);
    const remoteTask = mustGit(["rev-parse", `origin/${record.taskBranch}`], record.path);
    if (localTask !== remoteTask) {
      throw new Error(`${record.taskBranch} has local commits that were not reviewed and pushed`);
    }

    const marker = `Board-Agent-Item: ${record.itemId}`;
    const marked = (branch: string) => git([
      "log", "-1", "--format=%H", "--fixed-strings", `--grep=${marker}`, branch,
    ], record.path).stdout.trim().length > 0;

    mustGit(["checkout", record.planBranch], record.path);
    mustGit(["pull", "--ff-only", "origin", record.planBranch], record.path);

    if (!marked(record.planBranch) && !this.isIntegrated(record.planBranch, record.taskBranch, record.path)) {
      const subject = `chore(board): merge ${record.taskKey} after validation`;
      const body = `${title}\n\nRefs #${issueNumber}\n${marker}`;
      if (strategy === "squash") {
        mustGit(["merge", "--squash", record.taskBranch], record.path);
        mustGit(["commit", "--allow-empty", "-m", subject, "-m", body], record.path);
      } else {
        mustGit(["merge", "--no-ff", record.taskBranch, "-m", `${subject}\n\n${body}`], record.path);
        if (!marked(record.planBranch)) {
          mustGit(["commit", "--allow-empty", "-m", subject, "-m", body], record.path);
        }
      }
    }

    mustGit(["push", "origin", record.planBranch], record.path);
    this.remove(record);
  }

  remove(record: TicketWorktreeRecord): void {
    const result = git(["worktree", "remove", "--force", "--force", record.path], this.repoRoot);
    if (!result.ok && existsSync(record.path)) {
      if (this.isRegistered(record.path)) {
        throw new Error(`Failed to remove ticket worktree: ${result.stderr.trim()}`);
      }
      rmSync(record.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (existsSync(record.path)) throw new Error(`Ticket worktree still exists: ${record.path}`);
    git(["worktree", "prune"], this.repoRoot);
    this.clear(record.itemId);
  }
}
