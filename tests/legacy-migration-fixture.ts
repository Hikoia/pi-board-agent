// All state, WorkflowManager homes and Git remotes are disposable/offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { workflowProjectPaths, type PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import type { TicketBoardAdapter } from "../src/ticket-executor.js";
import { TicketWorktrees, type TicketExecutionRecord } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";
import { conflictRequestKey } from "../src/legacy-tickets.js";
import type { RepairRequest } from "../src/repair.js";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
export async function fixture() {
  assert.ok(process.env.TMP_DIR, "Use tests/run-offline.sh");
  const repo = join(process.env.TMP_DIR!, "repo"), origin = join(process.env.TMP_DIR!, "origin.git");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Offline");
  git(repo, "config", "user.email", "offline@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), ".pi/\n");
  writeFileSync(join(repo, "work.txt"), "original\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base");
  git(repo, "init", "--bare", origin);
  git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
  const sha = git(repo, "rev-parse", "HEAD");
  const cfg = structuredClone(_DEFAULTS);
  cfg.context.enabled = cfg.review.enabled = cfg.refine.enabled = cfg.watchdog.enabled = cfg.telegram.enabled = false;
  cfg.safety.require_clean_worktree = false;
  const store = new TicketWorktrees(repo), cards: Card[] = [], comments: IssueComment[] = [], writes: string[] = [];
  const board: TicketBoardAdapter = {
    getCard: async (id) => structuredClone(cards.find((c) => c.itemId === id)),
    setStatus: async (id, status) => { writes.push(`status:${id}:${status}`); cards.find((c) => c.itemId === id)!.status = status; },
    claim: async (card) => { writes.push(`claim:${card.itemId}`); cards.find((c) => c.itemId === card.itemId)!.assignees = ["bot"]; return true; },
    release: async (card) => { writes.push(`release:${card.itemId}`); cards.find((c) => c.itemId === card.itemId)!.assignees = []; },
    listComments: async () => comments.map((c) => c.body),
    comment: async (_card, body) => { writes.push("comment"); comments.push({ id: `C${comments.length}`, author: "bot", body, createdAt: new Date().toISOString() }); },
    conflict: {
      listComments: async (card) => structuredClone(comments.filter((c) => c.id === `repair-${card.itemId}`)),
      createComment: async () => assert.fail("No new legacy repair protocol"),
      updateComment: async () => assert.fail("Old comments stay read-only"),
      reopen: async () => assert.fail("Migration does not reopen issues"),
    },
  };
  const deps = { worktrees: store, cwd: repo, cfg, board, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {} };
  async function ticket(name: string, status: string = cfg.columns.building) {
    const card: Card = { itemId: name, number: cards.length + 1, contentType: "Issue", type: "Task", title: `T002 ${name}`,
      body: "Original question: which paid service? Option A or B; recommend A.", plan: "demo", status, closed: false,
      assignees: ["bot"], repoOwner: "owner", repoName: "repo" };
    cards.push(card);
    const task = buildTasksForWave(cfg, "demo", [card])[0];
    const record = { ...await store.ensure(task, "demo"), schemaVersion: 3 as const };
    const file = store.recordPath(card.itemId);
    writeFileSync(file, JSON.stringify(record, null, 2)); // Explicit historical source; ensure now creates v4.
    return { card, task, record, file };
  }
  function journal(record: TicketExecutionRecord, runId: string, status: PersistedRunState["status"] = "paused", repair?: RepairRequest) {
    const run: PersistedRunState = { runId, workflowName: "original", script: `export const meta = { name: 'original', description: 'do not regenerate' };\nreturn [await agent('original script and args', { label: 'original', model: 'offline-model' })];`,
      args: { itemId: record.itemId, issueNumber: record.issueNumber, taskKey: record.taskKey, custom: { keep: [1, "two"] }, ...(repair ? { repair } : {}) },
      status, agents: [], logs: ["original diagnostic"], phases: [], startedAt: new Date(record.createdAt + 10).toISOString(), updatedAt: new Date().toISOString() };
    const dir = workflowProjectPaths(record.path).runsDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${runId}.json`);
    writeFileSync(file, JSON.stringify(run, null, 2));
    return { run, file };
  }
  function ledger(record: TicketExecutionRecord, card: Card, step: "queued" | "launching" | "consumed", runId: string | null = null) {
    const request = { requestKey: conflictRequestKey(record.itemId, sha, sha), baseSha: sha, taskSha: sha };
    const { itemId, number, repoOwner, repoName, contentType, type, plan, title, body } = card;
    const h = { schemaVersion: 1, request, card: { itemId, number, repoOwner, repoName, contentType, type, plan, title, body }, record,
      step, attempted: false, commentId: `repair-${itemId}`, runId, notice: null };
    const dir = join(repo, ".pi", "board-agent", "repair"); mkdirSync(dir, { recursive: true });
    const file = join(dir, `${request.requestKey}.json`);
    writeFileSync(file, JSON.stringify(h, null, 2));
    comments.push({ id: h.commentId, author: "bot", createdAt: new Date().toISOString(),
      body: `<!-- board-agent-conflict-repair:v1:${request.requestKey} -->\n${JSON.stringify({ schemaVersion: 1, ...request, itemId, issueNumber: number, repoOwner, repoName, plan, title,
        bodyHash: createHash("sha256").update(body).digest("hex"), taskBranch: record.taskBranch, baseBranch: record.baseBranch, recordCreatedAt: record.createdAt,
        phase: step === "queued" ? "queued" : "consumed" })}` });
    return { request, file };
  }
  return { repo, origin, sha, cfg, store, cards, comments, writes, board, deps, ticket, journal, ledger };
}
