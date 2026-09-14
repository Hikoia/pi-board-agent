import { randomUUID } from "node:crypto";
import { readdir, unlink, lstat } from "node:fs/promises";
import { exactKeys } from "./cleanup-snapshot.js";
import {
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import {
  GIT_GH_TIMEOUT_MS,
  processFailure,
  runProcess,
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

export interface TicketRetryState {
  stage: "build" | "review" | "integrate" | "cleanup";
  /** Also retained while failure comment/status/reopen/release is unfinished. */
  reason: string;
}

export interface TicketIntegrationState {
  baseSha: string;
  taskSha: string;
  /** A prepared result, NOT proof of a successful push or permission to clean up. */
  resultSha: string;
}

export interface TicketExecutionRecord {
  /** v3 is read-only input to the stopped-upgrade adapter in production. */
  schemaVersion: 3 | 4;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  /** Required in v3; optional in v4. */
  plan?: string;
  taskBranch: string;
  baseBranch: string;
  path: string;
  createdAt: number;
  launchingAt?: number;
  activeRunId?: string;
  activeRunStartedAt?: number;
  lastRunId?: string;
  reviewedTaskSha?: string;
  /** Legacy paths remain available during the serial upgrade. */
  finalization?: TicketFinalizationState;
  retry?: TicketRetryState;
  integration?: TicketIntegrationState;
}

export type TicketWorktreeRecord = TicketExecutionRecord;

export interface WorktreeCheck {
  ok: boolean;
  clean: boolean;
  reason?: string;
}

export class MergeConflictError extends Error {
  constructor(
    readonly baseSha: string,
    readonly taskSha: string,
    readonly diagnostic: string,
  ) {
    super(diagnostic);
    this.name = "MergeConflictError";
  }
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
const V4_RECORD_FIELDS = new Set([...RECORD_FIELDS, "retry", "integration"]);
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

// Network and worktree mutations yield without changing the runner's policy.
function gitAsync(
  args: string[],
  cwd: string,
  input?: string,
): Promise<ProcessResult> {
  return runProcess("git", args, {
    cwd,
    input,
    timeoutMs: GIT_GH_TIMEOUT_MS,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

async function mustGitAsync(
  args: string[],
  cwd: string,
  input?: string,
): Promise<string> {
  const result = await gitAsync(args, cwd, input);
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

function isRetry(value: unknown): value is TicketRetryState {
  if (!exactKeys(value, ["stage", "reason"])) return false;
  const state = value as TicketRetryState;
  return (
    ["build", "review", "integrate", "cleanup"].includes(state.stage) &&
    typeof state.reason === "string" &&
    state.reason.trim().length > 0
  );
}

function isIntegration(value: unknown): value is TicketIntegrationState {
  if (!exactKeys(value, ["baseSha", "taskSha", "resultSha"])) return false;
  const state = value as TicketIntegrationState;
  return [state.baseSha, state.taskSha, state.resultSha].every(
    (sha) => typeof sha === "string" && SHA.test(sha),
  );
}

export function isTicketExecutionRecord(
  value: unknown,
): value is TicketExecutionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = record.schemaVersion === 4 ? V4_RECORD_FIELDS : RECORD_FIELDS;
  return (
    Object.keys(record).every((key) => fields.has(key)) &&
    (record.schemaVersion === 3 || record.schemaVersion === 4) &&
    singleLine(record.itemId) &&
    Number.isSafeInteger(record.issueNumber) &&
    Number(record.issueNumber) > 0 &&
    singleLine(record.taskKey) &&
    (record.schemaVersion === 3
      ? singleLine(record.plan)
      : optionalString(record.plan)) &&
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
      (record.finalization !== undefined || record.integration !== undefined) &&
      (record.launchingAt !== undefined || record.activeRunId !== undefined)
    ) &&
    !(record.finalization !== undefined && record.integration !== undefined) &&
    (record.reviewedTaskSha === undefined ||
      (typeof record.reviewedTaskSha === "string" &&
        SHA.test(record.reviewedTaskSha))) &&
    (record.finalization === undefined || isFinalization(record.finalization)) &&
    (record.retry === undefined || isRetry(record.retry)) &&
    (record.integration === undefined || isIntegration(record.integration))
  );
}

/** Persistent builder worktrees and local-branch finalization. */
export class TicketWorktrees {
  readonly repoRoot: string;
  readonly gitCommonDir?: string;
  private readonly recordsDir: string;
  private readonly worktreesDir: string;
  private readonly cleanupDir: string;

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
    this.cleanupDir = join(this.repoRoot, ".pi", "board-agent", "cleanup");
    if (
      [
        this.recordsDir,
        this.worktreesDir,
        this.cleanupDir,
        join(this.repoRoot, ".pi", "board-agent", "cleanup-backups"),
      ].some((path) => this.hasSymlink(path))
    )
      throw new Error(
        "Refusing symlinked Board Agent state/worktree directories.",
      );
    mkdirSync(this.recordsDir, { recursive: true });
    mkdirSync(this.worktreesDir, { recursive: true });
    mkdirSync(this.cleanupDir, { recursive: true }); // read-only legacy evidence directory
  }

  /** Presence, not validity: corrupt receipts must also survive the no-ref filter. */
  hasCleanupReceipt(itemId: string): boolean {
    if (this.hasSymlink(this.cleanupDir))
      throw new Error("Symlinked cleanup state.");
    return !!lstatSync(this.receiptPath(itemId), { throwIfNoEntry: false });
  }

  receiptPath(itemId: string): string {
    return join(this.cleanupDir, `${safe(itemId)}.json`);
  }

  private recordPath(itemId: string): string {
    return join(this.recordsDir, `${safe(itemId)}.json`);
  }

  private parse(path: string): TicketExecutionRecord | undefined {
    try {
      if (this.hasSymlink(path) || !lstatSync(path).isFile()) return undefined;
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isTicketExecutionRecord(value) &&
        path === this.recordPath(value.itemId)
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  read(itemId: string): TicketExecutionRecord | undefined {
    const path = this.recordPath(itemId);
    const record = this.parse(path);
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
    // Presence, not validity: even dangling links must block replacement.
    return !!lstatSync(this.recordPath(itemId), { throwIfNoEntry: false });
  }

  /** Full local ref names for a tick's negative filter, never approval evidence. */
  async localTaskRefs(prefix: string): Promise<Set<string>> {
    const output = await mustGitAsync(
      ["for-each-ref", "--format=%(refname)", `refs/heads/${prefix}issue-*`],
      this.repoRoot,
    );
    return new Set(output.split(/\r?\n/).filter(Boolean));
  }

  /** Only a missing local ref means done; Git errors must not look like absence. */
  localBranchSha(branch: string): string | undefined {
    this.validateBranches(branch);
    const ref = `refs/heads/${branch}`;
    const args = ["show-ref", "--verify", "--quiet", ref];
    const result = git(args, this.repoRoot);
    if (!result.ok) {
      if (result.status === 1) return undefined;
      throw processFailure("git", args, result);
    }
    const symbolic = git(["symbolic-ref", "--quiet", ref], this.repoRoot);
    if (symbolic.ok || symbolic.status !== 1)
      throw new Error(`Local ${branch} is symbolic or unreadable.`);
    return mustGit(["rev-parse", "--verify", `${ref}^{commit}`], this.repoRoot);
  }

  private save(record: TicketExecutionRecord, expectedBytes?: Buffer | null, beforePublish?: () => void): void {
    if (!isTicketExecutionRecord(record))
      throw new Error("Invalid ticket execution record.");
    const path = this.recordPath(record.itemId);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (this.hasSymlink(path) || (stat && !stat.isFile()))
      throw new Error("Unsafe ticket execution record path.");
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record, null, 2), {
        encoding: "utf8",
        flag: "wx",
        flush: true,
      });
      if (
        expectedBytes &&
        (this.hasSymlink(path) ||
          !lstatSync(path).isFile() ||
          !readFileSync(path).equals(expectedBytes))
      )
        throw new Error("Ticket record changed at atomic publication boundary.");
      if (expectedBytes === null && this.has(record.itemId))
        throw new Error("Legacy receipt restore raced with another record.");
      beforePublish?.();
      renameSync(temporary, path);
      if (process.platform !== "win32") {
        const fd = openSync(this.recordsDir, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /** Adapter-only publication, not an update() escape hatch. A stopped owner
   * must supply the exact v3 bytes; backups are create-only and never replayed. */
  publishLegacy(record: TicketExecutionRecord, original?: Buffer): void {
    if (record.schemaVersion !== 4 || !isTicketExecutionRecord(record))
      throw new Error("Invalid legacy conversion result.");
    const path = this.recordPath(record.itemId);
    if (original) {
      const previous: unknown = JSON.parse(original.toString("utf8"));
      if (!isTicketExecutionRecord(previous) || previous.schemaVersion !== 3 ||
          !sameIdentity(previous, record) || this.hasSymlink(path) ||
          !lstatSync(path).isFile() || !readFileSync(path).equals(original))
        throw new Error("Legacy source changed before conversion.");
      const backup = `${path}.v3.bak`;
      if (!lstatSync(backup, { throwIfNoEntry: false }))
        writeFileSync(backup, original, { flag: "wx", flush: true });
      if (this.hasSymlink(backup) || !lstatSync(backup).isFile() ||
          !readFileSync(backup).equals(original))
        throw new Error("Legacy backup differs from exact original bytes.");
      // Order the backup directory entry before v4 publication, including restart
      // after a writer died between create and directory flush.
      if (process.platform !== "win32") {
        const fd = openSync(this.recordsDir, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } else if (this.has(record.itemId)) {
      throw new Error("Cannot restore a legacy receipt over an existing record.");
    }
    this.save(record, original ?? null, () => {
      if (original) {
        const backup = `${path}.v3.bak`;
        if (this.hasSymlink(backup) || !lstatSync(backup).isFile() || !readFileSync(backup).equals(original))
          throw new Error("Legacy backup changed before v4 publication.");
      }
    });
  }

  hasLegacyBackup(itemId: string): boolean {
    return !!lstatSync(`${this.recordPath(itemId)}.v3.bak`, { throwIfNoEntry: false });
  }

  /** Conversion checks ownership, not cleanliness or the continued existence of
   * already removed refs/paths. No inventory-wide failure for unrelated tickets. */
  checkOwnership(record: TicketExecutionRecord, entries = this.worktreeEntries()): { registered: boolean } {
    this.assertOwnedPath(record);
    this.validateBranches(record.baseBranch, record.taskBranch);
    if (record.baseBranch.toLowerCase() === record.taskBranch.toLowerCase()) throw new Error("Task is the base branch.");
    for (const entry of entries) {
      if ((entry.branch === record.taskBranch && !samePath(entry.path, record.path)) ||
          (samePath(entry.path, record.path) && (entry.locked || entry.branch !== record.taskBranch)))
        throw new Error("Worktree ownership changed or locked.");
    }
    return { registered: entries.some((entry) => samePath(entry.path, record.path)) };
  }

  update(
    itemId: string,
    mutate: (record: TicketExecutionRecord) => TicketExecutionRecord,
  ): TicketExecutionRecord {
    if (this.hasCleanupReceipt(itemId) && !this.read(itemId)?.integration)
      throw new Error(
        "Ticket has a pending cleanup receipt; recover finalization first.",
      );
    const current = this.read(itemId);
    if (!current)
      throw new Error(
        `Ticket execution record is missing or unsupported: ${itemId}`,
      );
    const next = mutate(structuredClone(current));
    if (
      !sameIdentity(current, next) ||
      next.schemaVersion !== current.schemaVersion
    )
      throw new Error(`Invalid ticket execution update for ${itemId}`);
    if (
      (next.finalization || next.integration) &&
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
    const integration = current.integration;
    if (integration && current.retry?.stage === "cleanup" && next.retry?.stage !== "cleanup")
      throw new Error("Cannot discard cleanup-only integration state; delete the record after Project Done.");
    if (
      integration &&
      (!next.integration ||
        next.integration.baseSha !== integration.baseSha ||
        next.integration.taskSha !== integration.taskSha ||
        next.integration.resultSha !== integration.resultSha ||
        next.reviewedTaskSha !== current.reviewedTaskSha)
    )
      throw new Error("Cannot replace a pending integration result.");
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

  /** Release run occupancy without acknowledging retry settlement or integration. */
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
    if (
      record.finalization ||
      record.integration ||
      this.hasCleanupReceipt(record.itemId)
    )
      throw new Error(
        "Ticket has a pending finalization; recover it before starting another builder or review.",
      );
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

  pathFor(itemId: string, issueNumber: number): string {
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

  async hasTaskDelta(record: TicketExecutionRecord): Promise<boolean> {
    const fetched = await this.fetch(record.baseBranch, record.path);
    if (!fetched.ok) throw processFailure("git", ["fetch"], fetched);
    return this.hasLocalTaskDelta(record);
  }

  /** Revalidate after a card await without fetching (and yielding) again. */
  hasLocalTaskDelta(record: TicketExecutionRecord): boolean {
    return (
      Number(
        mustGit(
          [
            "rev-list",
            "--count",
            `origin/${record.baseBranch}..${record.taskBranch}`,
          ],
          record.path,
        ),
      ) > 0
    );
  }

  /** Create or resume the one persistent worktree owned by an Issue. */
  async ensure(
    task: BuilderTask,
    plan?: string,
  ): Promise<TicketExecutionRecord> {
    if (this.hasCleanupReceipt(task.itemId))
      throw new Error(
        "Ticket has a pending cleanup receipt; recover finalization first.",
      );
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

    const path = this.pathFor(task.itemId, task.issueNumber);
    const record: TicketExecutionRecord = {
      schemaVersion: 4,
      itemId: task.itemId,
      issueNumber: task.issueNumber,
      taskKey: task.taskKey,
      ...(plan === undefined ? {} : { plan }),
      taskBranch: task.taskBranch,
      baseBranch: task.baseBranch,
      path,
      createdAt: Date.now(),
    };
    if (!isTicketExecutionRecord(record))
      throw new Error("Invalid ticket execution record.");

    const branchOwner = this.list().find(
      (record) => record.taskBranch === task.taskBranch,
    );
    if (branchOwner)
      throw new Error(
        `${task.taskBranch} is already owned by ticket ${branchOwner.itemId}`,
      );

    this.validateBranches(task.baseBranch, task.taskBranch);
    if (task.baseBranch.toLowerCase() === task.taskBranch.toLowerCase())
      throw new Error("Task branch must differ from the base branch.");
    await this.fetchRequired(task.baseBranch);
    if (this.registeredPathForBranch(task.taskBranch))
      throw new Error(
        `${task.taskBranch} is already checked out without a ticket record.`,
      );
    if (
      branchSha(task.taskBranch, this.repoRoot) ||
      (await this.remoteSha(task.taskBranch))
    )
      throw new Error(
        `${task.taskBranch} already exists without a ticket record.`,
      );

    if (!this.isManagedPath(path))
      throw new Error(`Refusing unmanaged worktree path: ${path}`);
    if (existsSync(path))
      throw new Error(`Worktree path exists but is not registered: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    await mustGitAsync(
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

    this.save(record);
    return record;
  }

  /** Prepare/push a merge, then clean Git only. The record survives until the
   * caller has freshly observed Project Done (completeFinalization). */
  async finalizeAccepted(
    task: BuilderTask,
    _obsoleteStrategy: Config["task_merge_strategy"],
    assertCurrent: () => Promise<void> = async () => {},
    legacyResidual?: {
      paths(record: TicketExecutionRecord): Promise<Set<string>>;
      remove(record: TicketExecutionRecord, guard: () => Promise<void>): Promise<void>;
    },
  ): Promise<string | undefined> {
    const progress = this.read(task.itemId);
    if (progress?.retry && !["integrate", "cleanup"].includes(progress.retry.stage))
      throw new Error("Pending ticket progress requires build/review settlement.");
    if (progress && (progress.schemaVersion !== 4 || progress.finalization))
      throw new Error("Legacy finalization requires stopped-owner conversion.");
    if (this.hasCleanupReceipt(task.itemId) && !progress?.integration)
      throw new Error("Legacy cleanup receipt requires conversion.");
    let record = this.finalizationRecord(task);
    if (!record) return undefined;
    const originalTaskSha = record.integration ? undefined : this.localBranchSha(task.taskBranch);
    if (!record.integration && !originalTaskSha) throw new Error("Original task ref is missing before integration.");
    const guard = async () => {
      await assertCurrent();
      if (JSON.stringify(this.read(task.itemId)) !== JSON.stringify(record))
        throw new Error("Ticket execution changed during finalization.");
    };
    const observe = async () => {
      await this.fetchRequired(task.baseBranch);
      await guard();
      return this.fetchedSha(task.baseBranch);
    };
    let baseSha = await observe();
    const prepare = async (taskSha: string) => {
      await this.checkFinalizationWorktree(record!, taskSha, false);
      const remote = await this.remoteSha(task.taskBranch);
      if (remote && remote !== taskSha)
        throw new Error(`Remote ${task.taskBranch} moved or has unmerged work; integration refused.`);
      if (record!.reviewedTaskSha && record!.reviewedTaskSha !== taskSha)
        throw new Error("Task branch differs from the reviewed SHA.");
      let resultSha = baseSha;
      if (!this.isAncestor(taskSha, baseSha)) {
        const tree = await this.resultTree({ baseSha, taskSha });
        await guard();
        resultSha = await mustGitAsync(
          ["commit-tree", tree, "-p", baseSha, "-p", taskSha], this.repoRoot,
          `chore(board): merge ${task.taskKey} after validation\n\n${task.title.replace(/[\r\n]+/g, " ")}\n\nRefs #${task.issueNumber}\nBoard-Agent-Item: ${task.itemId}\n`,
        );
        if (!SHA.test(resultSha)) throw new Error("git commit-tree returned no result commit.");
      }
      await guard();
      await this.checkFinalizationWorktree(record!, taskSha, false);
      // Dedicated checked publication, never the general update() exemption.
      record = this.saveFinalization(record!, { baseSha, taskSha, resultSha }, "integrate");
    };
    if (!record.integration) {
      if (record.retry?.stage === "cleanup") throw new Error("Cleanup result is missing; preserve evidence.");
      await prepare(originalTaskSha!);
    }
    let integration = record.integration!;
    if (!this.isAncestor(integration.resultSha, baseSha)) {
      if (record.retry?.stage === "cleanup")
        throw new Error(`Pushed result ${integration.resultSha} is not on origin/${task.baseBranch}; cleanup only.`);
      await this.checkFinalizationWorktree(record, integration.taskSha, false);
      await guard();
      const args = ["push", "origin", `${integration.resultSha}:refs/heads/${task.baseBranch}`];
      // Even a thrown/lost response must observe origin before deciding anything.
      let pushed: ProcessResult | undefined, pushError: unknown;
      try { pushed = await gitAsync(args, this.repoRoot); }
      catch (error) { pushError = error; }
      baseSha = await observe();
      if (!this.isAncestor(integration.resultSha, baseSha)) {
        const failure = pushError ?? (pushed?.ok
          ? new Error(`Pushed result ${integration.resultSha} is not on origin/${task.baseBranch}.`)
          : processFailure("git", args, pushed!));
        // A normal non-FF rejection, not an ambiguous transport failure, permits
        // a new integration against an advancing base. One attempt per tick.
        if (pushed && !pushed.ok && !pushed.timedOut && pushed.status === 1 &&
            /\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(pushed.stderr) &&
            baseSha !== integration.baseSha && this.isAncestor(integration.baseSha, baseSha)) {
          try { await prepare(integration.taskSha); }
          catch (error) {
            if (error instanceof MergeConflictError) {
              await guard();
              record = this.saveFinalization(record, undefined, "integrate");
            }
            throw error;
          }
        }
        throw failure;
      }
    }
    integration = record.integration!;
    await guard();
    record = this.saveFinalization(record, integration, "cleanup");
    const legacyPaths = legacyResidual && this.hasCleanupReceipt(task.itemId) && !this.entryForPath(record.path)
      ? await legacyResidual.paths(record) : new Set<string>();
    const cleanupGuard = async () => {
      // Every destructive step observes remote ancestry, ownership and approval.
      const base = await observe();
      if (!this.isAncestor(integration.resultSha, base))
        throw new Error(`Pushed result ${integration.resultSha} is not on origin/${task.baseBranch}.`);
      await this.checkFinalizationWorktree(record!, integration.taskSha, true, legacyPaths);
      await guard();
    };
    const remote = await this.remoteSha(task.taskBranch);
    if (remote) {
      if (remote !== integration.taskSha) throw new Error(`Remote ${task.taskBranch} moved; cleanup refused.`);
      await cleanupGuard();
      await mustGitAsync(["push", "origin", `--force-with-lease=refs/heads/${task.taskBranch}:${integration.taskSha}`,
        `:refs/heads/${task.taskBranch}`], this.repoRoot);
    }
    await cleanupGuard();
    if (this.entryForPath(record.path)) {
      if (lstatSync(record.path, { throwIfNoEntry: false }) && !this.localBranchSha(task.taskBranch)) {
        // Old cleanup sometimes deleted the ref first. Native remove interprets
        // an unborn HEAD as staged additions: restore ONLY the verified SHA,
        // create-only, then use the ordinary removal and final expected delete.
        await mustGitAsync(["update-ref", "--no-deref", `refs/heads/${task.taskBranch}`, integration.taskSha, "0".repeat(40)], this.repoRoot);
        await cleanupGuard();
      }
      await mustGitAsync(["worktree", "remove", record.path], this.repoRoot);
    } else if (lstatSync(record.path, { throwIfNoEntry: false }) || legacyPaths.size) {
      if (!legacyResidual) throw new Error("Unregistered worktree residual has no legacy ownership evidence; preserved.");
      // Per-entry legacy deletion rechecks refs/approval, not the full snapshot.
      await legacyResidual.remove(record, async () => {
        const base = await observe();
        if (!this.isAncestor(integration.resultSha, base)) throw new Error("Legacy result no longer on origin/base.");
        await this.checkFinalizationWorktree(record!, integration.taskSha, true, legacyPaths);
      });
    }
    if (this.entryForPath(record.path) || lstatSync(record.path, { throwIfNoEntry: false }))
      throw new Error("Worktree path/registration remains after native removal.");
    if (await this.remoteSha(task.taskBranch)) throw new Error("Remote task branch reappeared; cleanup refused.");
    await cleanupGuard();
    if (this.localBranchSha(task.taskBranch))
      await mustGitAsync(["update-ref", "--no-deref", "-d", `refs/heads/${task.taskBranch}`, integration.taskSha], this.repoRoot);
    return integration.resultSha;
  }

  /** Project Done has been observed. Still validate all Git absence/ancestry
   * before the final record deletion; missing refs/path are normal retry input. */
  async completeFinalization(task: BuilderTask, assertCurrent: () => Promise<void>): Promise<void> {
    const record = this.finalizationRecord(task);
    if (!record?.integration || record.retry?.stage !== "cleanup") throw new Error("Missing cleanup acknowledgement evidence.");
    await this.fetchRequired(record.baseBranch);
    if (!this.isAncestor(record.integration.resultSha, this.fetchedSha(record.baseBranch)))
      throw new Error("Integration no longer on remote base; retain ticket record.");
    if (await this.remoteSha(record.taskBranch)) throw new Error("Remote task branch remains.");
    await assertCurrent();
    if (JSON.stringify(this.finalizationRecord(task)) !== JSON.stringify(record) ||
        this.localBranchSha(record.taskBranch) || this.entryForPath(record.path) ||
        lstatSync(record.path, { throwIfNoEntry: false })) throw new Error("Cleanup evidence changed before acknowledgement.");
    await unlink(this.recordPath(task.itemId));
  }

  private saveFinalization(record: TicketExecutionRecord, integration: TicketIntegrationState | undefined,
    stage: "integrate" | "cleanup"): TicketExecutionRecord {
    const bytes = readFileSync(this.recordPath(record.itemId));
    if (JSON.stringify(this.read(record.itemId)) !== JSON.stringify(record)) throw new Error("Finalization record changed before publication.");
    const next = { ...record, integration, retry: { stage, reason: stage === "cleanup"
      ? "Integration observed on origin/base; cleanup only."
      : "Prepared integration is not push success; observe origin/base before retry." } };
    this.save(next, bytes);
    return next;
  }

  /** Adapter-only removal of a verified old pre-push intent. The original v3
   * backup is already durable; no second archive or hot receipt hash protocol. */
  clearLegacyIntent(record: TicketExecutionRecord): void {
    if (record.schemaVersion !== 4 || !record.finalization || record.finalization.resultSha ||
        record.integration || !this.hasLegacyBackup(record.itemId)) throw new Error("Not a converted pre-push legacy intent.");
    const bytes = readFileSync(this.recordPath(record.itemId));
    if (JSON.stringify(this.read(record.itemId)) !== JSON.stringify(record)) throw new Error("Legacy intent changed.");
    const next = { ...record, finalization: undefined,
      retry: { stage: "integrate" as const, reason: "Verified legacy pre-push intent; integrate the original task." } };
    this.save(next, bytes);
  }

  private async resultTree(state: Pick<TicketIntegrationState, "baseSha" | "taskSha">): Promise<string> {
    const args = ["merge-tree", "--write-tree", state.baseSha, state.taskSha];
    const result = await gitAsync(args, this.repoRoot);
    const failure = processFailure("git", args, result);
    if (result.timedOut || result.status !== (result.ok ? 0 : 1)) throw failure;
    const [tree, ...lines] = result.stdout.split(/\r?\n/);
    if (!SHA.test(tree)) throw failure;
    if (result.ok) {
      if (!/^[0-9a-f]{40}(?:\r?\n)?$/i.test(result.stdout))
        throw new Error("git merge-tree returned a malformed result tree.");
    } else {
      const separator = lines.indexOf("");
      // Exit 1 alone is not enough: require merge-tree's stage/message format.
      // Stderr makes the result ambiguous (e.g. an object/permission failure).
      if (
        result.stderr.trim() ||
        result.stdout.includes("\0") ||
        separator < 0 ||
        !lines
          .slice(0, separator)
          .every((line) => /^[0-7]{6} [0-9a-f]{40} [123]\t.+$/i.test(line)) ||
        !/^CONFLICT \([^\r\n]+\): [^\r\n]+/m.test(
          lines.slice(separator + 1).join("\n"),
        )
      )
        throw failure;
    }
    // A commit-ish (or merely well-shaped hex) is not proof of a written tree.
    if (
      (await mustGitAsync(["cat-file", "-t", tree], this.repoRoot)) !== "tree"
    )
      throw new Error("git merge-tree returned a non-tree object.");
    if (!result.ok)
      throw new MergeConflictError(
        state.baseSha,
        state.taskSha,
        failure.message,
      );
    return tree;
  }

  private finalizationRecord(task: BuilderTask): TicketExecutionRecord | undefined {
    this.validateBranches(task.baseBranch, task.taskBranch);
    if (task.baseBranch.toLowerCase() === task.taskBranch.toLowerCase()) throw new Error("Task branch must differ from the base branch.");
    const record = this.read(task.itemId);
    if (!record) {
      if (this.has(task.itemId)) throw new Error("Corrupt or unsupported ticket execution record.");
      if (this.hasCleanupReceipt(task.itemId)) throw new Error("Legacy cleanup receipt requires conversion.");
      if (this.localBranchSha(task.taskBranch) || this.entryForPath(this.pathFor(task.itemId, task.issueNumber)) ||
          lstatSync(this.pathFor(task.itemId, task.issueNumber), { throwIfNoEntry: false }))
        throw new Error("Unknown/unrecorded task work; ownership cannot be inferred from a branch.");
      return undefined;
    }
    if (record.issueNumber !== task.issueNumber || record.taskBranch !== task.taskBranch || record.baseBranch !== task.baseBranch)
      throw new Error("Ticket cleanup record identity changed.");
    if (record.activeRunId || record.launchingAt !== undefined) throw new Error("Builder execution is still active.");
    this.checkOwnership(record);
    return record;
  }

  private async checkFinalizationWorktree(record: TicketExecutionRecord, taskSha: string, cleanup: boolean, legacyPaths = new Set<string>()): Promise<void> {
    const entries = this.worktreeEntries();
    this.checkOwnership(record, entries);
    const local = this.localBranchSha(record.taskBranch);
    if (local ? local !== taskSha : !cleanup) throw new Error(`Local ${record.taskBranch} moved or is missing; cleanup refused.`);
    if (!this.gitCommonDir || this.hasSymlink(this.gitCommonDir)) throw new Error("Unsafe Git common directory.");
    const entry = entries.find((e) => samePath(e.path, record.path));
    const pathStat = lstatSync(record.path, { throwIfNoEntry: false });
    if (pathStat && (!pathStat.isDirectory() || pathStat.isSymbolicLink())) throw new Error("Unsafe worktree directory.");
    const ref = join(this.gitCommonDir, "refs", "heads", record.taskBranch);
    if (this.hasSymlink(ref)) throw new Error("Symlinked Git ref ownership.");
    if (lstatSync(`${ref}.lock`, { throwIfNoEntry: false })) throw new Error("Locked Git ref.");
    await this.checkGitLocks(this.gitCommonDir);
    // Inspect administrative ownership, including broken/prunable registrations.
    // Never let fetch maintenance or an unrelated native remove prune them.
    const adminRoot = join(this.gitCommonDir, "worktrees");
    if (lstatSync(adminRoot, { throwIfNoEntry: false })) {
      if (this.hasSymlink(adminRoot)) throw new Error("Unsafe Git administration.");
      for (const name of await readdir(adminRoot)) {
        const admin = join(adminRoot, name);
        if (this.hasSymlink(admin) || !lstatSync(admin).isDirectory()) throw new Error("Unsafe Git registration.");
        const pointer = join(admin, "gitdir");
        if (!lstatSync(pointer, { throwIfNoEntry: false })) {
          if (legacyPaths.has(resolve(admin))) { await this.checkGitLocks(admin); continue; }
          throw new Error("Ambiguous Git registration.");
        }
        if (this.hasSymlink(pointer) || !lstatSync(pointer).isFile()) throw new Error("Unsafe Git registration pointer.");
        if (samePath(readFileSync(pointer, "utf8").trim(), join(record.path, ".git"))) {
          await this.checkGitLocks(admin);
          if (!entry && !legacyPaths.has(resolve(admin))) throw new Error("Unregistered Git administration; legacy evidence required.");
        }
      }
    }
    if (!entry || !pathStat) {
      if (!cleanup) throw new Error("Missing or unregistered worktree before integration.");
      return; // absent paths are resumable; unregistered survivors need the adapter
    }
    const dotgit = join(record.path, ".git");
    if (this.hasSymlink(dotgit) || !lstatSync(dotgit, { throwIfNoEntry: false })?.isFile()) throw new Error("Worktree Git identity changed.");
    const pointer = readFileSync(dotgit, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) throw new Error("Invalid worktree Git pointer.");
    const admin = resolve(record.path, pointer.slice(8));
    if (!samePath(dirname(admin), join(this.gitCommonDir, "worktrees")) || this.hasSymlink(admin))
      throw new Error("Other Git ownership in task worktree.");
    for (const name of ["gitdir", "commondir", "HEAD", "index"])
      if (this.hasSymlink(join(admin, name))) throw new Error("Symlinked Git administration.");
    if (!samePath(readFileSync(join(admin, "gitdir"), "utf8").trim(), dotgit) ||
        !samePath(resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim()), this.gitCommonDir))
      throw new Error("Worktree Git backlink/common identity changed.");
    const identity = mustGit(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], record.path).split(/\r?\n/);
    if (!samePath(identity[0], record.path) || !identity[1] || !samePath(identity[1], this.gitCommonDir) ||
        mustGit(["symbolic-ref", "--quiet", "HEAD"], record.path) !== `refs/heads/${record.taskBranch}`)
      throw new Error("Worktree repository/branch identity changed.");
    // Explicit tree comparison also works after an old cleanup removed the ref.
    const diff = git(["diff", "--quiet", taskSha, "--"], record.path);
    const staged = git(["diff", "--cached", "--quiet", taskSha, "--"], record.path);
    for (const result of [diff, staged]) {
      if (!result.ok) {
        if (result.status === 1 && !result.timedOut) throw new Error(`Dirty worktree: ${record.path}`);
        throw new Error(`Cannot read worktree status: ${result.stderr}`);
      }
    }
    if (mustGit(["ls-files", "--others", "--exclude-standard"], record.path)) throw new Error(`Dirty worktree: ${record.path}`);
    await this.checkNestedGit(record.path);
  }

  private async checkGitLocks(path: string): Promise<void> {
    for (const name of await readdir(path))
      if (name.endsWith(".lock") || name === "locked" || ["MERGE_HEAD", "rebase-merge", "rebase-apply"].includes(name))
        throw new Error(`Locked or active Git operation: ${join(path, name)}`);
  }

  /** Metadata only, no content hashes, receipts or copies. Native removal may
   * discard ignored files, but never a nested repository or an external target. */
  private async checkNestedGit(path: string, root = true): Promise<void> {
    const names = await readdir(path);
    if ((!root && names.some((n) => n.toLowerCase() === ".git")) ||
        ["HEAD", "objects", "refs"].every((n) => names.includes(n))) throw new Error(`Nested Git identity: ${path}`);
    for (const name of names) {
      if (root && name === ".git") continue;
      const child = join(path, name), stat = await lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await this.checkNestedGit(child, false);
    }
  }

  private validateBranches(...branches: string[]): void {
    for (const branch of branches) {
      if (!singleLine(branch) || branch.startsWith("-"))
        throw new Error(`Invalid branch: ${branch}`);
      mustGit(["check-ref-format", `refs/heads/${branch}`], this.repoRoot);
    }
  }

  private fetch(branch: string, cwd = this.repoRoot): Promise<ProcessResult> {
    this.validateBranches(branch);
    return gitAsync(
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      cwd,
    );
  }

  private async fetchRequired(...branches: string[]): Promise<void> {
    await mustGitAsync(
      [
        "fetch",
        // Auto-maintenance can silently prune broken worktree administration.
        "--no-auto-maintenance",
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

  async remoteSha(branch: string): Promise<string | undefined> {
    this.validateBranches(branch);
    const result = await gitAsync(
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      this.repoRoot,
    );
    if (!result.ok) {
      if (result.status === 2 && !result.timedOut) return undefined;
      throw processFailure("git", ["ls-remote"], result);
    }
    const match = /^([0-9a-f]{40})\s+([^\s]+)$/i.exec(result.stdout.trim());
    if (!match || match[2] !== `refs/heads/${branch}`) throw new Error("Malformed remote ref response.");
    return match[1];
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    const args = ["merge-base", "--is-ancestor", ancestor, descendant];
    const result = git(args, this.repoRoot);
    if (!result.ok && (result.status !== 1 || result.timedOut)) throw processFailure("git", args, result);
    return result.ok;
  }
}
