import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import { isTargetIssue } from "../src/gh.js";
import {
  BoardLoop,
  createLoopState,
  type LoopDeps,
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
  review: { ..._DEFAULTS.review },
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
const deps = (cards: Card[]): LoopDeps => ({
  cwd,
  cfg,
  repoOwner: "owner",
  repoName: "repo",
  botLogin: "bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: () => undefined,
  listCards: async () => cards,
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
    status: "Needs Design",
  }),
];
await new BoardLoop(deps(invalid), createLoopState(), executor).tickNow();
check(
  launches === 0 && finalizations === 0,
  "cross-repo, PR, DraftIssue, and untyped cards cause zero mutations",
);

// Review lane uses the same live board seam, but persists through the real v4 store.
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
    schemaVersion: 4,
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
const replacedTarget = (label: string) => ["content type", "Type", "item", "number", "origin", "repository"].includes(label);
for (const phase of ["claim", "model"] as const) {
  for (const [label, drift] of reviewDrifts) {
    const h = await reviewCase(phase, drift);
    assert.deepEqual(
      h.events,
      ["claim", ...(phase === "model" ? ["model"] : []), ...(replacedTarget(label) ? [] : ["release"])],
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
  assert.deepEqual(h.events, ["claim", "model", "comment", ...(replacedTarget(label) ? [] : ["release"])], label);
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
  const finalizationRoot = mkdtempSync(join(cwd, "finalization-"));
  execFileSync("git", ["init", "-b", "main", finalizationRoot], { stdio: "ignore" });
  execFileSync("git", ["-C", finalizationRoot, "-c", "user.name=Offline", "-c", "user.email=offline@example.test", "commit", "--allow-empty", "-m", "finalization fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", finalizationRoot, "branch", "task/issue-42"], { stdio: "ignore" });
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
      cwd: finalizationRoot,
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
for (const skip_closed_issues of [true, false]) {
  const before = launches;
  let closedCalls = 0;
  const noClosedWork = async (): Promise<never> => {
    closedCalls++;
    assert.fail("closed Issue entered a design/review/board operation");
  };
  const closedDesign = card({ closed: true, status: "Needs Design" });
  const config = { ...cfg, safety: { ...cfg.safety, skip_closed_issues } };
  const loop = new BoardLoop(
    {
      ...deps([
        card({ closed: true }), closedDesign,
        card({ closed: true, status: cfg.columns.review }),
        card({ closed: true, type: "Story" }),
        card({ closed: true, type: "Story", status: "Needs Design" }),
      ]),
      cfg: config, review: noClosedWork,
      boardOps: { claim: noClosedWork, refresh: noClosedWork, release: noClosedWork, listComments: noClosedWork, comment: noClosedWork, setStatus: noClosedWork },
    },
    createLoopState(),
    executor,
  );
  try {
    await loop.tickNow();
    assert.equal(closedCalls, 0);
    assert.equal(launches, before);
  } finally { await loop.stop(); }
  console.log(
    `PASS: closed Issues never start builders, Task design, Story refinement or review with skip_closed_issues=${skip_closed_issues}`,
  );
}

for (const verdict of ["model", "comment"] as const) {
  for (const patch of [
    { lastRunId: "NEW_RUN" },
    { launchingAt: 0 },
    { reviewedTaskSha: "b".repeat(40) },
  ]) {
    const h = await reviewCase(verdict, undefined, patch);
    assert.deepEqual(h.events, ["claim", "model"], "changed record retains claim for its new owner; no stale release/writeback");
    for (const [key, value] of Object.entries(patch)) assert.equal(h.record?.[key as keyof TicketExecutionRecord], value);
  }
}
console.log(
  "PASS: both pass/fail review write-backs reject changed execution/review records and in-progress builder admission",
);
