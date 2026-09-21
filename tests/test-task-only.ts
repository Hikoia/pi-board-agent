// Real executor/WorkflowManager, reviewer isolation and native finalization; offline models + board.
import assert from "node:assert/strict";
import { settledTicks } from "./async-loop-fixture.js";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createRunPersistence,
  runWorkflow,
  type WorkflowManagerOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import { loadConfig } from "../src/config.js";
import {
  validateProjectMetadata,
  type Card,
  type ProjectMetadata,
} from "../src/gh.js";
import { buildStandardSpecs } from "../src/init-project.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { runReview } from "../src/review.js";
import {
  ManagedTicketExecutor,
  createWorkflowManagerAdapter,
  type TicketBoardAdapter,
} from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh");
const repo = join(root, "repo"),
  origin = join(root, "origin.git");
mkdirSync(repo);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.invalid");
writeFileSync(join(repo, ".gitignore"), ".pi/\n");
writeFileSync(join(repo, "value.txt"), "before\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "base");
git(repo, "init", "--bare", origin);
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");
const base = git(repo, "rev-parse", "HEAD");
mkdirSync(join(repo, ".pi"));
const configPath = join(repo, ".pi", "board-agent.yml");
const legacyConfig = `project: {number: 1}
review: {enabled: false}
task_merge_strategy: squash
`;
writeFileSync(configPath, legacyConfig);
const cfg = loadConfig(repo, () => {});
cfg.project.number = 1;
cfg.max_workers = 1;
cfg.builder_retries = 0;
cfg.models = { builder: "offline-builder", review: "offline-review" };
cfg.builder_timeout_ms = 30_000;
cfg.review.timeout_ms = 30_000;
cfg.telegram.enabled = false;
const required = [
  cfg.columns.backlog,
  cfg.columns.ready,
  cfg.columns.building,
  cfg.columns.review,
  cfg.columns.done,
  cfg.columns.needs_human,
];
const meta: ProjectMetadata = {
  projectId: "P",
  statusFieldId: "S",
  statusFieldType: "SINGLE_SELECT",
  statusOptions: Object.fromEntries(required.map((name) => [name, name])),
  typeFieldId: "TYPE",
  typeFieldType: "SINGLE_SELECT",
  typeOptions: { Task: "TASK" },
};
validateProjectMetadata(meta, cfg);
assert.deepEqual(
  buildStandardSpecs(cfg).map((s) => s.name),
  [cfg.status_field, cfg.type_field],
);
assert.deepEqual(
  new Set(buildStandardSpecs(cfg)[0].options),
  new Set(required),
);
for (const patch of [
  { typeFieldId: undefined },
  { typeFieldType: "TEXT" },
  { typeOptions: { Story: "STORY" } },
  ...required.map((missing) => ({
    statusOptions: Object.fromEntries(
      required.filter((s) => s !== missing).map((s) => [s, s]),
    ),
  })),
])
  assert.throws(() => validateProjectMetadata({ ...meta, ...patch }, cfg));
console.log(
  "PASS: Task execution requires six Status options including Backlog and single-select Type:Task, never Plan/Story/Needs Design",
);

const card: Card = {
  itemId: "TASK",
  contentType: "Issue",
  number: 1,
  title: "T005 Plan-less task",
  body: "Change value to after.",
  type: "Task",
  status: cfg.columns.ready,
  closed: false,
  assignees: [],
  repoOwner: "owner",
  repoName: "repo",
};
const excluded: Card[] = [];
for (const patch of [
  { type: "Story" },
  { type: "Epic" },
  { type: undefined },
  { contentType: "PullRequest" },
  { contentType: "DraftIssue" },
  { repoOwner: "other" },
  { repoName: "other" },
])
  for (const status of [...required, "Needs Design"])
    for (const closed of [false, true]) {
      const candidate = {
        ...card,
        ...patch,
        itemId: `excluded-${excluded.length}`,
        status,
        closed,
        assignees: ["bot"],
      };
      // Closed Done target Issues use the separate any-Type completion lane.
      if (
        closed &&
        status === cfg.columns.done &&
        candidate.contentType === "Issue" &&
        candidate.repoOwner === "owner" &&
        candidate.repoName === "repo"
      )
        continue;
      excluded.push(candidate);
    }
// An open legacy Needs Design without startup migration cannot invoke a designer.
excluded.push({
  ...card,
  itemId: "old-design",
  number: 2,
  status: "Needs Design",
});
const cards = [card, ...excluded],
  untouched = structuredClone(excluded);
const store = new TicketWorktrees(repo, testOwner(repo));
const legacyFiles = [
  "refine-state.json",
  "refine-state-unblocked.json",
  "watchdog-state.json",
].map((name) => join(repo, ".pi", "board-agent", name));
for (const path of legacyFiles)
  writeFileSync(path, "unread legacy sentinel (not JSON)\n");
const inventory = () =>
  legacyFiles.map((path) => [
    readFileSync(path, "utf8"),
    statSync(path).mtimeMs,
  ]);
const before = inventory();
const events: string[] = [],
  comments: string[] = [];
const target = (c: Card) => {
  assert.equal(c.itemId, card.itemId, "excluded identity cannot mutate");
  return card;
};
const board: TicketBoardAdapter = {
  getCard: async (id) => structuredClone(cards.find((c) => c.itemId === id)),
  claim: async (c) => {
    target(c).assignees = ["bot"];
    events.push("claim");
    return true;
  },
  release: async (c) => {
    target(c).assignees = [];
    events.push("release");
  },
  setStatus: async (id, status) => {
    assert.equal(id, card.itemId);
    card.status = status;
    events.push(status);
  },
  listComments: async (c) => {
    target(c);
    return comments;
  },
  comment: async (c, body) => {
    target(c);
    comments.push(body);
  },
  reopen: async () =>
    assert.fail("normal flow never reopens or closes an Issue"),
};
let builds = 0,
  reviews = 0,
  taskSha = "";
const prs = fakePullRequests(repo, true);
const executor = new ManagedTicketExecutor({
  owner: testOwner(repo), pullRequests: prs.api, cwd: repo,
  cfg,
  board,
  worktrees: store,
  botLogin: "bot",
  repoOwner: "owner",
  repoName: "repo",
  callback: () => {},
  context: async () => "configured context retained",
  createManager: (cwd) =>
    createWorkflowManagerAdapter({
      cwd,
      defaultAgentRetries: 0,
      deferScheduling: true,
      callback: () => {},
      agent: {
        run: async (prompt, options) => {
          builds++;
          assert.equal(options?.model, cfg.models.builder);
          assert.ok(prompt.includes("configured context retained"));
          assert.ok(!prompt.includes("Plan slug:"));
          assert.ok(!prompt.includes("BOARD_AGENT_REPAIR_TEST"));
          assert.ok(!prompt.includes("testEvidence"));
          writeFileSync(join(cwd, "value.txt"), "after\n");
          git(cwd, "add", "value.txt");
          git(cwd, "commit", "-m", "task change");
          taskSha = git(cwd, "rev-parse", "HEAD");
          git(cwd, "push", "origin", "task/issue-1");
          return {
            taskKey: "T005",
            itemId: card.itemId,
            status: "success",
            branch: "task/issue-1",
            summary: "Changed value",
          };
        },
      } as NonNullable<WorkflowManagerOptions["agent"]>,
    }),
});
const notices: string[] = [];
const loop = new BoardLoop(
  {
    cwd: repo,
    cfg,
    meta,
    botLogin: "bot",
    repoOwner: "owner",
    repoName: "repo",
    callback: (s) => notices.push(s),
    listCards: async () => structuredClone(cards),
    boardOps: {
      claim: board.claim,
      release: board.release,
      refresh: async (c) => board.getCard(c.itemId),
      listComments: async () => [],
      comment: async (c, body) => {
        await board.comment(c, body);
        return "COMMENT";
      },
      setStatus: async (c, status) => board.setStatus(c.itemId, status),
    },
    review: (input) =>
      runReview(input, (source, options) =>
        runWorkflow(source, {
          ...options,
          agentRegistry: new Map(),
          agent: {
            run: async (_prompt, modelOptions) => {
              reviews++;
              assert.equal(modelOptions?.model, cfg.models.review);
              assert.equal(git(options.cwd, "rev-parse", "HEAD"), taskSha);
              assert.equal(
                readFileSync(join(options.cwd, "value.txt"), "utf8"),
                "after\n",
              );
              assert.equal(
                git(repo, "rev-parse", "HEAD"),
                base,
                "review never checks out task in main",
              );
              return {
                verdict: "pass",
                summary: "Acceptance verified",
                findings: [],
              };
            },
          },
        }),
      ),
  },
  createLoopState(),
  executor,
  store,
);
settledTicks(loop);
try {
  await loop.tickNow();
  assert.equal(card.status, cfg.columns.building);
  const record = store.read(card.itemId)!;
  assert.equal(record.plan, undefined);
  for (let attempt = 0; ; attempt++) {
    const run = createRunPersistence(record.path).load(record.activeRunId!);
    if (run?.status === "completed") {
      assert.equal(run.agentTimeoutMs, cfg.builder_timeout_ms);
      break;
    }
    assert.ok(attempt < 500, "builder must settle");
    await new Promise((r) => setTimeout(r, 10));
  }
  await loop.tickNow();
  assert.equal(card.status, cfg.columns.review, notices.join("\n"));
  assert.equal(reviews, 0, "no same-ticket second stage in settlement tick");
  await loop.tickNow();
  assert.equal(card.status, cfg.columns.done, notices.join("\n"));
  assert.equal(card.closed, false);
  assert.equal(reviews, 1);
  assert.equal(builds, 1);
  assert.equal(store.read(card.itemId)?.reviewedTaskSha, taskSha);
  assert.equal(git(origin, "rev-parse", "main"), base);
  await loop.tickNow();
  assert.ok(existsSync(record.path), "Done alone is not human approval");
  card.closed = true; // the human, not the executor
  await loop.tickNow();
  assert.equal(store.read(card.itemId), undefined, notices.join("\n"));
  const result = git(origin, "rev-parse", "main");
  assert.deepEqual(
    git(origin, "show", "-s", "--format=%P", result).split(" "),
    [base, prs.prs[0].headSha],
  );
  assert.equal(git(repo, "rev-parse", "HEAD"), base);
  assert.equal(readFileSync(join(repo, "value.txt"), "utf8"), "before\n");
  assert.equal(
    git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/task/"),
    "",
  );
  assert.equal(
    git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/task/"),
    "",
  );
  assert.equal(existsSync(record.path), false);
  assert.equal(readFileSync(configPath, "utf8"), legacyConfig);
  assert.equal(card.closed, true);
  assert.equal(card.status, cfg.columns.backlog);
  assert.equal(builds, 1);
  assert.equal(reviews, 1);
  assert.deepEqual(excluded, untouched);
  assert.deepEqual(inventory(), before);
  assert.equal(existsSync(join(repo, ".pi", "board-agent", "repair")), false);
  console.log(
    "PASS: Plan-less Ready/build/real isolated review/Done-open/manual-close/merge/push/cleanup retains models/timeouts/context and never launches legacy protocol",
  );
  console.log(
    "PASS: PR/Draft/foreign and non-Task model lanes cause zero mutations; retired Story/watchdog files stay byte/mtime identical and unread despite corrupt JSON",
  );
} finally {
  await loop.stop();
}

for (const patch of [
  { contentType: "PullRequest" },
  { contentType: "DraftIssue" },
  { type: "Story" },
  { type: undefined },
  { repoOwner: "foreign" },
  { repoName: "foreign" },
  { itemId: "replaced" },
  { number: 900 },
]) {
  const fresh: Card = {
    ...card,
    itemId: "claim-drift",
    number: 42,
    closed: false,
    status: cfg.columns.ready,
    assignees: [],
  };
  let claims = 0;
  const guarded = new ManagedTicketExecutor({
    owner: testOwner(repo), pullRequests: noPullRequests, cwd: repo,
    cfg,
    worktrees: store,
    botLogin: "bot",
    repoOwner: "owner",
    repoName: "repo",
    callback: () => {},
    board: {
      ...board,
      getCard: async () => structuredClone(fresh),
      claim: async () => {
        claims++;
        Object.assign(fresh, patch, { assignees: ["bot"] });
        return true;
      },
      release: async () =>
        assert.fail(
          "replaced/foreign/non-Task must not receive even claim release",
        ),
    },
    createManager: () => assert.fail("no model for stale identity"),
  });
  try {
    assert.equal(
      (await guarded.launch(structuredClone(fresh), undefined)).status,
      "skipped",
    );
    assert.equal(claims, 1);
    assert.equal(store.has("claim-drift"), false);
  } finally {
    await guarded.shutdown();
  }
}
console.log(
  "PASS: post-claim PR/Draft/foreign/non-Task/item/number replacement blocks all further mutation, including assignee release",
);

import { testOwner, noPullRequests, fakePullRequests } from "./pr-fixture.js";
