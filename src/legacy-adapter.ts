/** Stopped-upgrade compatibility only. No new workflow, ledger or cleanup receipts. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRunPersistence, type PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { exactKeys, verifySnapshot, verifyBackupSnapshots, directoryStamps, isCleanupSnapshot, readRegular, verifyParents, removeSnapshot, type CleanupSnapshot } from "./cleanup-snapshot.js";
import { planSlug } from "./config.js";
import { isTargetIssue, type Card } from "./gh.js";

import { isTicketExecutionRecord, type TicketExecutionRecord, type TicketIntegrationState, type TicketWorktrees } from "./ticket-worktree.js";
import type { BuilderTask } from "./workflow-prompt.js";
import type { TicketExecutorDeps } from "./ticket-executor.js";
import { GIT_GH_TIMEOUT_MS, processFailure, runProcess } from "./process-runner.js";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stateName = (id: string) => id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
const samePath = (a: string, b: string) => process.platform === "win32"
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);

export function legacyRegular(path: string): Buffer {
  for (let p = resolve(path); ; p = dirname(p)) {
    const stat = lstatSync(p, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || (p === resolve(path) ? !stat.isFile() : !stat.isDirectory())))
      throw new Error(`Unsafe legacy evidence path: ${path}`);
    if (p === dirname(p)) break;
  }
  return readFileSync(path);
}

export interface RepairRequest { requestKey: string; baseSha: string; taskSha: string; }

export type LegacyRepairStep =
  | "comment"
  | "ready"
  | "reopen"
  | "queue"
  | "queued"
  | "consume"
  | "launching"
  | "consumed"
  | "blocked";
export interface LegacyRepair {
  schemaVersion: 1;
  request: RepairRequest;
  card: {
    itemId: string; number: number; repoOwner: string; repoName: string;
    contentType: Card["contentType"]; type: string; plan: string; title: string; body: string;
  };
  record: TicketExecutionRecord;
  step: LegacyRepairStep;
  attempted: boolean;
  commentId: string | null;
  runId: string | null;
  notice: { body: string; id: string | null } | null;
}
const steps: LegacyRepairStep[] = [
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
export const conflictRequestKey = (
  itemId: string,
  baseSha: string,
  taskSha: string,
) => `conflict-${hash(JSON.stringify([itemId, baseSha, taskSha]))}`;

/** Read-only compatibility validator; new execution never writes this format. */
export function readLegacyRepair(path: string): LegacyRepair {
    const key = path.replaceAll("\\", "/").split("/").at(-1)!.slice(0, -5);
    let h: LegacyRepair;
    try {
      h = JSON.parse(legacyRegular(path).toString("utf8"));
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

/** One cold inventory under the exclusive, stopped-upgrade owner. Failed entries
 * are observed again; v4 files are never replayed. Retired state stays read-only. */
export class LegacyTicketAdapter {
  private inventoried = false;
  private readonly retired = new Set<"story" | "watchdog">();
  private readonly sources = new Set<string>();
  private readonly repairFiles = new Set<string>();
  private repairs: LegacyRepair[] = [];
  private readonly failures = new Map<string, string>();
  private readonly evidenceErrors = new Map<string, string>();
  private readonly state: string;

  constructor(private readonly deps: TicketExecutorDeps) {
    this.state = join(deps.worktrees.repoRoot, ".pi", "board-agent");
  }

  private assertOwner(): void {
    const owner = this.deps.ownerLock;
    if (!owner || !samePath(owner.path, join(this.state, "owner.lock")) ||
        owner.record.pid !== process.pid ||
        !equal(JSON.parse(legacyRegular(owner.path).toString("utf8")), owner.record))
      throw new Error("Legacy conversion requires the exclusive stopped-upgrade owner.");
  }

  private files(dir: string): string[] {
    const path = join(this.state, dir);
    // Check ancestors without following a directory link, including empty dirs.
    for (let p = path; ; p = dirname(p)) {
      const stat = lstatSync(p, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error(`Unsafe legacy state directory: ${p}`);
      if (p === dirname(p)) break;
    }
    return lstatSync(path, { throwIfNoEntry: false })
      ? readdirSync(path).filter((n) => n.endsWith(".json")).map((n) => join(path, n)) : [];
  }

  preservesLane(lane: "story" | "watchdog"): boolean { return this.retired.has(lane); }
  authorityHeld(): boolean {
    try { this.assertOwner(); return true; } catch { return false; }
  }
  owns(itemId: string): boolean {
    return this.deps.worktrees.hasLegacyBackup(itemId) ||
      this.repairs.some((h) => h.card.itemId === itemId) ||
      this.deps.worktrees.hasCleanupReceipt(itemId);
  }
  blocker(itemId: string): string | undefined {
    return this.failures.get(stateName(itemId)) ?? this.evidenceErrors.get(stateName(itemId));
  }

  private async git(...args: string[]): Promise<string> {
    const result = await runProcess("git", args, {
      cwd: this.deps.worktrees.repoRoot, timeoutMs: GIT_GH_TIMEOUT_MS,
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (!result.ok) throw processFailure("git", args, result);
    return result.stdout.trim();
  }

  private async observeResult(record: TicketExecutionRecord, integration: TicketIntegrationState): Promise<boolean> {
    await this.git("fetch", "--no-auto-maintenance", "--no-tags", "origin",
      `+refs/heads/${record.baseBranch}:refs/remotes/origin/${record.baseBranch}`);
    for (const oid of Object.values(integration))
      if (!sha(oid) || await this.git("cat-file", "-t", oid) !== "commit")
        throw new Error("Missing or invalid legacy integration commit.");
    const base = await this.git("rev-parse", "--verify", `refs/remotes/origin/${record.baseBranch}^{commit}`);
    const result = await runProcess("git", ["merge-base", "--is-ancestor", integration.resultSha, base], {
      cwd: this.deps.worktrees.repoRoot, timeoutMs: GIT_GH_TIMEOUT_MS,
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (!result.ok && (result.status !== 1 || result.timedOut)) throw processFailure("git", ["merge-base"], result);
    return result.ok;
  }

  private async convert(file: string, cards: Card[]): Promise<void> {
    const { worktrees } = this.deps;
    const name = file.replaceAll("\\", "/").split("/").at(-1)!.slice(0, -5);
    const isReceipt = samePath(dirname(file), join(this.state, "cleanup"));
    const recordFile = join(this.state, "ticket-worktrees", `${name}.json`);
    if (lstatSync(recordFile, { throwIfNoEntry: false })) {
      const saved = JSON.parse(legacyRegular(recordFile).toString("utf8"));
      if (isTicketExecutionRecord(saved) && stateName(saved.itemId) === name && saved.schemaVersion === 4) {
        if (saved.finalization) {
          const provenance = legacyRegular(recordFile + ".v3.bak");
          const original = JSON.parse(provenance.toString("utf8"));
          if (!isTicketExecutionRecord(original) || original.schemaVersion !== 3 || !equal(original.finalization, saved.finalization) ||
              (["itemId", "issueNumber", "taskKey", "plan", "path", "taskBranch", "baseBranch", "createdAt"] as const)
                .some((key) => original[key] !== saved[key]))
            throw new Error("Converted intent has no matching original provenance.");
          await this.verifyPreResult(saved);
          if (!legacyRegular(recordFile + ".v3.bak").equals(provenance)) throw new Error("Legacy intent provenance changed.");
          this.assertOwner();
          worktrees.clearLegacyIntent(saved);
        }
        return;
      }
    }
    const raw = JSON.parse(legacyRegular(file).toString("utf8"));
    const itemId = raw?.itemId;
    if (typeof itemId !== "string" || stateName(itemId) !== name)
      throw new Error("Legacy filename/identity mismatch.");
    // Even a now-corrupt old receipt cannot replay/overwrite published v4.
    if (worktrees.read(itemId)?.schemaVersion === 4) return;
    const original = worktrees.has(itemId) ? legacyRegular(recordFile) : undefined;
    let record: TicketExecutionRecord = original ? JSON.parse(original.toString("utf8")) : raw.record;
    if (!isTicketExecutionRecord(record) || record.schemaVersion !== 3) {
      // Old receipts could cover an unrecorded branch, but never nonempty paths.
      // The receipt reader below verifies that distinction before publication.
      if (!original && isReceipt && raw.record === null) {
        const card = cards.find((c) => c.itemId === itemId && c.number === raw.issueNumber &&
          isTargetIssue(c, this.deps.repoOwner, this.deps.repoName, "Task"));
        if (!card) throw new Error("Unrecorded receipt needs the matching target Task Issue.");
        record = { schemaVersion: 4, itemId, issueNumber: card.number!,
          taskKey: /^T\d+/i.exec(card.title)?.[0] ?? `T${String(card.number).padStart(3, "0")}`,
          taskBranch: raw.taskBranch, baseBranch: raw.baseBranch, path: raw.snapshots?.[0]?.path,
          createdAt: 0, ...(card.plan ? { plan: planSlug(card.plan) } : {}) };
        if (!isTicketExecutionRecord(record)) throw new Error("Unsupported unrecorded receipt identity.");
      } else throw new Error("Unsupported/corrupt legacy ticket record; preserved.");
    }
    if (record.itemId !== itemId) throw new Error("Legacy receipt/record identity mismatch.");
    const ownership = worktrees.checkOwnership(record);
    if (record.activeRunId || record.launchingAt !== undefined) {
      const check = worktrees.check(record, false);
      if (!check.ok) throw new Error(check.reason);
    }
    const next: TicketExecutionRecord = { ...record, schemaVersion: 4 };
    const receipt = worktrees.hasCleanupReceipt(itemId)
      ? await readLegacyReceipt(worktrees, { ...record, title: "", body: "" }) : undefined;
    if (receipt) {
      if (original && (!equal(receipt.record, record) || hash(original) !== receipt.recordHash))
        throw new Error("Legacy receipt's original record changed.");
      if (record.activeRunId || record.launchingAt !== undefined)
        throw new Error("Cleanup and builder evidence overlap.");
      if (record.finalization?.resultSha && record.finalization.resultSha !== receipt.resultSha)
        throw new Error("Legacy result and receipt disagree.");
      // A receipt already records a cleanup result, not a new merge intention.
      // Without an old base, the result itself is the known integrated baseline.
      next.integration = { baseSha: record.finalization?.baseSha ?? receipt.resultSha,
        taskSha: receipt.taskSha, resultSha: receipt.resultSha };
      delete next.finalization;
    } else if (record.finalization?.resultSha) {
      const old = record.finalization;
      if (old.targetBranch !== record.baseBranch ||
          (record.reviewedTaskSha && record.reviewedTaskSha !== old.taskSha))
        throw new Error("Legacy finalization identity changed.");
      next.integration = { baseSha: old.baseSha, taskSha: old.taskSha, resultSha: old.resultSha! };
      delete next.finalization;
    }
    if (next.integration) {
      const integrated = await this.observeResult(record, next.integration);
      if (!receipt && record.finalization?.resultSha) {
        const old = record.finalization;
        const parents = await this.git("show", "-s", "--format=%P", old.resultSha!);
        if (parents !== old.baseSha && parents !== `${old.baseSha} ${old.taskSha}`)
          throw new Error("Ambiguous legacy merge/squash parents.");
        const tree = await this.git("merge-tree", "--write-tree", old.baseSha, old.taskSha);
        if (!sha(tree) || tree !== await this.git("rev-parse", `${old.resultSha}^{tree}`))
          throw new Error("Ambiguous legacy merge/squash tree.");
      }
      next.retry = { stage: receipt || integrated ? "cleanup" : "integrate",
        reason: integrated ? "Legacy result observed on origin/base; cleanup only."
          : receipt ? "Legacy receipt result is not on today's remote base; remain cleanup-only until freshly confirmed."
          : "Legacy prepared result retained; observe remote before any push or cleanup." };
      const local = worktrees.localBranchSha(record.taskBranch);
      if (local && local !== next.integration.taskSha) throw new Error("Legacy task ref moved.");
      // Old snapshots are evidence ONLY for positively owned, unregistered
      // leftovers. Registered worktrees use native Git in T004, never snapshots.
      if (receipt && !ownership.registered && lstatSync(record.path, { throwIfNoEntry: false })) {
        if (!receipt.record) throw new Error("Unowned legacy residual.");
        await verifyReceiptBackup(receipt);
        for (const snapshot of receipt.snapshots) await verifySnapshot(snapshot);
      }
    } else if (record.finalization) {
      if (record.finalization.targetBranch !== record.baseBranch)
        throw new Error("Legacy pre-result target changed.");
      await this.verifyPreResult(record);
      delete next.finalization;
      next.retry = { stage: "integrate", reason: "Verified legacy pre-push intent; integrate the original task." };
    } else {
      const pending = this.repairs.filter((h) => h.card.itemId === itemId &&
        (h.step !== "consumed" || !h.runId || h.runId !== record.lastRunId || h.runId === record.activeRunId));
      if (pending.length > 1) throw new Error("Multiple legacy repair handoffs.");
      const repair = pending[0];
      if (repair && (repair.record.path !== record.path || repair.record.createdAt !== record.createdAt ||
          repair.record.taskBranch !== record.taskBranch || repair.record.baseBranch !== record.baseBranch))
        throw new Error("Legacy repair identity changed.");
      if (repair && !record.activeRunId && record.launchingAt === undefined) {
        if (repair.step === "blocked") throw new Error("Invalidated legacy repair handoff; preserve for manual reconciliation.");
        if (repair.runId) {
          const runs = this.runs(record).filter((r) => r.runId === repair.runId && this.matches(record, r.args, r.runId));
          if (runs.length !== 1) throw new Error("Legacy bound repair journal is missing or ambiguous.");
          next.activeRunId = runs[0].runId;
          next.activeRunStartedAt = Date.parse(runs[0].startedAt);
        } else {
          // beginLaunch was persisted BEFORE manager.start. With no launch window,
          // no bound run and no matching journal, queued/consumed input is an ordinary retry.
          const runs = this.runs(record).filter((r) => this.matches(record, r.args, r.runId) &&
            (r.args as any)?.repair?.requestKey === repair.request.requestKey);
          if (runs.length) throw new Error("Unassociated legacy repair journals; preserve for observation.");
          next.retry = { stage: "build", reason: ["Legacy merge conflict: resume the original task worktree; merge base, resolve and test.",
            JSON.stringify(repair.request), "Original requirements:", repair.card.body,
            repair.notice?.body ?? "", `Legacy handoff ${repair.step}; unfinished board settlement must be observed before launch.`].join("\n") };
        }
      }
    }
    if (!original && receipt && next.integration && await this.completedReceipt(next, cards)) return;
    this.assertOwner();
    if (!this.canContinue()) throw new Error("Stopped during legacy conversion.");
    worktrees.publishLegacy(next, original);
    this.deps.callback(`Migrated legacy ticket ${itemId} to v4; original evidence retained.`);
  }

  private async verifyPreResult(record: TicketExecutionRecord): Promise<void> {
    const old = record.finalization!;
    if (old.resultSha || old.targetBranch !== record.baseBranch ||
        (record.reviewedTaskSha && record.reviewedTaskSha !== old.taskSha) ||
        this.deps.worktrees.localBranchSha(record.taskBranch) !== old.taskSha)
      throw new Error("Legacy intent is not provably pre-push.");
    await this.git("fetch", "--no-auto-maintenance", "--no-tags", "origin",
      `+refs/heads/${record.baseBranch}:refs/remotes/origin/${record.baseBranch}`);
    await this.git("cat-file", "-e", `${old.baseSha}^{commit}`);
    await this.git("merge-base", "--is-ancestor", old.baseSha, `refs/remotes/origin/${record.baseBranch}`);
  }

  private async completedReceipt(record: TicketExecutionRecord, cards: Card[]): Promise<boolean> {
    const { worktrees, board, cfg } = this.deps;
    if (worktrees.localBranchSha(record.taskBranch) || lstatSync(record.path, { throwIfNoEntry: false }) ||
        worktrees.checkOwnership(record).registered || await worktrees.remoteSha(record.taskBranch)) return false;
    const receipt = await readLegacyReceipt(worktrees, { ...record, title: "", body: "" });
    if (receipt.snapshots.some((s) => lstatSync(s.path, { throwIfNoEntry: false }))) return false;
    const snapshot = cards.find((c) => c.itemId === record.itemId);
    if (!snapshot) return false; // missing Project evidence is not success
    const card = await board.getCard(record.itemId);
    return !!card && isTargetIssue(card, this.deps.repoOwner, this.deps.repoName, "Task") &&
      card.number === record.issueNumber && card.closed && card.status?.toLowerCase() === cfg.columns.done.toLowerCase() &&
      await this.observeResult(record, record.integration!);
  }

  /** Only an existing receipt can own registration-less leftovers. No new
   * snapshots/backups, and no comparison of a v4 record to the old record hash. */
  async residualPaths(record: TicketExecutionRecord): Promise<Set<string>> {
    this.assertOwner();
    const receipt = await readLegacyReceipt(this.deps.worktrees, { ...record, title: "", body: "" });
    if (!record.integration || receipt.resultSha !== record.integration.resultSha ||
        receipt.taskSha !== record.integration.taskSha || (receipt.record && receipt.record.createdAt !== record.createdAt))
      throw new Error("Legacy residual identity changed.");
    if (!receipt.record && receipt.snapshots.some((s) => lstatSync(s.path, { throwIfNoEntry: false })))
      throw new Error("Unowned legacy residual.");
    await verifyReceiptBackup(receipt);
    for (const snapshot of receipt.snapshots) await verifySnapshot(snapshot);
    return new Set(receipt.snapshots.filter((s) => lstatSync(s.path, { throwIfNoEntry: false })).map((s) => resolve(s.path)));
  }

  async removeResidual(record: TicketExecutionRecord, guard: () => Promise<void>): Promise<void> {
    this.assertOwner();
    const { worktrees } = this.deps;
    if (!record.integration || record.retry?.stage !== "cleanup" || !worktrees.hasCleanupReceipt(record.itemId))
      throw new Error("Unregistered residual has no positive legacy cleanup evidence.");
    const receipt = await readLegacyReceipt(worktrees, { ...record, title: "", body: "" });
    if (!receipt.record || receipt.taskSha !== record.integration.taskSha || receipt.resultSha !== record.integration.resultSha ||
        receipt.record.createdAt !== record.createdAt || worktrees.checkOwnership(record).registered)
      throw new Error("Legacy residual ownership changed.");
    await verifyReceiptBackup(receipt);
    for (const snapshot of receipt.snapshots) await verifySnapshot(snapshot);
    for (const snapshot of receipt.snapshots) await removeSnapshot(snapshot, async () => {
      this.assertOwner(); await guard();
      await verifyParents(receipt.parents); await verifyParents(receipt.gitParents);
    });
  }

  private canContinue: () => boolean = () => true;
  async reconcile(cards: Card[], canContinue: () => boolean): Promise<Array<{ itemId: string; reason: string }>> {
    this.canContinue = canContinue;
    this.assertOwner();
    if (!this.inventoried) {
      for (const [lane, names] of [
        ["story", ["refine-state.json", "refine-state-unblocked.json"]],
        ["watchdog", ["watchdog-state.json"]],
      ] as const)
        if (names.some((name) => lstatSync(join(this.state, name), { throwIfNoEntry: false }))) this.retired.add(lane);
      for (const path of [...this.files("ticket-worktrees"), ...this.files("cleanup")]) this.sources.add(path);
      for (const path of this.files("repair")) this.repairFiles.add(path);
      this.inventoried = true;
    }
    this.repairs = [];
    this.evidenceErrors.clear();
    for (const path of this.repairFiles) {
      try { this.repairs.push(readLegacyRepair(path)); }
      catch (error) {
        let id = path;
        try { const raw = JSON.parse(legacyRegular(path).toString("utf8")); id = raw?.card?.itemId ?? raw?.record?.itemId ?? path; } catch {}
        this.evidenceErrors.set(stateName(id), `Legacy repair evidence ${path}: ${String(error)}`);
      }
    }
    this.failures.clear();
    const attempted = new Set<string>();
    for (const path of this.sources) {
      if (!canContinue()) break;
      const name = path.replaceAll("\\", "/").split("/").at(-1)!.slice(0, -5);
      if (attempted.has(name)) continue;
      attempted.add(name);
      try {
        if (this.evidenceErrors.has(name)) throw new Error(this.evidenceErrors.get(name));
        await this.convert(path, cards);
        this.sources.delete(path);
      } catch (error) { this.failures.set(name, String(error)); }
    }
    // Preserve the issue body and ALL question/decision comments. Failed/stale
    // writes are observed again; comments alone never resume the Task.
    for (const snapshot of cards) {
      if (!canContinue()) break;
      if (!isTargetIssue(snapshot, this.deps.repoOwner, this.deps.repoName, "Task") || snapshot.closed ||
          snapshot.status?.toLowerCase() === this.deps.cfg.columns.needs_human.toLowerCase() ||
          snapshot.status?.toLowerCase() !== this.deps.cfg.columns.needs_design.toLowerCase()) continue;
      try {
        const current = await this.deps.board.getCard(snapshot.itemId);
        if (!equal(current, snapshot) || current!.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()) ||
            !canContinue()) continue;
        this.assertOwner();
        await this.deps.board.setStatus(snapshot.itemId, this.deps.cfg.columns.needs_human);
        snapshot.status = this.deps.cfg.columns.needs_human;
      } catch (error) { this.failures.set(stateName(snapshot.itemId), String(error)); }
    }
    const errors = new Map([...this.evidenceErrors, ...this.failures]);
    return [...errors].map(([name, reason]) => ({
      itemId: cards.find((c) => stateName(c.itemId) === name)?.itemId ?? name, reason,
    }));
  }

  /** Only the old input is consulted. New execution never mutates its ledger. */
  async assertRetryCard(record: TicketExecutionRecord, card: Card): Promise<void> {
    const h = this.repairs.find((r) => r.card.itemId === record.itemId && !r.runId);
    if (!h || !card || !Object.entries(h.card).every(([k, v]) => (card as any)[k] === v) ||
      ![this.deps.cfg.columns.ready, this.deps.cfg.columns.done].includes(card.status ?? "") ||
      (card.status === this.deps.cfg.columns.done && !card.closed) ||
      card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()))
      throw new Error("Legacy retry identity/claim/lane changed; preserve the original evidence.");
    this.assertOwner();
    if (h.notice?.id || h.commentId) {
      const comments = await (this.deps.board.missionComments?.(card));
      const authentic = (id: string | null | undefined) => comments?.find((c) => c.id === id &&
        c.author?.toLowerCase() === this.deps.botLogin.toLowerCase());
      if (h.commentId) {
        const comment = authentic(h.commentId);
        if (!comment?.body.startsWith(`<!-- board-agent-conflict-repair:v1:${h.request.requestKey} -->\n`))
          throw new Error("Legacy attempted comment is not confirmed; retry observation before launching.");
        const payload = JSON.parse(comment.body.split("\n").slice(1).join("\n"));
        if (payload.itemId !== record.itemId || Object.entries(h.request).some(([k, v]) => payload[k] !== v))
          throw new Error("Legacy comment identity changed; retry remains blocked.");
      }
      if (h.notice?.id && authentic(h.notice.id)?.body !== h.notice.body)
        throw new Error("Legacy terminal notice is not confirmed; preserve the unfinished settlement.");
    }
  }

  runs(record: TicketExecutionRecord): PersistedRunState[] {
    const check = this.deps.worktrees.check(record, false);
    if (!check.ok) throw new Error(check.reason);
    return createRunPersistence(record.path).list();
  }
  requestForRun(record: TicketExecutionRecord, runId?: string): RepairRequest | undefined {
    return this.repairs.find((h) => h.card.itemId === record.itemId && !!runId &&
      (h.runId === runId || (!h.runId && h.step === "launching" &&
        record.lastRunId === h.record.lastRunId && this.originalExecution(record, runId))))?.request;
  }
  private originalExecution(record: TicketExecutionRecord, runId: string): boolean {
    if (record.schemaVersion === 3)
      return record.activeRunId ? record.activeRunId === runId : record.launchingAt !== undefined;
    // Read-only provenance, never replay a backup. A queued ordinary retry must
    // not regain the retired protocol when T003 eventually settles retry.reason.
    const path = join(this.state, "ticket-worktrees", `${stateName(record.itemId)}.json.v3.bak`);
    const original: unknown = JSON.parse(legacyRegular(path).toString("utf8"));
    if (!isTicketExecutionRecord(original) || original.schemaVersion !== 3 || original.itemId !== record.itemId)
      throw new Error("Invalid legacy execution provenance.");
    return original.activeRunId ? original.activeRunId === runId : original.launchingAt !== undefined;
  }
  matches(record: TicketExecutionRecord, args: unknown, runId = record.activeRunId): boolean {
    if (!args || typeof args !== "object") return false;
    const a = args as Record<string, unknown>;
    if (a.itemId !== record.itemId || a.issueNumber !== record.issueNumber || a.taskKey !== record.taskKey) return false;
    const required = this.requestForRun(record, runId);
    if (required && !equal(required, a.repair)) return false;
    if (a.repair === undefined) return true;
    if (!isRepairRequest(a.repair)) return false;
    if (!a.repair.requestKey.startsWith("conflict-")) return true;
    return this.repairs.some((h) => h.card.itemId === record.itemId && equal(h.request, a.repair) &&
      ["launching", "consumed"].includes(h.step) && (!h.runId || h.runId === runId));
  }
  async executionCard(record: TicketExecutionRecord, expected: Card, runId = record.activeRunId): Promise<Card | undefined> {
    const request = this.requestForRun(record, runId);
    const h = this.repairs.find((r) => r.card.itemId === record.itemId && equal(r.request, request));
    if (!h) return expected;
    const fresh = await this.deps.board.getCard(record.itemId);
    if (!equal(this.deps.worktrees.read(record.itemId), record)) throw new Error("Legacy execution record changed.");
    return fresh && Object.entries(h.card).every(([key, value]) => (fresh as any)[key] === value) &&
      !fresh.closed && fresh.status === expected.status && fresh.assignees.length === 1 &&
      fresh.assignees[0].toLowerCase() === this.deps.botLogin.toLowerCase() ? fresh : undefined;
  }
}
/** Read-only legacy workflow argument validation. New runs never receive repair args. */
export function isRepairRequest(value: unknown): value is RepairRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 3 &&
    typeof r.requestKey === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(r.requestKey) &&
    typeof r.baseSha === "string" && /^[0-9a-f]{40}$/.test(r.baseSha) &&
    typeof r.taskSha === "string" && /^[0-9a-f]{40}$/.test(r.taskSha);
}

/** Read-only old cleanup receipt, never emitted by v4. */
export interface CleanupReceipt {
  schemaVersion: 1; itemId: string; issueNumber: number; taskBranch: string; baseBranch: string;
  taskSha: string; resultSha: string; record: TicketExecutionRecord | null; recordHash: string | null;
  snapshots: CleanupSnapshot[]; parents: Awaited<ReturnType<typeof directoryStamps>>;
  gitParents: Awaited<ReturnType<typeof directoryStamps>>; backup: string | null;
}
const SHA = /^[0-9a-f]{40}$/i;
const singleLine = (v: unknown): v is string => typeof v === "string" && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v);
export async function readLegacyReceipt(worktrees: TicketWorktrees, task: BuilderTask): Promise<CleanupReceipt> {
    const backupsDir = join(worktrees.repoRoot, ".pi", "board-agent", "cleanup-backups");
    const path = worktrees.receiptPath(task.itemId);
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
      !worktrees.gitCommonDir ||
      !isCleanupSnapshot({
        path: join(worktrees.gitCommonDir, "probe"),
        parents: r.gitParents,
        entries: [],
      }) ||
      r.gitParents.length !==
        (await directoryStamps(join(worktrees.gitCommonDir, "probe"))).length ||
      !(
        r.backup === null ||
        (singleLine(r.backup) && samePath(dirname(r.backup), backupsDir))
      )
    )
      throw new Error(`Corrupt or unsupported cleanup receipt: ${path}`);
    const receipt = r as CleanupReceipt;
    if (
      !samePath(
        receipt.snapshots[0].path,
        worktrees.pathFor(task.itemId, task.issueNumber),
      ) ||
      (receipt.snapshots[1] &&
        (!worktrees.gitCommonDir ||
          !samePath(
            dirname(receipt.snapshots[1].path),
            join(worktrees.gitCommonDir, "worktrees"),
          ))) ||
      (receipt.record &&
        (receipt.record.itemId !== task.itemId ||
          receipt.record.issueNumber !== task.issueNumber ||
          receipt.record.taskBranch !== task.taskBranch ||
          receipt.record.baseBranch !== task.baseBranch ||
          !samePath(receipt.record.path, receipt.snapshots[0].path) ||
          receipt.record.activeRunId ||
          receipt.record.launchingAt !== undefined ||
          receipt.record.retry ||
          receipt.record.integration)) ||
      (!receipt.record && receipt.snapshots.some((s) => s.entries.length))
    )
      throw new Error("Cleanup receipt identity/path mismatch.");
    await verifyParents(receipt.gitParents);
    worktrees.checkOwnership(receipt.record ?? { ...task, schemaVersion: 4, createdAt: 0, path: receipt.snapshots[0].path });
    if (receipt.taskBranch === receipt.baseBranch)
      throw new Error("Task branch must differ from the base branch.");
    await verifyParents(receipt.parents);
    const admin = receipt.snapshots[1];
    if (admin) {
      // Even half-removed metadata must be positively tied to THIS path, never
      // another registered worktree merely inside the same Git common dir.
      const pointer = admin.entries.find((e) => e.path === "gitdir");
      const target = join(receipt.snapshots[0].path, ".git");
      const spellings = [target, target.replaceAll("\\", "/")].flatMap((p) => [p + "\n", p + "\r\n"]);
      if (!pointer || pointer.type !== "file" || !spellings.some((p) => hash(p) === pointer.sha256))
        throw new Error("Legacy Git administration lacks original worktree ownership evidence.");
      if (lstatSync(join(admin.path, "gitdir"), { throwIfNoEntry: false }) &&
          !samePath((await readRegular(join(admin.path, "gitdir"))).toString("utf8").trim(), target))
        throw new Error("Other Git cleanup ownership.");
    }
    return receipt;
  }


async function verifyReceiptBackup(receipt: CleanupReceipt): Promise<void> {
  if (!receipt.backup) return;
  await verifyBackupSnapshots(receipt.backup, receipt.snapshots);
  if (hash(await readRegular(join(receipt.backup, "record.json"))) !== receipt.recordHash)
    throw new Error("Legacy cleanup backup record changed.");
}
