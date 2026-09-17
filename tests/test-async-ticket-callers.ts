// Real loop/executor/store; held public store operations expose missing awaits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import {
  ManagedTicketExecutor,
  type TicketBoardAdapter,
} from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const repo = join(root, "repo"),
  origin = join(root, "origin.git");
mkdirSync(repo);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), ".pi/\n");
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "fixture");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");
const cfg = structuredClone(_DEFAULTS);
cfg.max_workers = 1;
cfg.context.enabled = cfg.telegram.enabled = false;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let sequence = 0;
function fixture() {
  const number = ++sequence;
  const card: Card = {
    itemId: `ASYNC_${number}`,
    number,
    contentType: "Issue",
    type: "Task",
    title: `T${number} Acceptance`,
    body: "Acceptance",
    plan: "demo",
    repoOwner: "owner",
    repoName: "repo",
    closed: false,
    status: cfg.columns.ready,
    assignees: [],
  };
  const store = new TicketWorktrees(repo);
  const writes: string[] = [],
    notices: string[] = [];
  let starts = 0,
    revision = true,
    run: PersistedRunState | undefined;
  const board: TicketBoardAdapter = {
    getCard: async () => structuredClone(card),
    claim: async () => {
      card.assignees = ["bot"];
      return true;
    },
    release: async () => {
      writes.push("release");
      card.assignees = [];
    },
    setStatus: async (_id, status) => {
      writes.push(status);
      card.status = status;
    },
    listComments: async () => [],
    comment: async () => {
      writes.push("comment");
    },
  };
  const executor = new ManagedTicketExecutor({
    cwd: repo,
    cfg,
    worktrees: store,
    board,
    botLogin: "bot",
    repoOwner: "owner",
    repoName: "repo",
    callback: (s) => notices.push(s),
    createManager: () => ({
      start: (_source, args) => {
        starts++;
        run = {
          args,
          runId: `run-${number}`,
          status: "running",
        } as PersistedRunState;
        return run.runId;
      },
      list: () => (run ? [run] : []),
      resume: async () => false,
      pauseAndWait: async () => {
        if (run) run.status = "paused";
      },
      stopAndWait: async () => {
        if (run) run.status = "aborted";
      },
      dispose: () => {},
    }),
  });
  const loop = new BoardLoop(
    {
      cwd: repo,
      cfg,
      botLogin: "bot",
      repoOwner: "owner",
      repoName: "repo",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      callback: (s) => notices.push(s),
      listCards: async () => [structuredClone(card)],
      revisionCheck: async () => ({ ok: revision, reason: "revision closed" }),
    },
    createLoopState(),
    executor,
    store,
  );
  return {
    card,
    store,
    writes,
    notices,
    executor,
    loop,
    starts: () => starts,
    closeRevision: () => {
      revision = false;
    },
    task: buildTasksForWave(cfg, "demo", [card])[0],
  };
}

for (const change of ["unchanged", "revision", "human", "contract", "stop"]) {
  const f = fixture(),
    entered = deferred(),
    finish = deferred();
  const ensure = f.store.ensure.bind(f.store);
  let preparation: ReturnType<typeof ensure> | undefined;
  f.store.ensure = (...args) =>
    (preparation = (async () => {
      const record = await ensure(...args);
      entered.resolve();
      await finish.promise;
      return record;
    })());
  const tick = f.loop.tickNow();
  let stopping: Promise<void> | undefined,
    stopped = false;
  try {
    await Promise.race([
      entered.promise,
      tick.then(() => {
        throw new Error(
          `tick settled before async preparation: ${f.notices.join("; ")}`,
        );
      }),
    ]);
    assert.equal(f.starts(), 0);
    assert.deepEqual(
      [...f.writes],
      [],
      "no launch status/cleanup before worktree preparation settles",
    );
    if (change === "revision") f.closeRevision();
    if (change === "human") f.card.status = cfg.columns.needs_human;
    if (change === "contract")
      f.card.body = "Human changed acceptance during fetch";
    if (change === "stop") {
      stopping = f.loop.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        stopped,
        false,
        "stop waits for the in-flight preparation and cleanup",
      );
    }
    finish.resolve();
    await tick;
    await stopping;
    assert.equal(f.starts(), change === "unchanged" ? 1 : 0);
    const record = f.store.read(f.card.itemId)!;
    assert.ok(
      existsSync(record.path),
      "no destructive worktree cleanup on a skipped launch",
    );
    assert.equal(record.launchingAt, undefined);
    if (change === "unchanged") assert.equal(record.activeRunId, "run-1");
    else {
      assert.equal(record.activeRunId, undefined);
      assert.deepEqual(f.card.assignees, []);
      assert.equal(
        f.card.status,
        change === "human" ? cfg.columns.needs_human : cfg.columns.ready,
      );
      if (change === "contract" || change === "human")
        assert.deepEqual(
          f.writes,
          ["release"],
          "async preparation cannot overwrite a later human contract/state",
        );
      assert.equal(f.writes.includes("comment"), false);
    }
    console.log(
      `PASS: async ensure ${change} is awaited before actual-start fresh-card/revision/stop gates and recovery`,
    );
  } finally {
    finish.resolve();
    await preparation;
    await tick.catch(() => {});
    await f.loop.stop();
    f.store.clearExecution(f.card.itemId);
  }
}

for (const delta of [false, true]) {
  const f = fixture();
  const record = await f.store.ensure(f.task, "demo");
  if (delta) {
    writeFileSync(join(record.path, "partial.txt"), "preserve local commit\n");
    git(record.path, "add", ".");
    git(record.path, "commit", "-m", "partial");
  }
  f.store.beginLaunch(f.card.itemId);
  const launchRecord = f.store.read(f.card.itemId);
  f.card.status = cfg.columns.building;
  f.card.assignees = ["bot"];
  const summary = await f.executor.reconcile([structuredClone(f.card)]);
  assert.equal(summary.errors, 0);
  assert.equal(summary.needsHuman, 0);
  assert.deepEqual(f.writes, []);
  assert.equal(f.starts(), 0);
  assert.equal(f.card.status, cfg.columns.building);
  assert.deepEqual(
    f.store.read(f.card.itemId),
    launchRecord,
    "unknown launch retains exact crash evidence regardless of task delta",
  );
  assert.ok(existsSync(record.path));
  await f.loop.stop();
  console.log(
    `PASS: uncertain crash recovery with local delta=${delta} retains launch evidence/work and cannot guess Ready or Needs Human`,
  );
}

{
  const f = fixture();
  const record = await f.store.ensure(f.task, "demo");
  writeFileSync(join(record.path, "accepted.txt"), "accepted\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "accepted");
  git(record.path, "push", "origin", record.taskBranch);
  f.store.setReviewedTaskSha(
    f.card.itemId,
    git(record.path, "rev-parse", "HEAD"),
  );
  f.card.status = cfg.columns.done;
  f.card.closed = true;
  const entered = deferred(),
    finish = deferred(),
    finalize = f.store.finalizeAccepted.bind(f.store);
  f.store.finalizeAccepted = async (...args) => {
    entered.resolve();
    await finish.promise;
    return await finalize(...args);
  };
  const tick = f.loop.tickNow();
  let stopped = false;
  try {
    await Promise.race([
      entered.promise,
      tick.then(() => {
        throw new Error("finalization not reached");
      }),
    ]);
    const stopping = f.loop.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      stopped,
      false,
      "stop may not detach destructive finalization or release its owner early",
    );
    assert.equal(
      f.notices.some((s) => s.startsWith("Finalized")),
      false,
    );
    assert.ok(f.store.localBranchSha(record.taskBranch));
    finish.resolve();
    await tick;
    await stopping;
    assert.equal(
      f.store.localBranchSha(record.taskBranch),
      git(record.path, "rev-parse", "HEAD"),
    );
    assert.equal(existsSync(record.path), true);
    assert.throws(() => git(repo, "show", "origin/main:accepted.txt"));
    assert.equal(f.notices.filter((s) => s.startsWith("Finalized")).length, 0);
    assert.deepEqual(f.writes, []);
    // No Git operation had started when stop arrived. A fresh owner can finish
    // the retained, approved record, rather than deleting it to satisfy stop.
    const result = await finalize(f.task, "merge");
    assert.ok(result);
    assert.equal(git(repo, "show", "origin/main:accepted.txt"), "accepted");
    assert.equal(existsSync(record.path), false);
    assert.equal(f.store.localBranchSha(record.taskBranch), undefined);
    console.log(
      "PASS: stop drains held finalization, vetoes not-yet-started Git and retains approved work for later integration",
    );
  } finally {
    finish.resolve();
    await tick;
    await f.loop.stop();
  }
}
