import { createHash } from "node:crypto";
import type { Card, IssueComment } from "./gh.js";
import type { TicketExecutionRecord, TicketWorktrees } from "./ticket-worktree.js";

export interface Decision {
  question: string;
  context: string;
  options: string[];
  recommendation: string;
}

export function isDecision(value: unknown): value is Decision {
  if (!value || typeof value !== "object") return false;
  const d = value as Decision;
  const text = (s: unknown) => typeof s === "string" && !!s.trim();
  return text(d.question) && text(d.context) && text(d.recommendation) &&
    Array.isArray(d.options) && d.options.length >= 2 && d.options.every(text) &&
    new Set(d.options.map((option) => option.trim().toLowerCase())).size >= 2;
}

/** Technical failures never imply a missing human decision. */
export interface WaveOutcome extends Partial<Decision> {
  taskKey: string;
  itemId: string;
  status: "success" | "failure" | "needs_decision";
  branch?: string;
  commits?: number;
  summary?: string;
  error?: string;
  attempted?: string;
  limitations?: string;
  workaround?: string;
  humanAction?: string; // legacy diagnostics, not decision authority
}

export function normalizeWaveResults(raw: unknown): WaveOutcome[] {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) && "result" in raw
    ? (raw as { result?: unknown }).result : raw;
  if (!Array.isArray(value)) return [];
  const outcomes: WaveOutcome[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    if (typeof r.taskKey !== "string" || typeof r.itemId !== "string" ||
        !["success", "failure", "needs_decision"].includes(String(r.status))) return [];
    const outcome: WaveOutcome = { taskKey: r.taskKey, itemId: r.itemId, status: r.status as WaveOutcome["status"] };
    for (const key of ["branch", "summary", "error", "attempted", "limitations", "workaround", "humanAction",
      "question", "context", "recommendation"] as const)
      if (typeof r[key] === "string") outcome[key] = r[key];
    if (typeof r.commits === "number") outcome.commits = r.commits;
    if (Array.isArray(r.options) && r.options.every((s) => typeof s === "string")) outcome.options = r.options;
    if (outcome.status === "needs_decision" && !isDecision(outcome)) {
      outcome.status = "failure";
      outcome.error = `Incomplete needs_decision payload. ${outcome.error ?? ""}`.trim();
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

export function decisionComment(decision: Decision): string {
  return ["## Needs human input", "", "**Question**", decision.question, "", "**Context**", decision.context,
    "", "**Options**", ...decision.options.map((s) => `- ${s}`), "", "**Recommendation**", decision.recommendation,
    "", "Reply with the decision, then manually move this card to `Ready`. Comments alone do not resume work."].join("\n");
}

export function failureComment(reason: string, details?: WaveOutcome): string {
  return ["## Automation retry", "", reason, ...["attempted", "limitations", "workaround", "humanAction"]
    .flatMap((key) => details?.[key as keyof WaveOutcome] ? ["", `**${key}**`, String(details[key as keyof WaveOutcome])] : []),
    "", "Return to `Ready` after settlement; continue in the original task branch/worktree, preserving partial changes and MERGE_HEAD."].join("\n");
}

export function trustedMissionComments(comments: IssueComment[], botLogin: string): string {
  return comments.filter((c) => c.author?.toLowerCase() !== botLogin.toLowerCase() &&
    ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.authorAssociation ?? "") &&
    !c.body.trimStart().startsWith("<!-- board-agent-"))
    .map((c) => `${c.createdAt} ${c.author}: ${c.body}`).join("\n\n");
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function ticketCardKey(card: Card, record: TicketExecutionRecord): string {
  return hash([card.itemId, card.number, card.contentType, card.repoOwner?.toLowerCase(), card.repoName?.toLowerCase(),
    card.type?.toLowerCase(), card.plan, card.title, card.body, record.createdAt, record.path, record.taskBranch, record.baseBranch]);
}

/** The retry reason IS the pending comment. No step ledger: each GitHub write is
 * observed afresh. The marker binds its source/destination and Issue contract,
 * so a restart cannot overwrite a human's different lane, identity or scope. */
export function ticketNotice(record: TicketExecutionRecord, card: Card, target: string, body: string): string {
  return `<!-- board-agent-ticket:${encodeURIComponent(card.status ?? "")}:${encodeURIComponent(target)}:${card.closed ? "closed" : "open"}:${ticketCardKey(card, record)}:${hash([record.activeRunId ?? record.lastRunId ?? record.launchingAt, body])} -->\n${body}`;
}

export function readTicketNotice(reason: string | undefined) {
  const m = /^<!-- board-agent-ticket:([^:]*):([^:]*):(closed|open):([0-9a-f]{64}):[0-9a-f]{64} -->\n/.exec(reason ?? "");
  return m ? { from: decodeURIComponent(m[1]), to: decodeURIComponent(m[2]), closed: m[3] === "closed", key: m[4] } : undefined;
}

export function persistTicketNotice(worktrees: TicketWorktrees, record: TicketExecutionRecord, card: Card,
  stage: "build" | "review", target: string, body: string): TicketExecutionRecord {
  return worktrees.update(record.itemId, (current) => {
    if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Ticket record changed before settlement.");
    return { ...current, retry: { stage, reason: ticketNotice(record, card, target, body) } };
  });
}

export interface TicketSettlementBoard {
  getCard(itemId: string): Promise<Card | undefined>;
  /** Bodies supplied by old offline adapters are already trusted; production supplies authors. */
  listComments(card: Card): Promise<string[] | IssueComment[]>;
  comment(card: Card, body: string): Promise<unknown>;
  setStatus(itemId: string, status: string): Promise<void>;
  release(card: Card): Promise<void>;
  reopen?(card: Card): Promise<void>;
}

export class TicketChangedError extends Error {}

/** Build/review settlement only (destinations are open; not T004 cleanup).
 * One attempt, never a model retry or a retry loop. Caller drains the old run
 * first and retains retry/run evidence if any I/O throws. */
export async function settleTicketNotice(worktrees: TicketWorktrees, record: TicketExecutionRecord,
  board: TicketSettlementBoard, botLogin: string): Promise<{ changed: boolean; card: Card }> {
  const notice = readTicketNotice(record.retry?.reason);
  if (!notice) throw new Error("Ticket has no settlement notice.");
  let changed = false;
  const bot = botLogin.toLowerCase();
  const current = async (): Promise<Card> => {
    const card = await board.getCard(record.itemId);
    if (JSON.stringify(worktrees.read(record.itemId)) !== JSON.stringify(record))
      throw new Error("Ticket record changed during settlement.");
    if (!card || ticketCardKey(card, record) !== notice.key ||
        ![notice.from, notice.to].includes(card.status ?? "") ||
        (!notice.closed && card.closed) ||
        card.assignees.some((a) => a.toLowerCase() !== bot) ||
        (card.status !== notice.to && !card.assignees.some((a) => a.toLowerCase() === bot)))
      throw new TicketChangedError("Ticket identity, requirements, claim or lane changed; preserving human state.");
    return card;
  };
  let card = await current();
  const comments = await board.listComments(card);
  const found = comments.some((c) => typeof c === "string" ? c === record.retry!.reason :
    c.author?.toLowerCase() === bot && c.body === record.retry!.reason);
  if (!found) {
    card = await current();
    if (!card.assignees.length) throw new TicketChangedError("Claim withdrawn before comment settlement.");
    await board.comment(card, record.retry!.reason);
    changed = true;
  }
  card = await current();
  if (card.closed) {
    if (!card.assignees.length) throw new TicketChangedError("Claim withdrawn before Issue reopen; preserving manual closure.");
    if (!board.reopen) throw new Error("Board adapter cannot reopen the conflicted Issue.");
    await board.reopen(card);
    changed = true;
    card = await current();
    if (card.closed) throw new Error("Issue reopen not yet observed.");
  }
  if (card.status !== notice.to) {
    await board.setStatus(card.itemId, notice.to);
    changed = true;
    card = await current();
    if (card.status !== notice.to) throw new Error("Project status write not yet observed.");
  }
  if (card.assignees.length) {
    await board.release(card);
    changed = true;
    card = await current();
    if (card.assignees.length) throw new Error("Claim release not yet observed.");
  }
  return { changed, card };
}
