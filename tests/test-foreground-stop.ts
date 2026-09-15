// Real loop + foreground workflow runners. Only the model and board I/O are fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowAgent } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopBoardOps } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const origin = join(cwd, "origin.git");
git("init", "--bare", origin);
git("init", "-b", "main");
git("config", "user.name", "Offline");
git("config", "user.email", "offline@example.test");
writeFileSync(join(cwd, ".gitignore"), ".pi/\norigin.git/\n");
writeFileSync(join(cwd, "README.md"), "base\n");
git("add", ".gitignore", "README.md");
git("commit", "-m", "fixture");
git("remote", "add", "origin", origin);
git("push", "origin", "main");
git("branch", "task/issue-3");
git("push", "origin", "task/issue-3");
const sha = git("rev-parse", "HEAD");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>((done) => setImmediate(done));
let mode = "";
const original = WorkflowAgent.prototype.run;
try {
  for (mode of ["review"]) {
    const cfg = structuredClone(_DEFAULTS);
    cfg.safety.require_clean_worktree = false;
    cfg.context.enabled = cfg.telegram.enabled = false;
    const card: Card = {
      itemId: "PVTI_3", contentType: "Issue", number: 3, title: "Contract", body: "Acceptance",
      repoOwner: "owner", repoName: "repo", plan: "demo", closed: false, assignees: [],
      type: "Task",
      status: cfg.columns.review,
    };
    const comments: IssueComment[] = [];
    const worktrees = new TicketWorktrees(cwd);
    if (mode === "review") {
      const dir = join(cwd, ".pi", "board-agent", "ticket-worktrees");
      mkdirSync(dir, { recursive: true });
      const path = join(cwd, ".pi", "worktrees", "ticket-issue-3-pvti_3");
      git("worktree", "add", path, "task/issue-3");
      writeFileSync(join(dir, "pvti_3.json"), JSON.stringify({
        schemaVersion: 4, itemId: card.itemId, issueNumber: 3, taskKey: "T003", plan: "demo",
        taskBranch: "task/issue-3", baseBranch: "main", path, createdAt: 1, reviewedTaskSha: sha,
      }));
    }
    const owner = acquireOwnerLock(cwd, "bot");
    const entered = deferred(), cleanup = deferred(), finish = deferred();
    let received: AbortSignal | undefined;
    let cleanups = 0, calls = 0, releases = 0, mutations = 0, drains = 0;
    WorkflowAgent.prototype.run = (async (_prompt, options) => {
      calls++;
      received = options?.signal;
      entered.resolve();
      try {
        await new Promise<never>((_resolve, reject) => {
          if (received?.aborted) reject(new DOMException("cancelled", "AbortError"));
          else received?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
          // Bounded red path when the loop's signal is not connected.
          void finish.promise.then(() => reject(new DOMException("offline teardown", "AbortError")));
        });
      } finally {
        cleanups++;
        cleanup.resolve();
        await finish.promise;
      }
    }) as typeof original;
    const board: LoopBoardOps = {
      claim: async () => { card.assignees = ["bot"]; return true; },
      refresh: async () => structuredClone(card), listComments: async () => comments,
      release: async () => { releases++; card.assignees = []; },
      comment: async () => { mutations++; return "unexpected"; },
      setStatus: async () => { mutations++; },
    };
    const state = createLoopState();
    const loop = new BoardLoop({
      cwd, cfg, repoOwner: "owner", repoName: "repo", botLogin: "bot",
      meta: {
        projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT",
        statusOptions: Object.fromEntries(Object.values(cfg.columns).map((name) => [name, name])),
        planFieldId: "PLAN", planFieldType: "TEXT", typeFieldId: "TYPE", typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK", Story: "STORY" },
      },
      callback: () => {}, listCards: async () => [structuredClone(card)], boardOps: board,
    }, state, {
      reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
      activeCount: () => 0,
      launch: async () => { throw new Error("unexpected builder launch"); },
      finalizeClosed: async () => { throw new Error("unexpected finalization"); },
      shutdown: async () => { drains++; },
    }, worktrees, owner);
    const tick = loop.tickNow();
    // Do not hide a failure to reach the model behind an unresolved test promise.
    await Promise.race([entered.promise, tick.then(() => { throw new Error(`${mode}: no model reached`); })]);
    const stop = loop.stop();
    const second = loop.stop();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    try {
      assert.ok(received?.aborted, `${mode}: loop stop must reach the foreground runWorkflow signal`);
      await cleanup.promise;
      await turn();
      assert.equal(stopped, false, `${mode}: abort is not cleanup completion`);
      assert.equal(drains, 0, "tick cleanup precedes manager drain");
      assert.equal(releases, 0, "claim must stay held until workflow cleanup settles");
      assert.ok(existsSync(owner.path));
    } finally {
      finish.resolve();
      await Promise.all([tick, stop, second]);
    }
    assert.equal(cleanups, 1);
    assert.equal(calls, 1);
    assert.equal(drains, 1);
    assert.equal(releases, 1);
    assert.equal(mutations, 0, "cancelled output never writes a card");
    assert.equal(state.reviewingTask, null);
    assert.equal(existsSync(owner.path), false);
    if (mode === "review") {
      assert.ok(!readdirSync(join(cwd, ".pi", "worktrees")).some((name) => name.startsWith("review-")));
      assert.equal(git("for-each-ref", "--format=%(refname)", "refs/board-agent/reviews/"), "");
    }
    console.log(`PASS: ${mode} loop cancellation drains actual runWorkflow finally once before claim/owner release, with no stale writes`);
  }
} finally {
  WorkflowAgent.prototype.run = original;
}
