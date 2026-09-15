import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import {
  backupSnapshots,
  cleanupSnapshot,
  directoryStamps,
  exactKeys,
  isCleanupSnapshot,
  readRegular,
  readSymlink,
  removeSnapshot,
  verifyBackupSnapshots,
  verifyParents,
  verifySnapshot,
  writeCleanupEvidence,
  type CleanupSnapshot,
} from "./cleanup-snapshot.js";
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
import { isRepairRequest, type RepairRequest } from "./repair.js";

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
]);
const RETRY_FIELDS = new Set(["stage", "reason"]);
const INTEGRATION_FIELDS = new Set(["baseSha", "taskSha", "resultSha"]);
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

interface CleanupReceipt {
  schemaVersion: 1;
  itemId: string;
  issueNumber: number;
  taskBranch: string;
  baseBranch: string;
  taskSha: string;
  resultSha: string;
  record: TicketExecutionRecord | null;
  recordHash: string | null;
  snapshots: CleanupSnapshot[];
  parents: Awaited<ReturnType<typeof directoryStamps>>;
  gitParents: Awaited<ReturnType<typeof directoryStamps>>;
  backup: string | null;
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const equalRecordBytes = (bytes: Buffer, record: TicketExecutionRecord) => {
  try {
    return (
      JSON.stringify(JSON.parse(bytes.toString("utf8"))) ===
      JSON.stringify(record)
    );
  } catch (error) {
    throw new Error("Corrupt cleanup execution record.", { cause: error });
  }
};

/** Persistent builder worktrees and local-branch finalization. */
export class TicketWorktrees {
  readonly repoRoot: string;
  private readonly gitCommonDir?: string;
  readonly recordsDir: string;
  private readonly worktreesDir: string;
  private readonly cleanupDir: string;
  private readonly backupsDir: string;

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
    this.backupsDir = join(
      this.repoRoot,
      ".pi",
      "board-agent",
      "cleanup-backups",
    );
    if (
      [
        this.recordsDir,
        this.worktreesDir,
        this.cleanupDir,
        this.backupsDir,
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

  private save(
    record: TicketExecutionRecord,
    expectedBytes?: Buffer,
    beforePublish?: () => void,
  ): void {
    if (!isTicketExecutionRecord(record))
      throw new Error("Invalid ticket execution record.");
    const path = this.recordPath(record.itemId);
    const bytes = JSON.stringify(record, null, 2);
    if (!isTicketExecutionRecord(JSON.parse(bytes)))
      throw new Error("Invalid serialized ticket execution record.");
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
   * update may change schema or bypass a receipt. A missing source is permitted
   * only for receipt-only recovery (the original ticket was already removed). */
  publishLegacy(
    original: TicketExecutionRecord,
    next: TicketExecutionRecordV4,
    expectedBytes: Buffer | undefined,
    assertSource: () => void,
  ): void {
    if (original.schemaVersion !== 3 || next.schemaVersion !== 4 ||
        !isTicketExecutionRecord(original) || !sameIdentity(original, next))
      throw new Error("Invalid legacy ticket conversion.");
    assertSource();
    this.save(next, expectedBytes, assertSource);
  }

  update(
    itemId: string,
    mutate: (record: TicketExecutionRecord) => TicketExecutionRecord,
  ): TicketExecutionRecord {
    if (this.hasCleanupReceipt(itemId))
      throw new Error(
        "Ticket has a pending cleanup receipt; recover finalization first.",
      );
    const loaded = this.load(this.recordPath(itemId));
    if (!loaded || loaded.record.itemId !== itemId)
      throw new Error(
        `Ticket execution record is missing or unsupported: ${itemId}`,
      );
    const current = loaded.record;
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

  private pathFor(itemId: string, issueNumber: number): string {
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
    if (requireClean) {
      const merge = git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], record.path);
      if (merge.ok || merge.status !== 1)
        return { ok: false, clean: false, reason: "unfinished or unreadable MERGE_HEAD" };
    }
    return { ok: true, clean };
  }

  /** Closed handoff needs the exact remote pair; open Ready confirmation may
   * accept base descendants, with prepareRepair's original ancestry/owner gates. */
  async prepareConflict(
    record: TicketExecutionRecord,
    repair: RepairRequest,
    allowBaseAdvance = false,
  ): Promise<void> {
    const current = await this.cleanupRecord({
      ...record,
      title: "",
      body: "",
    });
    if (JSON.stringify(current) !== JSON.stringify(record))
      throw new Error("Conflict record changed.");
    await this.prepareRepair(record, repair);
    if (
      !allowBaseAdvance &&
      this.fetchedSha(record.baseBranch) !== repair.baseSha
    )
      throw new Error("Conflict base advanced before handoff.");
    this.checkConflict(record, repair);
  }

  checkConflict(record: TicketExecutionRecord, repair: RepairRequest): void {
    for (const name of readdirSync(this.recordsDir).filter((n) =>
      n.endsWith(".json"),
    )) {
      const path = join(this.recordsDir, name);
      const value =
        !this.hasSymlink(path) && lstatSync(path).isFile()
          ? this.load(path)?.record
          : undefined;
      if (!value || name !== `${safe(value.itemId)}.json`)
        throw new Error("Corrupt/changed conflict owner inventory.");
      if (
        value.itemId !== record.itemId &&
        (value.taskBranch === record.taskBranch ||
          samePath(value.path, this.pathFor(record.itemId, record.issueNumber)))
      )
        throw new Error("Ticket cleanup path/branch has another record owner.");
    }
    if (JSON.stringify(this.read(record.itemId)) !== JSON.stringify(record))
      throw new Error("Conflict record changed.");
    this.checkRepairStart(record, repair);
  }

  /** Initial admission only. Durable recovery intentionally does not repeat the
   * original-SHA/clean gate: the same run may have an interrupted dirty merge. */
  async prepareRepair(
    record: TicketExecutionRecord,
    repair: RepairRequest,
  ): Promise<void> {
    this.checkRepairStart(record, repair);
    await this.fetchRequired(record.baseBranch, record.taskBranch);
    if (this.fetchedSha(record.taskBranch) !== repair.taskSha)
      throw new Error(
        "Repair remote task SHA no longer matches the original task.",
      );
    if (
      mustGit(["cat-file", "-t", repair.baseSha], this.repoRoot) !== "commit" ||
      !this.isAncestor(repair.baseSha, this.fetchedSha(record.baseBranch))
    )
      throw new Error(
        "Repair designated base is missing from the remote base history.",
      );
    this.checkRepairStart(record, repair);
  }

  /** Synchronous recheck after the final admission/card await, before start(). */
  checkRepairStart(record: TicketExecutionRecord, repair: RepairRequest): void {
    if (!isRepairRequest(repair)) throw new Error("Invalid repair request.");
    this.assertNoFinalization(record);
    const check = this.check(record, true);
    if (!check.ok) throw new Error(check.reason ?? "Unsafe repair worktree.");
    if (this.localBranchSha(record.taskBranch) !== repair.taskSha)
      throw new Error(
        "Repair initial task SHA no longer matches the original task.",
      );
    if (git(["rev-parse", "--verify", "MERGE_HEAD"], record.path).ok)
      throw new Error(
        "An interrupted merge may only resume its existing durable run.",
      );
  }

  /** Repair-only completion gate. Fetch is not proof until the local worktree
   * has been rechecked after it; stale origin caches never authorize success. */
  async verifyRepairResult(
    record: TicketExecutionRecord,
    repair: RepairRequest,
    resultSha: string,
  ): Promise<void> {
    if (!isRepairRequest(repair) || !SHA.test(resultSha))
      throw new Error("Invalid repair result identity.");
    await this.fetchRequired(record.taskBranch);
    this.checkRepairResult(record, repair, resultSha);
  }

  /** Recheck local evidence after the completion card await without refetching. */
  checkRepairResult(
    record: TicketExecutionRecord,
    repair: RepairRequest,
    resultSha: string,
  ): void {
    this.assertNoFinalization(record);
    const check = this.check(record, true);
    if (!check.ok)
      throw new Error(check.reason ?? "Unsafe completed repair worktree.");
    if (
      mustGit(["ls-files", "--unmerged"], record.path) ||
      git(["rev-parse", "--verify", "MERGE_HEAD"], record.path).ok
    )
      throw new Error(
        "Repair has unresolved index stages or an unfinished merge.",
      );
    if (
      this.localBranchSha(record.taskBranch) !== resultSha ||
      this.fetchedSha(record.taskBranch) !== resultSha
    )
      throw new Error(
        "Repair result must equal the clean local tip and pushed remote task SHA.",
      );
    if (
      !this.isAncestor(repair.taskSha, resultSha) ||
      !this.isAncestor(repair.baseSha, resultSha)
    )
      throw new Error(
        "Repair result is missing original task or designated base ancestry.",
      );
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

  /** Closed + Done approves the current local branch, not an execution record. */
  async finalizeAccepted(
    task: BuilderTask,
    strategy: Config["task_merge_strategy"],
  ): Promise<string | undefined> {
    // v4 progress must survive until the staged finalizer is installed. Never
    // feed it through the v3 squash/receipt path or treat its result as pushed.
    if (this.read(task.itemId)?.schemaVersion === 4)
      throw new Error("v4 finalization requires staged integration/cleanup.");
    if (this.hasCleanupReceipt(task.itemId)) {
      const receipt = await this.readReceipt(task);
      await this.cleanupFinalized(task, receipt);
      return receipt.resultSha;
    }
    await this.checkCleanupGit();
    const taskSha = this.localBranchSha(task.taskBranch);
    if (!taskSha) return undefined;
    this.validateBranches(task.baseBranch);
    if (task.taskBranch === task.baseBranch)
      throw new Error("Task branch must differ from the base branch.");
    if (
      this.list().some(
        (record) =>
          record.taskBranch === task.taskBranch &&
          (record.activeRunId || record.launchingAt !== undefined),
      )
    )
      throw new Error("Builder execution is still active.");
    const record = await this.cleanupRecord(task);
    const path = this.pathFor(task.itemId, task.issueNumber);
    const orphan = !!record && !this.entryForPath(path) && existsSync(path);
    if (!orphan) this.checkedTaskWorktrees(task.taskBranch, taskSha);
    await this.fetchRequired(task.baseBranch);
    const baseSha = this.fetchedSha(task.baseBranch);
    const old = record?.finalization;
    if (
      old &&
      (old.targetBranch !== task.baseBranch ||
        old.taskSha !== taskSha ||
        (record?.reviewedTaskSha && record.reviewedTaskSha !== old.taskSha))
    )
      throw new Error("Legacy finalization identity changed; cleanup refused.");
    if (
      old &&
      !old.resultSha &&
      (mustGit(["cat-file", "-t", old.baseSha], this.repoRoot) !== "commit" ||
        !this.isAncestor(old.baseSha, baseSha))
    )
      throw new Error(
        "Legacy pre-result base is unknown or rewritten; finalization blocked.",
      );
    if (old?.resultSha) {
      if (!this.isAncestor(old.resultSha, baseSha))
        throw new Error(
          "Legacy finalization result is not confirmed on remote base.",
        );
      await this.verifyLegacyResult(old);
      const receipt = await this.prepareReceipt(
        task,
        taskSha,
        old.resultSha,
        true,
      );
      await this.cleanupFinalized(task, receipt);
      return old.resultSha;
    }
    const state = { targetBranch: task.baseBranch, baseSha, taskSha };
    const treeSha = await this.resultTree(state);
    const parents = this.resultParents(state, strategy);
    // ponytail: squash retries use tree equality; conflicting later edits need a manual merge.
    const integrated =
      this.isAncestor(taskSha, baseSha) ||
      (strategy === "squash" &&
        treeSha === mustGit(["rev-parse", `${baseSha}^{tree}`], this.repoRoot));
    if (orphan && !integrated)
      throw new Error(
        "Unregistered residual is not confirmed integrated; cleanup refused.",
      );
    let resultSha = baseSha;
    if (!integrated) {
      resultSha = await mustGitAsync(
        ["commit-tree", treeSha, ...parents.flatMap((sha) => ["-p", sha])],
        this.repoRoot,
        `chore(board): merge ${task.taskKey} after validation\n\n${task.title.replace(/[\r\n]+/g, " ")}\n\nRefs #${task.issueNumber}\nBoard-Agent-Item: ${task.itemId}\n`,
      );
      if (!SHA.test(resultSha))
        throw new Error("git commit-tree returned no result commit.");
      await mustGitAsync(
        ["push", "origin", `${resultSha}:refs/heads/${task.baseBranch}`],
        this.repoRoot,
      );
    }
    await this.fetchRequired(task.baseBranch);
    if (!this.isAncestor(resultSha, this.fetchedSha(task.baseBranch)))
      throw new Error(
        `Pushed result ${resultSha} is not on origin/${task.baseBranch}.`,
      );
    if (this.localBranchSha(task.taskBranch) !== taskSha)
      throw new Error(`Local ${task.taskBranch} moved; cleanup refused.`);
    const receipt = await this.prepareReceipt(
      task,
      taskSha,
      resultSha,
      integrated,
    );
    await this.cleanupFinalized(task, receipt);
    return resultSha;
  }

  /** Only the old pre-result order is provable: a4624e2 persisted the intent
   * before merge-tree, and persisted resultSha BEFORE any push. A present result
   * absent from today's remote is NEVER evidence that it wasn't once pushed.
   * Archive exact original bytes, then a dedicated checked atomic clear; ordinary
   * update() must continue rejecting intent removal/replacement. */
  async clearPrePushConflict(
    task: BuilderTask,
    conflict: MergeConflictError,
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    if (!(conflict instanceof MergeConflictError))
      throw new Error("Only a verified conflict can recover a legacy intent.");
    if (this.hasCleanupReceipt(task.itemId))
      throw new Error("Cleanup receipt owns this ticket.");
    const record = await this.cleanupRecord(task);
    const old = record?.finalization;
    if (
      !record ||
      !old ||
      old.resultSha !== undefined ||
      old.targetBranch !== task.baseBranch ||
      old.taskSha !== conflict.taskSha ||
      (record.reviewedTaskSha && record.reviewedTaskSha !== old.taskSha)
    )
      throw new Error("Legacy intent is not provably pre-push.");
    const path = this.recordPath(task.itemId),
      bytes = await readRegular(path);
    if (!equalRecordBytes(bytes, record))
      throw new Error("Legacy record changed.");
    const check = this.check(record, true);
    if (!check.ok) throw new Error(check.reason ?? "Unsafe legacy worktree.");
    this.validateBranches(task.baseBranch, task.taskBranch);
    await this.fetchRequired(task.baseBranch, task.taskBranch);
    // An older approved base may have advanced, but never been rewritten away.
    const checkShas = () => {
      if (
        this.localBranchSha(task.taskBranch) !== old.taskSha ||
        this.fetchedSha(task.taskBranch) !== old.taskSha ||
        this.fetchedSha(task.baseBranch) !== conflict.baseSha ||
        mustGit(["cat-file", "-t", old.baseSha], this.repoRoot) !== "commit" ||
        !this.isAncestor(old.baseSha, conflict.baseSha)
      )
        throw new Error("Legacy pre-push SHAs/history no longer match.");
    };
    checkShas();
    try {
      await this.resultTree(old);
    } catch (error) {
      if (!(error instanceof MergeConflictError)) throw error;
    }
    const backupDir = join(
      this.repoRoot,
      ".pi",
      "board-agent",
      "repair-intent-backups",
    );
    await directoryStamps(join(backupDir, "probe"));
    await mkdir(backupDir, { recursive: true });
    const archive = join(backupDir, `${safe(task.itemId)}-${hash(bytes)}.json`);
    if (!lstatSync(archive, { throwIfNoEntry: false }))
      await writeCleanupEvidence(archive, bytes);
    if (
      !(await readRegular(archive)).equals(bytes) ||
      !(await readRegular(path)).equals(bytes)
    )
      throw new Error("Legacy archive/source verification failed.");
    // Also flush a previously published archive after an interrupted link/flush.
    if (process.platform !== "win32") {
      const fd = openSync(backupDir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    await assertCurrent(); // last remote/revision/ownership check before the local clear
    if (
      this.hasCleanupReceipt(task.itemId) ||
      this.hasSymlink(path) ||
      this.hasSymlink(archive) ||
      !lstatSync(path).isFile() ||
      !readFileSync(path).equals(bytes) ||
      !readFileSync(archive).equals(bytes)
    )
      throw new Error("Legacy intent/archive changed before clear.");
    const finalCheck = this.check(record, true);
    if (!finalCheck.ok)
      throw new Error(finalCheck.reason ?? "Legacy worktree changed.");
    checkShas();
    const next = { ...record };
    delete next.finalization;
    this.save(next, bytes); // synchronous checked atomic replacement; no update() exemption
  }

  private async resultTree(state: TicketFinalizationState): Promise<string> {
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

  private checkedTaskWorktrees(branch: string, taskSha: string): string[] {
    const entries = this.worktreeEntries().filter(
      (entry) => entry.branch === branch,
    );
    for (const entry of entries) {
      if (!this.isManagedPath(entry.path))
        throw new Error(`Refusing to remove unmanaged worktree: ${entry.path}`);
      if (entry.locked) throw new Error(`Locked worktree: ${entry.path}`);
      if (!existsSync(entry.path))
        throw new Error(`Missing worktree: ${entry.path}`);
      if (
        mustGit(["branch", "--show-current"], entry.path) !== branch ||
        mustGit(["rev-parse", "HEAD"], entry.path) !== taskSha
      )
        throw new Error(`Worktree branch or HEAD changed: ${entry.path}`);
      if (
        mustGit(
          ["status", "--porcelain=v1", "--untracked-files=all"],
          entry.path,
        )
      )
        throw new Error(`Dirty worktree: ${entry.path}`);
    }
    return entries.map((entry) => entry.path);
  }

  /** Strict inventory: an unreadable/mixed record cannot silently disappear from ownership. */
  private async cleanupRecord(
    task: BuilderTask,
  ): Promise<TicketExecutionRecord | undefined> {
    await directoryStamps(join(this.recordsDir, "probe"));
    let own: TicketExecutionRecord | undefined;
    for (const name of await readdir(this.recordsDir)) {
      if (!name.endsWith(".json")) continue;
      const bytes = await readRegular(join(this.recordsDir, name));
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
          record.taskBranch !== task.taskBranch ||
          record.baseBranch !== task.baseBranch
        )
          throw new Error("Ticket cleanup record identity changed.");
        if (record.activeRunId || record.launchingAt !== undefined)
          throw new Error("Builder execution is still active.");
        this.assertOwnedPath(record);
        own = record;
      } else if (
        record.taskBranch === task.taskBranch ||
        samePath(record.path, this.pathFor(task.itemId, task.issueNumber))
      ) {
        throw new Error("Ticket cleanup path/branch has another record owner.");
      }
    }
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

  /** Read-only evidence checks shared with the owner-held legacy adapter. */
  async readReceipt(task: BuilderTask): Promise<CleanupReceipt> {
    const path = this.receiptPath(task.itemId);
    let r: any;
    try {
      r = JSON.parse((await readRegular(path)).toString("utf8"));
    } catch (error) {
      throw new Error(`Corrupt cleanup receipt: ${path}`, { cause: error });
    }
    if (
      !exactKeys(r, [
        "schemaVersion",
        "itemId",
        "issueNumber",
        "taskBranch",
        "baseBranch",
        "taskSha",
        "resultSha",
        "record",
        "recordHash",
        "snapshots",
        "parents",
        "gitParents",
        "backup",
      ]) ||
      r.schemaVersion !== 1 ||
      r.itemId !== task.itemId ||
      r.issueNumber !== task.issueNumber ||
      r.taskBranch !== task.taskBranch ||
      r.baseBranch !== task.baseBranch ||
      typeof r.taskSha !== "string" ||
      !SHA.test(r.taskSha) ||
      typeof r.resultSha !== "string" ||
      !SHA.test(r.resultSha) ||
      !(r.record === null
        ? r.recordHash === null
        : isTicketExecutionRecord(r.record) &&
          typeof r.recordHash === "string" &&
          /^[0-9a-f]{64}$/.test(r.recordHash)) ||
      !Array.isArray(r.snapshots) ||
      r.snapshots.length < 1 ||
      r.snapshots.length > 2 ||
      !r.snapshots.every(isCleanupSnapshot) ||
      !isCleanupSnapshot({ path, parents: r.parents, entries: [] }) ||
      r.parents.length !== (await directoryStamps(path)).length ||
      !this.gitCommonDir ||
      !isCleanupSnapshot({
        path: join(this.gitCommonDir, "probe"),
        parents: r.gitParents,
        entries: [],
      }) ||
      r.gitParents.length !==
        (await directoryStamps(join(this.gitCommonDir, "probe"))).length ||
      !(
        r.backup === null ||
        (singleLine(r.backup) && samePath(dirname(r.backup), this.backupsDir))
      )
    )
      throw new Error(`Corrupt or unsupported cleanup receipt: ${path}`);
    const receipt = r as CleanupReceipt;
    if (
      !samePath(
        receipt.snapshots[0].path,
        this.pathFor(task.itemId, task.issueNumber),
      ) ||
      (receipt.snapshots[1] &&
        (!this.gitCommonDir ||
          !samePath(
            dirname(receipt.snapshots[1].path),
            join(this.gitCommonDir, "worktrees"),
          ))) ||
      (receipt.record &&
        (receipt.record.itemId !== task.itemId ||
          receipt.record.issueNumber !== task.issueNumber ||
          receipt.record.taskBranch !== task.taskBranch ||
          receipt.record.baseBranch !== task.baseBranch ||
          !samePath(receipt.record.path, receipt.snapshots[0].path) ||
          receipt.record.activeRunId ||
          receipt.record.launchingAt !== undefined)) ||
      (!receipt.record && receipt.snapshots.some((s) => s.entries.length))
    )
      throw new Error("Cleanup receipt identity/path mismatch.");
    await verifyParents(receipt.gitParents);
    await this.checkCleanupGit(receipt);
    this.validateBranches(receipt.taskBranch, receipt.baseBranch);
    if (receipt.taskBranch === receipt.baseBranch)
      throw new Error("Task branch must differ from the base branch.");
    await verifyParents(receipt.parents);
    return receipt;
  }

  private async prepareReceipt(
    task: BuilderTask,
    taskSha: string,
    resultSha: string,
    legacy: boolean,
  ): Promise<CleanupReceipt> {
    const record = await this.cleanupRecord(task);
    const recordBytes = record
      ? await readRegular(this.recordPath(task.itemId))
      : null;
    if (recordBytes && !equalRecordBytes(recordBytes, record!))
      throw new Error("Cleanup execution record changed.");
    // Freeze a receipt only once every destructive precondition, including the remote task, is ready.
    const remote = await gitAsync(
      [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        `refs/heads/${task.taskBranch}`,
      ],
      this.repoRoot,
    );
    if (remote.ok) {
      const sha = remote.stdout.trim().split(/\s+/)[0];
      if (
        !SHA.test(sha) ||
        (!this.isAncestor(sha, taskSha) &&
          !this.isAncestor(sha, this.fetchedSha(task.baseBranch)))
      )
        throw new Error(
          `Remote ${task.taskBranch} has unmerged work; cleanup refused.`,
        );
    } else if (remote.status !== 2)
      throw processFailure("git", ["ls-remote"], remote);
    const path = this.pathFor(task.itemId, task.issueNumber);
    const entry = this.entryForPath(path);
    if (entry) this.checkedTaskWorktrees(task.taskBranch, taskSha);
    const snapshots = [await cleanupSnapshot(path)];
    const dotgit = snapshots[0].entries.find((e) => e.path === ".git");
    if (dotgit) {
      const pointer = (await readRegular(join(path, ".git")))
        .toString("utf8")
        .trim();
      if (!pointer.startsWith("gitdir: ") || !this.gitCommonDir)
        throw new Error("Unknown Git worktree identity.");
      const admin = resolve(path, pointer.slice(8));
      if (!samePath(dirname(admin), join(this.gitCommonDir, "worktrees")))
        throw new Error("Other Git ownership in cleanup path.");
      const snapshot = await cleanupSnapshot(admin);
      if (
        !snapshot.entries.length ||
        !samePath(
          (await readRegular(join(admin, "gitdir"))).toString("utf8").trim(),
          join(path, ".git"),
        ) ||
        !samePath(
          resolve(
            admin,
            (await readRegular(join(admin, "commondir")))
              .toString("utf8")
              .trim(),
          ),
          this.gitCommonDir,
        )
      )
        throw new Error("Broken Git worktree identity.");
      snapshots.push(snapshot);
    } else if (entry)
      throw new Error("Registered worktree is missing .git; cleanup refused.");
    if (!entry && snapshots[0].entries.length) {
      if (!legacy || !record || dotgit)
        throw new Error("Ambiguous unregistered cleanup residual.");
      await this.verifyLegacyResidual(taskSha, snapshots[0]);
    }
    let backup: string | null = null;
    if (legacy && record) {
      await directoryStamps(join(this.backupsDir, "probe"));
      await mkdir(this.backupsDir, { recursive: true });
      backup = join(this.backupsDir, `${safe(task.itemId)}-${randomUUID()}`);
      await backupSnapshots(backup, snapshots);
      await writeCleanupEvidence(join(backup, "record.json"), recordBytes!);
    }
    const receipt: CleanupReceipt = {
      schemaVersion: 1,
      itemId: task.itemId,
      issueNumber: task.issueNumber,
      taskBranch: task.taskBranch,
      baseBranch: task.baseBranch,
      taskSha,
      resultSha,
      record: record ?? null,
      recordHash: recordBytes ? hash(recordBytes) : null,
      snapshots,
      parents: await directoryStamps(this.receiptPath(task.itemId)),
      gitParents: await directoryStamps(join(this.gitCommonDir!, "probe")),
      backup,
    };
    await this.checkCleanup(task, receipt);
    for (const snapshot of snapshots) await verifySnapshot(snapshot, false);
    await writeCleanupEvidence(
      this.receiptPath(task.itemId),
      JSON.stringify(receipt, null, 2),
    );
    return this.readReceipt(task); // apply the same strict gate on first use and restart
  }

  async verifyLegacyResult(
    old: TicketFinalizationState,
  ): Promise<void> {
    // Prove the recorded merge/squash, not a new merge against today's possibly conflicting base.
    const parents = mustGit(
      ["show", "-s", "--format=%P", old.resultSha!],
      this.repoRoot,
    );
    if (parents !== old.baseSha && parents !== `${old.baseSha} ${old.taskSha}`)
      throw new Error("Ambiguous legacy finalization result parents.");
    let tree: string;
    try {
      tree = await this.resultTree(old);
    } catch (error) {
      throw new Error("Ambiguous legacy finalization result tree.", {
        cause: error,
      });
    }
    if (
      tree !== mustGit(["rev-parse", `${old.resultSha}^{tree}`], this.repoRoot)
    )
      throw new Error("Legacy finalization result tree mismatch.");
  }

  private async verifyLegacyResidual(
    taskSha: string,
    snapshot: CleanupSnapshot,
  ): Promise<void> {
    const tree = await mustGitAsync(
      ["ls-tree", "-r", "-z", taskSha],
      this.repoRoot,
    );
    const tracked = new Map(
      tree
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const match =
            /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/s.exec(line);
          if (!match)
            throw new Error("Legacy task contains special/nested Git entries.");
          return [match[3], { mode: match[1], oid: match[2] }];
        }),
    );
    let evidence = false;
    for (const file of snapshot.entries) {
      const expected = tracked.get(file.path);
      if (
        expected &&
        (expected.mode === "120000"
          ? file.type !== "symlink" || file.linkType === "junction"
          : file.type !== "file")
      )
        throw new Error(
          `Legacy tracked residual mode/kind changed: ${file.path}`,
        );
      if (file.type === "directory") {
        if (
          !file.path ||
          [...tracked.keys()].some((name) => name.startsWith(`${file.path}/`))
        )
          continue;
        const ignored = await gitAsync(
          [
            `--git-dir=${this.gitCommonDir}`,
            `--work-tree=${snapshot.path}`,
            "check-ignore",
            "--no-index",
            "--",
            `${file.path}/`,
          ],
          snapshot.path,
        );
        if (!ignored.ok)
          throw new Error(`Unknown legacy residual directory: ${file.path}`);
        continue;
      }
      if (expected) {
        // Git mode 120000 hashes the link text, never the file/directory it points to.
        // Read ordinary bytes non-following too: a replacement link must not be opened by Git.
        const path = join(snapshot.path, file.path);
        const bytes =
          file.type === "symlink"
            ? Buffer.from((await readSymlink(path)).target)
            : await readRegular(path);
        // Conservative: no guessing about filters/EOL conversions in a vanished checkout.
        const oid = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        if (oid !== expected.oid)
          throw new Error(`Legacy tracked residual changed: ${file.path}`);
        evidence = true;
      } else {
        const ignored = await gitAsync(
          [
            `--git-dir=${this.gitCommonDir}`,
            `--work-tree=${snapshot.path}`,
            "check-ignore",
            "--no-index",
            "--",
            file.path,
          ],
          snapshot.path,
        );
        if (!ignored.ok)
          throw new Error(`Unknown legacy residual file: ${file.path}`);
      }
    }
    if (!evidence)
      throw new Error(
        "No surviving tracked files prove legacy residual identity.",
      );
  }

  async checkCleanup(
    task: BuilderTask,
    receipt: CleanupReceipt,
  ): Promise<void> {
    await verifyParents(receipt.parents);
    await verifyParents(receipt.gitParents);
    const record = await this.cleanupRecord(task);
    if (record) {
      if (
        !receipt.record ||
        JSON.stringify(record) !== JSON.stringify(receipt.record) ||
        hash(await readRegular(this.recordPath(task.itemId))) !==
          receipt.recordHash
      )
        throw new Error("Cleanup execution record changed.");
    } else if (
      receipt.record &&
      (this.localBranchSha(task.taskBranch) ||
        receipt.snapshots.some((s) => existsSync(s.path)))
    ) {
      throw new Error(
        "Cleanup execution record disappeared before paths/ref cleanup.",
      );
    }
    const local = this.localBranchSha(task.taskBranch);
    if (local && local !== receipt.taskSha)
      throw new Error(`Local ${task.taskBranch} moved; cleanup refused.`);
    if (!this.gitCommonDir) throw new Error("Missing Git common directory.");
    for (const entry of receipt.snapshots[1]?.entries ?? []) {
      const name = entry.path.split("/").at(-1)!;
      if (name.endsWith(".lock") || name === "locked")
        throw new Error(`Locked Git cleanup path: ${entry.path}`);
    }
    for (const name of await readdir(this.gitCommonDir)) {
      if (name.endsWith(".lock"))
        throw new Error(`Locked Git cleanup: ${name}`);
    }
    const refLock = join(
      this.gitCommonDir,
      "refs",
      "heads",
      `${task.taskBranch}.lock`,
    );
    await directoryStamps(refLock);
    if (lstatSync(refLock, { throwIfNoEntry: false }))
      throw new Error(`Locked Git ref: ${refLock}`);
    await this.checkCleanupGit(receipt);
    if (receipt.backup) {
      await verifyBackupSnapshots(receipt.backup, receipt.snapshots);
      if (
        hash(await readRegular(join(receipt.backup, "record.json"))) !==
        receipt.recordHash
      )
        throw new Error("Cleanup backup record changed.");
    }
    // Leave source/ancestor checks last, after other asynchronous validation.
    for (const snapshot of receipt.snapshots) await verifySnapshot(snapshot);
  }

  private async checkCleanupGit(receipt?: CleanupReceipt): Promise<void> {
    const root = join(this.gitCommonDir!, "worktrees");
    await directoryStamps(join(root, "probe"));
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const admin = join(root, name);
      const known =
        receipt?.snapshots[1] && samePath(admin, receipt.snapshots[1].path);
      const stat = lstatSync(admin, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unknown Git registration: ${admin}`);
      const gitdir = join(admin, "gitdir");
      if (!lstatSync(gitdir, { throwIfNoEntry: false })) {
        if (known) continue; // only exact receipted partial metadata may disappear
        throw new Error(`Ambiguous Git registration: ${admin}`);
      }
      const target = (await readRegular(gitdir)).toString("utf8").trim();
      if (
        !singleLine(target) ||
        (receipt &&
          (known
            ? !samePath(target, join(receipt.snapshots[0].path, ".git"))
            : samePath(target, join(receipt.snapshots[0].path, ".git"))))
      )
        throw new Error(`Other Git cleanup ownership: ${admin}`);
    }
  }

  private async cleanupFinalized(
    task: BuilderTask,
    receipt: CleanupReceipt,
  ): Promise<void> {
    const receiptBytes = await readRegular(this.receiptPath(task.itemId));
    const guard = async () => {
      if (
        !(await readRegular(this.receiptPath(task.itemId))).equals(receiptBytes)
      )
        throw new Error("Cleanup receipt changed during cleanup.");
      await this.checkCleanup(task, receipt);
    };
    await this.fetchRequired(task.baseBranch);
    const baseSha = this.fetchedSha(task.baseBranch);
    if (!this.isAncestor(receipt.resultSha, baseSha))
      throw new Error(
        `Pushed result ${receipt.resultSha} is not on origin/${task.baseBranch}.`,
      );
    await guard();
    const args = [
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      `refs/heads/${task.taskBranch}`,
    ];
    const remote = await gitAsync(args, this.repoRoot);
    if (remote.ok) {
      const remoteSha = remote.stdout.trim().split(/\s+/)[0];
      if (
        !SHA.test(remoteSha) ||
        (!this.isAncestor(remoteSha, receipt.taskSha) &&
          !this.isAncestor(remoteSha, baseSha))
      )
        throw new Error(
          `Remote ${task.taskBranch} has unmerged work; cleanup refused.`,
        );
      await guard();
      await mustGitAsync(
        [
          "push",
          "origin",
          `--force-with-lease=refs/heads/${task.taskBranch}:${remoteSha}`,
          `:refs/heads/${task.taskBranch}`,
        ],
        this.repoRoot,
      );
    } else if (remote.status !== 2) throw processFailure("git", args, remote);
    for (const snapshot of receipt.snapshots) {
      await guard();
      if (this.entryForPath(snapshot.path)) {
        await mustGitAsync(
          ["worktree", "remove", snapshot.path],
          this.repoRoot,
        );
        if (this.entryForPath(snapshot.path))
          throw new Error(`Worktree registration remains: ${snapshot.path}`);
      }
      // Git may already have removed some/all entries. No registration permits only exact leftovers.
      await removeSnapshot(snapshot, guard);
    }
    await guard();
    // Preserve the local ref/record/receipt if the remote base moved during cleanup.
    await this.fetchRequired(task.baseBranch);
    if (!this.isAncestor(receipt.resultSha, this.fetchedSha(task.baseBranch)))
      throw new Error(
        `Pushed result ${receipt.resultSha} is not on origin/${task.baseBranch}.`,
      );
    const remaining = await gitAsync(args, this.repoRoot);
    if (remaining.ok)
      throw new Error("Remote task branch reappeared; cleanup refused.");
    if (remaining.status !== 2) throw processFailure("git", args, remaining);
    await guard();
    if (this.localBranchSha(task.taskBranch))
      await mustGitAsync(
        [
          "update-ref",
          "--no-deref",
          "-d",
          `refs/heads/${task.taskBranch}`,
          receipt.taskSha,
        ],
        this.repoRoot,
      );
    await guard();
    if (this.localBranchSha(task.taskBranch))
      throw new Error("Local task branch reappeared after cleanup.");
    if (this.has(task.itemId)) await unlink(this.recordPath(task.itemId));
    await guard();
    await unlink(this.receiptPath(task.itemId)); // last durable retry/completion signal
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

  async fetchRequired(...branches: string[]): Promise<void> {
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

  private async remoteSha(branch: string): Promise<string | undefined> {
    const result = await gitAsync(
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      this.repoRoot,
    );
    if (!result.ok) return undefined;
    return result.stdout.trim().split(/\s+/)[0];
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return git(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      this.repoRoot,
    ).ok;
  }
}
