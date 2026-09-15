// Real BoardLoop scheduling; only board, builder, and foreground model adapters are fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
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
type Lane = "design" | "refine" | "review";
function harness(max: number, lanes: Lane[], builders = max + 1) {
  const cwd = mkdtempSync(join(root, "capacity-"));
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = max;
  cfg.safety.require_clean_worktree =
    cfg.context.enabled =
    cfg.telegram.enabled =
    cfg.watchdog.enabled =
      false;
  cfg.refine.enabled = lanes.some((lane) => lane !== "review");
  cfg.review.enabled = lanes.includes("review");
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
      card({ design: 101, refine: 102, review: 103 }[lane], {
        type: lane === "refine" ? "Story" : "Task",
        status:
          lane === "design"
            ? cfg.columns.needs_design
            : lane === "review"
              ? cfg.columns.review
              : cfg.columns.ready,
      }),
    );
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
        path: join(cwd, ".pi", "worktrees", "item_103"),
        createdAt: 1,
      }),
    );
  }
  const current = (c: Card) =>
    cards.find((candidate) => candidate.itemId === c.itemId)!;
  const comments: IssueComment[] = [
    {
      id: "gate",
      author: "bot",
      createdAt: "2025-01-01",
      body: "<!-- board-agent-requirements-gate:101 -->\nApprove scope",
    },
    {
      id: "decision",
      author: "owner",
      authorAssociation: "OWNER",
      createdAt: "2025-01-02",
      body: "Approved",
    },
  ];
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
    listComments: async (c) => (c.number === 101 ? comments : []),
    comment: async () => "comment",
    setStatus: async (c, status) => {
      current(c).status = status;
    },
  };
  let occupied = 0,
    models = 0,
    peak = 0;
  let revision = true;
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
    revisionCheck: () => ({ ok: revision }),
    refine: () => model("refine"),
    review: () => model("review"),
    taskDesignOps: {
      ...board,
      design: () => model("design"),
      updateBody: async () => {},
      comment: async () => {},
      setReady: async () => {},
    },
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
    setRevision: (value: boolean) => {
      revision = value;
    },
  };
}

for (const max of [1, 2, 4]) {
  for (const lane of ["design", "refine", "review"] as const) {
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
          label:
            lane === "review"
              ? "T103"
              : lane === "design"
                ? "Task #101"
                : "Story #102",
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

for (const lanes of [
  ["design", "refine", "review"],
  ["refine", "review"],
] as Lane[][]) {
  const h = harness(4, lanes);
  const tick = h.loop.tickNow();
  await Promise.race([h.entered.promise, tick]);
  h.finish.resolve();
  await tick;
  await h.loop.stop();
  assert.deepEqual(
    h.events.filter((event) => ["design", "refine", "review"].includes(event)),
    [lanes[0]],
    "only one primary foreground model per tick, in Task-design -> Story -> Review priority",
  );
  console.log(
    `PASS: ${lanes[0]} is the sole primary foreground ahead of lower-priority lanes`,
  );
}

// Read-only design waiting falls through to the next primary lane, but a stale
// foreground candidate returns its reservation to Ready builders.
{
  const h = harness(2, ["design", "refine", "review"]);
  h.deps.taskDesignOps!.listComments = async () => [
    {
      id: "gate",
      author: "bot",
      createdAt: "2025-01-01",
      body: "<!-- board-agent-requirements-gate:101 -->\nWaiting",
    },
  ];
  const tick = h.loop.tickNow();
  await Promise.race([h.entered.promise, tick]);
  assert.equal(h.state.foreground?.kind, "refine");
  h.finish.resolve();
  await tick;
  await h.loop.stop();
  assert.deepEqual(
    h.events.filter((event) => ["design", "refine", "review"].includes(event)),
    ["refine"],
  );
  console.log(
    "PASS: waiting Task design does not consume the primary model turn ahead of an actionable Story",
  );
}
for (const lane of ["design", "refine", "review"] as const) {
  for (const change of ["stale", "full", "revision", "stop"] as const) {
    const h = harness(2, [lane]);
    const ops = lane === "design" ? h.deps.taskDesignOps! : h.board;
    const refresh = ops.refresh;
    let stopping: Promise<void> | undefined;
    ops.refresh = async (card) => {
      const fresh = await refresh(card);
      if (fresh?.assignees.includes("bot")) {
        if (change === "stale") fresh.body = "new contract";
        else if (change === "full") h.setOccupied(2);
        else if (change === "revision") h.setRevision(false);
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
    if (change === "revision") {
      h.setRevision(true);
      await h.loop.tickNow();
      assert.equal(
        h.occupied(),
        1,
        "revision latch cannot reopen from a subsequent ok observation",
      );
    }
    await h.loop.stop();
    console.log(
      `PASS: ${lane} ${change} gate after prefill blocks stale/new model work without leaking foreground state`,
    );
  }
}

{
  const h = harness(2, ["design"]);
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
  h.setRevision(false);
  await h.loop.tickNow();
  assert.deepEqual(
    h.events,
    ["reconcile", "finalize"],
    "durable recovery/finalization precede admission safety gates",
  );
  await h.loop.stop();
  console.log(
    "PASS: reconcile/finalize run before the revision safety gate, without new builder/foreground admissions",
  );
}
