import { assertOwnerLock, type OwnerLock } from "./owner-lock.js";
import { createHash } from "node:crypto";
import { checkOperation, type OperationControl } from "./operation.js";
import { isTargetIssue, type Card } from "./gh.js";
import { formatAgentComment } from "./dispatch.js";
import {
  TicketWorktrees,
  type TicketExecutionRecordV5,
  type StoredTicketExecutionRecord,
  type TicketRetryState,
} from "./ticket-worktree.js";

/** Writeback lives in retry.reason until all I/O settles. No second journal or
 * repair-specific protocol: the same path handles build, review and conflict. */
interface PendingWrite {
  card: Card;
  status: string;
  reason: string;
  comment?: string;
  reopen?: boolean;
  retry: boolean;
}
const PREFIX = "Pending ticket writeback:\n";

export function pendingTicketWrite(
  record: StoredTicketExecutionRecord,
): PendingWrite | undefined {
  if (!record.retry?.reason.startsWith(PREFIX)) return undefined;
  let value: PendingWrite;
  try {
    value = JSON.parse(
      record.retry.reason.slice(PREFIX.length),
    ) as PendingWrite;
  } catch (cause) {
    throw new Error(
      "Invalid pending ticket writeback; preserved for inspection.",
      { cause },
    );
  }
  if (
    !value?.card ||
    value.card.itemId !== record.itemId ||
    value.card.number !== record.issueNumber ||
    !isTargetIssue(
      value.card,
      value.card.repoOwner!,
      value.card.repoName!,
      value.card.closed && ["integrate", "cleanup"].includes(record.retry.stage)
        ? undefined
        : "Task",
    ) ||
    typeof value.card.title !== "string" ||
    typeof value.card.body !== "string" ||
    typeof value.card.status !== "string" ||
    typeof value.card.closed !== "boolean" ||
    !Array.isArray(value.card.assignees) ||
    !value.card.assignees.every((a) => typeof a === "string" && !!a) ||
    !Object.keys(value).every((key) =>
      ["card", "status", "reason", "comment", "reopen", "retry"].includes(key),
    ) ||
    typeof value.status !== "string" ||
    !value.status ||
    typeof value.reason !== "string" ||
    !value.reason ||
    typeof value.retry !== "boolean" ||
    (value.comment !== undefined && typeof value.comment !== "string") ||
    (value.reopen !== undefined && value.reopen !== true)
  )
    throw new Error(
      "Invalid pending ticket writeback; preserved for inspection.",
    );
  return value;
}

export function queueTicketWrite(
  store: TicketWorktrees,
  record: TicketExecutionRecordV5,
  stage: TicketRetryState["stage"],
  write: PendingWrite,
  owner: OwnerLock | undefined = store.owner,
  assertCurrent: () => void = () => {},
): TicketExecutionRecordV5 {
  if (record.schemaVersion !== 5)
    throw new Error("Migrate ticket before executing v5 writeback.");
  if (JSON.stringify(store.read(record.itemId)) !== JSON.stringify(record))
    throw new Error("Ticket record changed before writeback.");
  if (pendingTicketWrite(record)) return record;
  return store.update(record.itemId, (current) => ({
    ...current,
    retry: { stage, reason: PREFIX + JSON.stringify(write) },
  }), owner, assertCurrent);
}

export interface TicketWriteBoard {
  getCard(itemId: string): Promise<Card | undefined>;
  listComments(card: Card): Promise<string[]>; // authentic bot comments only in production
  comment(card: Card, body: string): Promise<void>;
  setStatus(itemId: string, status: string): Promise<void>;
  release(card: Card): Promise<void>;
  reopen?(card: Card): Promise<void>;
}

export function sameTicketContract(a: Card, b: Card): boolean {
  return (
    a.itemId === b.itemId &&
    a.number === b.number &&
    a.contentType === b.contentType &&
    a.repoOwner?.toLowerCase() === b.repoOwner?.toLowerCase() &&
    a.repoName?.toLowerCase() === b.repoName?.toLowerCase() &&
    a.type?.toLowerCase() === b.type?.toLowerCase() &&
    a.plan === b.plan &&
    a.title === b.title &&
    a.body === b.body
  );
}

/** Caller must drain the old run BEFORE even releasing a withdrawn claim. An
 * exception retains the pending write AND execution identity for the next tick. */
export async function settleTicketWrite(
  store: TicketWorktrees,
  record: TicketExecutionRecordV5,
  board: TicketWriteBoard,
  botLogin: string,
  drain: () => Promise<void> = async () => {},
  control?: OperationControl,
  owner: OwnerLock | undefined = store.owner,
): Promise<"settled" | "withdrawn"> {
  if (!owner) throw new Error("V5 writeback requires the exclusive owner.");
  const external = control;
  control = { ...control, check: () => { checkOperation(external); assertOwnerLock(owner, store.repoRoot); } };
  checkOperation(control);
  const write = pendingTicketWrite(record);
  if (!write) throw new Error("No pending ticket writeback.");
  const technical = write.card.closed && ["integrate", "cleanup"].includes(record.retry!.stage);
  await drain();
  const sameRecord = () => {
    checkOperation(control);
    if (JSON.stringify(store.read(record.itemId)) !== JSON.stringify(record))
      throw new Error("Ticket record changed during writeback.");
    // Conflict reopening must retain exclusive branch/path ownership across
    // each awaited board operation, not only the initial merge-tree check.
    if (write.reopen)
      store.cleanupRecordV5({
        ...record,
        title: write.card.title,
        body: write.card.body,
      });
  };
  const fresh = async () => {
    sameRecord();
    const card = await board.getCard(record.itemId);
    sameRecord();
    return card;
  };
  const target = (card: Card | undefined): card is Card =>
    !!card &&
    isTargetIssue(
      card,
      write.card.repoOwner!,
      write.card.repoName!,
      write.card.closed &&
        ["integrate", "cleanup"].includes(record.retry!.stage)
        ? undefined
        : "Task",
    ) &&
    card.itemId === record.itemId &&
    card.number === record.issueNumber;
  const hasBot = (card: Card) =>
    card.assignees.some((a) => a.toLowerCase() === botLogin.toLowerCase());
  const allowed = (card: Card | undefined): card is Card =>
    target(card) &&
    sameTicketContract(card, write.card) &&
    card.assignees.every((a) => a.toLowerCase() === botLogin.toLowerCase()) &&
    (technical || hasBot(card) || card.status === write.status) &&
    (card.status === write.card.status || card.status === write.status) &&
    (card.closed === write.card.closed ||
      (write.reopen === true && card.closed === false));
  const finish = (withdrawn = false) =>
    store.update(record.itemId, (current) => ({
      ...current,
      launchingAt: undefined,
      activeRunId: undefined,
      activeRunStartedAt: undefined,
      lastRunId: current.activeRunId ?? current.lastRunId,
      retry:
        technical || (!withdrawn && write.retry)
          ? { stage: current.retry!.stage, reason: write.reason }
          : undefined,
    }), owner, () => checkOperation(control));
  const guard = async (): Promise<Card | undefined> => {
    const card = await fresh();
    if (allowed(card)) return card;
    if (target(card) && hasBot(card)) await board.release(card);
    sameRecord();
    finish(true);
    return undefined;
  };
  let card = await guard();
  if (!card) return "withdrawn";
  if (technical) {
    // Old versions queued Ready/comment writes for pure I/O failures. Never
    // replay those writes, but retain the retry after guarded claim release.
    if (hasBot(card)) {
      await board.release(card);
      card = await guard();
      if (!card) return "withdrawn";
      if (hasBot(card)) throw new Error("Claim release is not yet observed.");
    }
    sameRecord();
    finish();
    return "settled";
  }
  if (write.comment) {
    const marker = `<!-- board-agent-write:${record.itemId}:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          record.activeRunId ?? record.lastRunId ?? record.createdAt,
          record.retry!.reason,
        ]),
      )
      .digest("hex")
      .slice(0, 20)} -->`;
    const legacyBody = `${marker}\n${write.comment}`;
    const body = formatAgentComment(legacyBody);
    const comments = await board.listComments(card);
    card = await guard();
    if (!card) return "withdrawn";
    if (!comments.includes(body) && !comments.includes(legacyBody)) await board.comment(card, body);
  }
  card = await guard();
  if (!card) return "withdrawn";
  if (write.reopen && card.closed) {
    if (!board.reopen) throw new Error("Issue reopen is unavailable.");
    await board.reopen(card);
  }
  card = await guard();
  if (!card) return "withdrawn";
  if (write.reopen && card.closed)
    throw new Error("Issue reopen is not yet observed.");
  if (card.status !== write.status)
    await board.setStatus(card.itemId, write.status);
  card = await guard();
  if (!card) return "withdrawn";
  if (card.status !== write.status)
    throw new Error("Project status write is not yet observed.");
  if (hasBot(card)) {
    await board.release(card);
    card = await guard();
    if (!card) return "withdrawn";
    if (hasBot(card)) throw new Error("Claim release is not yet observed.");
  }
  sameRecord();
  finish();
  return "settled";
}
