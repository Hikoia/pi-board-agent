import { randomUUID } from "node:crypto";
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
import { lstat, readdir } from "node:fs/promises";
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
  /** Also retained while failure comment/status/release writeback is unsettled. */
  reason: string;
}

export interface TicketIntegrationState {
  baseSha: string;
  taskSha: string;
  /** Exact second source; absent on older v4 records means taskSha. */
  remoteTaskSha?: string | null;
  /** Prepared result, NOT proof that a push was accepted. */
  resultSha: string;
}

/** The version-specific field sets are enforced on both reads and writes. */
export interface TicketExecutionRecord {
  schemaVersion: 3 | 4;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  /** Required only for v3. */
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
  /** v3 only; compatibility execution is unchanged until conversion. */
  finalization?: TicketFinalizationState;
  /** v4 only. Clearing execution must not discard pending settlement/progress. */
  retry?: TicketRetryState;
  integration?: TicketIntegrationState;
}

export type TicketExecutionRecordV4 = Omit<
  TicketExecutionRecord,
  "schemaVersion" | "finalization"
> & { schemaVersion: 4 };

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
    readonly repairable = true,
  ) {
    super(diagnostic);
    this.name = "MergeConflictError";
  }
}

export class TicketStateChangedError extends Error {}

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
]);
const RETRY_FIELDS = new Set(["stage", "reason"]);
const INTEGRATION_FIELDS = new Set(["baseSha", "taskSha", "remoteTaskSha", "resultSha"]);
const FINALIZATION_FIELDS = new Set([
  "targetBranch",
  "baseSha",
  "taskSha",
  "resultSha",
]);

export function git(args: string[], cwd: string, input?: string): ProcessResult {
  return runProcessSync("git", args, {
    cwd,
    input,
    timeoutMs: GIT_GH_TIMEOUT_MS,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

export function mustGit(args: string[], cwd: string, input?: string): string {
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

export function samePath(a: string, b: string): boolean {
  const normalize = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}

export function singleLine(value: unknown): value is string {
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const retry = value as Record<string, unknown>;
  return (
    Object.keys(retry).every((key) => RETRY_FIELDS.has(key)) &&
    typeof retry.stage === "string" &&
    ["build", "review", "integrate", "cleanup"].includes(retry.stage) &&
    typeof retry.reason === "string" &&
    retry.reason.trim().length > 0
  );
}

function isIntegration(value: unknown): value is TicketIntegrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).every((key) => INTEGRATION_FIELDS.has(key)) &&
    (state.remoteTaskSha === undefined || state.remoteTaskSha === null ||
      (typeof state.remoteTaskSha === "string" && SHA.test(state.remoteTaskSha))) &&
    [state.baseSha, state.taskSha, state.resultSha].every(
      (sha) => typeof sha === "string" && SHA.test(sha),
    )
  );
}

export function isTicketExecutionRecord(
  value: unknown,
): value is TicketExecutionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.schemaVersion === 3 || record.schemaVersion === 4) &&
    Object.keys(record).every(
      (key) =>
        RECORD_FIELDS.has(key) ||
        (record.schemaVersion === 3
          ? key === "finalization"
          : key === "retry" || key === "integration"),
    ) &&
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
  readonly recordsDir: string;
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
      ].some((path) => this.hasSymlink(path))
    )
      throw new Error(
        "Refusing symlinked Board Agent state/worktree directories.",
      );
    mkdirSync(this.recordsDir, { recursive: true });
    mkdirSync(this.worktreesDir, { recursive: true });
    mkdirSync(this.cleanupDir, { recursive: true });
  }

  /** Presence, not validity: corrupt receipts must also survive the no-ref filter. */
  hasCleanupReceipt(itemId: string): boolean {
    if (this.hasSymlink(this.cleanupDir))
      throw new Error("Symlinked cleanup state.");
    return !!lstatSync(this.receiptPath(itemId), { throwIfNoEntry: false });
  }

  hasCleanupReceipts(): boolean {
    if (this.hasSymlink(this.cleanupDir)) throw new Error("Symlinked cleanup state.");
    return readdirSync(this.cleanupDir).some((name) => name.endsWith(".json"));
  }

  private receiptPath(itemId: string): string {
    return join(this.cleanupDir, `${safe(itemId)}.json`);
  }

  recordPath(itemId: string): string {
    return join(this.recordsDir, `${safe(itemId)}.json`);
  }

  private load(path: string):
    | { record: TicketExecutionRecord; bytes: Buffer }
    | undefined {
    try {
      if (this.hasSymlink(path) || !lstatSync(path).isFile()) return undefined;
      const bytes = readFileSync(path);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      return isTicketExecutionRecord(value)
        ? { record: value, bytes }
        : undefined;
    } catch {
      return undefined;
    }
  }

  read(itemId: string): TicketExecutionRecord | undefined {
    const record = this.load(this.recordPath(itemId))?.record;
    return record?.itemId === itemId ? record : undefined;
  }

  list(): TicketExecutionRecord[] {
    if (!existsSync(this.recordsDir)) return [];
    return readdirSync(this.recordsDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const record = this.load(join(this.recordsDir, name))?.record;
        return record && name === `${safe(record.itemId)}.json` ? [record] : [];
      });
  }

  has(itemId: string): boolean {
    return !!lstatSync(this.recordPath(itemId), { throwIfNoEntry: false });
  }

  /** Publish a new v4 record only. Existing v3 files are never converted here. */
  create(record: TicketExecutionRecordV4): TicketExecutionRecordV4 {
    if (!isTicketExecutionRecord(record) || record.schemaVersion !== 4)
      throw new Error("Invalid v4 ticket execution record.");
    if (this.hasCleanupReceipt(record.itemId))
      throw new Error("Ticket has a pending cleanup receipt.");
    this.save(record);
    return record;
  }

  /** Idle historical records are retained; unreadable recovery is never absence. */
  hasPendingRecovery(itemId: string): boolean {
    if (this.hasCleanupReceipt(itemId)) return true;
    if (!this.has(itemId)) return false;
    const record = this.read(itemId);
    if (!record) throw new Error("Corrupt or unsupported ticket execution record.");
    return !!(record.activeRunId || record.launchingAt !== undefined ||
      record.finalization || record.integration || record.retry);
  }

  /** Full local ref names for diagnostics, never approval evidence. */
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
    const symbolic = git(["symbolic-ref", "--quiet", ref], this.repoRoot);
    if (symbolic.ok || symbolic.status !== 1 || symbolic.timedOut)
      throw new Error(`Local ${branch} is symbolic or unreadable.`);
    const args = ["show-ref", "--verify", "--quiet", ref];
    const result = git(args, this.repoRoot);
    if (!result.ok) {
      if (result.status === 1 && !result.timedOut) return undefined;
      throw processFailure("git", args, result);
    }
    return mustGit(["rev-parse", "--verify", `${ref}^{commit}`], this.repoRoot);
  }

  private save(
    record: TicketExecutionRecord,
    expectedBytes?: Buffer,
    beforePublish?: () => void,
  ): void {
    if (!isTicketExecutionRecord(record))
      throw new Error("Invalid ticket execution record.");
    const path = this.recordPath(record.itemId);
    const bytes = JSON.stringify(record, null, 2);
    try {
      if (!isTicketExecutionRecord(JSON.parse(bytes)))
        throw new Error("Invalid serialized ticket execution record.");
    } catch (cause) {
      throw new Error("Invalid serialized ticket execution record.", { cause });
    }
    const assertCurrent = () => {
      if (this.hasSymlink(path)) throw new Error("Symlinked ticket state.");
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (
        expectedBytes
          ? !stat?.isFile() || !readFileSync(path).equals(expectedBytes)
          : !!stat
      )
        throw new Error(
          "Ticket record changed or already exists at atomic write boundary.",
        );
    };
    assertCurrent();
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let ownsTemporary = false;
    try {
      const fd = openSync(temporary, "wx");
      ownsTemporary = true;
      try {
        writeFileSync(fd, bytes, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      beforePublish?.();
      assertCurrent();
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
      if (ownsTemporary && existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /** The owner-held legacy adapter has archived the exact source. No ordinary
   * v3 update may change schema or bypass a receipt. A missing source is permitted
   * only for receipt-only recovery, including a v4 draft for a recordless receipt. */
  publishLegacy(
    original: TicketExecutionRecord,
    next: TicketExecutionRecordV4,
    expectedBytes: Buffer | undefined,
    assertSource: () => void,
  ): void {
    const receiptOnly = expectedBytes === undefined && original.schemaVersion === 4 && this.hasCleanupReceipt(original.itemId);
    if ((!receiptOnly && original.schemaVersion !== 3) || next.schemaVersion !== 4 ||
        !isTicketExecutionRecord(original) || !sameIdentity(original, next))
      throw new Error("Invalid legacy ticket conversion.");
    assertSource();
    this.save(next, expectedBytes, assertSource);
  }

  update(
    itemId: string,
    mutate: (record: TicketExecutionRecord) => TicketExecutionRecord,
  ): TicketExecutionRecord {
    const loaded = this.load(this.recordPath(itemId));
    if (!loaded || loaded.record.itemId !== itemId)
      throw new Error(
        `Ticket execution record is missing or unsupported: ${itemId}`,
      );
    const current = loaded.record;
    if (current.schemaVersion === 3 && this.hasCleanupReceipt(itemId))
      throw new Error("Ticket has a pending cleanup receipt; recover finalization first.");
    const next = mutate(structuredClone(current));
    if (
      !isTicketExecutionRecord(next) ||
      !sameIdentity(current, next) ||
      next.schemaVersion !== current.schemaVersion
    )
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
    const integration = current.integration;
    if (
      integration &&
      (!next.integration ||
        next.integration.baseSha !== integration.baseSha ||
        next.integration.taskSha !== integration.taskSha ||
        next.integration.remoteTaskSha !== integration.remoteTaskSha ||
        next.integration.resultSha !== integration.resultSha ||
        next.reviewedTaskSha !== current.reviewedTaskSha)
    )
      throw new Error("Cannot replace pending integration progress.");
    this.save(next, loaded.bytes);
    return next;
  }

  beginLaunch(itemId: string, launchingAt = Date.now()): TicketExecutionRecord {
    return this.update(itemId, (record) => {
      this.assertNoFinalization(record);
      if (record.retry && record.retry.stage !== "build")
        throw new Error(
          `Pending ${record.retry.stage} retry cannot start a builder.`,
        );
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

  /** Call only after drain/release. Retry writeback and integration survive. */
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

  assertOwnedPath(record: TicketExecutionRecord): void {
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

  worktreeEntries(): Array<{
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
    if (requireClean) {
      const merge = git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], record.path);
      if (merge.ok || merge.status !== 1)
        return { ok: false, clean: false, reason: "unfinished or unreadable MERGE_HEAD" };
    }
    return { ok: true, clean };
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

    const path = this.pathFor(task.itemId, task.issueNumber);
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

    const record: TicketExecutionRecord = {
      schemaVersion: 4,
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

  /** Keep the prepared result through every I/O failure. Its presence is never
   * push evidence. Human closure approves both sources without a review marker.
   * The caller confirms Backlog and deletes the record last. */
  async finalizeAccepted(
    task: BuilderTask,
    _strategy: "merge" | "squash", // legacy config is merge-only here
    assertCurrent: () => Promise<void> = async () => {},
    legacyResidual?: (record: TicketExecutionRecord, remove: boolean, guard: () => Promise<void>) => Promise<void>,
    _legacyApproval?: (record: TicketExecutionRecord) => string | undefined,
  ): Promise<string | undefined> {
    this.validateBranches(task.baseBranch, task.taskBranch);
    if (task.baseBranch === task.taskBranch) throw new Error("Task branch must differ from the base branch.");
    let record = this.cleanupRecord(task, false);
    let local = this.localBranchSha(task.taskBranch);
    const remote = await this.remoteSha(task.taskBranch);
    await assertCurrent();
    if (!local && !remote && !record?.integration) {
      if (this.hasPendingRecovery(task.itemId)) throw new Error("Pending recovery has no task refs; work retained.");
      return undefined; // Historical completion must not touch leftover paths or idle records.
    }
    record = this.cleanupRecord(task);
    if (!record?.integration) {
      await this.fetchRequired(task.baseBranch, ...(remote ? [task.taskBranch] : []));
      await assertCurrent();
      if (this.localBranchSha(task.taskBranch) !== local ||
          (remote && this.fetchedSha(task.taskBranch) !== remote) ||
          await this.remoteSha(task.taskBranch) !== remote)
        throw new Error("Task sources changed during fetch; work retained.");
      if (!local && remote) {
        await assertCurrent();
        await mustGitAsync(["update-ref", "--no-deref", `refs/heads/${task.taskBranch}`, remote, "0".repeat(40)], this.repoRoot);
        local = remote; // Restore only the missing ref, never a builder or worktree.
      }
    }
    if (!record) {
      await assertCurrent();
      record = this.create({ schemaVersion: 4, itemId: task.itemId, issueNumber: task.issueNumber,
        taskKey: task.taskKey, taskBranch: task.taskBranch, baseBranch: task.baseBranch,
        path: this.pathFor(task.itemId, task.issueNumber), createdAt: Date.now() });
    }
    if (record.schemaVersion !== 4) throw new Error("Legacy conversion is required before finalization.");
    if (this.hasCleanupReceipt(task.itemId) && !record.integration)
      throw new Error("Legacy cleanup receipt requires validated conversion before integration.");
    const sourceLocal = record.integration?.taskSha ?? local!;
    const sourceRemote = record.integration
      ? record.integration.remoteTaskSha === undefined ? record.integration.taskSha : record.integration.remoteTaskSha
      : remote ?? null;
    if (record.retry?.stage === "build")
      throw new Error("Build retry must finish before renewed manual close approval.");
    const guard = async () => {
      await assertCurrent();
      this.assertFinalizationRecord(task, record!);
    };
    const observe = async () => {
      await this.fetchRequired(task.baseBranch);
      await guard();
      return this.fetchedSha(task.baseBranch);
    };
    const save = (patch: Partial<TicketExecutionRecord>) => {
      this.assertFinalizationRecord(task, record!);
      record = this.update(task.itemId, (r) => ({ ...r, ...patch }));
    };
    const taskPresent = async () => {
      if (!sourceLocal || this.localBranchSha(task.taskBranch) !== sourceLocal)
        throw new Error("Approved local task tip changed; work retained.");
      if ((await this.remoteSha(task.taskBranch) ?? null) !== sourceRemote)
        throw new Error("Remote task SHA differs from the approved source; work retained.");
      await guard();
      if (this.localBranchSha(task.taskBranch) !== sourceLocal) throw new Error("Approved local task tip changed; work retained.");
      return sourceLocal;
    };
    const prepare = async (baseSha: string, taskSha: string): Promise<TicketIntegrationState> => {
      let sourceSha = taskSha;
      if (sourceRemote && !this.isAncestor(sourceRemote, taskSha)) {
        if (this.isAncestor(taskSha, sourceRemote)) sourceSha = sourceRemote;
        else {
          let tree: string;
          try { tree = await this.resultTree({ baseSha: taskSha, taskSha: sourceRemote }); }
          catch (error) {
            if (error instanceof MergeConflictError)
              throw new MergeConflictError(taskSha, sourceRemote, `Local/remote task sources conflict; resolve manually.\n${error.diagnostic}`, false);
            throw error;
          }
          await guard();
          sourceSha = await mustGitAsync(["commit-tree", tree, "-p", taskSha, "-p", sourceRemote], this.repoRoot,
            `chore(board): combine local/remote ${task.taskBranch}\n`);
          if (!SHA.test(sourceSha)) throw new Error("git commit-tree returned no source commit.");
        }
      }
      let resultSha = baseSha;
      if (!this.isAncestor(taskSha, baseSha) || (sourceRemote && !this.isAncestor(sourceRemote, baseSha))) {
        let tree: string;
        try { tree = await this.resultTree({ baseSha, taskSha: sourceSha }); }
        catch (error) {
          if (error instanceof MergeConflictError)
            throw new MergeConflictError(baseSha, taskSha, error.diagnostic.replaceAll(sourceSha, "<combined-task-tip>"),
              sourceSha === taskSha && sourceRemote === taskSha);
          throw error;
        }
        await guard();
        resultSha = await mustGitAsync(
          ["commit-tree", tree, "-p", baseSha, "-p", sourceSha], this.repoRoot,
          `chore(board): merge ${task.taskKey} after validation\n\n${task.title.replace(/[\r\n]+/g, " ")}\n\nRefs #${task.issueNumber}\nBoard-Agent-Item: ${task.itemId}\n`,
        );
        if (!SHA.test(resultSha)) throw new Error("git commit-tree returned no result commit.");
      }
      if (await taskPresent() !== taskSha) throw new Error("Approved task changed during integration preparation.");
      return { baseSha, taskSha, remoteTaskSha: sourceRemote, resultSha };
    };
    const preparedRetry = { stage: "integrate" as const, reason: "Prepared result; observe origin/base before push or cleanup." };
    let baseSha = await observe();
    if (!record.integration) {
      const taskSha = await taskPresent();
      save({ integration: await prepare(baseSha, taskSha), retry: preparedRetry });
    }
    let integration = record.integration!;
    baseSha = await observe(); // also before retrying a recorded/ambiguous push
    if (!this.isAncestor(integration.resultSha, baseSha)) {
      if (record.retry?.stage === "cleanup" || this.hasCleanupReceipt(task.itemId))
        throw new Error("Previously confirmed/receipted result is absent from fresh origin/base; cleanup-only retry retained.");
      await taskPresent();
      if (baseSha !== integration.baseSha) {
        if (!this.isAncestor(integration.baseSha, baseSha))
          throw new Error("Remote base history was rewritten; prepared integration retained.");
        // A rejected push retries Git, not the successful builder. Only this
        // checked path may replace progress; ordinary update() stays immutable.
        const supersede = async (patch: Partial<TicketExecutionRecord>) => {
          await taskPresent();
          if (await observe() !== baseSha)
            throw new Error("Remote base changed during preparation; previous integration retained for observation.");
          const previous = record!;
          const check = () => {
            this.assertFinalizationRecord(task, previous);
            if (previous.retry?.stage === "cleanup" || this.hasCleanupReceipt(task.itemId))
              throw new Error("Confirmed/receipted cleanup cannot be superseded.");
          };
          check();
          const loaded = this.load(this.recordPath(task.itemId))!;
          const next = { ...previous, ...patch };
          this.save(next, loaded.bytes, check);
          record = next;
        };
        let replacement: TicketIntegrationState;
        try { replacement = await prepare(baseSha, integration.taskSha); }
        catch (error) {
          if (!(error instanceof MergeConflictError) || !error.repairable) throw error;
          const reason = `Merge conflict with base ${baseSha}: merge into original task ${integration.taskSha}, resolve, test, push, review, and obtain renewed manual close approval.\n\n${error.diagnostic}`;
          await supersede({ integration: undefined, reviewedTaskSha: undefined, retry: { stage: "build", reason } });
          throw error;
        }
        await supersede({ integration: replacement, retry: preparedRetry });
        integration = replacement;
      }
      await guard();
      if (!this.isAncestor(integration.resultSha, baseSha))
        await mustGitAsync(["push", "origin", `${integration.resultSha}:refs/heads/${task.baseBranch}`], this.repoRoot);
    }
    baseSha = await observe();
    if (!this.isAncestor(integration.resultSha, baseSha))
      throw new Error(`Pushed result ${integration.resultSha} is not on origin/${task.baseBranch}.`);
    save({ retry: { stage: "cleanup", reason: "Result confirmed on fresh origin/base; cleanup only." } });

    const cleanupGuard = async () => {
      const base = await observe();
      if (!this.isAncestor(integration.resultSha, base)) throw new Error("Integrated result is no longer on fresh origin/base; cleanup retained.");
    };
    const residual = () => existsSync(record!.path) && !this.entryForPath(record!.path);
    const checkResidual = async () => {
      if (this.entryForPath(record!.path)) return;
      if (!residual() && !legacyResidual) return;
      if (!legacyResidual) throw new Error("Unregistered residual requires existing legacy evidence; work retained.");
      await legacyResidual(record!, false, cleanupGuard);
    };
    await checkResidual();
    await cleanupGuard();
    const cleanupRemote = await this.remoteSha(task.taskBranch);
    if (cleanupRemote && cleanupRemote !== sourceRemote) throw new Error("Remote task ref changed; cleanup retained.");
    await cleanupGuard();
    if (this.entryForPath(record.path) && existsSync(record.path)) {
      await this.checkNestedGit(record.path);
      await cleanupGuard();
      // An ignored Windows OS lock must fail while registration and refs remain.
      await mustGitAsync(["clean", "-fdX"], record.path);
      const links: string[] = [];
      await this.checkNestedGit(record.path, true, links);
      await cleanupGuard();
      for (const path of links) {
        const args = ["check-ignore", "--quiet", "--", relative(record.path, path)];
        const ignored = git(args, record.path);
        if (!ignored.ok) {
          if (ignored.status === 1 && !ignored.timedOut) continue;
          throw processFailure("git", args, ignored);
        }
        if (this.hasSymlink(dirname(path)) || !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error(`Ignored link changed before cleanup: ${path}`);
        unlinkSync(path); // Never recurse into a junction's external target.
      }
      await cleanupGuard();
    }
    if (cleanupRemote) await mustGitAsync(
      ["push", "origin", `--force-with-lease=refs/heads/${task.taskBranch}:${cleanupRemote}`, `:refs/heads/${task.taskBranch}`], this.repoRoot,
    );
    // Detect a reappearing remote before removing the worktree or local ref.
    const remoteAbsent = async () => {
      if (await this.remoteSha(task.taskBranch)) throw new Error("Remote task branch reappeared; cleanup retained.");
      await cleanupGuard();
    };
    await remoteAbsent();
    if (this.entryForPath(record.path)) {
      await mustGitAsync(["worktree", "remove", record.path], this.repoRoot);
      if (this.entryForPath(record.path)) throw new Error("Worktree registration remains after normal removal.");
    }
    // Never a fallback for failed git worktree remove. Only converted,
    // unregistered old remnants may consume their pre-existing snapshots.
    if (!this.entryForPath(record.path) && (residual() || legacyResidual)) {
      if (!legacyResidual) throw new Error("Unknown unregistered worktree residual retained.");
      await legacyResidual(record, true, cleanupGuard);
    }
    await remoteAbsent();
    if (existsSync(record.path) || this.entryForPath(record.path)) throw new Error("Worktree remains; cleanup retained.");
    if (this.localBranchSha(task.taskBranch)) await mustGitAsync(
      ["update-ref", "--no-deref", "-d", `refs/heads/${task.taskBranch}`, integration.taskSha], this.repoRoot,
    );
    await remoteAbsent();
    if (this.localBranchSha(task.taskBranch)) throw new Error("Local task branch reappeared after cleanup.");
    return integration.resultSha;
  }

  /** Rechecked after each yielded Git/GitHub operation; no filesystem snapshots. */
  private assertFinalizationRecord(task: BuilderTask, record: TicketExecutionRecord): void {
    if (JSON.stringify(this.cleanupRecord(task)) !== JSON.stringify(record)) throw new TicketStateChangedError("Finalization record changed.");
    const local = this.localBranchSha(task.taskBranch);
    const expected = record.integration?.taskSha;
    if (expected && local && local !== expected) throw new Error(`Local ${task.taskBranch} moved; work retained.`);
    const entry = this.entryForPath(record.path);
    if (!entry && existsSync(record.path) && !this.hasCleanupReceipt(task.itemId))
      throw new Error("Unregistered residual requires existing legacy evidence; work retained.");
    if (entry && existsSync(record.path)) {
      if (this.hasSymlink(join(record.path, ".git"))) throw new Error("Symlinked worktree Git identity; work retained.");
      const check = this.check(record, true);
      if (!check.ok) throw new Error(check.reason ?? "Unsafe cleanup worktree.");
    }
    if (!this.gitCommonDir || this.hasSymlink(this.gitCommonDir)) throw new Error("Unsafe Git common directory.");
    for (const name of readdirSync(this.gitCommonDir))
      if (name.endsWith(".lock")) throw new Error(`Locked Git cleanup: ${name}`);
    const refLock = join(this.gitCommonDir, "refs", "heads", `${task.taskBranch}.lock`);
    if (this.hasSymlink(refLock) || existsSync(refLock)) throw new Error("Locked or symlinked task ref.");
    const root = join(this.gitCommonDir, "worktrees");
    if (this.hasSymlink(root)) throw new Error("Symlinked Git worktree administration.");
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      const admin = join(root, name);
      if (this.hasSymlink(admin) || !lstatSync(admin).isDirectory()) throw new Error("Unsafe Git worktree administration.");
      const pointer = join(admin, "gitdir");
      if (!existsSync(pointer)) throw new Error("Unknown partial Git registration; ownership must be repaired before cleanup.");
      if (this.hasSymlink(pointer) || !lstatSync(pointer).isFile()) throw new Error("Unsafe Git worktree pointer.");
      if (!samePath(readFileSync(pointer, "utf8").trim(), join(record.path, ".git"))) continue;
      for (const file of readdirSync(admin))
        if (file === "locked" || file.endsWith(".lock")) throw new Error(`Locked worktree administration: ${file}`);
      for (const file of ["HEAD", "commondir"])
        if (this.hasSymlink(join(admin, file))) throw new Error("Symlinked Git worktree identity.");
      if (readFileSync(join(admin, "HEAD"), "utf8").trim() !== `ref: refs/heads/${task.taskBranch}` ||
          !samePath(resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim()), this.gitCommonDir))
        throw new Error("Worktree administration ownership changed.");
    }
  }

  /** Metadata only: native cleanup may discard ignored files, never nested Git. */
  private async checkNestedGit(path: string, root = true, links?: string[]): Promise<void> {
    const names = await readdir(path);
    if ((!root && names.some((name) => name.toLowerCase() === ".git")) ||
        ["HEAD", "objects", "refs"].every((name) => names.includes(name)))
      throw new Error(`Nested Git identity: ${path}`);
    for (const name of names) {
      if (root && name === ".git") continue;
      const child = join(path, name), stat = await lstat(child);
      if (stat.isSymbolicLink()) links?.push(child);
      else if (stat.isDirectory()) await this.checkNestedGit(child, false, links);
    }
  }

  /** Project Backlog must already be freshly confirmed by the caller. Record
   * deletion is the last operation, including after a lost board response. */
  async completeFinalization(task: BuilderTask, resultSha: string, assertDone: () => Promise<void>): Promise<void> {
    const loaded = this.load(this.recordPath(task.itemId));
    const record = loaded?.record;
    if (!record || record.schemaVersion !== 4 || record.integration?.resultSha !== resultSha || record.retry?.stage !== "cleanup")
      throw new Error("Missing cleanup progress before final Done confirmation.");
    await this.fetchRequired(task.baseBranch);
    if (!this.isAncestor(resultSha, this.fetchedSha(task.baseBranch))) throw new Error("Integration no longer confirmed; record retained.");
    if (await this.remoteSha(task.taskBranch)) throw new Error("Remote task branch reappeared; record retained.");
    await assertDone();
    this.assertFinalizationRecord(task, record);
    if (this.localBranchSha(task.taskBranch) || existsSync(record.path) || this.entryForPath(record.path))
      throw new Error("Task artifacts reappeared; record retained.");
    const path = this.recordPath(task.itemId);
    if (!readFileSync(path).equals(loaded!.bytes)) throw new Error("Cleanup record changed before deletion.");
    unlinkSync(path);
  }

  async resultTree(state: { baseSha: string; taskSha: string }): Promise<string> {
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

  /** Strict inventory: an unreadable/mixed record cannot silently disappear from ownership. */
  cleanupRecord(
    task: BuilderTask,
    inspectPaths = true,
  ): TicketExecutionRecord | undefined {
    if (this.hasSymlink(this.recordsDir)) throw new Error("Symlinked ticket inventory.");
    let own: TicketExecutionRecord | undefined;
    for (const name of readdirSync(this.recordsDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.recordsDir, name);
      if (this.hasSymlink(path) || !lstatSync(path).isFile()) throw new Error("Unsafe ticket inventory.");
      const bytes = readFileSync(path);
      let record: unknown;
      try {
        record = JSON.parse(bytes.toString("utf8"));
      } catch {
        /* rejected below */
      }
      if (
        !isTicketExecutionRecord(record) ||
        name !== `${safe(record.itemId)}.json`
      )
        throw new Error(
          `Corrupt or unsupported ticket execution record: ${name}`,
        );
      if (record.itemId === task.itemId) {
        if (
          record.issueNumber !== task.issueNumber ||
          record.taskKey !== task.taskKey ||
          record.taskBranch !== task.taskBranch ||
          record.baseBranch !== task.baseBranch
        )
          throw new Error("Ticket cleanup record identity changed.");
        if (record.activeRunId || record.launchingAt !== undefined)
          throw new Error("Builder execution is still active.");
        if (inspectPaths) this.assertOwnedPath(record);
        own = record;
      } else if (
        record.taskBranch === task.taskBranch ||
        samePath(record.path, this.pathFor(task.itemId, task.issueNumber))
      ) {
        throw new Error("Ticket cleanup path/branch has another record owner.");
      }
    }
    if (!inspectPaths) return own;
    const path = this.pathFor(task.itemId, task.issueNumber);
    if (!this.isManagedPath(path))
      throw new Error(`Refusing unmanaged worktree: ${path}`);
    for (const entry of this.worktreeEntries()) {
      if (entry.branch === task.taskBranch && !samePath(entry.path, path))
        throw new Error(
          `Refusing unmanaged or unrecorded worktree: ${entry.path}`,
        );
      if (samePath(entry.path, path)) {
        if (entry.locked) throw new Error(`Locked worktree: ${path}`);
        if (entry.branch !== task.taskBranch)
          throw new Error(`Changed worktree ownership: ${path}`);
      }
    }
    if (!own && (existsSync(path) || this.entryForPath(path)))
      throw new Error(`Unknown/unrecorded cleanup directory: ${path}`);
    return own;
  }

  validateBranches(...branches: string[]): void {
    for (const branch of branches) {
      if (!singleLine(branch) || branch.startsWith("-"))
        throw new Error(`Invalid branch: ${branch}`);
      mustGit(["check-ref-format", `refs/heads/${branch}`], this.repoRoot);
    }
  }

  async fetchRequired(...branches: string[]): Promise<void> {
    this.validateBranches(...branches);
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

  fetchedSha(branch: string): string {
    return mustGit(
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`],
      this.repoRoot,
    );
  }

  remoteBranchSha(branch: string): Promise<string | undefined> {
    return this.remoteSha(branch);
  }

  async remoteSha(branch: string): Promise<string | undefined> {
    this.validateBranches(branch);
    const ref = `refs/heads/${branch}`;
    const args = ["ls-remote", "--exit-code", "--heads", "origin", ref];
    const result = await gitAsync(args, this.repoRoot);
    if (!result.ok) {
      if (result.status === 2 && !result.timedOut && !result.stdout.trim() && !result.stderr.trim()) return undefined;
      throw processFailure("git", args, result);
    }
    const match = /^([0-9a-f]{40})\t([^\r\n]+)(?:\r?\n)?$/i.exec(result.stdout);
    if (!match || match[2] !== ref) throw new Error("Malformed remote ref observation.");
    return match[1];
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const args = ["merge-base", "--is-ancestor", ancestor, descendant];
    const result = git(args, this.repoRoot);
    if (!result.ok && (result.status !== 1 || result.timedOut)) throw processFailure("git", args, result);
    return result.ok;
  }
}
