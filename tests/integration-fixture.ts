import assert from "node:assert/strict";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketBoardAdapter } from "../src/ticket-executor.js";
import { fixture, TicketWorktrees } from "./cleanup-fixture.js";
const { acquireOwnerLock } = await import("../src/owner-lock.js");
const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
const { BoardLoop, createLoopState } = await import("../src/loop.js");

export async function integrationFixture(legacy = false) {
  const f = await fixture(true), cfg = structuredClone(_DEFAULTS);
  cfg.context.enabled = cfg.refine.enabled = cfg.watchdog.enabled = cfg.telegram.enabled = false;
  cfg.safety.require_clean_worktree = false;
  cfg.task_merge_strategy = "squash"; // obsolete input MUST NOT create new squash
  const card: Card = { itemId: f.task.itemId, number: f.task.issueNumber, type: "Task", contentType: "Issue",
    repoOwner: "owner", repoName: "repo", title: f.task.title, body: f.task.body, plan: "demo",
    closed: true, status: cfg.columns.done, assignees: [] };
  const comments: string[] = [], writes: string[] = [], notices: string[] = [];
  const board: TicketBoardAdapter = {
    getCard: async () => structuredClone(card),
    listComments: async () => [...comments],
    comment: async (_c, body) => { comments.push(body); writes.push("comment"); },
    setStatus: async (_id, status) => { card.status = status; writes.push(status); },
    claim: async () => { card.assignees = ["bot"]; writes.push("claim"); return true; },
    release: async () => { card.assignees = []; writes.push("release"); },
    reopen: async () => { card.closed = false; writes.push("reopen"); },
  };
  const ownerLock = legacy ? acquireOwnerLock(f.repo, "bot", f.repo, true) : undefined;
  const executor = () => new ManagedTicketExecutor({ cwd: f.repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo",
    worktrees: new TicketWorktrees(f.repo), ownerLock, board, callback: (m) => notices.push(m),
    createManager: () => assert.fail("Integration/cleanup must never invoke a model manager") });
  const tick = async () => {
    const e = executor(), loop = new BoardLoop({ cwd: f.repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, listCards: async () => [structuredClone(card)],
      callback: (m) => notices.push(m), review: async () => assert.fail("No review replay") }, createLoopState(), e, new TicketWorktrees(f.repo));
    try { await loop.tickNow(); } finally { await loop.stop(); }
  };
  return { ...f, cfg, card, comments, writes, notices, board, executor, tick, ownerLock };
}
