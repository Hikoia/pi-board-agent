// Real BoardLoop scheduling; only board, builder, and foreground model adapters are fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import {
  BoardLoop,
  createLoopState,
  type LoopBoardOps,
  type LoopDeps,
} from "../src/loop.js";
import type { TicketExecutor } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const summary = () => ({
  active: [],
  resumed: 0,
  adopted: 0,
  needsHuman: 0,
  orphans: 0,
  errors: 0,
});
type Lane = "review";
function harness(max: number, lanes: Lane[], builders = max + 1) {
  const cwd = mkdtempSync(join(root, "capacity-"));
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = max;
  cfg.safety.require_clean_worktree =
    cfg.context.enabled =
    cfg.telegram.enabled = false;
  const card = (number: number, patch: Partial<Card> = {}): Card => ({
    itemId: `ITEM_${number}`,
    contentType: "Issue",
    number,
    type: "Task",
    title: `T${String(number).padStart(3, "0")} contract`,
    body: "Acceptance",
    plan: "demo",
    repoOwner: "owner",
    repoName: "repo",
    closed: false,
    status: cfg.columns.ready,
    assignees: [],
    ...patch,
  });
  const cards = Array.from({ length: builders }, (_, i) => card(i + 1));
  for (const lane of lanes)
    cards.push(
      card(103, { status: cfg.columns.review }),
    );
  const reviewPath = join(cwd, ".pi", "worktrees", "ticket-issue-103-item_103");
  let reviewSha: string | undefined;
  if (lanes.includes("review")) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main"); git("config", "user.name", "Offline"); git("config", "user.email", "offline@example.test");
    git("commit", "--allow-empty", "-m", "capacity fixture");
    git("worktree", "add", "-b", "task/issue-103", reviewPath, "main");
    reviewSha = git("rev-parse", "HEAD");
  }
  const worktrees = new TicketWorktrees(cwd);
  if (lanes.includes("review")) {
    const dir = join(cwd, ".pi", "board-agent", "ticket-worktrees");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "item_103.json"),
      JSON.stringify({
        schemaVersion: 4,
        itemId: "ITEM_103",
        issueNumber: 103,
        taskKey: "T103",
        plan: "demo",
        taskBranch: "task/issue-103",
        baseBranch: "main",
        path: reviewPath,
        reviewedTaskSha: reviewSha,
        createdAt: 1,
      }),
    );
  }
  const current = (c: Card) =>
    cards.find((candidate) => candidate.itemId === c.itemId)!;
  const events: string[] = [];
  const board: LoopBoardOps = {
    claim: async (c) => {
      current(c).assignees = ["bot"];
      return true;
    },
    refresh: async (c) => structuredClone(current(c)),
    release: async (c) => {
      current(c).assignees = [];
    },
    listComments: async () => [],
    comment: async () => "comment",
    setStatus: async (c, status) => {
      current(c).status = status;
    },
  };
  let occupied = 0,
    models = 0,
    peak = 0;
  const entered = deferred(),
    finish = deferred();
  const state = createLoopState();
  const model = async (lane: Lane) => {
    models++;
    peak = Math.max(peak, occupied + models);
    events.push(lane);
    entered.resolve();
    try {
      await finish.promise;
    } finally {
      models--;
    }
    // No writeback noise: capacity/cleanup, not model output, is under test.
    throw new Error("offline model finished");
  };
  const executor: TicketExecutor = {
    reconcile: async () => {
      events.push("reconcile");
      return summary();
    },
    finalizeClosed: async () => {
      events.push("finalize");
      return { status: "skipped", reason: "fixture" };
    },
    activeCount: () => occupied,
    launch: async (c) => {
      occupied++;
      peak = Math.max(peak, occupied + models);
      current(c).status = cfg.columns.building;
      events.push(`builder:${c.number}`);
      return { status: "launched", runId: `run-${c.number}`, worktree: cwd };
    },
    shutdown: async () => {},
  };
  const deps: LoopDeps = {
    cwd,
    cfg,
    repoOwner: "owner",
    repoName: "repo",
    botLogin: "bot",
    meta: {
      projectId: "P",
      statusFieldId: "S",
      statusFieldType: "SINGLE_SELECT",
      statusOptions: Object.fromEntries(
        Object.values(cfg.columns).map((name) => [name, name]),
      ),
      planFieldId: "PLAN",
      planFieldType: "TEXT",
      typeFieldId: "TYPE",
      typeFieldType: "SINGLE_SELECT",
      typeOptions: { Task: "TASK", Story: "STORY" },
    },
    callback: () => {},
    listCards: async () => structuredClone(cards),
    boardOps: board,
    review: () => model("review"),
  };
  const loop = new BoardLoop(deps, state, executor, worktrees);
  return {
    loop,
    deps,
    cards,
    board,
    events,
    entered,
    finish,
    state,
    occupied: () => occupied,
    peak: () => peak,
    setOccupied: (count: number) => {
      occupied = count;
    },
  };
}

for (const max of [1, 2, 4]) {
  for (const lane of ["review"] as const) {
    const h = harness(max, [lane]);
    let settled = false;
    const tick = h.loop.tickNow().then(() => {
      settled = true;
    });
    try {
      await Promise.race([
        h.entered.promise,
        tick.then(() => {
          throw new Error("model was not reached");
        }),
      ]);
      assert.equal(
        settled,
        false,
        "foreground is held at a real model-adapter barrier",
      );
      assert.deepEqual(
        h.events.slice(0, max + 1),
        [
          "reconcile",
          ...Array.from({ length: max - 1 }, (_, i) => `builder:${i + 1}`),
          lane,
        ],
        `${lane} max=${max}: fill other builder slots BEFORE awaiting the foreground`,
      );
      assert.equal(h.occupied(), max - 1);
      assert.equal(h.peak(), max);
      assert.deepEqual(
        h.state.foreground,
        {
          kind: lane,
          label: "T103",
        },
        "one transient foreground model is visible while held",
      );
    } finally {
      h.finish.resolve();
      await tick;
      await h.loop.stop();
    }
    assert.equal(
      h.occupied(),
      max,
      "foreground release backfills the Ready builder slot",
    );
    assert.equal(h.peak(), max, "shared model cap is never exceeded");
    assert.equal(h.state.wavesLaunched, max);
    assert.equal(
      h.state.foreground,
      null,
      "failure/cleanup releases foreground state",
    );
    console.log(
      `PASS: ${lane} max=${max} launches builders first, holds one foreground, and backfills without exceeding the cap`,
    );
  }
}

for (const lane of ["review"] as const) {
  for (const change of ["stale", "full", "admission", "stop"] as const) {
    const h = harness(2, [lane]);
    const ops = h.board;
    const refresh = ops.refresh;
    let stopping: Promise<void> | undefined;
    ops.refresh = async (card) => {
      const fresh = await refresh(card);
      if (fresh?.assignees.includes("bot")) {
        if (change === "stale") fresh.body = "new contract";
        else if (change === "full") h.setOccupied(2);
        else if (change === "admission") h.loop.disableAdmissions();
        else stopping = h.loop.stop();
      }
      return fresh;
    };
    h.finish.resolve();
    await h.loop.tickNow();
    await stopping;
    assert.ok(
      !h.events.includes(lane),
      `${lane}: recheck ${change} at actual foreground admission`,
    );
    assert.equal(h.state.foreground, null);
    if (change === "stale")
      assert.equal(
        h.occupied(),
        2,
        "a stale candidate gives its reservation back to builders",
      );
    if (change === "admission") {
      await h.loop.tickNow();
      assert.equal(
        h.occupied(),
        1,
        "disabled admissions remain closed on subsequent ticks",
      );
    }
    await h.loop.stop();
    console.log(
      `PASS: ${lane} ${change} gate after prefill blocks stale/new model work without leaking foreground state`,
    );
  }
}

{
  const h = harness(2, []);
  // Real branch evidence keeps this recovery-order check in the finalizer lane.
  execFileSync("git", ["init", "-b", "main", h.deps.cwd], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      h.deps.cwd,
      "-c",
      "user.name=Offline",
      "-c",
      "user.email=offline@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "finalization fixture",
    ],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", h.deps.cwd, "branch", "task/issue-999"], {
    stdio: "ignore",
  });
  h.cards.push({
    ...h.cards[0],
    itemId: "CLOSED",
    number: 999,
    closed: true,
    status: h.deps.cfg.columns.done,
  });
  h.loop.disableAdmissions();
  await h.loop.tickNow();
  assert.deepEqual(
    h.events,
    ["reconcile", "finalize"],
    "durable recovery/finalization precede admission safety gates",
  );
  await h.loop.stop();
  console.log(
    "PASS: reconcile/finalize run with admissions disabled, without new builder/foreground admissions",
  );
}
