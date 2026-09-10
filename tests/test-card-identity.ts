import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import { isTargetIssue } from "../src/gh.js";
import {
  BoardLoop,
  createLoopState,
  processNeedsDesignTask,
  type LoopDeps,
  type TaskDesignOps,
} from "../src/loop.js";
import type { TicketExecutor } from "../src/ticket-executor.js";
import {
  TicketWorktrees,
  type TicketExecutionRecord,
} from "../src/ticket-worktree.js";

const cwd = mkdtempSync(join(tmpdir(), "board-orchestration-"));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
const check = (ok: boolean, label: string) => {
  assert.ok(ok, label);
  console.log(`PASS: ${label}`);
};
const cfg: Config = {
  ..._DEFAULTS,
  context: { ..._DEFAULTS.context, enabled: false },
  refine: { ..._DEFAULTS.refine, enabled: true },
  review: { ..._DEFAULTS.review, enabled: true },
  watchdog: { ..._DEFAULTS.watchdog, enabled: false },
  safety: { ..._DEFAULTS.safety, require_clean_worktree: false },
};
const card = (overrides: Partial<Card> = {}): Card => ({
  itemId: "ITEM",
  contentType: "Issue",
  number: 42,
  title: "T042 exact task",
  body: "acceptance",
  status: cfg.columns.ready,
  plan: "release",
  type: "Task",
  assignees: [],
  closed: false,
  repoOwner: "owner",
  repoName: "repo",
  ...overrides,
});

check(
  isTargetIssue(card(), "owner", "repo", "Task") &&
    !isTargetIssue(
      card({ contentType: "PullRequest" }),
      "owner",
      "repo",
      "Task",
    ) &&
    !isTargetIssue(
      card({ contentType: "DraftIssue" }),
      "owner",
      "repo",
      "Task",
    ) &&
    !isTargetIssue(card({ repoOwner: "other" }), "owner", "repo", "Task") &&
    !isTargetIssue(card({ type: "Story" }), "owner", "repo", "Task"),
  "candidate identity requires an Issue in the exact repository and configured Type",
);

let launches = 0;
let finalizations = 0;
const executor: TicketExecutor = {
  reconcile: async () => ({
    active: [],
    resumed: 0,
    adopted: 0,
    needsHuman: 0,
    orphans: 0,
    errors: 0,
  }),
  launch: async () => {
    launches++;
    return { status: "skipped", reason: "test" };
  },
  finalizeClosed: async () => {
    finalizations++;
    return { status: "skipped", reason: "test" };
  },
  activeCount: () => 0,
  shutdown: async () => undefined,
};
let designClaims = 0;
const taskDesignOps: TaskDesignOps = {
  claim: async () => {
    designClaims++;
    return true;
  },
  refresh: async (candidate) => ({ ...candidate, assignees: ["bot"] }),
  release: async () => undefined,
  listComments: async () => [],
  design: async () => ({ body: "", summary: "", openQuestions: [] }),
  updateBody: async () => undefined,
  comment: async () => undefined,
  setReady: async () => undefined,
};
const deps = (cards: Card[]): LoopDeps => ({
  cwd,
  cfg,
  repoOwner: "owner",
  repoName: "repo",
  botLogin: "bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: () => undefined,
  listCards: async () => cards,
  taskDesignOps,
});

const invalid = [
  card({ itemId: "PR", contentType: "PullRequest" }),
  card({ itemId: "DRAFT", contentType: "DraftIssue" }),
  card({ itemId: "CROSS", repoOwner: "other" }),
  card({ itemId: "UNTYPED", type: undefined }),
  card({
    itemId: "CLOSED_PR",
    contentType: "PullRequest",
    status: cfg.columns.done,
    closed: true,
  }),
  card({
    itemId: "REVIEW_DRAFT",
    contentType: "DraftIssue",
    status: cfg.columns.review,
  }),
  card({
    itemId: "DESIGN_CROSS",
    repoOwner: "other",
    status: cfg.columns.needs_design,
  }),
];
await new BoardLoop(deps(invalid), createLoopState(), executor).tickNow();
check(
  launches === 0 && finalizations === 0 && designClaims === 0,
  "cross-repo, PR, DraftIssue, and untyped cards cause zero mutations",
);

await new BoardLoop(
  deps([
    card({
      itemId: "WAITING_STORY",
      number: 41,
      status: cfg.columns.building,
      type: "Story",
    }),
    card({
      itemId: "DESIGN",
      status: cfg.columns.needs_design,
    }),
  ]),
  createLoopState(),
  executor,
).tickNow();
check(
  designClaims === 1,
  "a waiting Story does not starve a later exact Needs Design Task",
);

const gate: IssueComment = {
  id: "gate",
  body: "<!-- board-agent-requirements-gate:42 -->",
  createdAt: "2026-01-01T00:00:00Z",
  author: "bot",
  authorAssociation: "MEMBER",
};
const decision: IssueComment = {
  id: "decision",
  body: "approved",
  createdAt: "2026-01-01T00:00:01Z",
  author: "owner",
  authorAssociation: "OWNER",
};
let mutations = 0;
let releases = 0;
let staleClaimed = false;
const staleOps: TaskDesignOps = {
  ...taskDesignOps,
  claim: async () => {
    staleClaimed = true;
    return true;
  },
  refresh: async (candidate) => ({
    ...candidate,
    assignees: ["bot"],
    repoOwner: staleClaimed ? "other" : candidate.repoOwner,
  }),
  release: async () => {
    releases++;
  },
  listComments: async () => [gate, decision],
  design: async () => {
    mutations++;
    return { body: "contract", summary: "done", openQuestions: [] };
  },
  comment: async () => {
    mutations++;
  },
};
await processNeedsDesignTask(
  {
    card: card({ status: cfg.columns.needs_design }),
    cfg,
    cwd,
    contextDigest: "",
    botLogin: "bot",
    callback: () => undefined,
  },
  staleOps,
);
check(
  mutations === 0 && releases === 1,
  "post-claim repository drift is revalidated before Task design mutation",
);

// Review lane uses the same live board seam, but persists through the real v3 store.
const reviewDrifts: [string, (card: Card) => void][] = [
  [
    "closed",
    (card) => {
      card.closed = true;
    },
  ],
  [
    "content type",
    (card) => {
      card.contentType = "PullRequest";
    },
  ],
  [
    "Type",
    (card) => {
      card.type = "Story";
    },
  ],
  [
    "item",
    (card) => {
      card.itemId = "OTHER";
    },
  ],
  [
    "number",
    (card) => {
      card.number = 43;
    },
  ],
  [
    "origin",
    (card) => {
      card.repoOwner = "other";
    },
  ],
  [
    "repository",
    (card) => {
      card.repoName = "other";
    },
  ],
  [
    "Plan",
    (card) => {
      card.plan = "other";
    },
  ],
  [
    "status",
    (card) => {
      card.status = cfg.columns.ready;
    },
  ],
  [
    "title",
    (card) => {
      card.title = "edited";
    },
  ],
  [
    "body",
    (card) => {
      card.body = "edited";
    },
  ],
  [
    "assignees",
    (card) => {
      card.assignees.push("human");
    },
  ],
];
const reviewRoot = mkdtempSync(join(cwd, "review-"));
const reviewWorktrees = new TicketWorktrees(reviewRoot);
async function reviewCase(
  phase?: "claim" | "model" | "comment",
  drift?: (card: Card) => void,
  recordPatch?: Partial<TicketExecutionRecord>,
) {
  const root = reviewRoot;
  const current = card({ status: cfg.columns.review });
  const worktrees = reviewWorktrees;
  const record: TicketExecutionRecord = {
    schemaVersion: 3,
    itemId: "ITEM",
    issueNumber: 42,
    taskKey: "T042",
    plan: "release",
    taskBranch: "task/issue-42",
    baseBranch: cfg.branches.base,
    path: join(root, ".pi", "worktrees", "ITEM"),
    createdAt: 1,
  };
  writeFileSync(
    join(root, ".pi", "board-agent", "ticket-worktrees", "item.json"),
    JSON.stringify(record),
  );
  const events: string[] = [];
  const reviewedSha = "a".repeat(40);
  const state = createLoopState();
  const loop = new BoardLoop(
    {
      ...deps([current]),
      cwd: root,
      listCards: async () => [structuredClone(current)],
      boardOps: {
        refresh: async () => structuredClone(current),
        claim: async () => {
          events.push("claim");
          current.assignees = ["bot"];
          if (phase === "claim") drift?.(current);
          return true;
        },
        release: async (original) => {
          assert.equal(original.number, 42);
          events.push("release");
        },
        listComments: async () => [],
        comment: async () => {
          events.push("comment");
          if (phase === "comment") drift?.(current);
          return "COMMENT";
        },
        setStatus: async (_card, status) => {
          if (status === cfg.columns.done)
            assert.equal(
              new TicketWorktrees(root).read("ITEM")?.reviewedTaskSha,
              reviewedSha,
              "exact reviewed SHA must be durable BEFORE Done",
            );
          events.push(`status:${status}`);
          current.status = status;
        },
      },
      review: async () => {
        events.push("model");
        if (phase === "model") drift?.(current);
        if (recordPatch)
          writeFileSync(
            join(root, ".pi", "board-agent", "ticket-worktrees", "item.json"),
            JSON.stringify({ ...record, ...recordPatch }),
          );
        return {
          verdict: phase === "comment" ? "fail" : "pass",
          summary: "Result",
          findings: phase === "comment" ? ["Fix it"] : [],
          taskSha: reviewedSha,
        };
      },
    },
    state,
    executor,
    worktrees,
  );
  await loop.tickNow();
  assert.equal(state.reviewingTask, null);
  return {
    current,
    events,
    record: worktrees.read("ITEM"),
    reviewedSha,
  };
}
for (const phase of ["claim", "model"] as const) {
  for (const [label, drift] of reviewDrifts) {
    const h = await reviewCase(phase, drift);
    assert.deepEqual(
      h.events,
      phase === "claim" ? ["claim", "release"] : ["claim", "model", "release"],
      `${phase} ${label}`,
    );
    assert.equal(
      h.record?.reviewedTaskSha,
      undefined,
      "stale result is not persisted as approval",
    );
  }
  console.log(
    `PASS: review ${phase} freshness rejects every closed/open/Type/origin/contract/claim drift`,
  );
}
for (const [label, drift] of reviewDrifts) {
  const h = await reviewCase("comment", drift);
  assert.deepEqual(h.events, ["claim", "model", "comment", "release"], label);
}
console.log(
  "PASS: review findings cannot return a stale/replaced Task to Ready",
);
{
  const h = await reviewCase();
  assert.deepEqual(h.events, [
    "claim",
    "model",
    `status:${cfg.columns.done}`,
    "release",
  ]);
  assert.equal(h.record?.reviewedTaskSha, h.reviewedSha);
  console.log(
    "PASS: the first reviewer-returned origin SHA is persisted before Done and survives store restart without re-pinning",
  );
}

{
  const events: string[] = [];
  const closed = card({ status: cfg.columns.done, closed: true });
  const recoveryExecutor: TicketExecutor = {
    ...executor,
    reconcile: async () => {
      events.push("reconcile");
      return {
        active: [],
        resumed: 0,
        adopted: 0,
        needsHuman: 0,
        orphans: 0,
        errors: 0,
      };
    },
    finalizeClosed: async (card) => {
      events.push(`finalize:${card.number}`);
      return { status: "skipped", reason: "adapter-only check" };
    },
    launch: async () => {
      throw new Error("recovery-only loop launched work");
    },
  };
  await new BoardLoop(
    {
      ...deps([closed]),
      cfg: { ...cfg, safety: { ...cfg.safety, require_clean_worktree: true } },
      revisionCheck: () => ({ ok: false }),
    },
    createLoopState(),
    recoveryExecutor,
    undefined,
    undefined,
    false,
  ).tickNow();
  assert.deepEqual(events, ["reconcile", "finalize:42"]);
  console.log(
    "PASS: closed Done reaches executor finalization before dirty/admission/revision gates (adapter routing, not a Git merge E2E)",
  );
}
{
  const before = launches;
  await new BoardLoop(
    {
      ...deps([card({ closed: true })]),
      cfg: { ...cfg, safety: { ...cfg.safety, skip_closed_issues: false } },
    },
    createLoopState(),
    executor,
  ).tickNow();
  assert.equal(launches, before);
  console.log(
    "PASS: closed Ready Tasks never launch, even when the legacy safety preference is false",
  );
}

for (const verdict of ["model", "comment"] as const) {
  for (const patch of [
    { lastRunId: "NEW_RUN" },
    { launchingAt: 0 },
    { reviewedTaskSha: "b".repeat(40) },
  ]) {
    const h = await reviewCase(verdict, undefined, patch);
    assert.deepEqual(h.events, ["claim", "model", "release"]);
  }
}
console.log(
  "PASS: both pass/fail review write-backs reject changed execution/review records and in-progress builder admission",
);
