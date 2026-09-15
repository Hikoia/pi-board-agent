import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { workflowProjectPaths, type PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { exactKeys, writeCleanupEvidence } from "./cleanup-snapshot.js";
import { assertOwnerLock, type OwnerLock } from "./owner-lock.js";
import type { Config } from "./config.js";
import { planSlug, taskBranch } from "./config.js";
import { isTargetIssue, type Card, type IssueComment } from "./gh.js";
import { isRepairRequest, type RepairRequest } from "./repair.js";
import {
  isTicketExecutionRecord,
  type TicketExecutionRecord,
  type TicketExecutionRecordV4,
  type TicketWorktrees,
} from "./ticket-worktree.js";

/** Deliberately optional on offline boards. Never substitute live APIs for a
 * missing author-aware reader or write capability. Mutation replies aren't authority. */
export interface ConflictBoardOps {
  listComments(card: Card): Promise<IssueComment[]>;
  createComment(card: Card, body: string): Promise<string>;
  updateComment(card: Card, id: string, body: string): Promise<void>;
  reopen(card: Card): Promise<void>;
}
export interface RepairBlocker {
  status: "blocked";
  reason: string;
  repair?: RepairRequest;
}
class HandoffChanged extends Error {}
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
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
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
function marker(h: Handoff, phase: "requested" | "queued" | "consumed") {
  return `${PREFIX}v1:${h.request.requestKey} -->\n${JSON.stringify({ schemaVersion: 1, ...h.request, itemId: h.card.itemId, issueNumber: h.card.number, repoOwner: h.card.repoOwner, repoName: h.card.repoName, plan: h.card.plan, title: h.card.title, bodyHash: hash(h.card.body), taskBranch: h.record.taskBranch, baseBranch: h.record.baseBranch, recordCreatedAt: h.record.createdAt, phase })}`;
}

export interface LegacyMigrationReport {
  converted: string[];
  failures: Array<{ source: string; reason: string }>;
}

/** The only v3 interpreter. Conversion never starts a manager, rewrites a run,
 * changes Git/worktree contents, or writes/collects old repair/cleanup evidence.
 * The old v3 execution methods below remain only until T003/T004 replace them. */
export class LegacyTickets {
  private readonly dir: string;
  private owner?: OwnerLock;
  private canMigrate: () => boolean = () => true;
  private migrationStarted = false;
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
        conflict?: ConflictBoardOps;
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
    const record = worktrees.read(itemId);
    return this.failures.get(itemId) ??
      (this.pendingDesign.has(itemId) ? "Legacy Needs Design lane conversion is pending." : undefined) ??
      (this.migrationStarted &&
       ((!record && worktrees.has(itemId)) ||
        (this.pendingFiles.has(worktrees.recordPath(itemId)) && record?.schemaVersion !== 4))
        ? "Legacy ticket conversion is pending or unsupported; sources preserved."
        : undefined);
  }

  private assertOwner(): void {
    if (!this.owner || !this.canMigrate())
      throw new Error("Startup migration cancelled; no hot update is permitted.");
    assertOwnerLock(this.owner, this.deps.worktrees.repoRoot);
  }

  private bytes(path: string): Buffer {
    this.safePath(path);
    if (!lstatSync(path).isFile()) throw new Error(`Not a regular source: ${path}`);
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
    for (const target of process.platform === "win32" ? [path] : [path, dirname(path)]) {
      const fd = openSync(target, target === path ? "r+" : "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }

  /** Unlike WorkflowManager.list(), corrupt files or differing duplicate IDs
   * must not disappear from a launch-window observation. Never call load(): its
   * backup recovery can write the journal. Stale leases are left to the manager. */
  private runs(record: TicketExecutionRecord, stopped = false): PersistedRunState[] {
    const paths = workflowProjectPaths(record.path);
    const runs = new Map<string, PersistedRunState>();
    for (const dir of [paths.runsDir, paths.legacyRunsDir]) {
      this.safePath(join(dir, "probe"));
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json") && !name.endsWith(".lock")) continue;
        const value = JSON.parse(this.bytes(join(dir, name)).toString("utf8"));
        if (name.endsWith(".lock")) {
          if (!stopped) continue;
          if (!Number.isSafeInteger(value?.pid) || value.pid <= 0)
            throw new Error("Unreadable workflow lease; stop/drain must be confirmed.");
          try { process.kill(value.pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
            throw error;
          }
          throw new Error(`Workflow owner ${value.pid} is still alive; stop/drain before migration.`);
        }
        if (!value || typeof value.runId !== "string" || name !== `${value.runId}.json` ||
            typeof value.script !== "string" || !value.script.trim() ||
            !Number.isFinite(Date.parse(value.startedAt)) ||
            !["running", "pending", "paused", "completed", "failed", "aborted"].includes(value.status) ||
            !Array.isArray(value.agents))
          throw new Error(`Unsupported workflow journal: ${name}`);
        if (runs.has(value.runId) && !equal(runs.get(value.runId), value))
          throw new Error(`Differing duplicate workflow journal: ${value.runId}`);
        runs.set(value.runId, value);
      }
    }
    return [...runs.values()];
  }

  private launchMatches(record: TicketExecutionRecord, runs: PersistedRunState[]) {
    return runs.filter((run) => {
      const args = run.args as Record<string, unknown> | undefined;
      return run.runId !== record.lastRunId && args?.itemId === record.itemId &&
        args?.issueNumber === record.issueNumber && args?.taskKey === record.taskKey &&
        (!Object.hasOwn(args, "repair") || isRepairRequest(args.repair)) &&
        this.matches(record, args, run.runId) &&
        Date.parse(run.startedAt) >= (record.launchingAt ?? 0) - 1000;
    });
  }

  /** Re-observe, don't clear/quarantine an uncertain migrated launch. The caller
   * opens a manager only AFTER unique persisted matching and v4 publication. */
  observeLaunch(record: TicketExecutionRecord): TicketExecutionRecord | undefined {
    const matches = this.launchMatches(record, this.runs(record));
    if (matches.length !== 1) return undefined;
    return this.deps.worktrees.setActiveRun(record.itemId, matches[0].runId,
      Date.parse(matches[0].startedAt));
  }

  async migrate(owner: OwnerLock, canMigrate: () => boolean = () => true): Promise<LegacyMigrationReport> {
    this.owner = owner;
    this.canMigrate = canMigrate;
    this.assertOwner();
    this.migrationStarted = true;
    const report: LegacyMigrationReport = { converted: [], failures: [] };
    const { worktrees } = this.deps;
    const cleanupDir = join(worktrees.repoRoot, ".pi", "board-agent", "cleanup");
    this.safePath(join(this.dir, "probe"));
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".json"))) {
        try { this.read(name.slice(0, -5)); }
        catch (error) { report.failures.push({ source: join(this.dir, name), reason: String(error) }); }
      }
    }
    const sources = new Set(readdirSync(worktrees.recordsDir).filter((n) => n.endsWith(".json")));
    // An old cleanup may already have unlinked the ticket file. Its receipt is
    // the surviving source, not permission to invent the original raw bytes.
    for (const name of readdirSync(cleanupDir).filter((n) => n.endsWith(".json"))) sources.add(name);
    for (const name of sources) this.pendingFiles.add(join(worktrees.recordsDir, name));
    for (const name of sources) {
      this.assertOwner();
      let itemId: string | undefined;
      const path = join(worktrees.recordsDir, name);
      try {
        const bytes = lstatSync(path, { throwIfNoEntry: false }) ? this.bytes(path) : undefined;
        const saved = bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
        if (isTicketExecutionRecord(saved) && saved.schemaVersion === 4 && worktrees.recordPath(saved.itemId) === path) {
          this.failures.delete(saved.itemId);
          continue; // never reinterpret old evidence for a published ticket
        }
        const receiptPath = join(cleanupDir, name);
        const receiptBytes = lstatSync(receiptPath, { throwIfNoEntry: false }) ? this.bytes(receiptPath) : undefined;
        const original: unknown = bytes ? saved :
          receiptBytes ? JSON.parse(receiptBytes.toString("utf8")).record : undefined;
        if (!isTicketExecutionRecord(original) || worktrees.recordPath(original.itemId) !== path)
          throw new Error("Unsupported/corrupt ticket source; not guessed or deleted.");
        itemId = original.itemId;
        if (original.schemaVersion === 4) continue; // never replay, including after rename succeeded but reply was lost
        this.assertOwner();
        const card = await this.deps.board.getCard(itemId);
        if (!card || !isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") ||
            card.itemId !== itemId || card.number !== original.issueNumber)
          throw new Error("Not the matching target-repository Task Issue; preserved without writes.");
        worktrees.assertOwnedPath(original);
        if (!receiptBytes && !original.finalization) {
          const check = worktrees.check(original, false); // dirty / MERGE_HEAD is intentionally allowed
          if (!check.ok) throw new Error(check.reason ?? "Unsafe legacy worktree.");
        }
        const runState = this.runs(original, true);
        const handoffs = this.all(itemId);
        // A corrupt/lost ledger cannot turn an authentic pending repair marker
        // into an ordinary Ready launch. Its issue scopes the failure; other
        // tickets with damaged, unidentifiable files remain independent.
        if (this.deps.board.conflict) {
          const comments = await this.deps.board.conflict.listComments(card);
          if (comments.some((c) => c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() &&
              c.body.startsWith(PREFIX) && !handoffs.some((h) =>
                h.commentId === c.id && c.body.includes(h.request.requestKey))))
            throw new Error("Unrecognized authentic repair marker; missing/corrupt ledger preserved.");
        }
        for (const h of handoffs) {
          if (h.record.path !== original.path || h.record.createdAt !== original.createdAt ||
              h.record.taskBranch !== original.taskBranch || h.record.baseBranch !== original.baseBranch ||
              h.card.number !== original.issueNumber)
            throw new Error("Legacy repair identity does not match the original ticket.");
        }
        const next: TicketExecutionRecordV4 = { ...original, schemaVersion: 4 };
        delete (next as TicketExecutionRecord).finalization;
        if (original.launchingAt !== undefined) {
          const matches = this.launchMatches(original, runState);
          if (matches.length === 1) {
            delete next.launchingAt;
            next.activeRunId = matches[0].runId;
            next.activeRunStartedAt = Date.parse(matches[0].startedAt);
          }
        }
        if (!next.activeRunId && next.launchingAt === undefined) {
          const pending = handoffs.filter((h) => h.step !== "consumed" || h.runId !== original.lastRunId);
          const matches = runState.filter((run) => {
            const args = run.args as Record<string, unknown> | undefined;
            return run.runId !== original.lastRunId && args?.itemId === original.itemId &&
              args?.issueNumber === original.issueNumber && args?.taskKey === original.taskKey &&
              pending.some((h) => (!h.runId || h.runId === run.runId) && equal(args?.repair, h.request));
          });
          if (matches.length === 1) {
            next.activeRunId = matches[0].runId;
            next.activeRunStartedAt = Date.parse(matches[0].startedAt);
          } else if (matches.length > 1) next.launchingAt = original.createdAt;
          else if (pending.some((h) => h.runId))
            throw new Error("Bound repair run is missing; retain and reobserve, never launch another builder.");
        }
        const task = { ...original, title: card.title, body: card.body };
        if (receiptBytes || original.finalization) {
          const old = original.finalization;
          if (old && (old.targetBranch !== original.baseBranch ||
              (original.reviewedTaskSha && original.reviewedTaskSha !== old.taskSha)))
            throw new Error("Legacy finalization identity changed.");
          const receipt = receiptBytes ? await worktrees.readReceipt(task) : undefined;
          if (receipt) await worktrees.checkCleanup(task, receipt);
          if (old?.resultSha) await worktrees.verifyLegacyResult(old);
          if (receipt && old?.resultSha && receipt.resultSha !== old.resultSha)
            throw new Error("Receipt and legacy result disagree.");
          const resultSha = receipt?.resultSha ?? old?.resultSha;
          if (resultSha) {
            next.integration = {
              // A receipt lacking old intent records an already integrated base,
              // not the pre-merge base. Never reconstruct it by guessing parents.
              baseSha: old?.baseSha ?? resultSha,
              taskSha: receipt?.taskSha ?? old!.taskSha,
              resultSha,
            };
            await worktrees.fetchRequired(original.baseBranch);
            const integrated = worktrees.isAncestor(resultSha, worktrees.fetchedSha(original.baseBranch));
            next.retry = { stage: integrated ? "cleanup" : "integrate",
              reason: integrated ? "Legacy result confirmed on fresh origin/base; cleanup only. Existing receipts remain read-only." :
                "Legacy recorded result is not confirmed on fresh origin/base; observe before push or cleanup." };
          } else next.retry = { stage: "integrate", reason: `Legacy pre-result finalization: ${JSON.stringify(old)}` };
        } else if (!next.activeRunId && next.launchingAt === undefined) {
          const pending = handoffs.filter((h) => h.step !== "consumed" || (!h.runId && !original.lastRunId));
          if (pending.length) next.retry = { stage: "build",
            reason: `Unlaunched legacy repair; continue the original worktree, merge base and test. Original request/diagnostics: ${JSON.stringify(pending.map((h) => ({ request: h.request, step: h.step, notice: h.notice, title: h.card.title, body: h.card.body })))}` };
        }
        const archiveDir = join(worktrees.repoRoot, ".pi", "board-agent", "legacy-v3");
        const archivePath = join(archiveDir, bytes ? name : `receipt-${name}`);
        const source = bytes ?? receiptBytes!;
        await this.archive(archivePath, source);
        if (receiptBytes && bytes) await this.archive(join(archiveDir, `receipt-${name}`), receiptBytes);
        await this.mapDesign(card);
        const assertSource = () => {
          this.assertOwner();
          if (!this.bytes(archivePath).equals(source) ||
              (receiptBytes && !this.bytes(receiptPath).equals(receiptBytes)) ||
              !equal(this.runs(original, true), runState) || !equal(this.all(itemId), handoffs))
            throw new Error("Legacy source/backup changed before atomic conversion.");
        };
        worktrees.publishLegacy(original, next, bytes, assertSource);
        this.failures.delete(itemId);
        report.converted.push(itemId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (itemId) this.failures.set(itemId, reason);
        report.failures.push({ source: path, reason });
      }
    }
    return report;
  }

  /** Keep the original question in the issue/comments. Only the lane changes;
   * identity, withdrawal and other people's claims never authorize a write. */
  async mapDesign(expected: Card): Promise<void> {
    const { cfg, board } = this.deps;
    if (!this.owner) return; // only owner-held startup/recovery converts old lanes
    this.pendingDesign.delete(expected.itemId);
    if (expected.closed || expected.status?.toLowerCase() !== cfg.columns.needs_design.toLowerCase() ||
        !isTargetIssue(expected, this.deps.repoOwner, this.deps.repoName, "Task")) return;
    // A failed/stale lane write must not fall through to the still-staged v3
    // designer. Re-observe this ticket next tick, independently of other work.
    this.pendingDesign.add(expected.itemId);
    const card = await board.getCard(expected.itemId);
    if (!card || !equal(identity(card), identity(expected)) || card.closed ||
        card.status !== expected.status || card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase())) return;
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
    for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".json"))) {
      // A damaged ticket ledger must not stop unrelated running tickets. The
      // untrusted identity is used ONLY to block that ticket, never as authority.
      let hint: any;
      try { hint = JSON.parse(this.bytes(join(this.dir, name)).toString("utf8")); }
      catch { /* retained and reported by migration below */ }
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
  private save(h: Handoff, previous?: Handoff): void {
    if (this.deps.worktrees.read(h.card.itemId)?.schemaVersion === 4 || this.blockedReason(h.card.itemId))
      throw new Error("Legacy repair ledger is read-only after migration.");
    const path = this.file(h.request.requestKey);
    this.safePath(path);
    if (!equal(this.read(h.request.requestKey), previous))
      throw new Error("Repair ledger changed.");
    mkdirSync(this.dir, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(h, null, 2), {
        flag: "wx",
        flush: true,
      });
      this.safePath(path);
      if (!equal(this.read(h.request.requestKey), previous))
        throw new Error("Repair ledger changed before replacement.");
      renameSync(temp, path);
      if (process.platform !== "win32") {
        const fd = openSync(this.dir, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  private change(h: Handoff, patch: Partial<Handoff>): Handoff {
    const next = { ...h, ...patch };
    this.save(next, h);
    return next;
  }
  private ops(): ConflictBoardOps {
    const ops = this.deps.board.conflict;
    if (!ops)
      throw new Error(
        "Conflict repair requires an author-aware board adapter; preserved for manual resolution.",
      );
    return ops;
  }
  private async comments(
    h: Handoff,
    phases: Array<"requested" | "queued" | "consumed">,
  ): Promise<IssueComment | undefined> {
    const comments = await this.ops().listComments({
      ...h.card,
      closed: false,
      assignees: [],
    });
    if (
      !Array.isArray(comments) ||
      new Set(comments.map((c) => c.id)).size !== comments.length
    )
      throw new Error("Ambiguous repair comment read.");
    const botComments = comments.filter(
      (c) => c.author?.toLowerCase() === this.deps.botLogin.toLowerCase(),
    );
    const candidates = botComments.filter(
      (c) =>
        c.id === h.commentId ||
        (c.body.startsWith(PREFIX) && c.body.includes(h.request.requestKey)),
    );
    if (
      candidates.length > 1 ||
      candidates.some((c) => !phases.some((p) => c.body === marker(h, p))) ||
      (h.commentId && candidates[0]?.id !== h.commentId)
    )
      throw new Error(
        "Repair comment author, identity or exact versioned data changed.",
      );
    return candidates[0];
  }
  private async current(
    h: Handoff,
    status: string,
    closed: boolean,
    canWork: () => boolean | Promise<boolean>,
    canNow: () => boolean,
    prior?: { status: string; closed: boolean },
  ): Promise<Card> {
    if (!(await canWork())) throw new Error("Repair admissions stopped.");
    const { worktrees, cfg } = this.deps;
    const record = worktrees.read(h.card.itemId);
    if (!equal(record, h.record) || worktrees.hasCleanupReceipt(h.card.itemId))
      throw new HandoffChanged(
        "Repair record changed or cleanup owns the ticket.",
      );
    if (
      record!.baseBranch !== cfg.branches.base ||
      record!.taskBranch !==
        taskBranch(cfg.branches.task_prefix, h.card.number) ||
      planSlug(h.card.plan) !== record!.plan
    )
      throw new HandoffChanged("Repair branch or Plan changed.");
    await worktrees.prepareConflict(
      record!,
      h.request,
      !closed && status === cfg.columns.ready,
    );
    const card = await this.deps.board.getCard(h.card.itemId);
    if (
      !card ||
      !equal(identity(card), h.card) ||
      card.repoOwner?.toLowerCase() !== this.deps.repoOwner.toLowerCase() ||
      card.repoName?.toLowerCase() !== this.deps.repoName.toLowerCase() ||
      card.assignees.length > 1 ||
      card.assignees.some(
        (a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase(),
      ) ||
      !equal(worktrees.read(h.card.itemId), h.record)
    )
      throw new HandoffChanged(
        "Repair card identity, claim or record changed; handoff blocked.",
      );
    if (card.status !== status || card.closed !== closed) {
      if (prior && card.status === prior.status && card.closed === prior.closed)
        throw new Error("Repair write not yet confirmed; not replaying.");
      throw new HandoffChanged(
        "Repair lane/closed state changed; handoff blocked.",
      );
    }
    worktrees.checkConflict(record!, h.request);
    if (!canNow())
      throw new Error("Repair admissions stopped after fresh read.");
    return card;
  }

  async request(
    card: Card,
    request: RepairRequest,
    canWork: () => boolean | Promise<boolean>,
    canNow: () => boolean,
  ): Promise<void> {
    this.ops();
    let h = this.read(request.requestKey);
    if (h?.step === "consumed" || h?.step === "launching")
      throw new Error(
        "Conflict request already consumed; automatic repair will not rerun it.",
      );
    if (!h) {
      if (
        this.all().some(
          (v) => v.card.itemId === card.itemId && v.step !== "consumed",
        )
      )
        throw new Error("Another repair handoff is pending.");
      const record = this.deps.worktrees.read(card.itemId);
      if (
        !record ||
        record.finalization ||
        record.activeRunId ||
        record.launchingAt !== undefined ||
        record.issueNumber !== card.number ||
        !card.plan
      )
        throw new Error("Repair requires the matching idle original record.");
      h = {
        schemaVersion: 1,
        request,
        card: identity(card),
        record,
        step: "comment",
        attempted: false,
        commentId: null,
        runId: null,
        notice: null,
      };
      await this.current(h, this.deps.cfg.columns.done, true, canWork, canNow);
      this.save(h);
    }
    await this.progress(h, canWork, canNow);
  }

  private async progress(
    h: Handoff,
    canWork: () => boolean | Promise<boolean>,
    canNow: () => boolean,
  ): Promise<void> {
    const ops = this.ops(),
      { cfg, board } = this.deps;
    if (h.step === "blocked")
      throw new Error(
        "Repair handoff was invalidated by a later card/claim/record change.",
      );
    try {
      while (!["queued", "launching", "consumed"].includes(h.step)) {
        const phase = h.step === "consume" ? "queued" : "requested";
        const afterPhase =
          h.step === "consume"
            ? "consumed"
            : h.step === "queue"
              ? "queued"
              : "requested";
        const comment = await this.comments(
          h,
          h.attempted ? [phase, afterPhase] : [phase],
        );
        const nextStep: Step =
          h.step === "comment"
            ? "ready"
            : h.step === "ready"
              ? "reopen"
              : h.step === "reopen"
                ? "queue"
                : h.step === "queue"
                  ? "queued"
                  : "launching";
        if (h.attempted) {
          // Never blindly replay a write. Confirm its complete observable result,
          // including actual author; unchanged/unknown state remains blocked.
          if (
            !comment ||
            ((h.step === "queue" || h.step === "consume") &&
              comment.body !== marker(h, afterPhase))
          )
            throw new Error(
              "Cannot confirm attempted repair comment write; not replaying.",
            );
          await this.current(
            h,
            h.step === "comment" ? cfg.columns.done : cfg.columns.ready,
            ["comment", "ready"].includes(h.step),
            canWork,
            canNow,
            h.step === "ready"
              ? { status: cfg.columns.done, closed: true }
              : h.step === "reopen"
                ? { status: cfg.columns.ready, closed: true }
                : undefined,
          );
          h = this.change(h, {
            step: nextStep,
            attempted: false,
            commentId: comment.id,
          });
          continue;
        }
        if (h.step !== "comment" && !comment)
          throw new Error("Authentic repair marker is missing.");
        if (h.step === "comment" && comment)
          throw new Error(
            "Unjournaled repair comment cannot authorize a handoff.",
          );
        const card = await this.current(
          h,
          ["comment", "ready"].includes(h.step)
            ? cfg.columns.done
            : cfg.columns.ready,
          ["comment", "ready", "reopen"].includes(h.step),
          canWork,
          canNow,
        );
        h = this.change(h, { attempted: true }); // durable BEFORE every GitHub write
        if (h.step === "comment")
          await ops.createComment(card, marker(h, "requested"));
        else if (h.step === "ready")
          await board.setStatus(card.itemId, cfg.columns.ready);
        else if (h.step === "reopen") await ops.reopen(card);
        else await ops.updateComment(card, h.commentId!, marker(h, afterPhase));
      }
    } catch (error) {
      if (error instanceof HandoffChanged) this.change(h, { step: "blocked" });
      throw error;
    }
  }

  async reconcile(
    canWork: () => boolean | Promise<boolean>,
    canNow: () => boolean,
  ): Promise<Array<RepairBlocker & { itemId: string }>> {
    const blockers: Array<RepairBlocker & { itemId: string }> = [];
    for (const h of this.all()) {
      if (this.deps.worktrees.read(h.card.itemId)?.schemaVersion === 4 || this.blockedReason(h.card.itemId)) continue;
      if (["launching", "consumed", "blocked"].includes(h.step)) continue;
      const unattemptedConsume = h.step === "consume" && !h.attempted;
      try {
        if (h.step === "queued" || unattemptedConsume) {
          if (!(await this.comments(h, ["queued"])))
            throw new Error("Queued repair marker missing.");
          await this.current(
            h,
            this.deps.cfg.columns.ready,
            false,
            canWork,
            canNow,
          );
          // No consume write was attempted: re-enter normal capacity/launch admission,
          // not a consumed launch window with no builder to recover.
          if (unattemptedConsume) this.change(h, { step: "queued" });
        } else await this.progress(h, canWork, canNow);
      } catch (error) {
        if (
          (h.step === "queued" || unattemptedConsume) &&
          error instanceof HandoffChanged
        )
          this.change(h, { step: "blocked" });
        blockers.push({
          itemId: h.card.itemId,
          status: "blocked",
          repair: h.request,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return blockers;
  }
  async repairFor(
    card: Card,
  ): Promise<RepairRequest | RepairBlocker | undefined> {
    let h: Handoff | undefined;
    try {
      const blocked = this.blockedReason(card.itemId);
      if (blocked) throw new Error(blocked);
      if (this.deps.worktrees.read(card.itemId)?.schemaVersion === 4) return undefined;
      const pending = this.all(card.itemId).filter(
        (h) => h.card.itemId === card.itemId && h.step !== "consumed",
      );
      if (pending.length > 1)
        throw new Error("Multiple pending repair requests.");
      if (!pending.length) {
        // A lost local ledger is not permission to execute a remote marker as an
        // ordinary Ready task. Forged non-bot comments never participate.
        if (this.deps.board.conflict) {
          const known = this.all().filter((h) => h.card.itemId === card.itemId);
          const comments = await this.ops().listComments(card);
          if (
            comments.some(
              (c) =>
                c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() &&
                c.body.startsWith(PREFIX) &&
                !known.some(
                  (h) =>
                    h.commentId === c.id && c.body === marker(h, "consumed"),
                ),
            )
          )
            throw new Error(
              "Unrecognized authentic repair marker; ordinary launch blocked.",
            );
        }
        return undefined;
      }
      h = pending[0];
      if (
        h.step !== "queued" ||
        !equal(identity(card), h.card) ||
        card.closed ||
        card.status !== this.deps.cfg.columns.ready
      )
        throw new Error("Repair handoff is not confirmed queued.");
      if (!(await this.comments(h, ["queued"])))
        throw new Error("Queued repair marker missing.");
      return { ...h.request };
    } catch (error) {
      return {
        status: "blocked",
        repair: h?.request,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  assertLaunch(itemId: string, repair?: RepairRequest): void {
    const blocked = this.blockedReason(itemId);
    if (blocked) throw new Error(blocked);
    if (this.deps.worktrees.read(itemId)?.schemaVersion === 4) {
      if (repair) throw new Error("Migrated tickets use ordinary build retry, not a new repair protocol.");
      return;
    }
    const pending = this.all(itemId).filter(
      (h) => h.card.itemId === itemId && h.step !== "consumed",
    );
    if (
      pending.length &&
      (pending.length !== 1 ||
        pending[0].step !== "queued" ||
        !equal(pending[0].request, repair))
    )
      throw new Error("Launch must bind the unique queued repair request.");
    if (
      repair?.requestKey.startsWith("conflict-") &&
      (!pending.length || !equal(pending[0].request, repair))
    )
      throw new Error("Conflict repair is missing its queued authorization.");
  }
  async consume(
    repair: RepairRequest,
    canWork: () => boolean | Promise<boolean>,
    canNow: () => boolean,
  ): Promise<void> {
    const h = this.readIfConflict(repair);
    if (!h) return; // T14's trusted optional builder input remains usable independently.
    if (h.step !== "queued") throw new Error("Repair request is not queued.");
    await this.progress(
      this.change(h, { step: "consume", attempted: false }),
      canWork,
      canNow,
    );
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
    // The old process may have persisted its run before binding the ledger. The
    // immutable journal supplies that binding; do not rewrite the ledger to bind.
    if (handoffs.length && !bound.length && record.schemaVersion === 4 && runId) {
      const run = this.runs(record).find((r) => r.runId === runId);
      const repair = (run?.args as { repair?: unknown } | undefined)?.repair;
      if (repair) bound.push(...handoffs.filter((h) =>
        (!h.runId || h.runId === runId) && equal(h.request, repair)));
    }
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
  requestForRun(
    record: TicketExecutionRecord,
    runId?: string,
  ): RepairRequest | undefined {
    return this.boundRun(record, runId)?.request;
  }
  matches(
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
  isUnstarted(record: TicketExecutionRecord): boolean {
    if (record.schemaVersion === 4) return false;
    return (
      !record.activeRunId &&
      record.launchingAt === undefined &&
      this.execution(record)?.step === "launching"
    );
  }
  private execution(
    record: TicketExecutionRecord,
    runId = record.activeRunId,
  ): Handoff | undefined {
    return (
      this.boundRun(record, runId) ??
      (record.schemaVersion === 3 ? this.all(record.itemId).find(
        (h) => h.step === "launching",
      ) : undefined)
    );
  }
  /** Fresh authorization for both recovery and every repair settlement write.
   * A lost claim/changed human contract stops only local work, never writeback. */
  async executionCard(
    record: TicketExecutionRecord,
    expected: Card,
    runId = record.activeRunId,
  ): Promise<Card | undefined> {
    const h = this.execution(record, runId);
    if (!h) return expected;
    if (!(await this.comments(h, ["consumed"])))
      throw new Error("Consumed repair authorization is missing.");
    const card = await this.deps.board.getCard(record.itemId);
    if (
      !equal(this.deps.worktrees.read(record.itemId), record) ||
      this.deps.worktrees.hasCleanupReceipt(record.itemId)
    )
      throw new Error("Repair execution record changed during authorization.");
    return card &&
      equal(identity(card), h.card) &&
      !card.closed &&
      card.status === expected.status &&
      card.assignees.length === 1 &&
      card.assignees[0].toLowerCase() === this.deps.botLogin.toLowerCase()
      ? card
      : undefined;
  }
  /** Only repair terminal notices use this write-ahead protection. Ordinary
   * executor comments keep their original behavior. Absence after an attempted
   * create is ambiguous, not permission to create another comment. */
  async terminalNotice(
    record: TicketExecutionRecord,
    card: Card,
    body: string,
  ): Promise<boolean> {
    let h = this.execution(record);
    if (!h || (record.schemaVersion === 4 && !h.notice)) return false;
    if (h.notice && h.notice.body !== body)
      throw new Error(
        "Repair terminal notice changed; previous write must be reconciled.",
      );
    const confirm = async () => {
      const matches = (await this.ops().listComments(card)).filter(
        (c) =>
          c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() &&
          (c.id === h!.notice?.id || c.body === body),
      );
      if (
        matches.length > 1 ||
        matches.some((c) => c.body !== body) ||
        (h!.notice?.id && matches[0]?.id !== h!.notice.id)
      )
        throw new Error("Ambiguous repair terminal notice author/data.");
      return matches[0];
    };
    let comment = await confirm();
    if (!comment) {
      if (h.notice)
        throw new Error(
          "Cannot confirm attempted repair terminal notice; not replaying.",
        );
      await this.assertSettlement(record, card);
      h = this.change(h, { notice: { body, id: null } });
      await this.ops().createComment(card, body);
      comment = await confirm();
      if (!comment)
        throw new Error("Repair terminal notice author/data not confirmed.");
    }
    await this.assertSettlement(record, card);
    if (record.schemaVersion !== 4) this.change(h, { notice: { body, id: comment.id } });
    return true;
  }
  async assertSettlement(
    record: TicketExecutionRecord,
    card: Card,
  ): Promise<void> {
    if (!(await this.executionCard(record, card)))
      throw new Error("Repair settlement lost its fresh card/claim authority.");
  }
  abandon(record: TicketExecutionRecord): void {
    if (record.schemaVersion === 4) return;
    const h = this.execution(record);
    if (h?.step === "launching")
      this.change(h, { step: "consumed", runId: record.activeRunId ?? null });
  }
  bind(record: TicketExecutionRecord, runId: string, args: unknown): void {
    if (record.schemaVersion === 4) {
      if (!this.matches(record, args, runId)) throw new Error("Legacy run arguments changed.");
      return;
    }
    const repair = (args as { repair?: RepairRequest } | undefined)?.repair;
    if (!repair?.requestKey.startsWith("conflict-")) return;
    const h = this.readIfConflict(repair);
    if (!h || !equal(h.request, repair) || (h.runId && h.runId !== runId))
      throw new Error("Repair run binding changed.");
    if (h.step !== "consumed") this.change(h, { step: "consumed", runId });
  }
}
