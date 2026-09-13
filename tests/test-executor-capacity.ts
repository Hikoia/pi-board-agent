// Real BoardLoop + ManagedTicketExecutor + durable v3 records/worktrees.
// Board and manager/model I/O are offline adapters; Git uses a local bare origin.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import { ManagedTicketExecutor, type TicketBoardAdapter, type TicketWorkflowManager } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const repo = join(cwd, "repo"), origin = join(cwd, "origin.git");
mkdirSync(repo);
const git = (path: string, ...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "ignore" });
git(cwd, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, "README.md"), "base\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "fixture");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");
const cfg = structuredClone(_DEFAULTS);
cfg.max_workers = 3;
cfg.safety.require_clean_worktree = cfg.context.enabled = cfg.refine.enabled = cfg.review.enabled = cfg.watchdog.enabled = cfg.telegram.enabled = false;
const cards: Card[] = Array.from({ length: 4 }, (_, i) => ({
  itemId: `ITEM_${i + 1}`, number: i + 1, contentType: "Issue", type: "Task", title: `T00${i + 1} Task`, body: "Acceptance", plan: "demo",
  repoOwner: "owner", repoName: "repo", closed: false, assignees: [], status: cfg.columns.ready,
}));
const current = (itemId: string) => cards.find((card) => card.itemId === itemId)!;
let unreadable = false;
const board: TicketBoardAdapter = {
  getCard: async (id) => { if (unreadable) throw new Error("unverifiable board"); return structuredClone(current(id)); },
  claim: async (card) => { current(card.itemId).assignees = ["bot"]; return true; },
  release: async (card) => { current(card.itemId).assignees = []; },
  setStatus: async (id, status) => { current(id).status = status; },
  listComments: async () => [], comment: async () => {},
};
const worktrees = new TicketWorktrees(repo);
const runs = new Map<string, PersistedRunState>();
let starts = 0, resumes = 0, stops = 0, brokenManagerRead = false;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const contextEntered = deferred(), contextRelease = deferred();
let context = async () => { contextEntered.resolve(); await contextRelease.promise; return undefined; };
let executor: ManagedTicketExecutor;
const makeExecutor = () => new ManagedTicketExecutor({
  cwd: repo, cfg, worktrees, board, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {}, context: () => context(),
  createManager: (path): TicketWorkflowManager => ({
    start: (_script, args) => {
      starts++;
      const run = { runId: `run-${args.itemId}`, args, status: "running" } as PersistedRunState;
      runs.set(path, run);
      return run.runId;
    },
    list: () => { if (brokenManagerRead) throw new Error("unreadable run"); return runs.has(path) ? [runs.get(path)!] : []; },
    resume: async () => {
      // Recovery reuses an ALREADY occupied slot, including after a lower cap.
      assert.equal(executor.activeCount(), 3);
      resumes++;
      runs.get(path)!.status = "running";
      assert.equal(executor.activeCount(), 3);
      return true;
    },
    pauseAndWait: async () => { const run = runs.get(path); if (run?.status === "running") run.status = "paused"; },
    stopAndWait: async () => { stops++; }, dispose: () => {},
  }),
});
const deps: LoopDeps = {
  cwd: repo, cfg, repoOwner: "owner", repoName: "repo", botLogin: "bot", meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: () => {}, listCards: async () => structuredClone(cards),
};
executor = makeExecutor();
let loop = new BoardLoop(deps, createLoopState(), executor, worktrees);
try {
  const launching = loop.tickNow();
  await contextEntered.promise;
  assert.equal(starts, 0);
  assert.equal(executor.activeCount(), 1, "launchingAt reserves a slot BEFORE manager.start");
  contextRelease.resolve();
  await launching;
  assert.equal(starts, 3);
  assert.equal(executor.activeCount(), 3);
  assert.equal(cards[3].status, cfg.columns.ready);
  console.log("PASS: real executor counts launch preparation and BoardLoop fills only max_workers durable builders");

  const [firstPath, first] = [...runs.entries()][0];
  for (const status of ["pending", "paused", "running"] as const) {
    first.status = status;
    first.pauseReason = status === "paused" ? "usage_limit" : undefined;
    await loop.tickNow();
    assert.equal(executor.activeCount(), 3);
    assert.equal(starts, 3, `${status} is not spare capacity`);
  }
  assert.equal(resumes, 0, "usage-limit resume belongs to the existing manager scheduler");
  first.status = "paused";
  assert.equal(executor.activeCount(), 3);
  first.status = "running"; // Scheduler resumption changes model activity, not occupied slots.
  assert.equal(executor.activeCount(), 3);
  console.log("PASS: pending/usage-limit-paused runs retain their slots, so auto-resume adds no uncounted work");

  unreadable = true; // Reconcile cannot discard uncertain durable associations.
  runs.delete(firstPath);
  await loop.tickNow();
  assert.equal(executor.activeCount(), 3, "missing persisted run retains its slot");
  runs.set(firstPath, first);
  brokenManagerRead = true;
  await loop.tickNow();
  assert.equal(executor.activeCount(), 3, "unreadable persisted run retains its slot");
  assert.equal(starts, 3);
  brokenManagerRead = unreadable = false;
  console.log("PASS: missing/unreadable durable runs block new admissions instead of lending uncertain slots");

  cfg.max_workers = 1;
  await loop.tickNow();
  assert.equal(executor.activeCount(), 3);
  assert.equal(starts, 3);
  assert.equal(stops, 0, "lowering the cap must not terminate existing work");
  await loop.stop();
  assert.ok([...runs.values()].every((run) => run.status === "paused"));
  executor = makeExecutor();
  loop = new BoardLoop(deps, createLoopState(), executor, worktrees);
  assert.equal(executor.activeCount(), 3, "restored excess runs already own slots");
  await loop.tickNow();
  assert.equal(resumes, 3);
  assert.equal(executor.activeCount(), 3);
  assert.equal(starts, 3);
  assert.equal(stops, 0, "recovery does not evict excess runs to meet the new cap");
  for (const [index, run] of [...runs.values()].entries()) {
    const args = run.args as { itemId: string; taskKey: string };
    run.status = "completed";
    run.result = [{ ...args, status: "failure", error: "offline completed blocker" }];
    await loop.tickNow();
    assert.equal(starts, index < 2 ? 3 : 4, "new work waits until occupancy falls BELOW the cap");
  }
  assert.equal(executor.activeCount(), 1);
  assert.equal(stops, 0);
  console.log("PASS: excess recovered builders resume within retained slots without eviction; new admissions wait until enough slots drain");
} finally {
  contextRelease.resolve();
  brokenManagerRead = unreadable = false;
  await loop.stop();
}
