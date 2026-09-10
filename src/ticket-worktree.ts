import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import {
  GIT_GH_TIMEOUT_MS,
  processFailure,
  runProcessSync,
  type ProcessResult,
} from "./process-runner.js";
import type { BuilderTask } from "./workflow-prompt.js";

export interface TicketFinalizationState {
  targetBranch: string;
  baseSha: string;
  taskSha: string;
  resultSha?: string;
}

export interface TicketExecutionRecord {
  schemaVersion: 3;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  plan: string;
  taskBranch: string;
  baseBranch: string;
  path: string;
  createdAt: number;
  launchingAt?: number;
  activeRunId?: string;
  activeRunStartedAt?: number;
  lastRunId?: string;
  reviewedTaskSha?: string;
  finalization?: TicketFinalizationState;
}

export type TicketWorktreeRecord = TicketExecutionRecord;

export interface WorktreeCheck {
  ok: boolean;
  clean: boolean;
  reason?: string;
}

export interface FinalizeResult {
  resultSha: string;
  resumed: boolean;
}

const SHA = /^[0-9a-f]{40}$/i;
const RECORD_FIELDS = new Set([
  "schemaVersion",
  "itemId",
  "issueNumber",
  "taskKey",
  "plan",
  "taskBranch",
  "baseBranch",
  "path",
  "createdAt",
  "launchingAt",
  "activeRunId",
  "activeRunStartedAt",
  "lastRunId",
  "reviewedTaskSha",
  "finalization",
]);
const FINALIZATION_FIELDS = new Set([
  "targetBranch",
  "baseSha",
  "taskSha",
  "resultSha",
]);

function git(args: string[], cwd: string, input?: string): ProcessResult {
  return runProcessSync("git", args, {
    cwd,
    input,
    timeoutMs: GIT_GH_TIMEOUT_MS,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

function mustGit(args: string[], cwd: string, input?: string): string {
  const result = git(args, cwd, input);
  if (!result.ok) throw processFailure("git", args, result);
  return result.stdout.trim();
}

function safe(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ticket"
  );
}

function branchSha(branch: string, cwd: string): string | undefined {
  const result = git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
  );
  return result.ok ? result.stdout.trim() : undefined;
}

function samePath(a: string, b: string): boolean {
  const normalize = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}

function singleLine(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function sameIdentity(
  a: TicketExecutionRecord,
  b: TicketExecutionRecord,
): boolean {
  return (
    a.itemId === b.itemId &&
    a.issueNumber === b.issueNumber &&
    a.taskKey === b.taskKey &&
    a.plan === b.plan &&
    a.taskBranch === b.taskBranch &&
    a.baseBranch === b.baseBranch &&
    a.path === b.path &&
    a.createdAt === b.createdAt
  );
}

function optionalNumber(value: unknown): value is number | undefined {
  return (
    value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0)
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || singleLine(value);
}

function isFinalization(value: unknown): value is TicketFinalizationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).every((key) => FINALIZATION_FIELDS.has(key)) &&
    singleLine(state.targetBranch) &&
    typeof state.baseSha === "string" &&
    SHA.test(state.baseSha) &&
    typeof state.taskSha === "string" &&
    SHA.test(state.taskSha) &&
    (state.resultSha === undefined ||
      (typeof state.resultSha === "string" && SHA.test(state.resultSha)))
  );
}

export function isTicketExecutionRecord(
  value: unknown,
): value is TicketExecutionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => RECORD_FIELDS.has(key)) &&
    record.schemaVersion === 3 &&
    singleLine(record.itemId) &&
    Number.isSafeInteger(record.issueNumber) &&
    Number(record.issueNumber) > 0 &&
    singleLine(record.taskKey) &&
    singleLine(record.plan) &&
    singleLine(record.taskBranch) &&
    singleLine(record.baseBranch) &&
    singleLine(record.path) &&
    Number.isSafeInteger(record.createdAt) &&
    Number(record.createdAt) >= 0 &&
    optionalNumber(record.launchingAt) &&
    optionalString(record.activeRunId) &&
    optionalNumber(record.activeRunStartedAt) &&
    optionalString(record.lastRunId) &&
    (record.activeRunId === undefined) ===
      (record.activeRunStartedAt === undefined) &&
    !(record.launchingAt !== undefined && record.activeRunId !== undefined) &&
    !(
      record.finalization !== undefined &&
      (record.launchingAt !== undefined || record.activeRunId !== undefined)
    ) &&
    (record.reviewedTaskSha === undefined ||
      (typeof record.reviewedTaskSha === "string" &&
        SHA.test(record.reviewedTaskSha))) &&
    (record.finalization === undefined || isFinalization(record.finalization))
  );
}

/** Persistent per-ticket worktrees and exact-SHA finalization state. */
export class TicketWorktrees {
  private readonly repoRoot: string;
  private readonly gitCommonDir?: string;
  private readonly recordsDir: string;
  private readonly worktreesDir: string;

  constructor(cwd: string) {
    const root = git(
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ],
      cwd,
    );
    const [top, common] = root.stdout.trim().split(/\r?\n/);
    this.repoRoot = root.ok ? top : resolve(cwd);
    this.gitCommonDir = root.ok ? common : undefined;
    this.recordsDir = join(
      this.repoRoot,
      ".pi",
      "board-agent",
      "ticket-worktrees",
    );
    this.worktreesDir = join(this.repoRoot, ".pi", "worktrees");
    if (this.hasSymlink(this.recordsDir) || this.hasSymlink(this.worktreesDir))
      throw new Error(
        "Refusing symlinked Board Agent state/worktree directories.",
      );
    mkdirSync(this.recordsDir, { recursive: true });
    mkdirSync(this.worktreesDir, { recursive: true });
  }

  private recordPath(itemId: string): string {
    return join(this.recordsDir, `${safe(itemId)}.json`);
  }

  private parse(path: string): TicketExecutionRecord | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isTicketExecutionRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  read(itemId: string): TicketExecutionRecord | undefined {
    const path = this.recordPath(itemId);
    const record = existsSync(path) ? this.parse(path) : undefined;
    return record?.itemId === itemId ? record : undefined;
  }

  list(): TicketExecutionRecord[] {
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
    if (!isTicketExecutionRecord(record))
      throw new Error("Invalid v3 ticket execution record.");
    const path = this.recordPath(record.itemId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
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
    if (!current)
      throw new Error(
        `Ticket execution record is missing or unsupported: ${itemId}`,
      );
    const next = mutate(structuredClone(current));
    if (!sameIdentity(current, next) || next.schemaVersion !== 3)
      throw new Error(`Invalid ticket execution update for ${itemId}`);
    if (
      next.finalization &&
      (next.activeRunId || next.launchingAt !== undefined)
    )
      throw new Error(
        "Cannot mix builder execution with a pending finalization.",
      );
    const previous = current.finalization;
    if (
      previous &&
      (!next.finalization ||
        next.finalization.targetBranch !== previous.targetBranch ||
        next.finalization.baseSha !== previous.baseSha ||
        next.finalization.taskSha !== previous.taskSha ||
        (previous.resultSha !== undefined &&
          next.finalization.resultSha !== previous.resultSha) ||
        next.reviewedTaskSha !== current.reviewedTaskSha)
    )
      throw new Error("Cannot replace a pending finalization journal.");
    this.save(next);
    return next;
  }

  beginLaunch(itemId: string, launchingAt = Date.now()): TicketExecutionRecord {
    return this.update(itemId, (record) => {
      this.assertNoFinalization(record);
      if (record.activeRunId || record.launchingAt !== undefined)
        throw new Error("Ticket already has an active builder execution.");
      return {
        ...record,
        launchingAt,
        activeRunId: undefined,
        activeRunStartedAt: undefined,
        reviewedTaskSha: undefined,
      };
    });
  }

  setActiveRun(
    itemId: string,
    runId: string,
    startedAt = Date.now(),
  ): TicketExecutionRecord {
    return this.update(itemId, (record) => {
      this.assertNoFinalization(record);
      return {
        ...record,
        launchingAt: undefined,
        activeRunId: runId,
        activeRunStartedAt: startedAt,
      };
    });
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

  setReviewedTaskSha(itemId: string, taskSha: string): TicketExecutionRecord {
    if (!SHA.test(taskSha))
      throw new Error(`Invalid reviewed task SHA: ${taskSha}`);
    return this.update(itemId, (record) => {
      this.assertNoFinalization(record);
      if (record.activeRunId || record.launchingAt !== undefined)
        throw new Error(
          "Cannot record a review while builder execution is active.",
        );
      return { ...record, reviewedTaskSha: taskSha };
    });
  }

  private assertNoFinalization(record: TicketExecutionRecord): void {
    if (record.finalization)
      throw new Error(
        "Ticket has a pending finalization; recover it before starting another builder or review.",
      );
  }

  isMerged(itemId: string, targetBranch: string): boolean {
    if (!singleLine(itemId) || !this.fetch(targetBranch).ok) return false;
    const escaped = itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = git(
      [
        "log",
        "--format=%B%x00",
        "--extended-regexp",
        `--grep=^Board-Agent-Item: ${escaped}$`,
        `refs/remotes/origin/${targetBranch}`,
        "--",
      ],
      this.repoRoot,
    );
    return (
      result.ok &&
      result.stdout
        .split("\0")
        .some(
          (message) =>
            message.trimEnd().split(/\r?\n/).at(-1) ===
            `Board-Agent-Item: ${itemId}`,
        )
    );
  }

  private clear(itemId: string): void {
    rmSync(this.recordPath(itemId), { force: true });
  }

  private hasSymlink(path: string): boolean {
    let current = this.repoRoot;
    for (const part of relative(this.repoRoot, resolve(path)).split(sep)) {
      current = join(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
        return true;
    }
    return false;
  }

  private isManagedPath(path: string): boolean {
    const root = resolve(this.worktreesDir);
    const target = resolve(path);
    return samePath(dirname(target), root) && !this.hasSymlink(target);
  }

  private pathFor(itemId: string, issueNumber: number): string {
    return join(
      this.worktreesDir,
      `ticket-issue-${issueNumber}-${safe(itemId).slice(-10)}`,
    );
  }

  private assertOwnedPath(record: TicketExecutionRecord): void {
    if (
      !this.isManagedPath(record.path) ||
      !samePath(record.path, this.pathFor(record.itemId, record.issueNumber))
    )
      throw new Error(
        `Refusing unmanaged or mismatched worktree path: ${record.path}`,
      );
    if (
      this.list().some(
        (other) =>
          other.itemId !== record.itemId &&
          (other.taskBranch === record.taskBranch ||
            samePath(other.path, record.path)),
      )
    )
      throw new Error("Ticket branch/path has another execution record owner.");
  }

  private worktreeEntries(): Array<{
    path: string;
    branch?: string;
    locked: boolean;
  }> {
    const output = mustGit(
      ["worktree", "list", "--porcelain", "-z"],
      this.repoRoot,
    );
    const entries: Array<{ path: string; branch?: string; locked: boolean }> =
      [];
    let entry: { path: string; branch?: string; locked: boolean } | undefined;
    for (const line of output.split("\0")) {
      if (line.startsWith("worktree ")) {
        entry = { path: line.slice(9), locked: false };
        entries.push(entry);
      } else if (entry && line.startsWith("branch refs/heads/")) {
        entry.branch = line.slice("branch refs/heads/".length);
      } else if (entry && line.startsWith("locked")) {
        entry.locked = true;
      }
    }
    return entries;
  }

  private entryForPath(path: string) {
    return this.worktreeEntries().find((entry) => samePath(entry.path, path));
  }

  private registeredPathForBranch(branch: string): string | undefined {
    return this.worktreeEntries().find((entry) => entry.branch === branch)
      ?.path;
  }

  check(record: TicketExecutionRecord, requireClean = true): WorktreeCheck {
    try {
      this.assertOwnedPath(record);
    } catch (error) {
      return { ok: false, clean: false, reason: (error as Error).message };
    }
    if (!existsSync(record.path))
      return {
        ok: false,
        clean: false,
        reason: `missing worktree: ${record.path}`,
      };
    const entry = this.entryForPath(record.path);
    if (!entry)
      return {
        ok: false,
        clean: false,
        reason: `unregistered worktree: ${record.path}`,
      };
    if (entry.locked)
      return {
        ok: false,
        clean: false,
        reason: `locked worktree: ${record.path}`,
      };
    const identity = git(
      [
        "rev-parse",
        "--path-format=absolute",
        "--symbolic-full-name",
        "HEAD",
        "--show-toplevel",
        "--git-common-dir",
      ],
      record.path,
    );
    const [branch, top, common] = identity.stdout.trim().split(/\r?\n/);
    if (
      !identity.ok ||
      branch !== `refs/heads/${record.taskBranch}` ||
      entry.branch !== record.taskBranch
    )
      return {
        ok: false,
        clean: false,
        reason: `expected branch ${record.taskBranch}, found ${branch?.replace(/^refs\/heads\//, "") || "detached/unknown"}`,
      };
    if (
      !top ||
      !samePath(top, record.path) ||
      !common ||
      !this.gitCommonDir ||
      !samePath(common, this.gitCommonDir)
    )
      return {
        ok: false,
        clean: false,
        reason: "worktree repository identity changed",
      };
    const status = git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      record.path,
    );
    if (!status.ok)
      return {
        ok: false,
        clean: false,
        reason: `cannot read worktree status: ${record.path}`,
      };
    const clean = !status.stdout.trim();
    if (requireClean && !clean)
      return {
        ok: false,
        clean: false,
        reason: `dirty worktree: ${record.path}`,
      };
    return { ok: true, clean };
  }

  hasTaskDelta(record: TicketExecutionRecord): boolean {
    if (!this.fetch(record.baseBranch, record.path).ok) return true;
    const result = git(
      [
        "rev-list",
        "--count",
        `origin/${record.baseBranch}..${record.taskBranch}`,
      ],
      record.path,
    );
    return !result.ok || Number(result.stdout.trim()) > 0;
  }

  /** Create or resume the one persistent worktree owned by an Issue. */
  ensure(task: BuilderTask, plan: string): TicketExecutionRecord {
    const saved = this.read(task.itemId);
    if (!saved && this.has(task.itemId))
      throw new Error(
        `Ticket execution record is corrupt or unsupported: ${this.recordPath(task.itemId)}`,
      );
    if (saved) {
      if (
        saved.issueNumber !== task.issueNumber ||
        saved.taskBranch !== task.taskBranch ||
        saved.baseBranch !== task.baseBranch ||
        saved.plan !== plan
      )
        throw new Error(
          `Ticket worktree metadata no longer matches ${task.itemId}`,
        );
      this.assertNoFinalization(saved);
      const check = this.check(saved, false);
      if (!check.ok)
        throw new Error(check.reason ?? "Ticket worktree is unsafe.");
      return saved;
    }

    const branchOwner = this.list().find(
      (record) => record.taskBranch === task.taskBranch,
    );
    if (branchOwner)
      throw new Error(
        `${task.taskBranch} is already owned by ticket ${branchOwner.itemId}`,
      );

    this.validateBranches(task.baseBranch, task.taskBranch);
    if (task.baseBranch === task.taskBranch)
      throw new Error("Task branch must differ from the base branch.");
    this.fetchRequired(task.baseBranch);
    if (this.registeredPathForBranch(task.taskBranch))
      throw new Error(
        `${task.taskBranch} is already checked out without a v3 ticket record.`,
      );
    if (
      branchSha(task.taskBranch, this.repoRoot) ||
      this.remoteSha(task.taskBranch)
    )
      throw new Error(
        `${task.taskBranch} already exists without a v3 ticket record.`,
      );

    const path = this.pathFor(task.itemId, task.issueNumber);
    if (!this.isManagedPath(path))
      throw new Error(`Refusing unmanaged worktree path: ${path}`);
    if (existsSync(path))
      throw new Error(`Worktree path exists but is not registered: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    mustGit(
      [
        "worktree",
        "add",
        "-b",
        task.taskBranch,
        path,
        `origin/${task.baseBranch}`,
      ],
      this.repoRoot,
    );

    const record: TicketExecutionRecord = {
      schemaVersion: 3,
      itemId: task.itemId,
      issueNumber: task.issueNumber,
      taskKey: task.taskKey,
      plan,
      taskBranch: task.taskBranch,
      baseBranch: task.baseBranch,
      path,
      createdAt: Date.now(),
    };
    this.save(record);
    return record;
  }

  /** Finalize from immutable remote SHAs, verify the pushed result, then clean up. */
  finalizeAccepted(
    record: TicketExecutionRecord,
    strategy: Config["task_merge_strategy"],
    title: string,
    targetBranch: string,
  ): FinalizeResult {
    let current = this.read(record.itemId);
    if (!current || !sameIdentity(current, record))
      throw new Error(`Missing or changed v3 record for ${record.itemId}.`);
    if (
      current.baseBranch !== targetBranch ||
      current.taskBranch === targetBranch
    )
      throw new Error(
        "Ticket base/task branch identity does not match the finalization target.",
      );
    this.validateBranches(targetBranch, current.taskBranch);
    this.assertOwnedPath(current);
    if (current.activeRunId || current.launchingAt !== undefined)
      throw new Error("Builder execution is still active.");
    const resumed = !!current.finalization;

    if (!current.finalization) {
      const check = this.check(current, true);
      if (!check.ok) throw new Error(check.reason ?? "worktree is unsafe");
      this.fetchRequired(targetBranch, current.taskBranch);
      const baseSha = this.fetchedSha(targetBranch);
      const taskSha = this.fetchedSha(current.taskBranch);
      // AI review is optional. A human-only closed Done ticket approves this
      // fresh remote SHA; an existing AI approval must still match exactly.
      if (current.reviewedTaskSha && taskSha !== current.reviewedTaskSha)
        throw new Error(
          `origin/${current.taskBranch} moved after review from ${current.reviewedTaskSha} to ${taskSha}.`,
        );
      this.assertTaskSha(current, taskSha);
      current = this.update(current.itemId, (value) => ({
        ...value,
        finalization: { targetBranch, baseSha, taskSha },
      }));
    }

    let state = current.finalization!;
    if (state.targetBranch !== targetBranch)
      throw new Error(
        "Saved finalization target changed; refusing to continue.",
      );
    if (current.reviewedTaskSha && state.taskSha !== current.reviewedTaskSha)
      throw new Error(
        "Saved finalization SHA does not match the reviewed task SHA.",
      );

    const treeSha = this.resultTree(state);
    if (!state.resultSha) {
      this.assertReadyToPush(current, state);
      const subject = `chore(board): merge ${current.taskKey} after validation`;
      const body = `${title.replace(/[\r\n]+/g, " ")}\n\nRefs #${current.issueNumber}\nBoard-Agent-Item: ${current.itemId}`;
      const parents = this.resultParents(state, strategy).flatMap((sha) => [
        "-p",
        sha,
      ]);
      const resultSha = mustGit(
        ["commit-tree", treeSha, ...parents],
        this.repoRoot,
        `${subject}\n\n${body}\n`,
      );
      if (!SHA.test(resultSha))
        throw new Error("git commit-tree returned no result commit.");
      current = this.update(current.itemId, (value) => ({
        ...value,
        finalization: { ...state, resultSha },
      }));
      state = current.finalization!;
    }

    const resultSha = state.resultSha!;
    // The journal is recovery input, not proof: verify the exact tree, ordered
    // parents and marker even when the saved result is already on the remote.
    const [tree, parents, ...message] = mustGit(
      ["show", "-s", "--format=%T%n%P%n%B", resultSha, "--"],
      this.repoRoot,
    ).split(/\r?\n/);
    if (
      tree !== treeSha ||
      parents !== this.resultParents(state, strategy).join(" ") ||
      message.at(-1) !== `Board-Agent-Item: ${current.itemId}`
    )
      throw new Error(
        "Saved finalization result does not match its exact tree, parents or item marker.",
      );

    this.fetchRequired(targetBranch);
    if (!this.isAncestor(resultSha, this.fetchedSha(targetBranch))) {
      // Every retry must pass the same worktree and SHA gates as the first push.
      this.assertReadyToPush(current, state);
      mustGit(
        ["push", "origin", `${resultSha}:refs/heads/${targetBranch}`],
        this.repoRoot,
      );
      this.fetchRequired(targetBranch);
      if (!this.isAncestor(resultSha, this.fetchedSha(targetBranch)))
        throw new Error(
          `Pushed result ${resultSha} is not on origin/${targetBranch}.`,
        );
    }

    this.cleanupFinalized(current, state);
    return { resultSha, resumed };
  }

  private resultTree(state: TicketFinalizationState): string {
    const tree = mustGit(
      ["merge-tree", "--write-tree", state.baseSha, state.taskSha],
      this.repoRoot,
    ).split(/\s+/)[0];
    if (!SHA.test(tree))
      throw new Error("git merge-tree returned no result tree.");
    return tree;
  }

  private resultParents(
    state: TicketFinalizationState,
    strategy: Config["task_merge_strategy"],
  ): string[] {
    if (strategy !== "merge" && strategy !== "squash")
      throw new Error("Unsupported finalization strategy.");
    return strategy === "merge"
      ? [state.baseSha, state.taskSha]
      : [state.baseSha];
  }

  private assertReadyToPush(
    record: TicketExecutionRecord,
    state: TicketFinalizationState,
  ): void {
    const check = this.check(record, true);
    if (!check.ok) throw new Error(check.reason ?? "worktree is unsafe");
    this.assertRemoteShas(record, state);
  }

  private assertTaskSha(record: TicketExecutionRecord, expected: string): void {
    const local = branchSha(record.taskBranch, this.repoRoot);
    const head = git(["rev-parse", "HEAD"], record.path);
    if (
      !local ||
      local !== expected ||
      !head.ok ||
      head.stdout.trim() !== expected
    )
      throw new Error(
        `${record.taskBranch} does not exactly match approved origin SHA ${expected}.`,
      );
  }

  private assertRemoteShas(
    record: TicketExecutionRecord,
    state: TicketFinalizationState,
  ): void {
    this.fetchRequired(state.targetBranch, record.taskBranch);
    const base = this.fetchedSha(state.targetBranch);
    const task = this.fetchedSha(record.taskBranch);
    if (base !== state.baseSha)
      throw new Error(
        `origin/${state.targetBranch} moved from approved ${state.baseSha} to ${base}.`,
      );
    if (task !== state.taskSha)
      throw new Error(
        `origin/${record.taskBranch} moved from approved ${state.taskSha} to ${task}.`,
      );
    this.assertTaskSha(record, state.taskSha);
  }

  private cleanupFinalized(
    record: TicketExecutionRecord,
    state: TicketFinalizationState,
  ): void {
    if (record.taskBranch === state.targetBranch)
      throw new Error(
        `Refusing to delete target branch: ${state.targetBranch}`,
      );
    this.fetchRequired(state.targetBranch);
    if (
      !state.resultSha ||
      !this.isAncestor(state.resultSha, this.fetchedSha(state.targetBranch))
    )
      throw new Error(
        "Remote finalization result is not verified; cleanup refused.",
      );

    this.assertOwnedPath(record);
    const entries = this.worktreeEntries();
    const entry = entries.find((entry) => samePath(entry.path, record.path));
    if (
      entries.some(
        (entry) =>
          entry.branch === record.taskBranch &&
          !samePath(entry.path, record.path),
      )
    )
      throw new Error(
        `Task branch is registered at another worktree; cleanup refused.`,
      );
    if (existsSync(record.path)) {
      const check = this.check(record, true);
      if (!check.ok)
        throw new Error(check.reason ?? "Unsafe worktree remains.");
      this.assertTaskSha(record, state.taskSha);
    } else if (entry) {
      throw new Error(
        `Missing registered worktree cannot be cleaned: ${record.path}`,
      );
    }

    const symbolic = git(
      ["symbolic-ref", "--quiet", `refs/heads/${record.taskBranch}`],
      this.repoRoot,
    );
    if (symbolic.ok || symbolic.status !== 1)
      throw new Error(
        `Local ${record.taskBranch} is symbolic or unreadable; cleanup refused.`,
      );
    const local = branchSha(record.taskBranch, this.repoRoot);
    if (local && local !== state.taskSha)
      throw new Error(`Local ${record.taskBranch} moved; cleanup refused.`);
    const remote = git(
      [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        `refs/heads/${record.taskBranch}`,
      ],
      this.repoRoot,
    );
    if (remote.ok) {
      const remoteSha = remote.stdout.trim().split(/\s+/)[0];
      if (remoteSha !== state.taskSha)
        throw new Error(`Remote ${record.taskBranch} moved; cleanup refused.`);
    } else if (remote.status !== 2) {
      throw processFailure(
        "git",
        ["ls-remote", "origin", record.taskBranch],
        remote,
      );
    }

    if (existsSync(record.path))
      mustGit(["worktree", "remove", record.path], this.repoRoot);
    if (local)
      mustGit(
        [
          "update-ref",
          "--no-deref",
          "-d",
          `refs/heads/${record.taskBranch}`,
          state.taskSha,
        ],
        this.repoRoot,
      );
    if (remote.ok)
      mustGit(
        [
          "push",
          "origin",
          `--force-with-lease=refs/heads/${record.taskBranch}:${state.taskSha}`,
          `:refs/heads/${record.taskBranch}`,
        ],
        this.repoRoot,
      );

    this.clear(record.itemId);
  }

  private validateBranches(...branches: string[]): void {
    for (const branch of branches) {
      if (!singleLine(branch) || branch.startsWith("-"))
        throw new Error(`Invalid branch: ${branch}`);
      mustGit(["check-ref-format", `refs/heads/${branch}`], this.repoRoot);
    }
  }

  private fetch(branch: string, cwd = this.repoRoot): ProcessResult {
    this.validateBranches(branch);
    return git(
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      cwd,
    );
  }

  private fetchRequired(...branches: string[]): void {
    mustGit(
      [
        "fetch",
        "--no-tags",
        "origin",
        ...branches.map(
          (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ),
      ],
      this.repoRoot,
    );
  }

  private fetchedSha(branch: string): string {
    return mustGit(
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
      this.repoRoot,
    );
  }

  private remoteSha(branch: string): string | undefined {
    const result = git(
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      this.repoRoot,
    );
    if (!result.ok) return undefined;
    return result.stdout.trim().split(/\s+/)[0];
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    return git(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      this.repoRoot,
    ).ok;
  }
}
