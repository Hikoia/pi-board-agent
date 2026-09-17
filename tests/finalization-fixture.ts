// Real local bare remote; only Git/GitHub I/O fault boundaries are controlled.
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture as oldFixture, git, calls, faults, dispose, TicketWorktrees } from "./cleanup-fixture.js";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketBoardAdapter } from "../src/ticket-executor.js";
const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
const { BoardLoop, createLoopState } = await import("../src/loop.js");
export { git, calls, faults, dispose, TicketWorktrees };
export async function fixture(legacy = false) {
  faults.beforeGit = faults.afterGit = faults.beforeFs = faults.afterFs = faults.beforeSyncFs = undefined;
  const f = await oldFixture();
  const cfg = structuredClone(_DEFAULTS);
  cfg.safety.require_clean_worktree = cfg.context.enabled = cfg.telegram.enabled = false;
  cfg.task_merge_strategy = "merge"; // compatibility input must never create a new squash
  f.task.taskKey = f.record.taskKey = `T${String(f.task.issueNumber).padStart(3, "0")}`;
  writeFileSync(f.recordFile, JSON.stringify({ ...f.record, schemaVersion: legacy ? 3 : 4, reviewedTaskSha: f.taskSha }, null, 2));
  const card: Card = { itemId: f.task.itemId, number: f.task.issueNumber, title: f.task.taskKey + " " + f.task.title, body: f.task.body,
    contentType: "Issue", type: "Task", plan: "demo", status: cfg.columns.done, closed: true, assignees: [], repoOwner: "owner", repoName: "repo" };
  const comments: string[] = [], events: string[] = [], notices: string[] = [];
  let failDone = false, loseDone = false, failClaim = false, starts = 0, reviews = 0;
  const board: TicketBoardAdapter = {
    getCard: async () => structuredClone(card),
    claim: async () => { if (failClaim) throw new Error("offline claim failure"); card.assignees = ["bot"]; return true; },
    release: async () => { card.assignees = []; },
    comment: async (_card, body) => { comments.push(body); },
    listComments: async () => [...comments],
    reopen: async () => { events.push("reopen"); card.closed = false; },
    setStatus: async (_id, status) => {
      events.push(`status:${status}`);
      if (status === cfg.columns.backlog) {
        assert.ok(f.store.has(f.task.itemId), "record survives until Project Backlog");
        assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
        assert.equal(existsSync(f.record.path), false);
        assert.equal(git(f.repo, "ls-remote", "origin", `refs/heads/${f.task.taskBranch}`), "");
        if (failDone) throw new Error("offline final Done failure");
      }
      card.status = status;
      if (status === cfg.columns.backlog && loseDone) throw new Error("offline lost Done response");
    },
  };
  const make = () => new ManagedTicketExecutor({ cwd: f.repo, cfg, board, worktrees: new TicketWorktrees(f.repo), botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: (s) => notices.push(s),
    createManager: () => { starts++; throw new Error("No model/manager during integrate or cleanup"); } });
  const executor = make();
  const loop = new BoardLoop({ cwd: f.repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: (s) => notices.push(s),
    meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, listCards: async () => [structuredClone(card)],
    review: async () => { reviews++; throw new Error("No review during integrate or cleanup"); },
    boardOps: { claim: board.claim, refresh: () => board.getCard(card.itemId), release: board.release,
      listComments: async () => [], comment: async (c, body) => { await board.comment(c, body); return "comment"; },
      setStatus: async (c, status) => board.setStatus(c.itemId, status) },
  }, createLoopState(), executor, f.store);
  const noNewEvidence = () => {
    assert.deepEqual(readdirSync(join(f.repo, ".pi", "board-agent", "cleanup")), []);
    assert.equal(existsSync(join(f.repo, ".pi", "board-agent", "cleanup-backups")), false);
    assert.equal(existsSync(join(f.repo, ".pi", "board-agent", "repair")), false);
  };
  const finish = () => make().finalizeClosed(structuredClone(card));
  return { ...f, cfg, card, board, events, comments, notices, executor, loop, make, finish, noNewEvidence,
    recordNow: () => f.store.read(f.task.itemId)!, starts: () => starts, reviews: () => reviews,
    failDone: (value: boolean) => { failDone = value; }, loseDone: (value: boolean) => { loseDone = value; }, failClaim: (value: boolean) => { failClaim = value; } };
}
