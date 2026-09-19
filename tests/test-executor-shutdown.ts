import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { ManagedTicketExecutor, type TicketWorkflowManager } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
const worktrees = new TicketWorktrees(cwd);
const cfg = structuredClone(_DEFAULTS);
cfg.safety.require_clean_worktree = false;
const deps: LoopDeps = {
  cwd, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: () => {}, listCards: async () => [],
};
const recordDir = join(cwd, ".pi", "board-agent", "ticket-worktrees");
mkdirSync(recordDir, { recursive: true });
// Public activeCount opens the real executor manager map for durable records.
// Manager I/O is the offline seam; no private map mutation or fake shutdown.
for (const number of [1, 2]) {
  writeFileSync(join(recordDir, `pvti_${number}.json`), JSON.stringify({
    schemaVersion: 3, itemId: `PVTI_${number}`, issueNumber: number,
    taskKey: `T00${number}`, plan: "demo", taskBranch: `task/issue-${number}`,
    baseBranch: "main", path: join(cwd, ".pi", "worktrees", `pvti_${number}`),
    createdAt: 1, activeRunId: `run-${number}`, activeRunStartedAt: 1,
  }));
}
let failDrain = true;
const pauses = [0, 0];
const disposed = [0, 0];
const schedulingStopped = [false, false];
let created = 0;
const executor = new ManagedTicketExecutor({
  cwd, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", worktrees,
  callback: () => {},
  board: {
    getCard: async () => undefined, claim: async () => false,
    release: async () => {}, setStatus: async () => {},
    listComments: async () => [], comment: async () => {},
  },
  createManager: (): TicketWorkflowManager => {
    const index = created++;
    const run = { runId: `run-${index + 1}`, status: "running" } as PersistedRunState;
    return {
      start: () => { throw new Error("unexpected start"); },
      list: () => [run], resume: async () => { throw new Error("unexpected resume"); },
      stopAndWait: async () => { throw new Error("stop would discard resumable builder state"); },
      pauseAndWait: async () => {
        pauses[index]++;
        // Real upstream marks paused before its cooperative cleanup finishes.
        run.status = "paused";
        if (index === 1 && failDrain) throw new Error("pause cleanup failed");
      },
      stopScheduling: () => { schedulingStopped[index] = true; },
      dispose: () => { disposed[index]++; },
    };
  },
});
assert.equal(executor.activeCount(), 2);
const owner = acquireOwnerLock(cwd, "bot");
const loop = new BoardLoop(deps, createLoopState(), executor, worktrees, owner);
try {
  const stopping = loop.stop();
  assert.deepEqual(schedulingStopped, [true, true], "stop synchronously disables ALL managers' recovery scheduling before drain");
  await assert.rejects(stopping, /pause cleanup failed/);
  assert.ok(existsSync(owner.path));
  assert.equal(loop.isStopped(), false);
  assert.deepEqual(disposed, [1, 0], "failed manager must remain retryable, not disposed or cleared");
  failDrain = false;
  const retry = loop.stop();
  assert.equal(loop.stop(), retry, "retry itself is also a shared barrier");
  await retry;
  assert.deepEqual(pauses, [1, 2], "retry drains the retained paused manager, not a new/recreated manager");
  assert.deepEqual(disposed, [1, 1]);
  assert.equal(created, 2);
  assert.equal(existsSync(owner.path), false);
  assert.equal(loop.isStopped(), true);
  console.log("PASS: actual executor manager-map drain failure retains only unfinished managers and owner lock; stop retry drains paused cleanup before unlock");
} finally {
  failDrain = false;
  await loop.stop();
  owner.release(); // Fixture cleanup only; no live processes/models were created.
}

// Launch and recovery awaits use the real executor/worktree code in a disposable
// local repository. The only adapters are board I/O, model manager and context.
{
  const repo = join(cwd, "repo");
  const origin = join(cwd, "origin.git");
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
  const cfg = structuredClone(deps.cfg);

  const worktrees = new TicketWorktrees(repo);
  const card = {
    itemId: "PVTI_9", contentType: "Issue" as const, number: 9, title: "Task", body: "Acceptance",
    repoOwner: "owner", repoName: "repo", plan: "demo", type: "Task", closed: false,
    status: cfg.columns.ready, assignees: [] as string[],
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  let reads = 0, claims = 0, releases = 0, starts = 0, resumes = 0;
  let context = async () => undefined;
  let beforeRead = async () => {};
  let run: PersistedRunState | undefined;
  const makeExecutor = () => new ManagedTicketExecutor({
    cwd: repo, cfg, worktrees, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {},
    context: () => context(),
    board: {
      getCard: async () => { reads++; await beforeRead(); return structuredClone(card); },
      claim: async () => { claims++; card.assignees = ["bot"]; return true; },
      release: async () => { releases++; card.assignees = []; },
      setStatus: async (_id, status) => { card.status = status; },
      comment: async () => {}, listComments: async () => [],
    },
    createManager: () => ({
      start: (_source, args) => { starts++; run = { runId: "run-9", args, status: "running" } as PersistedRunState; return "run-9"; },
      list: () => run ? [run] : [],
      resume: async () => { resumes++; run!.status = "running"; return true; },
      pauseAndWait: async () => { if (run) run.status = "paused"; },
      stopAndWait: async () => { if (run) run.status = "aborted"; },
      dispose: () => {},
    }),
  });
  const makeLoop = (executor: ManagedTicketExecutor) => {
    const owner = acquireOwnerLock(repo, "bot");
    return { owner, loop: new BoardLoop({ ...deps, cwd: repo, cfg, listCards: async () => [structuredClone(card)] }, createLoopState(), executor, worktrees, owner) };
  };
  let executor = makeExecutor();
  const contextEntered = deferred(), contextGate = deferred();
  context = async () => { contextEntered.resolve(); await contextGate.promise; return undefined; };
  const first = makeLoop(executor);
  const launching = first.loop.tickNow();
  await contextEntered.promise;
  const stopped = first.loop.stop();
  assert.ok(existsSync(first.owner.path));
  contextGate.resolve();
  await Promise.all([launching, stopped]);
  assert.equal(starts, 0, "a launch already awaiting context cannot start a builder while stopping");
  assert.ok(worktrees.read(card.itemId)?.launchingAt);
  assert.ok(pendingTicketWrite(worktrees.read(card.itemId)!));
  assert.equal(card.status, cfg.columns.building, "stop never writes a late Ready reset");
  assert.deepEqual(card.assignees, ["bot"], "claim remains tied to durable pending settlement");
  assert.equal(existsSync(first.owner.path), false);
  const observations = [reads, claims, starts, resumes];
  await executor.launch(card, "demo");
  await executor.reconcile([card]);
  executor.activeCount();
  assert.deepEqual([reads, claims, starts, resumes], observations, "closed executor admits neither direct launch nor recovery");
  console.log("PASS: stop closes an in-flight launch before manager start, retains its pending reset without late status writes, and latches executor admission");

  context = async () => undefined;
  executor = makeExecutor();
  assert.equal((await executor.reconcile([card])).errors, 0);
  assert.equal(worktrees.read(card.itemId)?.launchingAt, undefined);
  assert.equal(card.status, cfg.columns.ready);
  assert.deepEqual(card.assignees, []);
  assert.equal((await executor.launch(card, "demo")).status, "launched");
  run!.status = "paused";
  const readEntered = deferred(), readGate = deferred();
  beforeRead = async () => { readEntered.resolve(); await readGate.promise; };
  const recovery = makeLoop(executor);
  const reconciling = recovery.loop.tickNow();
  await readEntered.promise;
  const stopRecovery = recovery.loop.stop();
  readGate.resolve();
  await Promise.all([reconciling, stopRecovery]);
  assert.equal(resumes, 0, "reconcile returning from a fresh read cannot resume while stopping");
  assert.equal(worktrees.read(card.itemId)?.activeRunId, "run-9", "paused execution association remains recoverable");
  assert.equal(existsSync(recovery.owner.path), false);
  console.log("PASS: stop disables paused-run recovery across an in-flight fresh read without discarding execution evidence");
}
