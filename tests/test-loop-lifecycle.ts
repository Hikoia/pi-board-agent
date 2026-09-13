import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import type { TicketExecutor } from "../src/ticket-executor.js";

const root = mkdtempSync(join(tmpdir(), "board-loop-lifecycle-"));
try {
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  const worktrees = new TicketWorktrees(root);
  let reads = 0;
  let reconciles = 0;
  let heartbeats = 0;
  const deps: LoopDeps = {
    cwd: root,
    cfg: structuredClone(_DEFAULTS),
    repoOwner: "owner",
    repoName: "repo",
    botLogin: "bot",
    meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
    callback: () => undefined,
    listCards: async () => {
      reads++;
      return [];
    },
    onTick: () => {
      heartbeats++;
    },
  };
  const executor: TicketExecutor = {
    reconcile: async () => {
      reconciles++;
      return {
        active: [],
        resumed: 0,
        adopted: 0,
        needsHuman: 0,
        orphans: 0,
        errors: 0,
      };
    },
    activeCount: () => 0,
    shutdown: async () => undefined,
    launch: async () => ({ status: "skipped", reason: "fixture" }),
    finalizeClosed: async () => ({ status: "skipped", reason: "fixture" }),
  };
  const loop = new BoardLoop(deps, createLoopState(), executor, worktrees);
  const legacy = join(root, ".pi", "board-agent", "inflight", "old.json");
  mkdirSync(join(legacy, ".."), { recursive: true });
  writeFileSync(legacy, "preserve this evidence");
  await assert.rejects(loop.tickNow(), /Unsupported pre-0.2.0/);
  assert.equal(reads + reconciles + heartbeats, 0);
  assert.equal(readFileSync(legacy, "utf8"), "preserve this evidence");
  await loop.stop();
  rmSync(join(legacy, ".."), { recursive: true });
  console.log(
    "PASS: every tick rejects unsupported state before board reads, recovery mutations or heartbeat writes",
  );

  // A stop is a barrier, not merely a request to stop. All callers share it.
  const barrierOwner = acquireOwnerLock(root, "bot");
  let finishDrain!: () => void;
  const drainBarrier = new Promise<void>((resolve) => { finishDrain = resolve; });
  let drains = 0;
  let launches = 0;
  const waiting = new BoardLoop(
    deps,
    createLoopState(),
    {
      ...executor,
      shutdown: async () => { drains++; await drainBarrier; },
      launch: async () => { launches++; return { status: "skipped", reason: "fixture" }; },
    },
    worktrees,
    barrierOwner,
  );
  const first = waiting.stop();
  const second = waiting.stop();
  let settled = false;
  void second.then(() => { settled = true; });
  try {
    assert.equal(first, second, "stop callers must receive the SAME in-flight promise");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "second stop cannot resolve before manager drain");
    assert.equal(drains, 1);
    assert.ok(existsSync(barrierOwner.path));
    waiting.enableAdmissions();
    await waiting.start();
    await waiting.tickNow();
    assert.equal(waiting.isAdmittingNewWork(), false);
    assert.equal(waiting.isRunning(), false);
    assert.equal(launches, 0);
  } finally {
    finishDrain();
    await Promise.all([first, second]);
  }
  assert.equal(existsSync(barrierOwner.path), false);
  assert.equal(waiting.stop(), first, "completed stop remains idempotent");
  console.log("PASS: repeated stop shares one drain barrier and cannot restart or promote the stopped loop");

  // An async busy-tick heartbeat is owner work too, not a detached continuation.
  const heartbeatOwner = acquireOwnerLock(root, "bot");
  let finishBusyRead!: () => void, finishHeartbeat!: () => void, enterHeartbeat!: () => void;
  const busyRead = new Promise<void>((done) => { finishBusyRead = done; });
  const heartbeatPending = new Promise<void>((done) => { finishHeartbeat = done; });
  const heartbeatEntered = new Promise<void>((done) => { enterHeartbeat = done; });
  const heartbeatLoop = new BoardLoop({
    ...deps, cfg: { ...deps.cfg, tick_seconds: 1 },
    listCards: async () => { await busyRead; return []; },
    revisionCheck: async () => { enterHeartbeat(); await heartbeatPending; return { ok: true }; },
  }, createLoopState(), executor, worktrees, heartbeatOwner);
  const busyStart = heartbeatLoop.start();
  await heartbeatEntered;
  let heartbeatStopped = false;
  const heartbeatStop = heartbeatLoop.stop().then(() => { heartbeatStopped = true; });
  try {
    finishBusyRead();
    await busyStart;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(heartbeatStopped, false, "stop awaits a revision heartbeat already in flight");
    assert.ok(existsSync(heartbeatOwner.path), "heartbeat continuation cannot outlive ownership");
  } finally {
    finishBusyRead(); finishHeartbeat();
    await Promise.all([busyStart, heartbeatStop]);
  }
  assert.equal(existsSync(heartbeatOwner.path), false);
  console.log("PASS: stop drains the in-flight asynchronous heartbeat before releasing its owner");

  const closed: Card = {
    itemId: "PVTI_1", number: 1, contentType: "Issue", type: "Task",
    repoOwner: "owner", repoName: "repo", title: "Done", body: "", plan: "demo",
    status: deps.cfg.columns.done, closed: true, assignees: [],
  };
  // Both candidates must have real local refs so the finalizer stop assertions
  // exercise the lane instead of passing through the historical-card filter.
  execFileSync("git", ["-C", root, "-c", "user.name=Offline", "-c", "user.email=offline@example.test", "commit", "--allow-empty", "-m", "finalization fixture"], { stdio: "ignore" });
  for (const number of [1, 2])
    execFileSync("git", ["-C", root, "branch", `task/issue-${number}`], { stdio: "ignore" });
  let finishFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { finishFetch = resolve; });
  let recoveryCalls = 0;
  const delayedFetch = new BoardLoop(
    { ...deps, listCards: async () => { await fetchGate; return [closed]; } },
    createLoopState(),
    { ...executor, reconcile: async () => { recoveryCalls++; return executor.reconcile([]); }, finalizeClosed: async () => { recoveryCalls++; return { status: "skipped", reason: "fixture" }; } },
    worktrees,
  );
  const fetching = delayedFetch.tickNow();
  const fetchStop = delayedFetch.stop();
  finishFetch();
  await Promise.all([fetching, fetchStop]);
  assert.equal(recoveryCalls, 0, "a board read that finishes after stop cannot schedule recovery/finalization");
  console.log("PASS: stopping during the board read does not admit another recovery or finalization action");

  const finalizerOwner = acquireOwnerLock(root, "bot");
  let finishFinalization!: () => void;
  let enteredFinalization!: () => void;
  const finalizationGate = new Promise<void>((resolve) => { finishFinalization = resolve; });
  const finalizationEntered = new Promise<void>((resolve) => { enteredFinalization = resolve; });
  let finalizations = 0;
  const finalizing = new BoardLoop(
    { ...deps, listCards: async () => [closed, { ...closed, itemId: "PVTI_2", number: 2 }] },
    createLoopState(),
    { ...executor, finalizeClosed: async () => { finalizations++; enteredFinalization(); await finalizationGate; return { status: "skipped", reason: "fixture" }; } },
    worktrees, finalizerOwner,
  );
  const finalizerTick = finalizing.tickNow();
  await Promise.race([finalizationEntered, finalizerTick.then(() => { throw new Error("finalization was not reached"); })]);
  const finalizerStop = finalizing.stop();
  let finalizerStopped = false;
  void finalizerStop.then(() => { finalizerStopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finalizerStopped, false);
  assert.ok(existsSync(finalizerOwner.path), "ongoing Git finalization retains ownership until it actually finishes");
  finishFinalization();
  await Promise.all([finalizerTick, finalizerStop]);
  assert.equal(finalizations, 1, "stop awaits current finalization but does not schedule the next one");
  assert.equal(existsSync(finalizerOwner.path), false);
  console.log("PASS: stop never interrupts an operating finalizer or unlocks early, and schedules no further finalization");

  const events: string[] = [];
  const owner = acquireOwnerLock(root, "bot");
  let rejectRead!: (error: Error) => void;
  const pendingRead = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const failing = new BoardLoop(
    { ...deps, listCards: () => pendingRead },
    createLoopState(),
    {
      ...executor,
      shutdown: async () => {
        events.push("drained");
      },
    },
    worktrees,
    {
      ...owner,
      release: () => {
        events.push("released");
        owner.release();
      },
    },
  );
  const tick = assert.rejects(failing.tickNow(), /read failed/);
  const stopped = assert.rejects(failing.stop(), /read failed/);
  rejectRead(new Error("read failed"));
  await Promise.all([tick, stopped]);
  assert.deepEqual(events, ["drained", "released"]);
  console.log(
    "PASS: a rejected in-flight tick still drains builders before releasing ownership",
  );

  const retained = acquireOwnerLock(root, "bot");
  const unsafeStop = new BoardLoop(
    deps,
    createLoopState(),
    {
      ...executor,
      shutdown: async () => {
        throw new Error("pause failed");
      },
    },
    worktrees,
    retained,
  );
  await assert.rejects(unsafeStop.stop(), /pause failed/);
  assert.ok(existsSync(join(root, ".pi", "board-agent", "owner.lock")));
  retained.release(); // No real managers were launched by this fixture.
  console.log(
    "PASS: failed builder draining retains the owner lock instead of permitting a second owner",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
