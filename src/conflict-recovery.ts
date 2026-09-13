import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exactKeys } from "./cleanup-snapshot.js";
import type { Config } from "./config.js";
import { planSlug, taskBranch } from "./config.js";
import type { Card, IssueComment } from "./gh.js";
import { isRepairRequest, type RepairRequest } from "./repair.js";
import { isTicketExecutionRecord, type TicketExecutionRecord, type TicketWorktrees } from "./ticket-worktree.js";

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
type Step = "comment" | "ready" | "reopen" | "queue" | "queued" | "consume" | "launching" | "consumed" | "blocked";
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
const steps: Step[] = ["comment", "ready", "reopen", "queue", "queued", "consume", "launching", "consumed", "blocked"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PREFIX = "<!-- board-agent-conflict-repair:";
export const conflictRequestKey = (itemId: string, baseSha: string, taskSha: string) => `conflict-${hash(JSON.stringify([itemId, baseSha, taskSha]))}`;
function identity(card: Card) {
  return { itemId: card.itemId, number: card.number!, repoOwner: card.repoOwner!, repoName: card.repoName!, contentType: card.contentType, type: card.type!, plan: card.plan!, title: card.title, body: card.body };
}
function marker(h: Handoff, phase: "requested" | "queued" | "consumed") {
  return `${PREFIX}v1:${h.request.requestKey} -->\n${JSON.stringify({ schemaVersion: 1, ...h.request, itemId: h.card.itemId, issueNumber: h.card.number, repoOwner: h.card.repoOwner, repoName: h.card.repoName, plan: h.card.plan, title: h.card.title, bodyHash: hash(h.card.body), taskBranch: h.record.taskBranch, baseBranch: h.record.baseBranch, recordCreatedAt: h.record.createdAt, phase })}`;
}

/** One narrowly scoped write-ahead handoff ledger, not a queue or execution
 * record. Retained consumed keys prevent automatic reuse after manual close. */
export class ConflictRecovery {
  private readonly dir: string;
  constructor(private readonly deps: {
    worktrees: TicketWorktrees; cfg: Config; botLogin: string; repoOwner: string; repoName: string;
    board: { conflict?: ConflictBoardOps; getCard(itemId: string): Promise<Card | undefined>; setStatus(itemId: string, status: string): Promise<void> };
  }) { this.dir = join(deps.worktrees.repoRoot, ".pi", "board-agent", "repair"); }

  private safePath(path: string): void {
    for (let p = resolve(path); ; p = dirname(p)) {
      const stat = lstatSync(p, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || (p !== resolve(path) && !stat.isDirectory()))) throw new Error("Unsafe repair ledger path.");
      if (p === dirname(p)) break;
    }
  }
  private file(key: string) {
    if (!/^conflict-[0-9a-f]{64}$/.test(key)) throw new Error("Invalid conflict request key.");
    return join(this.dir, `${key}.json`);
  }
  private read(key: string): Handoff | undefined {
    const path = this.file(key); this.safePath(path);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new Error("Invalid repair ledger file.");
    const h = JSON.parse(readFileSync(path, "utf8")) as Handoff;
    if (!exactKeys(h, ["schemaVersion", "request", "card", "record", "step", "attempted", "commentId", "runId", "notice"]) || h.schemaVersion !== 1 ||
        !isRepairRequest(h.request) || h.request.requestKey !== key ||
        !exactKeys(h.card, ["itemId", "number", "repoOwner", "repoName", "contentType", "type", "plan", "title", "body"]) ||
        !isTicketExecutionRecord(h.record) || h.record.finalization || h.record.activeRunId || h.record.launchingAt !== undefined ||
        h.card.itemId !== h.record.itemId || h.card.number !== h.record.issueNumber || h.card.contentType !== "Issue" || h.card.type?.toLowerCase() !== "task" ||
        ![h.card.repoOwner, h.card.repoName, h.card.plan, h.card.title, h.card.body].every((s) => typeof s === "string") || !h.card.plan ||
        key !== conflictRequestKey(h.card.itemId, h.request.baseSha, h.request.taskSha) ||
        !steps.includes(h.step) || typeof h.attempted !== "boolean" ||
        !(h.commentId === null || typeof h.commentId === "string" && !!h.commentId) || !(h.runId === null || typeof h.runId === "string" && !!h.runId) ||
        !(h.notice === null || exactKeys(h.notice, ["body", "id"]) && typeof h.notice.body === "string" && !!h.notice.body && (h.notice.id === null || typeof h.notice.id === "string" && !!h.notice.id)) ||
        (!["comment", "blocked"].includes(h.step) && !h.commentId)) throw new Error("Corrupt or unsupported repair ledger.");
    return h;
  }
  private all(): Handoff[] {
    this.safePath(join(this.dir, "probe"));
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((n) => n.endsWith(".json")).map((n) => this.read(n.slice(0, -5))!);
  }
  private save(h: Handoff, previous?: Handoff): void {
    const path = this.file(h.request.requestKey); this.safePath(path);
    if (!equal(this.read(h.request.requestKey), previous)) throw new Error("Repair ledger changed.");
    mkdirSync(this.dir, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(h, null, 2), { flag: "wx", flush: true });
      this.safePath(path);
      if (!equal(this.read(h.request.requestKey), previous)) throw new Error("Repair ledger changed before replacement.");
      renameSync(temp, path);
      if (process.platform !== "win32") { const fd = openSync(this.dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private change(h: Handoff, patch: Partial<Handoff>): Handoff {
    const next = { ...h, ...patch }; this.save(next, h); return next;
  }
  private ops(): ConflictBoardOps {
    const ops = this.deps.board.conflict;
    if (!ops) throw new Error("Conflict repair requires an author-aware board adapter; preserved for manual resolution.");
    return ops;
  }
  private async comments(h: Handoff, phases: Array<"requested" | "queued" | "consumed">): Promise<IssueComment | undefined> {
    const comments = await this.ops().listComments({ ...h.card, closed: false, assignees: [] });
    if (!Array.isArray(comments) || new Set(comments.map((c) => c.id)).size !== comments.length) throw new Error("Ambiguous repair comment read.");
    const botComments = comments.filter((c) => c.author?.toLowerCase() === this.deps.botLogin.toLowerCase());
    const candidates = botComments.filter((c) => c.id === h.commentId || c.body.startsWith(PREFIX) && c.body.includes(h.request.requestKey));
    if (candidates.length > 1 || candidates.some((c) => !phases.some((p) => c.body === marker(h, p))) ||
        (h.commentId && candidates[0]?.id !== h.commentId)) throw new Error("Repair comment author, identity or exact versioned data changed.");
    return candidates[0];
  }
  private async current(h: Handoff, status: string, closed: boolean, canWork: () => boolean | Promise<boolean>, canNow: () => boolean, prior?: { status: string; closed: boolean }): Promise<Card> {
    if (!(await canWork())) throw new Error("Repair admissions stopped.");
    const { worktrees, cfg } = this.deps;
    const record = worktrees.read(h.card.itemId);
    if (!equal(record, h.record) || worktrees.hasCleanupReceipt(h.card.itemId)) throw new HandoffChanged("Repair record changed or cleanup owns the ticket.");
    if (record!.baseBranch !== cfg.branches.base || record!.taskBranch !== taskBranch(cfg.branches.task_prefix, h.card.number) || planSlug(h.card.plan) !== record!.plan) throw new HandoffChanged("Repair branch or Plan changed.");
    await worktrees.prepareConflict(record!, h.request);
    const card = await this.deps.board.getCard(h.card.itemId);
    if (!card || !equal(identity(card), h.card) ||
        card.repoOwner?.toLowerCase() !== this.deps.repoOwner.toLowerCase() || card.repoName?.toLowerCase() !== this.deps.repoName.toLowerCase() ||
        card.assignees.length > 1 || card.assignees.some((a) => a.toLowerCase() !== this.deps.botLogin.toLowerCase()) ||
        !equal(worktrees.read(h.card.itemId), h.record)) throw new HandoffChanged("Repair card identity, claim or record changed; handoff blocked.");
    if (card.status !== status || card.closed !== closed) {
      if (prior && card.status === prior.status && card.closed === prior.closed) throw new Error("Repair write not yet confirmed; not replaying.");
      throw new HandoffChanged("Repair lane/closed state changed; handoff blocked.");
    }
    worktrees.checkConflict(record!, h.request);
    if (!canNow()) throw new Error("Repair admissions stopped after fresh read.");
    return card;
  }

  async request(card: Card, request: RepairRequest, canWork: () => boolean | Promise<boolean>, canNow: () => boolean): Promise<void> {
    this.ops();
    let h = this.read(request.requestKey);
    if (h?.step === "consumed" || h?.step === "launching") throw new Error("Conflict request already consumed; automatic repair will not rerun it.");
    if (!h) {
      if (this.all().some((v) => v.card.itemId === card.itemId && v.step !== "consumed")) throw new Error("Another repair handoff is pending.");
      const record = this.deps.worktrees.read(card.itemId);
      if (!record || record.finalization || record.activeRunId || record.launchingAt !== undefined || record.issueNumber !== card.number || !card.plan)
        throw new Error("Repair requires the matching idle original record.");
      h = { schemaVersion: 1, request, card: identity(card), record, step: "comment", attempted: false, commentId: null, runId: null, notice: null };
      await this.current(h, this.deps.cfg.columns.done, true, canWork, canNow);
      this.save(h);
    }
    await this.progress(h, canWork, canNow);
  }

  private async progress(h: Handoff, canWork: () => boolean | Promise<boolean>, canNow: () => boolean): Promise<void> {
    const ops = this.ops(), { cfg, board } = this.deps;
    if (h.step === "blocked") throw new Error("Repair handoff was invalidated by a later card/claim/record change.");
    try {
    while (!["queued", "launching", "consumed"].includes(h.step)) {
      const phase = h.step === "consume" ? "queued" : "requested";
      const afterPhase = h.step === "consume" ? "consumed" : h.step === "queue" ? "queued" : "requested";
      const comment = await this.comments(h, h.attempted ? [phase, afterPhase] : [phase]);
      const nextStep: Step = h.step === "comment" ? "ready" : h.step === "ready" ? "reopen" : h.step === "reopen" ? "queue" : h.step === "queue" ? "queued" : "launching";
      if (h.attempted) {
        // Never blindly replay a write. Confirm its complete observable result,
        // including actual author; unchanged/unknown state remains blocked.
        if (!comment || ((h.step === "queue" || h.step === "consume") && comment.body !== marker(h, afterPhase))) throw new Error("Cannot confirm attempted repair comment write; not replaying.");
        await this.current(h, h.step === "comment" ? cfg.columns.done : cfg.columns.ready, ["comment", "ready"].includes(h.step), canWork, canNow,
          h.step === "ready" ? { status: cfg.columns.done, closed: true } : h.step === "reopen" ? { status: cfg.columns.ready, closed: true } : undefined);
        h = this.change(h, { step: nextStep, attempted: false, commentId: comment.id });
        continue;
      }
      if (h.step !== "comment" && !comment) throw new Error("Authentic repair marker is missing.");
      if (h.step === "comment" && comment) throw new Error("Unjournaled repair comment cannot authorize a handoff.");
      const card = await this.current(h, ["comment", "ready"].includes(h.step) ? cfg.columns.done : cfg.columns.ready, ["comment", "ready", "reopen"].includes(h.step), canWork, canNow);
      h = this.change(h, { attempted: true }); // durable BEFORE every GitHub write
      if (h.step === "comment") await ops.createComment(card, marker(h, "requested"));
      else if (h.step === "ready") await board.setStatus(card.itemId, cfg.columns.ready);
      else if (h.step === "reopen") await ops.reopen(card);
      else await ops.updateComment(card, h.commentId!, marker(h, afterPhase));
    }
    } catch (error) {
      if (error instanceof HandoffChanged) this.change(h, { step: "blocked" });
      throw error;
    }
  }

  async reconcile(canWork: () => boolean | Promise<boolean>, canNow: () => boolean): Promise<Array<RepairBlocker & { itemId: string }>> {
    const blockers: Array<RepairBlocker & { itemId: string }> = [];
    for (const h of this.all()) {
      if (["launching", "consumed", "blocked"].includes(h.step)) continue;
      try {
        if (h.step === "queued") {
          if (!(await this.comments(h, ["queued"]))) throw new Error("Queued repair marker missing.");
          await this.current(h, this.deps.cfg.columns.ready, false, canWork, canNow);
        } else await this.progress(h, canWork, canNow);
      } catch (error) {
        if (h.step === "queued" && error instanceof HandoffChanged) this.change(h, { step: "blocked" });
        blockers.push({ itemId: h.card.itemId, status: "blocked", repair: h.request, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return blockers;
  }
  async repairFor(card: Card): Promise<RepairRequest | RepairBlocker | undefined> {
    let h: Handoff | undefined;
    try {
      const pending = this.all().filter((h) => h.card.itemId === card.itemId && h.step !== "consumed");
      if (pending.length > 1) throw new Error("Multiple pending repair requests.");
      if (!pending.length) {
        // A lost local ledger is not permission to execute a remote marker as an
        // ordinary Ready task. Forged non-bot comments never participate.
        if (this.deps.board.conflict) {
          const known = this.all().filter((h) => h.card.itemId === card.itemId);
          const comments = await this.ops().listComments(card);
          if (comments.some((c) => c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() && c.body.startsWith(PREFIX) && !known.some((h) => h.commentId === c.id && c.body === marker(h, "consumed")))) throw new Error("Unrecognized authentic repair marker; ordinary launch blocked.");
        }
        return undefined;
      }
      h = pending[0];
      if (h.step !== "queued" || !equal(identity(card), h.card) || card.closed || card.status !== this.deps.cfg.columns.ready) throw new Error("Repair handoff is not confirmed queued.");
      if (!(await this.comments(h, ["queued"]))) throw new Error("Queued repair marker missing.");
      return { ...h.request };
    } catch (error) {
      return { status: "blocked", repair: h?.request, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  assertLaunch(itemId: string, repair?: RepairRequest): void {
    const pending = this.all().filter((h) => h.card.itemId === itemId && h.step !== "consumed");
    if (pending.length && (pending.length !== 1 || pending[0].step !== "queued" || !equal(pending[0].request, repair))) throw new Error("Launch must bind the unique queued repair request.");
    if (repair?.requestKey.startsWith("conflict-") && (!pending.length || !equal(pending[0].request, repair))) throw new Error("Conflict repair is missing its queued authorization.");
  }
  async consume(repair: RepairRequest, canWork: () => boolean | Promise<boolean>, canNow: () => boolean): Promise<void> {
    const h = this.readIfConflict(repair);
    if (!h) return; // T14's trusted optional builder input remains usable independently.
    if (h.step !== "queued") throw new Error("Repair request is not queued.");
    await this.progress(this.change(h, { step: "consume", attempted: false }), canWork, canNow);
  }
  private readIfConflict(repair: RepairRequest) { return repair.requestKey.startsWith("conflict-") ? this.read(repair.requestKey) : undefined; }
  /** The retained run binding is authority even if its optional args/file was
   * lost. A later explicit ordinary retry has a different run ID. */
  private boundRun(record: TicketExecutionRecord, runId?: string): Handoff | undefined {
    const bound = this.all().filter((h) => !!runId && h.runId === runId && h.step === "consumed");
    if (bound.length > 1) throw new Error("Multiple repair requests bind the same run.");
    const h = bound[0];
    if (h && (h.card.itemId !== record.itemId || h.record.createdAt !== record.createdAt ||
        h.record.path !== record.path || h.record.taskBranch !== record.taskBranch || h.record.baseBranch !== record.baseBranch))
      throw new Error("Repair run binding does not match the ticket record.");
    return h;
  }
  requestForRun(record: TicketExecutionRecord, runId?: string): RepairRequest | undefined {
    return this.boundRun(record, runId)?.request;
  }
  matches(record: TicketExecutionRecord, args: unknown, runId = record.activeRunId): boolean {
    const pending = this.all().filter((h) => h.card.itemId === record.itemId && h.step === "launching");
    const repair = (args as { repair?: RepairRequest } | undefined)?.repair;
    const required = this.requestForRun(record, runId);
    if (required && !equal(required, repair)) return false;
    if (pending.length && (pending.length !== 1 || !equal(pending[0].request, repair))) return false;
    if (!repair?.requestKey.startsWith("conflict-")) return true;
    const h = this.readIfConflict(repair);
    return !!h && equal(h.request, repair) && h.card.itemId === record.itemId && h.record.createdAt === record.createdAt && ["launching", "consumed"].includes(h.step) && (!h.runId || h.runId === runId);
  }
  isUnstarted(record: TicketExecutionRecord): boolean {
    return !record.activeRunId && record.launchingAt === undefined && this.execution(record)?.step === "launching";
  }
  private execution(record: TicketExecutionRecord, runId = record.activeRunId): Handoff | undefined {
    return this.boundRun(record, runId) ?? this.all().find((h) => h.card.itemId === record.itemId && h.step === "launching");
  }
  /** Fresh authorization for both recovery and every repair settlement write.
   * A lost claim/changed human contract stops only local work, never writeback. */
  async executionCard(record: TicketExecutionRecord, expected: Card, runId = record.activeRunId): Promise<Card | undefined> {
    const h = this.execution(record, runId);
    if (!h) return expected;
    if (!(await this.comments(h, ["consumed"]))) throw new Error("Consumed repair authorization is missing.");
    const card = await this.deps.board.getCard(record.itemId);
    if (!equal(this.deps.worktrees.read(record.itemId), record) || this.deps.worktrees.hasCleanupReceipt(record.itemId)) throw new Error("Repair execution record changed during authorization.");
    return card && equal(identity(card), h.card) && !card.closed && card.status === expected.status &&
      card.assignees.length === 1 && card.assignees[0].toLowerCase() === this.deps.botLogin.toLowerCase() ? card : undefined;
  }
  /** Only repair terminal notices use this write-ahead protection. Ordinary
   * executor comments keep their original behavior. Absence after an attempted
   * create is ambiguous, not permission to create another comment. */
  async terminalNotice(record: TicketExecutionRecord, card: Card, body: string): Promise<boolean> {
    let h = this.execution(record);
    if (!h) return false;
    if (h.notice && h.notice.body !== body) throw new Error("Repair terminal notice changed; previous write must be reconciled.");
    const confirm = async () => {
      const matches = (await this.ops().listComments(card)).filter((c) => c.author?.toLowerCase() === this.deps.botLogin.toLowerCase() && (c.id === h!.notice?.id || c.body === body));
      if (matches.length > 1 || matches.some((c) => c.body !== body) || h!.notice?.id && matches[0]?.id !== h!.notice.id) throw new Error("Ambiguous repair terminal notice author/data.");
      return matches[0];
    };
    let comment = await confirm();
    if (!comment) {
      if (h.notice) throw new Error("Cannot confirm attempted repair terminal notice; not replaying.");
      await this.assertSettlement(record, card);
      h = this.change(h, { notice: { body, id: null } });
      await this.ops().createComment(card, body);
      comment = await confirm();
      if (!comment) throw new Error("Repair terminal notice author/data not confirmed.");
    }
    await this.assertSettlement(record, card);
    this.change(h, { notice: { body, id: comment.id } });
    return true;
  }
  async assertSettlement(record: TicketExecutionRecord, card: Card): Promise<void> {
    if (!(await this.executionCard(record, card))) throw new Error("Repair settlement lost its fresh card/claim authority.");
  }
  abandon(record: TicketExecutionRecord): void {
    const h = this.execution(record);
    if (h?.step === "launching") this.change(h, { step: "consumed", runId: record.activeRunId ?? null });
  }
  bind(record: TicketExecutionRecord, runId: string, args: unknown): void {
    const repair = (args as { repair?: RepairRequest } | undefined)?.repair;
    if (!repair?.requestKey.startsWith("conflict-")) return;
    const h = this.readIfConflict(repair);
    if (!h || !equal(h.request, repair) || h.runId && h.runId !== runId) throw new Error("Repair run binding changed.");
    if (h.step !== "consumed") this.change(h, { step: "consumed", runId });
  }
}
