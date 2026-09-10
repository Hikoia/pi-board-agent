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
