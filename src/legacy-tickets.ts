import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  workflowProjectPaths,
  type PersistedRunState,
} from "@quintinshaw/pi-dynamic-workflows";
import { readdir } from "node:fs/promises";
import {
  directoryStamps,
  exactKeys,
  isCleanupSnapshot,
  readRegular,
  readEvidence,
  verifyEvidence,
  verifyEvidenceNow,
  type FileEvidence,
  prepareSnapshot,
  removalBatch,
  removeSnapshot,
  verifyBackupSnapshots,
  verifyParents,
  verifySnapshot,
  writeCleanupEvidence,
  type CleanupSnapshot,
  type PreparedSnapshot,
} from "./cleanup-snapshot.js";
import { checkOperation, operationCheckpoint, type OperationControl } from "./operation.js";
import { buildTasksForWave, type BuilderTask } from "./workflow-prompt.js";
import { sameTicketContract } from "./ticket-retry.js";
import { assertOwnerLock, type OwnerLock } from "./owner-lock.js";
import { legacyNeedsDesignColumn, type Config } from "./config.js";
import { isTargetIssue, type Card, type IssueComment } from "./gh.js";
import {
  isTicketExecutionRecord,
  isTicketExecutionRecordV5,
  TicketStateChangedError,
  mustGit,
  samePath,
  singleLine,
  type TicketFinalizationState,
  type TicketExecutionRecord,
  type TicketExecutionRecordV4,
  type TicketExecutionRecordV5,
  type StoredTicketExecutionRecord,
  type TicketWorktrees,
} from "./ticket-worktree.js";

export interface RepairRequest {
  requestKey: string;
  baseSha: string;
  taskSha: string;
}

export function isRepairRequest(value: unknown): value is RepairRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).length === 3 &&
    typeof r.requestKey === "string" &&
    /^[a-zA-Z0-9._:-]{1,200}$/.test(r.requestKey) &&
    typeof r.baseSha === "string" &&
    /^[0-9a-f]{40}$/.test(r.baseSha) &&
    typeof r.taskSha === "string" &&
    /^[0-9a-f]{40}$/.test(r.taskSha)
  );
}

type Step =
  | "comment"
  | "ready"
  | "reopen"
  | "queue"
  | "queued"
  | "consume"
  | "launching"
  | "consumed"
  | "blocked";
interface Handoff {
  schemaVersion: 1;
  request: RepairRequest;
  card: ReturnType<typeof identity>;
  record: TicketExecutionRecord;
  step: Step;
  attempted: boolean;
  commentId: string | null;
  runId: string | null;
  notice: { body: string; id: string | null } | null;
}
const steps: Step[] = [
  "comment",
  "ready",
  "reopen",
  "queue",
  "queued",
  "consume",
  "launching",
  "consumed",
  "blocked",
];
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const PREFIX = "<!-- board-agent-conflict-repair:";
export const conflictRequestKey = (
  itemId: string,
  baseSha: string,
  taskSha: string,
) => `conflict-${hash(JSON.stringify([itemId, baseSha, taskSha]))}`;
function identity(card: Card) {
  return {
    itemId: card.itemId,
    number: card.number!,
    repoOwner: card.repoOwner!,
    repoName: card.repoName!,
    contentType: card.contentType,
    type: card.type!,
    plan: card.plan!,
    title: card.title,
    body: card.body,
  };
}
interface CleanupReceipt {
  schemaVersion: 1 | 2;
  remoteTaskSha?: string | null;
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
const SHA = /^[0-9a-f]{40}$/i;

export interface LegacyMigrationReport {
  converted: string[];
  failures: Array<{ source: string; reason: string }>;
}

/** The only v3/v4 interpreter. Conversion never starts a manager, rewrites a run,
 * changes Git/worktree contents, or writes/collects old repair/cleanup evidence.
 * Legacy repair ledgers and workflow journals are read-only. */
export class LegacyTickets {
  private readonly dir: string;
  private owner?: OwnerLock;
  private canMigrate: () => boolean = () => true;
  private migrationStarted = false;
  private migrationTarget: 4 | 5 = 4;
  private control?: OperationControl;
  private readonly pendingFiles = new Set<string>();
  readonly pendingDesign = new Set<string>();
  private readonly failures = new Map<string, string>();
  constructor(
    private readonly deps: {
      worktrees: TicketWorktrees;
      cfg: Config;
      botLogin: string;
      repoOwner: string;
      repoName: string;
      board: {
        decisionComments?(card: Card): Promise<IssueComment[]>;
        getCard(itemId: string): Promise<Card | undefined>;
        setStatus(itemId: string, status: string): Promise<void>;
      };
    },
  ) {
    this.dir = join(deps.worktrees.repoRoot, ".pi", "board-agent", "repair");
  }

  /** A failed conversion may not fall back to the mutating v3 executor. */
  blockedReason(itemId: string): string | undefined {
    const { worktrees } = this.deps;
    const record = worktrees.readStored(itemId);
    return (
      this.failures.get(itemId) ??
      (this.pendingDesign.has(itemId)
        ? "Legacy Needs Design lane conversion is pending."
        : undefined) ??
      (this.migrationStarted &&
      ((!record && worktrees.has(itemId)) ||
        (this.pendingFiles.has(worktrees.recordPath(itemId)) &&
          record?.schemaVersion !== this.migrationTarget))
        ? "Legacy ticket conversion is pending or unsupported; sources preserved."
        : undefined)
    );
  }

  private assertOwner(): void {
    checkOperation(this.control);
    if (!this.owner || !this.canMigrate())
      throw new Error(
        "Startup migration cancelled; no hot update is permitted.",
      );
    assertOwnerLock(this.owner, this.deps.worktrees.repoRoot);
  }

  private bytes(path: string): Buffer {
    this.safePath(path);
    if (!lstatSync(path).isFile())
      throw new Error(`Not a regular source: ${path}`);
    return readFileSync(path);
  }

  private async archive(path: string, bytes: Buffer): Promise<void> {
    this.assertOwner();
    this.safePath(path);
    mkdirSync(dirname(path), { recursive: true });
    if (!lstatSync(path, { throwIfNoEntry: false }))
      await writeCleanupEvidence(path, bytes);
    if (!this.bytes(path).equals(bytes))
      throw new Error(`Create-only legacy backup differs: ${path}`);
    // Also finish a previously published archive's interrupted flush.
    for (const target of process.platform === "win32"
      ? [path]
      : [path, dirname(path)]) {
      const fd = openSync(target, target === path ? "r+" : "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  /** Unlike WorkflowManager.list(), corrupt files or differing duplicate IDs
   * must not disappear from a launch-window observation. Never call load(): its
   * backup recovery can write the journal. Stale leases are left to the manager. */
  private runs(
    record: StoredTicketExecutionRecord,
    stopped = false,
  ): PersistedRunState[] {
    const paths = workflowProjectPaths(record.path);
    const runs = new Map<string, PersistedRunState>();
    for (const dir of [paths.runsDir, paths.legacyRunsDir]) {
      this.safePath(join(dir, "probe"));
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json") && !name.endsWith(".lock")) continue;
        let value: any;
        try {
          value = JSON.parse(this.bytes(join(dir, name)).toString("utf8"));
        } catch (cause) {
          throw new Error(`Unreadable workflow journal: ${name}`, { cause });
        }
        if (name.endsWith(".lock")) {
          if (!stopped) continue;
          if (!Number.isSafeInteger(value?.pid) || value.pid <= 0)
            throw new Error(
              "Unreadable workflow lease; stop/drain must be confirmed.",
            );
          try {
            process.kill(value.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
            throw error;
          }
          throw new Error(
            `Workflow owner ${value.pid} is still alive; stop/drain before migration.`,
          );
        }
        if (
          !value ||
          typeof value.runId !== "string" ||
          name !== `${value.runId}.json` ||
          typeof value.script !== "string" ||
          !value.script.trim() ||
          !Number.isFinite(Date.parse(value.startedAt)) ||
          ![
            "running",
            "pending",
            "paused",
            "completed",
            "failed",
            "aborted",
          ].includes(value.status) ||
          !Array.isArray(value.agents)
        )
          throw new Error(`Unsupported workflow journal: ${name}`);
        if (runs.has(value.runId) && !equal(runs.get(value.runId), value))
          throw new Error(
            `Differing duplicate workflow journal: ${value.runId}`,
          );
        runs.set(value.runId, value);
      }
    }
    return [...runs.values()];
  }

  private launchMatches(
    record: StoredTicketExecutionRecord,
    runs: PersistedRunState[],
  ) {
    return runs.filter((run) => {
      const args = run.args as Record<string, unknown> | undefined;
      return (
        run.runId !== record.lastRunId &&
        args?.itemId === record.itemId &&
        args?.issueNumber === record.issueNumber &&
        args?.taskKey === record.taskKey &&
        (!Object.hasOwn(args, "repair") || isRepairRequest(args.repair)) &&
        // Published v4 observes the original journal, never replays a legacy
        // requested/queued/consumed ledger as new-run authorization.
        (record.schemaVersion !== 3 || this.matches(record, args, run.runId)) &&
        Date.parse(run.startedAt) >= (record.launchingAt ?? 0) - 1000
      );
    });
  }

  /** Re-observe an uncertain launch using strict on-disk journal reading. The
   * caller opens a manager only AFTER unique persisted matching; published v4
   * never needs a legacy ledger to authorize this observation. */
  observeLaunch(
    record: TicketExecutionRecord,
  ): TicketExecutionRecord | undefined {
    const matches = this.launchMatches(record, this.runs(record));
    if (matches.length !== 1) return undefined;
    return this.deps.worktrees.setActiveRun(
      record.itemId,
      matches[0].runId,
      Date.parse(matches[0].startedAt),
    );
  }

  /** Re-observe a published uncertain launch without replaying legacy ledgers. */
  observeLaunchV5(record: TicketExecutionRecordV5, owner: OwnerLock, assertCurrent: () => void): TicketExecutionRecordV5 | undefined {
    if (record.activeRunId || record.launchingAt === undefined)
      throw new Error("Only an uncertain launch may bind a persisted run.");
    const runs = this.runs(record);
    const matches = this.launchMatches(record, runs);
    if (matches.length !== 1) return undefined;
    return this.deps.worktrees.updateV5(record, (r) => ({ ...r, launchingAt: undefined,
      activeRunId: matches[0].runId, activeRunStartedAt: Date.parse(matches[0].startedAt) }), owner, () => {
      assertCurrent();
      if (!equal(this.runs(record), runs)) throw new Error("Legacy launch journal changed before publication.");
    });
  }

  /** Transitional v4 entry point. T05 switches the executor to migrateV5. */
  async migrate(
    owner: OwnerLock,
    canMigrate: () => boolean = () => true,
    control?: OperationControl,
  ): Promise<LegacyMigrationReport> {
    return this.migrateTo(4, owner, canMigrate, control);
  }

  async migrateV5(
    owner: OwnerLock,
    canMigrate: () => boolean = () => true,
    control?: OperationControl,
  ): Promise<LegacyMigrationReport> {
    return this.migrateTo(5, owner, canMigrate, control);
  }

  private async migrateTo(
    target: 4 | 5,
    owner: OwnerLock,
    canMigrate: () => boolean,
    control?: OperationControl,
  ): Promise<LegacyMigrationReport> {
    this.migrationTarget = target;
    const external = control;
    control = { ...control, check: () => {
      checkOperation(external);
      if (!canMigrate()) throw new Error("Startup migration cancelled.");
      assertOwnerLock(owner, this.deps.worktrees.repoRoot);
    } };
    this.control = control;
    const checkpoint = operationCheckpoint(control);
    this.owner = owner;
    this.canMigrate = canMigrate;
    this.assertOwner();
    this.migrationStarted = true;
    const report: LegacyMigrationReport = { converted: [], failures: [] };
    const { worktrees } = this.deps;
    const cleanupDir = join(
      worktrees.repoRoot,
      ".pi",
      "board-agent",
      "cleanup",
    );
    this.safePath(join(this.dir, "probe"));
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir).filter((n) =>
        n.endsWith(".json"),
      )) {
        try {
          this.read(name.slice(0, -5));
        } catch (error) {
          report.failures.push({
            source: join(this.dir, name),
            reason: String(error),
          });
        }
      }
    }
    const sources = new Set(
      readdirSync(worktrees.recordsDir).filter((n) => n.endsWith(".json")),
    );
    // An old cleanup may already have unlinked the ticket file. Its receipt is
    // the surviving source, not permission to invent the original raw bytes.
    for (const name of readdirSync(cleanupDir).filter((n) =>
      n.endsWith(".json"),
    ))
      sources.add(name);
    for (const name of sources)
      this.pendingFiles.add(join(worktrees.recordsDir, name));
    let completed = 0;
    for (const name of sources) {
      await checkpoint();
      this.assertOwner();
      control?.onProgress?.({ phase: "read-evidence", completed, total: sources.size, unit: "items" });
      let itemId: string | undefined;
      const path = join(worktrees.recordsDir, name);
      try {
        const bytes = lstatSync(path, { throwIfNoEntry: false })
          ? this.bytes(path)
          : undefined;
        const saved = bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
        if (
          (isTicketExecutionRecordV5(saved) ||
            (target === 4 && isTicketExecutionRecord(saved) && saved.schemaVersion === 4)) &&
          worktrees.recordPath(saved.itemId) === path
        ) {
          this.failures.delete(saved.itemId);
          continue; // never reinterpret old evidence for a published ticket
        }
        const receiptPath = join(cleanupDir, name);
        const receiptBytes = lstatSync(receiptPath, { throwIfNoEntry: false })
          ? await readRegular(receiptPath, control)
          : undefined;
        const rawReceipt = receiptBytes
          ? JSON.parse(receiptBytes.toString("utf8"))
          : undefined;
        let original: unknown = bytes ? saved : rawReceipt?.record;
        const recordless = !bytes && rawReceipt?.record === null;
        if (recordless) {
          if (
            !singleLine(rawReceipt.itemId) ||
            worktrees.recordPath(rawReceipt.itemId) !== path
          )
            throw new Error("Recordless receipt identity mismatch.");
          itemId = rawReceipt.itemId;
          const card = await this.deps.board.getCard(itemId!);
          if (
            !card ||
            !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName) ||
            card.itemId !== itemId
          )
            throw new Error("Recordless receipt has no matching target Issue.");
          const task = buildTasksForWave(this.deps.cfg, "", [card])[0];
          await this.readReceipt(task, control, receiptBytes); // Full validation before deriving execution metadata.
          original = {
            schemaVersion: 4,
            itemId,
            issueNumber: task.issueNumber,
            taskKey: task.taskKey,
            taskBranch: task.taskBranch,
            baseBranch: task.baseBranch,
            path: worktrees.pathFor(itemId!, task.issueNumber),
            createdAt: Date.now(),
          };
        }
        if (
          !isTicketExecutionRecord(original) ||
          worktrees.recordPath(original.itemId) !== path
        )
          throw new Error(
            "Unsupported/corrupt ticket source; not guessed or deleted.",
          );
        itemId = original.itemId;
        control?.onProgress?.({ phase: "read-evidence", itemId, issueNumber: original.issueNumber, completed, total: sources.size, unit: "items" });
        if (target === 4 && original.schemaVersion === 4 && !recordless) continue;
        this.assertOwner();
        const card = await this.deps.board.getCard(itemId);
        if (
          !card ||
          !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName) ||
          card.itemId !== itemId ||
          card.number !== original.issueNumber ||
          (card.type?.toLowerCase() !== "task" &&
            (!card.closed ||
              ![this.deps.cfg.columns.done, this.deps.cfg.columns.backlog].some(
                (s) => s.toLowerCase() === card.status?.toLowerCase(),
              ) ||
              original.activeRunId ||
              original.launchingAt !== undefined))
        )
          throw new Error(
            "Not the matching target-repository Task or closed completion Issue; preserved without writes.",
          );
        if (
          card.closed &&
          !original.activeRunId &&
          original.launchingAt === undefined &&
          !original.finalization &&
          !original.integration &&
          !original.retry &&
          !receiptBytes &&
          !this.all(itemId).length &&
          !worktrees.localBranchSha(original.taskBranch) &&
          !(await worktrees.remoteSha(original.taskBranch))
        ) {
          this.pendingFiles.delete(path);
          this.failures.delete(itemId);
          continue; // No-ref history keeps original bytes and leftovers; finalizer only moves Backlog.
        }
        if (
          !bytes &&
          receiptBytes &&
          (await this.completedReceipt(
            { ...original, title: card.title, body: card.body },
            card,
            control,
          ))
        ) {
          this.assertOwner();
          this.pendingFiles.delete(path);
          this.failures.delete(itemId);
          continue;
        }
        worktrees.assertOwnedPath(original);
        if (!receiptBytes && !original.finalization && !original.integration && original.retry?.stage !== "cleanup") {
          const check = worktrees.check(original, false); // dirty / MERGE_HEAD is intentionally allowed
          if (!check.ok)
            throw new Error(check.reason ?? "Unsafe legacy worktree.");
        }
        const runState = this.runs(original, true);
        // V4 already consumed v3 repair authority. Never replay a retained ledger.
        const handoffs = original.schemaVersion === 3 ? this.all(itemId) : [];
        // A corrupt/lost ledger cannot turn an authentic pending repair marker
        // into an ordinary Ready launch. Its issue scopes the failure; other
        // tickets with damaged, unidentifiable files remain independent.
        if (original.schemaVersion === 3 && this.deps.board.decisionComments) {
          const comments = await this.deps.board.decisionComments(card);
          if (
            comments.some(
              (c) =>
                c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() &&
                c.body.startsWith(PREFIX) &&
                !handoffs.some(
                  (h) =>
                    h.commentId === c.id &&
                    c.body.includes(h.request.requestKey),
                ),
            )
          )
            throw new Error(
              "Unrecognized authentic repair marker; missing/corrupt ledger preserved.",
            );
        }
        for (const h of handoffs) {
          if (
            h.record.path !== original.path ||
            h.record.createdAt !== original.createdAt ||
            h.record.taskBranch !== original.taskBranch ||
            h.record.baseBranch !== original.baseBranch ||
            h.card.number !== original.issueNumber
          )
            throw new Error(
              "Legacy repair identity does not match the original ticket.",
            );
        }
        const next: TicketExecutionRecordV4 = { ...original, schemaVersion: 4 };
        delete (next as TicketExecutionRecord).finalization;
        if (original.schemaVersion === 3 && original.launchingAt !== undefined) {
          const matches = this.launchMatches(original, runState);
          if (matches.length === 1) {
            delete next.launchingAt;
            next.activeRunId = matches[0].runId;
            next.activeRunStartedAt = Date.parse(matches[0].startedAt);
          }
        }
        if (original.schemaVersion === 3 && !next.activeRunId && next.launchingAt === undefined) {
          const pending = handoffs.filter(
            (h) => h.step !== "consumed" || h.runId !== original.lastRunId,
          );
          const matches = runState.filter((run) => {
            const args = run.args as Record<string, unknown> | undefined;
            return (
              run.runId !== original.lastRunId &&
              args?.itemId === original.itemId &&
              args?.issueNumber === original.issueNumber &&
              args?.taskKey === original.taskKey &&
              pending.some(
                (h) =>
                  (!h.runId || h.runId === run.runId) &&
                  equal(args?.repair, h.request),
              )
            );
          });
          if (matches.length === 1) {
            next.activeRunId = matches[0].runId;
            next.activeRunStartedAt = Date.parse(matches[0].startedAt);
          } else if (matches.length > 1) next.launchingAt = original.createdAt;
          else if (pending.some((h) => h.runId))
            throw new Error(
              "Bound repair run is missing; retain and reobserve, never launch another builder.",
            );
        }
        const task = { ...original, title: card.title, body: card.body };
        if ((receiptBytes || original.finalization) && !(target === 5 && original.schemaVersion === 4 && !recordless)) {
          const old = original.finalization;
          if (
            old &&
            (old.targetBranch !== original.baseBranch ||
              (original.reviewedTaskSha &&
                original.reviewedTaskSha !== old.taskSha))
          )
            throw new Error("Legacy finalization identity changed.");
          if (old && !old.resultSha && !receiptBytes) {
            await worktrees.fetchRequired(original.baseBranch);
            if (
              !worktrees.isAncestor(
                old.baseSha,
                worktrees.fetchedSha(original.baseBranch),
              )
            )
              throw new Error(
                "Legacy pre-result base is no longer in remote history.",
              );
            if (
              worktrees.localBranchSha(original.taskBranch) !== old.taskSha ||
              (await worktrees.remoteSha(original.taskBranch)) !== old.taskSha
            )
              throw new Error("Legacy pre-result task identity changed.");
            const check = worktrees.check(original, true);
            if (!check.ok)
              throw new Error(
                check.reason ?? "Unsafe legacy pre-result worktree.",
              );
          }
          const receipt = receiptBytes
            ? await this.readReceipt(task, control, receiptBytes)
            : undefined;
          if (receipt) await this.checkCleanup(task, receipt, control);
          if (old?.resultSha) await this.verifyLegacyResult(old);
          if (receipt && old?.resultSha && receipt.resultSha !== old.resultSha)
            throw new Error("Receipt and legacy result disagree.");
          const resultSha = receipt?.resultSha ?? old?.resultSha;
          if (resultSha) {
            next.integration = {
              // A receipt lacking old intent records an already integrated base,
              // not the pre-merge base. Never reconstruct it by guessing parents.
              baseSha: old?.baseSha ?? resultSha,
              taskSha: receipt?.taskSha ?? old!.taskSha,
              ...(receipt?.schemaVersion === 2
                ? { remoteTaskSha: receipt.remoteTaskSha! }
                : {}),
              resultSha,
            };
            await worktrees.fetchRequired(original.baseBranch);
            const integrated = worktrees.isAncestor(
              resultSha,
              worktrees.fetchedSha(original.baseBranch),
            );
            next.retry = {
              stage: integrated ? "cleanup" : "integrate",
              reason: integrated
                ? "Legacy result confirmed on fresh origin/base; cleanup only. Existing receipts remain read-only."
                : "Legacy recorded result is not confirmed on fresh origin/base; observe before push or cleanup.",
            };
          } else
            next.retry = {
              stage: "integrate",
              reason: `Legacy pre-result finalization: ${JSON.stringify(old)}`,
            };
        } else if (!next.activeRunId && next.launchingAt === undefined) {
          const pending = handoffs.filter(
            (h) => h.step !== "consumed" || (!h.runId && !original.lastRunId),
          );
          if (pending.length)
            next.retry = {
              stage: "build",
              reason: `Unlaunched legacy repair; continue the original worktree, merge base and test. Original request/diagnostics: ${JSON.stringify(pending.map((h) => ({ request: h.request, step: h.step, notice: h.notice, title: h.card.title, body: h.card.body })))}`,
            };
        }
        const archiveDir = join(
          worktrees.repoRoot,
          ".pi",
          "board-agent",
          bytes && original.schemaVersion === 4 ? "legacy-v4" : "legacy-v3",
        );
        const archivePath = join(archiveDir, bytes ? name : `receipt-${name}`);
        const source = bytes ?? receiptBytes!;
        await this.archive(archivePath, source);
        const receiptArchive = join(worktrees.repoRoot, ".pi", "board-agent", "legacy-v3", `receipt-${name}`);
        if (receiptBytes && bytes)
          await this.archive(receiptArchive, receiptBytes);
        await this.mapDesign(card);
        const assertSource = () => {
          this.assertOwner();
          if (
            !this.bytes(archivePath).equals(source) ||
            (target === 5 && (bytes ? !this.bytes(path).equals(bytes) : worktrees.has(original.itemId))) ||
            (receiptBytes && (!this.bytes(receiptPath).equals(receiptBytes) ||
              !this.bytes(receiptArchive).equals(receiptBytes))) ||
            !equal(this.runs(original, true), runState) ||
            (original.schemaVersion === 3 && !equal(this.all(itemId), handoffs))
          )
            throw new Error(
              "Legacy source/backup changed before atomic conversion.",
            );
        };
        if (target === 5) {
          const { record, assertGit } = await this.v5Draft(original, next, receiptBytes, assertSource);
          const observedRun = original.schemaVersion !== 3 ? undefined
            : next.activeRunId !== original.activeRunId && next.activeRunId
              ? { runId: next.activeRunId, startedAt: next.activeRunStartedAt! }
              : next.launchingAt !== original.launchingAt && next.launchingAt !== undefined
                ? { launchingAt: next.launchingAt } : undefined;
          worktrees.publishV5(original, record, bytes, owner, () => { assertSource(); assertGit(); }, observedRun);
        } else worktrees.publishLegacy(original, next, bytes, assertSource);
        this.failures.delete(itemId);
        report.converted.push(itemId);
      } catch (error) {
        this.assertOwner(); // Stop/owner loss is not a per-ticket migration failure.
        const reason = error instanceof Error ? error.message : String(error);
        if (itemId) this.failures.set(itemId, reason);
        report.failures.push({ source: path, reason });
      } finally {
        completed++;
      }
    }
    this.assertOwner();
    control?.onProgress?.({ phase: "read-evidence", completed, total: sources.size, unit: "items" });
    return report;
  }

  /** Finish the old in-memory draft directly as v5. This path observes only:
   * no ref writes, no fresh result commit and no intermediate v4 publication. */
  private async v5Draft(
    original: TicketExecutionRecord,
    draft: TicketExecutionRecordV4,
    receiptBytes: Buffer | undefined,
    assertSource: () => void,
  ): Promise<{ record: TicketExecutionRecordV5; assertGit: () => void }> {
    const { worktrees } = this.deps;
    const task = { ...original, title: "", body: "" };
    const guard = async () => { assertSource(); };
    assertSource();
    const { integration: _old, ...execution } = draft;
    const record: TicketExecutionRecordV5 = { ...execution, schemaVersion: 5 };
    if (!draft.integration && !original.finalization && !receiptBytes) {
      if (draft.retry?.stage === "cleanup")
        throw new Error("Legacy cleanup has no recorded result proof; sources retained.");
      return { record, assertGit: () => {} }; // active/idle execution needs no network observation
    }
    const local = worktrees.localBranchSha(original.taskBranch);
    const remote = (await worktrees.remoteSha(original.taskBranch)) ?? null;
    assertSource();
    const receipt = receiptBytes ? await this.readReceipt(task, this.control, receiptBytes) : undefined;
    if (receipt) {
      await this.checkCleanup(task, receipt, this.control);
      assertSource();
    }
    const state = draft.integration ?? (receipt ? {
      baseSha: receipt.resultSha, taskSha: receipt.taskSha, resultSha: receipt.resultSha,
      remoteTaskSha: receipt.schemaVersion === 2 ? receipt.remoteTaskSha! : receipt.taskSha,
    } : undefined);
    if (receipt && state && (state.resultSha !== receipt.resultSha || state.taskSha !== receipt.taskSha ||
        (receipt.schemaVersion === 2 && (state.remoteTaskSha ?? null) !== receipt.remoteTaskSha)))
      throw new Error("Receipt and legacy integration sources disagree.");
    if (original.finalization && state && (state.baseSha !== original.finalization.baseSha ||
        state.taskSha !== original.finalization.taskSha))
      throw new Error("Receipt and legacy finalization sources disagree.");
    let assertLegacyEvidence = () => {};
    if (original.finalization?.resultSha) await this.verifyLegacyResult(original.finalization, guard);
    // Receipt-only v4 conversion recorded the integrated base, not a pre-merge
    // intent. Its verified snapshots (including old squashes) are the proof;
    // never guess original parents or require task ancestry in that result.
    else if (original.integration && !(receipt && original.integration.baseSha === receipt.resultSha))
      assertLegacyEvidence = await this.verifyDirectResult(original, guard);
    assertSource();
    let base: string | undefined;
    let pending = false;
    if (state || original.finalization) {
      await worktrees.fetchRequired(original.baseBranch);
      assertSource();
      base = worktrees.fetchedSha(original.baseBranch);
      const intent = state ?? original.finalization!;
      if (!worktrees.isAncestor(intent.baseSha, base))
        throw new Error("Legacy base history was rewritten; sources retained.");
      const integrated = !!state && worktrees.isAncestor(state.resultSha, base);
      if (!integrated && (receipt || draft.retry?.stage === "cleanup"))
        throw new Error("Legacy cleanup result is absent from fresh origin/base; cleanup proof retained.");
      pending = !integrated;
      const remoteTaskSha = state?.remoteTaskSha === undefined ? intent.taskSha : state.remoteTaskSha;
      if (pending && (local !== intent.taskSha || remote !== remoteTaskSha))
        throw new Error("Legacy task sources changed; original result/work retained.");
      if (state) {
        const sources = { scope: { owner: this.deps.repoOwner, repo: this.deps.repoName,
          base: original.baseBranch, head: original.taskBranch },
          baseSha: state.baseSha, taskSha: state.taskSha, remoteTaskSha };
        if (integrated) {
          record.integration = { ...sources, kind: "legacy-completed", resultSha: state.resultSha };
          record.retry = { stage: "cleanup", reason: "Legacy result verified on fresh origin/base; immutable cleanup only." };
        } else {
          // A historical squash can be cleanup proof, but cannot be a normally
          // pushed PR head if it loses source ancestry. Never guess equivalence.
          for (const sha of [state.taskSha, remoteTaskSha])
            if (sha && !worktrees.isAncestor(sha, state.resultSha))
              throw new Error("Legacy result does not retain task source ancestry; cannot reuse it as a PR head.");
          record.integration = { ...sources, kind: "pr", phase: "prepared",
            preparedHeadSha: state.resultSha, initialPreparedHeadSha: state.resultSha };
          record.retry = draft.retry ?? { stage: "integrate", reason: "Reuse the verified legacy result on the task PR; never push base." };
        }
      }
    }
    if (((await worktrees.remoteSha(original.taskBranch)) ?? null) !== remote)
      throw new Error("Legacy remote task source changed during conversion.");
    const assertGit = () => {
      assertLegacyEvidence();
      if (worktrees.localBranchSha(original.taskBranch) !== local ||
          (base && worktrees.fetchedSha(original.baseBranch) !== base))
        throw new Error("Legacy Git sources changed before atomic conversion.");
      if (pending) {
        worktrees.cleanupRecord(task); // strict inventory/ownership, including an absent worktree
        if (existsSync(original.path) || worktrees.worktreeEntries().some((e) => samePath(e.path, original.path))) {
          const check = worktrees.check(original, true);
          if (!check.ok) throw new Error(check.reason ?? "Unsafe pending legacy worktree.");
        }
      }
    };
    assertSource();
    assertGit();
    return { record, assertGit };
  }

  /** Validate the old merge-tree/commit-tree algorithm, including its optional
   * local/remote combination, without creating another result commit. */
  private async verifyDirectResult(record: TicketExecutionRecord, guard: () => Promise<void>): Promise<() => void> {
    const { worktrees } = this.deps;
    const state = record.integration!;
    const remote = state.remoteTaskSha === undefined ? state.taskSha : state.remoteTaskSha;
    if (state.resultSha === state.baseSha) {
      for (const sha of [state.taskSha, remote])
        if (sha && !worktrees.isAncestor(sha, state.baseSha))
          throw new Error("Legacy base result does not cover its recorded sources.");
      return () => {};
    }
    const parents = mustGit(["show", "-s", "--format=%P", state.resultSha], worktrees.repoRoot).split(" ");
    if (parents.length === 1 && remote === state.taskSha) {
      // Native v4 never squashed. Only an exact archived v3 intent explains
      // this shape; an arbitrary one-parent task commit is not an old result.
      const path = join(worktrees.repoRoot, ".pi", "board-agent", "legacy-v3", basename(worktrees.recordPath(record.itemId)));
      if (!existsSync(path)) throw new Error("Legacy single-parent result lacks its original v3 evidence.");
      const bytes = this.bytes(path);
      const old: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isTicketExecutionRecord(old) || old.schemaVersion !== 3 || !old.finalization ||
          old.finalization.targetBranch !== record.baseBranch || old.finalization.baseSha !== state.baseSha ||
          old.finalization.taskSha !== state.taskSha || old.finalization.resultSha !== state.resultSha ||
          !["itemId", "issueNumber", "taskKey", "plan", "path", "createdAt", "taskBranch", "baseBranch", "lastRunId", "reviewedTaskSha"].every(
            (key) => old[key as keyof TicketExecutionRecord] === record[key as keyof TicketExecutionRecord]))
        throw new Error("Legacy single-parent result differs from archived v3 evidence.");
      await this.verifyLegacyResult(old.finalization, guard);
      return () => {
        if (!this.bytes(path).equals(bytes)) throw new Error("Archived legacy result evidence changed before publication.");
      };
    }
    if (parents.length !== 2 || parents[0] !== state.baseSha)
      throw new Error("Ambiguous legacy integration result parents.");
    let source = state.taskSha;
    if (remote && !worktrees.isAncestor(remote, source)) {
      if (worktrees.isAncestor(source, remote)) source = remote;
      else {
        source = parents[1];
        if (mustGit(["show", "-s", "--format=%P", source], worktrees.repoRoot) !== `${state.taskSha} ${remote}` ||
            await worktrees.resultTree({ baseSha: state.taskSha, taskSha: remote }, guard) !==
              mustGit(["rev-parse", `${source}^{tree}`], worktrees.repoRoot))
          throw new Error("Legacy combined task sources/tree mismatch.");
      }
    }
    if (parents[1] !== source || await worktrees.resultTree({ baseSha: state.baseSha, taskSha: source }, guard) !==
        mustGit(["rev-parse", `${state.resultSha}^{tree}`], worktrees.repoRoot))
      throw new Error("Legacy integration result sources/tree mismatch.");
    return () => {};
  }

  /** v3 allowed human-approved Done without AI review. Only the exact original
   * execution archived by migration may use that approval; a later v4 build or
   * a new ticket must pass review. The caller still checks fresh closed approval
   * and the exact clean local/remote task before preparing or pushing anything. */
  approvedTaskSha(record: TicketExecutionRecord): string | undefined {
    if (
      record.schemaVersion !== 4 ||
      record.reviewedTaskSha ||
      record.activeRunId ||
      record.launchingAt !== undefined ||
      (record.retry && ["build", "review"].includes(record.retry.stage))
    )
      return undefined;
    const { worktrees } = this.deps;
    const path = join(
      worktrees.repoRoot,
      ".pi",
      "board-agent",
      "legacy-v3",
      basename(worktrees.recordPath(record.itemId)),
    );
    if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
    let original: unknown;
    try {
      original = JSON.parse(this.bytes(path).toString("utf8"));
    } catch (cause) {
      throw new Error(`Unreadable legacy approval source: ${path}`, { cause });
    }
    if (
      !isTicketExecutionRecord(original) ||
      original.schemaVersion !== 3 ||
      original.activeRunId ||
      original.launchingAt !== undefined ||
      original.reviewedTaskSha
    )
      return undefined;
    const { schemaVersion: _oldVersion, finalization, ...source } = original;
    const {
      schemaVersion: _version,
      integration,
      retry: _retry,
      ...current
    } = record;
    if (!equal(source, current)) return undefined; // includes original lastRunId, createdAt, path and branch ownership
    worktrees.assertOwnedPath(original);
    const check = worktrees.check(original, true);
    if (!check.ok)
      throw new Error(check.reason ?? "Unsafe original legacy worktree.");
    return (
      finalization?.taskSha ??
      integration?.taskSha ??
      worktrees.localBranchSha(original.taskBranch)
    );
  }

  /** Conversion and verified legacy residual evidence only. */
  private async readReceipt(task: BuilderTask, control?: OperationControl, bytes?: Buffer): Promise<CleanupReceipt> {
    checkOperation(control);
    const path = join(
      this.deps.worktrees.repoRoot,
      ".pi",
      "board-agent",
      "cleanup",
      basename(this.deps.worktrees.recordPath(task.itemId)),
    );
    let r: any;
    try {
      r = JSON.parse((bytes ?? await readRegular(path, control)).toString("utf8"));
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
        ...(r?.schemaVersion === 2 ? ["remoteTaskSha"] : []),
      ]) ||
      ![1, 2].includes(r.schemaVersion) ||
      (r.schemaVersion === 2 &&
        r.remoteTaskSha !== null &&
        (typeof r.remoteTaskSha !== "string" || !SHA.test(r.remoteTaskSha))) ||
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
          r.record.schemaVersion === 3 &&
          typeof r.recordHash === "string" &&
          /^[0-9a-f]{64}$/.test(r.recordHash)) ||
      !Array.isArray(r.snapshots) ||
      r.snapshots.length < 1 ||
      r.snapshots.length > 2 ||
      !r.snapshots.every(isCleanupSnapshot) ||
      !isCleanupSnapshot({ path, parents: r.parents, entries: [] }) ||
      r.parents.length !== (await directoryStamps(path)).length ||
      !this.deps.worktrees.gitCommonDir ||
      !isCleanupSnapshot({
        path: join(this.deps.worktrees.gitCommonDir, "probe"),
        parents: r.gitParents,
        entries: [],
      }) ||
      r.gitParents.length !==
        (await directoryStamps(join(this.deps.worktrees.gitCommonDir, "probe")))
          .length ||
      !(
        r.backup === null ||
        (singleLine(r.backup) &&
          samePath(
            dirname(r.backup),
            join(
              this.deps.worktrees.repoRoot,
              ".pi",
              "board-agent",
              "cleanup-backups",
            ),
          ))
      )
    )
      throw new Error(`Corrupt or unsupported cleanup receipt: ${path}`);
    const receipt = r as CleanupReceipt;
    if (
      !samePath(
        receipt.snapshots[0].path,
        this.deps.worktrees.pathFor(task.itemId, task.issueNumber),
      ) ||
      (receipt.snapshots[1] &&
        (!this.deps.worktrees.gitCommonDir ||
          !samePath(
            dirname(receipt.snapshots[1].path),
            join(this.deps.worktrees.gitCommonDir, "worktrees"),
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
    for (const entry of receipt.snapshots[1]?.entries ?? []) {
      const name = entry.path.split("/").at(-1)!;
      if (name.endsWith(".lock") || name === "locked")
        throw new Error(`Locked Git cleanup path: ${entry.path}`);
    }
    await verifyParents(receipt.gitParents);
    await this.checkCleanupGit(receipt, control);
    this.deps.worktrees.validateBranches(
      receipt.taskBranch,
      receipt.baseBranch,
    );
    if (receipt.taskBranch === receipt.baseBranch)
      throw new Error("Task branch must differ from the base branch.");
    await verifyParents(receipt.parents);
    return receipt;
  }

  private async verifyLegacyResult(
    old: TicketFinalizationState,
    guard: () => Promise<void> = async () => {},
  ): Promise<void> {
    // Prove the recorded merge/squash, not a new merge against today's possibly conflicting base.
    const parents = mustGit(
      ["show", "-s", "--format=%P", old.resultSha!],
      this.deps.worktrees.repoRoot,
    );
    if (parents !== old.baseSha && parents !== `${old.baseSha} ${old.taskSha}`)
      throw new Error("Ambiguous legacy finalization result parents.");
    let tree: string;
    try {
      tree = await this.deps.worktrees.resultTree(old, guard);
    } catch (error) {
      throw new Error("Ambiguous legacy finalization result tree.", {
        cause: error,
      });
    }
    if (
      tree !==
      mustGit(
        ["rev-parse", `${old.resultSha}^{tree}`],
        this.deps.worktrees.repoRoot,
      )
    )
      throw new Error("Legacy finalization result tree mismatch.");
  }

  private async checkCleanup(
    task: BuilderTask,
    receipt: CleanupReceipt,
    control?: OperationControl,
    full = true,
  ): Promise<void> {
    checkOperation(control);
    await verifyParents(receipt.parents);
    await verifyParents(receipt.gitParents);
    const stored = this.deps.worktrees.readStored(task.itemId);
    const record = stored?.schemaVersion === 5
      ? this.deps.worktrees.cleanupRecordV5(task) : this.deps.worktrees.cleanupRecord(task);
    if (record) {
      if (record.schemaVersion === 5 && record.integration?.kind !== "legacy-completed")
        throw new Error("Only legacy-completed records may consume old cleanup evidence.");
      const integration = record.integration;
      if (
        record.schemaVersion !== 3
          ? (receipt.record &&
              ![
                "itemId",
                "issueNumber",
                "taskKey",
                "plan",
                "taskBranch",
                "baseBranch",
                "path",
                "createdAt",
              ].every(
                (key) =>
                  record[key as keyof TicketExecutionRecordV5] ===
                  receipt.record![key as keyof TicketExecutionRecord],
              )) ||
            integration?.taskSha !== receipt.taskSha ||
            !integration || !("resultSha" in integration) || integration.resultSha !== receipt.resultSha ||
            (receipt.schemaVersion === 2 &&
              integration.remoteTaskSha !== receipt.remoteTaskSha)
          : !receipt.record ||
            JSON.stringify(record) !== JSON.stringify(receipt.record) ||
            hash(
              await readRegular(this.deps.worktrees.recordPath(task.itemId), control),
            ) !== receipt.recordHash
      )
        throw new Error("Cleanup execution record changed.");
    } else if (
      receipt.record &&
      (this.deps.worktrees.localBranchSha(task.taskBranch) ||
        receipt.snapshots.some((s) => existsSync(s.path)))
    ) {
      throw new Error(
        "Cleanup execution record disappeared before paths/ref cleanup.",
      );
    }
    const local = this.deps.worktrees.localBranchSha(task.taskBranch);
    if (local && local !== receipt.taskSha)
      throw new Error(`Local ${task.taskBranch} moved; cleanup refused.`);
    if (!this.deps.worktrees.gitCommonDir)
      throw new Error("Missing Git common directory.");
    for (const name of await readdir(this.deps.worktrees.gitCommonDir)) {
      if (name.endsWith(".lock"))
        throw new Error(`Locked Git cleanup: ${name}`);
    }
    const refLock = join(
      this.deps.worktrees.gitCommonDir,
      "refs",
      "heads",
      `${task.taskBranch}.lock`,
    );
    await directoryStamps(refLock);
    if (lstatSync(refLock, { throwIfNoEntry: false }))
      throw new Error(`Locked Git ref: ${refLock}`);
    await this.checkCleanupGit(receipt, control);
    checkOperation(control);
    if (!full) return;
    if (receipt.backup) {
      await verifyBackupSnapshots(receipt.backup, receipt.snapshots, control);
      if (
        hash(await readRegular(join(receipt.backup, "record.json"), control)) !==
        receipt.recordHash
      )
        throw new Error("Cleanup backup record changed.");
    }
    // Leave source/ancestor checks last, after other asynchronous validation.
    for (const snapshot of receipt.snapshots) await verifySnapshot(snapshot, true, control);
  }

  private async checkCleanupGit(receipt?: CleanupReceipt, control?: OperationControl): Promise<void> {
    const root = join(this.deps.worktrees.gitCommonDir!, "worktrees");
    await directoryStamps(join(root, "probe"));
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      checkOperation(control);
      const admin = join(root, name);
      const known =
        receipt?.snapshots[1] && samePath(admin, receipt.snapshots[1].path);
      const stat = lstatSync(admin, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unknown Git registration: ${admin}`);
      if (known && (await readdir(admin)).some((file) => file === "locked" || file.endsWith(".lock")))
        throw new Error(`Locked Git cleanup: ${admin}`);
      const gitdir = join(admin, "gitdir");
      if (!lstatSync(gitdir, { throwIfNoEntry: false })) {
        if (known) continue; // only exact receipted partial metadata may disappear
        throw new Error(`Ambiguous Git registration: ${admin}`);
      }
      const target = (await readRegular(gitdir, control)).toString("utf8").trim();
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

  /** Old receipts are immutable conversion evidence, not a second ticket store.
   * Fresh Done + integrated base + absent artifacts is sufficient completion
   * evidence on restart; no tombstone and no receipt GC. */
  async completedReceipt(task: BuilderTask, expected: Card, control?: OperationControl): Promise<boolean> {
    const { worktrees, board, cfg, repoOwner, repoName, botLogin } = this.deps;
    if (worktrees.has(task.itemId) || !worktrees.hasCleanupReceipt(task.itemId))
      return false;
    const receipt = await this.readReceipt(task, control);
    await this.checkCleanup(task, receipt, control);
    await worktrees.fetchRequired(task.baseBranch);
    if (
      !worktrees.isAncestor(
        receipt.resultSha,
        worktrees.fetchedSha(task.baseBranch),
      ) ||
      (await worktrees.remoteSha(task.taskBranch))
    )
      return false;
    const card = await board.getCard(task.itemId);
    if (
      !card ||
      !isTargetIssue(card, repoOwner, repoName) ||
      !sameTicketContract(card, expected) ||
      !card.closed ||
      ![cfg.columns.done, cfg.columns.backlog].some(
        (s) => s.toLowerCase() === card.status?.toLowerCase(),
      ) ||
      card.assignees.some((a) => a.toLowerCase() !== botLogin.toLowerCase())
    )
      return false;
    if (
      worktrees.has(task.itemId) ||
      worktrees.localBranchSha(task.taskBranch) ||
      receipt.snapshots.some((s) => existsSync(s.path)) ||
      worktrees
        .worktreeEntries()
        .some(
          (e) =>
            e.branch === task.taskBranch ||
            samePath(e.path, receipt.snapshots[0].path),
        )
    )
      return false;
    return true;
  }

  /** The only residual deletion path: existing, unchanged v3 snapshots, after
   * conversion. Never called as a fallback when normal worktree remove fails. */
  async cleanupResidual(record: StoredTicketExecutionRecord, control?: OperationControl) {
    const { worktrees } = this.deps;
    const external = control;
    const evidence: FileEvidence[] = [];
    control = { ...control, check: () => {
      checkOperation(external);
      if (!equal(worktrees.readStored(record.itemId), record))
        throw new TicketStateChangedError("Legacy cleanup record changed; work retained.");
      // Recheck immutable evidence even after an awaited authorization/long hash,
      // without repeating expensive Git probes or rereading whole receipts.
      for (const file of evidence) verifyEvidenceNow(file);
    } };
    checkOperation(control);
    if (worktrees.worktreeEntries().some((e) => samePath(e.path, record.path)))
      throw new Error("Registered worktree requires normal Git removal.");
    if (!worktrees.hasCleanupReceipt(record.itemId)) {
      if (existsSync(record.path))
        throw new Error("Unknown unregistered residual; no legacy snapshot evidence.");
      return undefined;
    }
    control?.onProgress?.({ phase: "read-evidence" });
    const task = { ...record, title: "", body: "" };
    const path = join(worktrees.repoRoot, ".pi", "board-agent", "cleanup", basename(worktrees.recordPath(record.itemId)));
    const original = await readEvidence(path, control);
    const archive = await readEvidence(join(worktrees.repoRoot, ".pi", "board-agent", "legacy-v3", `receipt-${basename(path)}`), control);
    if (!archive.bytes.equals(original.bytes))
      throw new Error("Legacy receipt differs from converted evidence.");
    const receipt = await this.readReceipt(task, control, original.bytes);
    await this.checkCleanup(task, receipt, control, false);
    evidence.push(original.evidence, archive.evidence);
    const backup = receipt.backup ? await verifyBackupSnapshots(receipt.backup, receipt.snapshots, control) : undefined;
    if (backup) {
      const saved = await readEvidence(join(receipt.backup!, "record.json"), control);
      if (hash(saved.bytes) !== receipt.recordHash) throw new Error("Cleanup backup record changed.");
      evidence.push(backup.manifest, saved.evidence);
    }
    const prepared: PreparedSnapshot[] = [];
    for (const [i, snapshot] of receipt.snapshots.entries()) {
      const source = await prepareSnapshot(snapshot, control);
      source.backup = backup?.copies[i];
      prepared.push(source);
    }
    const check = async () => {
      checkOperation(control);
      for (const file of evidence) await verifyEvidence(file);
      await this.checkCleanup(task, receipt, control, false);
      checkOperation(control);
    };
    await check();
    let consumed = false;
    return {
      remove: async (authorize: () => Promise<void>, local: () => void) => {
        if (consumed) throw new Error("Legacy cleanup context already consumed.");
        consumed = true; // Never reuse authorization after failure or partial cleanup.
        const batch = removalBatch(authorize, async () => { await check(); local(); }, control);
        for (const snapshot of prepared) await removeSnapshot(snapshot, batch, control);
        // Full evidence is read only at preparation and completion; metadata
        // pins reject replacement in between rather than accepting new evidence.
        await check();
        if (!(await readRegular(path, control)).equals(original.bytes) ||
            !(await readRegular(archive.evidence.path, control)).equals(original.bytes))
          throw new Error("Legacy evidence changed during cleanup.");
        if (receipt.backup) {
          await verifyBackupSnapshots(receipt.backup, receipt.snapshots, control);
          if (hash(await readRegular(join(receipt.backup, "record.json"), control)) !== receipt.recordHash)
            throw new Error("Cleanup backup record changed.");
        }
        await check();
        for (const snapshot of receipt.snapshots) {
          await verifyParents(snapshot.parents, true);
          if (lstatSync(snapshot.path, { throwIfNoEntry: false })) throw new Error(`Cleanup directory remains: ${snapshot.path}`);
        }
        await authorize();
        await check();
        local();
      },
    };
  }

  /** Keep the original question in the issue/comments. Only the lane changes;
   * identity, withdrawal and other people's claims never authorize a write. */
  async mapDesign(expected: Card): Promise<void> {
    const { cfg, board } = this.deps;
    if (!this.owner) return; // only owner-held startup/recovery converts old lanes
    this.pendingDesign.delete(expected.itemId);
    if (
      expected.closed ||
      expected.status?.toLowerCase() !==
        legacyNeedsDesignColumn(cfg).toLowerCase() ||
      !isTargetIssue(expected, this.deps.repoOwner, this.deps.repoName, "Task")
    )
      return;
    // Re-observe a failed/stale migration independently of other tickets.
    this.pendingDesign.add(expected.itemId);
    const card = await board.getCard(expected.itemId);
    if (
      !card ||
      !equal(identity(card), identity(expected)) ||
      card.closed ||
      card.status !== expected.status ||
      card.assignees.some(
        (a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase(),
      )
    )
      return;
    if (this.owner) this.assertOwner();
    await board.setStatus(card.itemId, cfg.columns.needs_human);
    expected.status = cfg.columns.needs_human;
    this.pendingDesign.delete(expected.itemId);
  }

  private safePath(path: string): void {
    for (let p = resolve(path); ; p = dirname(p)) {
      const stat = lstatSync(p, { throwIfNoEntry: false });
      if (
        stat &&
        (stat.isSymbolicLink() || (p !== resolve(path) && !stat.isDirectory()))
      )
        throw new Error("Unsafe repair ledger path.");
      if (p === dirname(p)) break;
    }
  }
  private file(key: string) {
    if (!/^conflict-[0-9a-f]{64}$/.test(key))
      throw new Error("Invalid conflict request key.");
    return join(this.dir, `${key}.json`);
  }
  private read(key: string): Handoff | undefined {
    const path = this.file(key);
    this.safePath(path);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new Error("Invalid repair ledger file.");
    let h: Handoff;
    try {
      h = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error("Corrupt or unreadable repair ledger.", { cause: error });
    }
    if (
      !exactKeys(h, [
        "schemaVersion",
        "request",
        "card",
        "record",
        "step",
        "attempted",
        "commentId",
        "runId",
        "notice",
      ]) ||
      h.schemaVersion !== 1 ||
      !isRepairRequest(h.request) ||
      h.request.requestKey !== key ||
      !exactKeys(h.card, [
        "itemId",
        "number",
        "repoOwner",
        "repoName",
        "contentType",
        "type",
        "plan",
        "title",
        "body",
      ]) ||
      !isTicketExecutionRecord(h.record) ||
      h.record.finalization ||
      h.record.activeRunId ||
      h.record.launchingAt !== undefined ||
      h.card.itemId !== h.record.itemId ||
      h.card.number !== h.record.issueNumber ||
      h.card.contentType !== "Issue" ||
      h.card.type?.toLowerCase() !== "task" ||
      ![
        h.card.repoOwner,
        h.card.repoName,
        h.card.plan,
        h.card.title,
        h.card.body,
      ].every((s) => typeof s === "string") ||
      !h.card.plan ||
      key !==
        conflictRequestKey(
          h.card.itemId,
          h.request.baseSha,
          h.request.taskSha,
        ) ||
      !steps.includes(h.step) ||
      typeof h.attempted !== "boolean" ||
      !(
        h.commentId === null ||
        (typeof h.commentId === "string" && !!h.commentId)
      ) ||
      !(h.runId === null || (typeof h.runId === "string" && !!h.runId)) ||
      !(
        h.notice === null ||
        (exactKeys(h.notice, ["body", "id"]) &&
          typeof h.notice.body === "string" &&
          !!h.notice.body &&
          (h.notice.id === null ||
            (typeof h.notice.id === "string" && !!h.notice.id)))
      ) ||
      (!["comment", "blocked"].includes(h.step) && !h.commentId)
    )
      throw new Error("Corrupt or unsupported repair ledger.");
    return h;
  }
  private all(itemId?: string): Handoff[] {
    this.safePath(join(this.dir, "probe"));
    if (!existsSync(this.dir)) return [];
    const result: Handoff[] = [];
    for (const name of readdirSync(this.dir).filter((n) =>
      n.endsWith(".json"),
    )) {
      // A damaged ticket ledger must not stop unrelated running tickets. The
      // untrusted identity is used ONLY to block that ticket, never as authority.
      let hint: any;
      try {
        hint = JSON.parse(this.bytes(join(this.dir, name)).toString("utf8"));
      } catch {
        /* retained and reported by migration below */
      }
      try {
        const h = this.read(name.slice(0, -5))!;
        if (!itemId || h.card.itemId === itemId) result.push(h);
      } catch (error) {
        const id = hint?.card?.itemId ?? hint?.record?.itemId;
        if (typeof id === "string") this.failures.set(id, String(error));
        if (itemId && id === itemId) throw error;
      }
    }
    return result;
  }
  private readIfConflict(repair: RepairRequest) {
    return repair.requestKey.startsWith("conflict-")
      ? this.read(repair.requestKey)
      : undefined;
  }
  /** The retained run binding is authority even if its optional args/file was
   * lost. A later explicit ordinary retry has a different run ID. */
  private boundRun(
    record: TicketExecutionRecord,
    runId?: string,
  ): Handoff | undefined {
    const handoffs = this.all(record.itemId);
    const bound = handoffs.filter(
      (h) => !!runId && h.runId === runId && h.step === "consumed",
    );
    if (bound.length > 1)
      throw new Error("Multiple repair requests bind the same run.");
    const h = bound[0];
    if (
      h &&
      (h.card.itemId !== record.itemId ||
        h.record.createdAt !== record.createdAt ||
        h.record.path !== record.path ||
        h.record.taskBranch !== record.taskBranch ||
        h.record.baseBranch !== record.baseBranch)
    )
      throw new Error("Repair run binding does not match the ticket record.");
    return h;
  }
  private requestForRun(
    record: TicketExecutionRecord,
    runId?: string,
  ): RepairRequest | undefined {
    return this.boundRun(record, runId)?.request;
  }
  private matches(
    record: TicketExecutionRecord,
    args: unknown,
    runId = record.activeRunId,
  ): boolean {
    const pending = this.all(record.itemId).filter(
      (h) => h.step === "launching" && record.schemaVersion === 3,
    );
    const repair = (args as { repair?: RepairRequest } | undefined)?.repair;
    const required = this.requestForRun(record, runId);
    if (required && !equal(required, repair)) return false;
    if (
      pending.length &&
      (pending.length !== 1 || !equal(pending[0].request, repair))
    )
      return false;
    if (!repair?.requestKey.startsWith("conflict-")) return true;
    const h = this.readIfConflict(repair);
    return (
      !!h &&
      equal(h.request, repair) &&
      h.card.itemId === record.itemId &&
      h.record.createdAt === record.createdAt &&
      ["launching", "consumed"].includes(h.step) &&
      (!h.runId || h.runId === runId)
    );
  }
}
