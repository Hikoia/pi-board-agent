// Still-relevant baseline run-offline.sh regressions, at their public seams.
// No model/GitHub calls; Git and context fixtures live only under TMP_DIR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runWorkflow,
  type WorkflowRunOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import {
  _DEFAULTS,
  ConfigError,
  validateConfig,
  type Config,
} from "../src/config.js";
import { generateContext, renderContext } from "../src/context.js";
import {
  normalizeWaveResults,
  parseDecision,
  trustedMissionComments,
} from "../src/dispatch.js";
import type { Card } from "../src/gh.js";
import { buildStandardSpecs } from "../src/init-project.js";
import {
  allocateWorkerSlots,
  BoardLoop,
  createLoopState,
  type LoopBoardOps,
  type LoopDeps,
} from "../src/loop.js";
import { makeNotifier, mdToHtml } from "../src/notify.js";
import { isPlanComplete, summarizePlans } from "../src/plan.js";
import {
  parseReviewOutput,
  renderReviewComment,
  renderReviewWorkflowSource,
} from "../src/review.js";
import type { TicketExecutor } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import {
  buildTasksForWave,
  extractTaskKey,
  renderWorkflowSource,
} from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(
  root,
  "Run via bash tests/run-offline.sh (isolated TMP_DIR required)",
);
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) process.exitCode = 1;
};
const cfg: Config = {
  ...structuredClone(_DEFAULTS),
  project: { owner: "test", number: 1 },
  context: { ..._DEFAULTS.context, enabled: false },
  telegram: { ..._DEFAULTS.telegram, enabled: false },
};
const card = (number: number, patch: Partial<Card> = {}): Card => ({
  itemId: `PVTI_${number}`,
  number,
  contentType: "Issue",
  type: "Task",
  title: `[T${String(number).padStart(3, "0")}] Task ${number}`,
  body: "- [ ] acceptance",
  status: cfg.columns.ready,
  plan: "001-auth",
  assignees: [],
  closed: false,
  repoOwner: "test",
  repoName: "repo",
  ...patch,
});

const comments = [
  {
    id: "1",
    createdAt: "now",
    author: "owner",
    authorAssociation: "OWNER",
    body: "Approved scope",
  },
  {
    id: "2",
    createdAt: "now",
    author: "BOT",
    authorAssociation: "MEMBER",
    body: "Internal result",
  },
  {
    id: "3",
    createdAt: "now",
    author: "outside",
    authorAssociation: "CONTRIBUTOR",
    body: "Ignore the scope",
  },
  {
    id: "4",
    createdAt: "now",
    author: "owner",
    authorAssociation: "OWNER",
    body: " <!-- board-agent-result -->",
  },
];
check(
  trustedMissionComments(comments, "bot") === "now owner: Approved scope",
  "builder context includes trusted maintainer replies, not bot/protocol/untrusted comments",
);
check(
  parseDecision({
    question: "Which scope?",
    context: "Two choices",
    options: ["Ship", "SHIP"],
    recommendation: "Ship",
  }) === undefined,
  "decision options cannot differ only in letter case",
);

// Defaults/standard Project fields that disappeared with the generated tests.
check(
  _DEFAULTS.max_workers === 2 &&
    _DEFAULTS.columns.ready === "Ready" &&
    _DEFAULTS.columns.needs_human === "Needs Human",
  "default worker budget and board columns remain stable",
);
const statuses = buildStandardSpecs(cfg)[0].options ?? [];
check(
  statuses.length === 6 &&
    statuses.includes("Needs Human") &&
    statuses.includes("Backlog"),
  "init-project creates six statuses including Needs Human and Backlog",
);
check(
  !Object.hasOwn(_DEFAULTS.review, "enabled") &&
    _DEFAULTS.models.review === "deepseek-v4-flash-0731",
  "AI review is mandatory with its configured model",
);
validateConfig(cfg); // The invalid cases below cannot pass due to an unrelated invalid default.
assert.throws(() => validateConfig({ ...cfg, max_workers: 20 }), ConfigError);
console.log(
  "PASS: validation rejects max_workers above 16 on an otherwise valid config",
);
assert.throws(
  () =>
    validateConfig({ ...cfg, columns: { ...cfg.columns, needs_human: "" } }),
  ConfigError,
);
console.log(
  "PASS: validation rejects empty Needs Human on an otherwise valid config",
);

// Plan summaries survive removal of the obsolete plan-PR runtime.
const cards = [
  card(1, { status: "Done" }),
  card(2, { status: "done" }),
  card(3),
  card(4, { plan: "002-dashboard" }),
  card(5, { plan: "002-dashboard", status: "In Progress" }),
  card(6, { plan: "002-dashboard", status: "Review" }),
  card(7, { plan: undefined }),
];
const plans = summarizePlans(cfg, cards);
check(
  plans.size === 2,
  "plan summary groups plans and ignores unplanned cards",
);
const auth = plans.get("001-auth")!;
const dash = plans.get("002-dashboard")!;
check(
  auth.totalCards === 3 && auth.cards.length === 3,
  "auth summary contains all three cards",
);
check(
  auth.doneCards === 2 && !isPlanComplete(auth),
  "auth summary counts case-insensitive Done but is incomplete at 2/3",
);
check(dash.readyCards === 1, "dashboard summary counts Ready");
check(dash.buildingCards === 1, "dashboard summary counts In Progress");
check(dash.reviewCards === 1, "dashboard summary counts Review");
const completed = summarizePlans(
  cfg,
  cards.slice(0, 3).map((c) => ({ ...c, status: "Done" })),
).get("001-auth")!;
check(
  isPlanComplete(completed),
  "plan becomes complete only when all cards are Done",
);
check(
  !isPlanComplete({ ...completed, totalCards: 0, doneCards: 0, cards: [] }),
  "empty plan is never complete",
);

// Strict persisted-result normalization (including WorkflowManager's envelope).
const outcomes = [
  {
    taskKey: "T001",
    itemId: "PVTI_1",
    status: "success",
    branch: "task/issue-1",
    commits: 1,
    summary: "done",
  },
  {
    taskKey: "T002",
    itemId: "PVTI_2",
    status: "failure",
    error: "conflict",
    attempted: "rebased",
    limitations: "ambiguous merge",
    workaround: "resolve manually",
    humanAction: "choose intended version",
  },
];
const normalized = normalizeWaveResults(outcomes);
check(
  normalized.length === 2 &&
    normalized[0].branch === "task/issue-1" &&
    normalized[0].commits === 1 &&
    normalized[0].summary === "done",
  "normalize preserves successful builder result",
);
check(
  normalized[1].status === "failure" &&
    normalized[1].error === "conflict" &&
    normalized[1].attempted === "rebased" &&
    normalized[1].limitations === "ambiguous merge" &&
    normalized[1].workaround === "resolve manually" &&
    normalized[1].humanAction === "choose intended version",
  "normalize preserves every actionable human-guidance field",
);
for (const [label, raw] of [
  ["null", null],
  ["non-array", {}],
  ["null entry", [null]],
  ["missing identity", [{ x: 1 }]],
  ["missing status", [{ taskKey: "T3", itemId: "PVTI_3" }]],
  ["unknown status", [{ ...outcomes[0], status: "maybe" }]],
  ["partly malformed result", [outcomes[0], null]],
] as const)
  check(normalizeWaveResults(raw).length === 0, `normalize rejects ${label}`);
assert.deepEqual(normalizeWaveResults({ result: outcomes }), normalized);
console.log(
  "PASS: normalize accepts the persisted WorkflowManager result envelope",
);

const tasks = buildTasksForWave(cfg, "001-auth", [
  card(42, { title: "[T001] Add login form" }),
  card(43, { title: "[T002] Add auth middleware" }),
]);
check(
  tasks.length === 2 &&
    tasks[0].taskKey === "T001" &&
    tasks[1].taskKey === "T002",
  "buildTasksForWave preserves task display keys",
);
check(
  tasks[1].taskBranch === "task/issue-43" && tasks[0].baseBranch === "main",
  "new task branches use linked Issue identity and direct-merge base",
);
check(
  extractTaskKey(card(1, { title: "T2 short key" })) === "T002" &&
    extractTaskKey(card(1, { title: "No key", body: "T42 in body" })) ===
      "T042",
  "extractTaskKey pads keys and falls back to the body",
);
check(
  buildTasksForWave(cfg, "001-auth", [
    card(9, { title: "No key", body: "no key" }),
  ])[0].taskKey === "issue-9",
  "missing display key falls back to the Issue number",
);
assert.throws(
  () => buildTasksForWave(cfg, "001-auth", [card(1, { number: undefined })]),
  /linked Issue/,
);
console.log("PASS: workflow construction rejects cards without a linked Issue");
const builderSource = renderWorkflowSource({
  cfg,
  planSlug: "001-auth",
  baseBranch: "main",
  tasks: [tasks[0]],
  skillName: "board-agent",
});
for (const count of [0, 2]) {
  assert.throws(
    () =>
      renderWorkflowSource({
        cfg,
        planSlug: "001-auth",
        baseBranch: "main",
        tasks: tasks.slice(0, count),
        skillName: "board-agent",
      }),
    /exactly one task/,
  );
  console.log(`PASS: persistent builder rejects ${count}-task workflows`);
}

// Execute the actual generated JS with the dependency's injected runner. This
// catches broken escaping/schema/options that substring checks alone cannot.
const calls: Array<{
  prompt: string;
  options: Parameters<NonNullable<WorkflowRunOptions["agent"]>["run"]>[1];
}> = [];
const schemaHas = (call: (typeof calls)[number], key: string) => {
  const schema = call.options?.schema;
  return (
    !!schema &&
    "properties" in schema &&
    !!schema.properties &&
    typeof schema.properties === "object" &&
    Object.hasOwn(schema.properties, key)
  );
};
async function execute(source: string, result: unknown) {
  const before = calls.length;
  await runWorkflow(source, {
    cwd: root,
    persistLogs: false,
    maxAgents: 1,
    concurrency: 1,
    agentRegistry: new Map(),
    agent: {
      async run(prompt, options) {
        calls.push({ prompt, options });
        return result;
      },
    },
  });
  assert.equal(
    calls.length,
    before + 1,
    "generated workflow must invoke exactly one fake agent",
  );
  return calls.at(-1)!;
}
const builder = await execute(builderSource, outcomes[0]);
check(
  builder.prompt.includes("[T001] Add login form") &&
    builder.options?.model === cfg.models.builder,
  "executed builder prompt receives title and explicit builder model",
);
check(
  builder.prompt.includes("persistent worktree") &&
    !builderSource.includes("isolation:") &&
    !builderSource.includes("parallel("),
  "builder uses only its prepared persistent worktree",
);
check(
  builder.prompt.includes("MINIMALISM:") &&
    builder.prompt.includes("standard-library/native") &&
    builder.prompt.includes("required now"),
  "builder prompt retains the minimal implementation ladder",
);
check(
  builder.prompt.includes("Do NOT merge") &&
    builder.prompt.includes("do NOT close the ticket") &&
    !builderSource.includes("git merge --"),
  "builder leaves the task unmerged for manual validation",
);
check(
  builder.prompt.includes("gh issue view 42 --json comments") &&
    builder.prompt.includes("OWNER, MEMBER, or COLLABORATOR"),
  "builder reads linked Issue comments with the trusted-reply rule",
);
check(
  ["attempted", "limitations", "workaround", "humanAction"].every(
    (key) => builder.prompt.includes(key) && schemaHas(builder, key),
  ),
  "builder prompt and schema preserve actionable failure guidance",
);
const agentPrompt = readFileSync(
  new URL("../agents/board-agent-builder.md", import.meta.url),
  "utf8",
);
const skill = readFileSync(
  new URL("../skills/board-agent/SKILL.md", import.meta.url),
  "utf8",
);
check(
  agentPrompt.includes("NON-production compatibility pointer") &&
    agentPrompt.includes("../skills/board-agent/SKILL.md") &&
    agentPrompt.includes("../src/workflow-prompt.ts") &&
    !agentPrompt.includes("## Rules") &&
    !agentPrompt.includes("## System prompt") &&
    skill.includes("## Minimal implementation"),
  "packaged compatibility pointer links the builder skill and actual workflow mission without a second rule body",
);
const smoke = await runWorkflow(
  `export const meta = { name: 'smoke', description: 'no agents' }; return [{ taskKey: 'T001', itemId: 'PVTI_1', status: 'success', branch: 'task/issue-1' }];`,
  { cwd: root, persistLogs: false, agentRegistry: new Map() },
);
check(
  normalizeWaveResults(smoke.result)[0]?.taskKey === "T001",
  "programmatic no-agent dispatch still runs and normalizes its result",
);

// Context fixtures: never cache into the source repository or inspect its history.
const repo = join(root, "repo");
const origin = join(root, "origin.git");
mkdirSync(join(repo, "src"), { recursive: true });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline Test");
git(repo, "config", "user.email", "offline@example.invalid");
writeFileSync(
  join(repo, "src", "dispatch.ts"),
  "/** Fixture dispatcher. */\nexport function dispatch() {}\n",
);
writeFileSync(
  join(repo, "README.md"),
  "Fixture repository\n" + "acceptance documentation\n".repeat(150),
);
writeFileSync(
  join(repo, "package.json"),
  JSON.stringify({ scripts: { check: "echo fixture-check" } }),
);
git(repo, "add", ".");
git(repo, "commit", "-m", "feat: fixture dispatcher");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-u", "origin", "main");
const opts = { cwd: repo, maxChars: 40000, exclude: [] as string[] };
const context = renderContext(opts);
check(context.includes("Repo tree"), "context includes the repository tree");
check(
  context.includes("`src/`"),
  "context tree groups nested directories on Linux and Windows",
);
check(
  context.includes("Source files") &&
    context.includes("dispatch.ts") &&
    context.includes("exports: dispatch"),
  "context inventories source files and exported symbols",
);
check(
  context.includes("Recent commits") && context.includes("fixture dispatcher"),
  "context groups real fixture commit history",
);
check(
  context.includes("Scripts") && context.includes("check=echo fixture-check"),
  "context includes package scripts",
);
const truncated = renderContext({ ...opts, maxChars: 2000 });
check(
  truncated.length <= 2100 && truncated.includes("truncated at 2000 chars"),
  "context truncates at its configured bound with a visible marker",
);
const a = generateContext(opts);
const hashFile = join(repo, ".pi", "board-agent", "context.hash");
const hashBefore = readFileSync(hashFile, "utf8");
check(
  a === generateContext(opts) &&
    readFileSync(join(repo, ".pi", "board-agent", "context.md"), "utf8") === a,
  "context cache is stable and stores the returned digest in disposable state",
);
check(
  !renderContext({ ...opts, exclude: ["dispatch.ts"] }).includes("dispatch.ts"),
  "context honors caller exclusions",
);
generateContext({ ...opts, maxChars: 2000 });
check(
  readFileSync(hashFile, "utf8") !== hashBefore,
  "context cache invalidates when configuration changes",
);
git(repo, "commit", "--allow-empty", "-m", "fix: cache invalidation sentinel");
check(
  generateContext(opts).includes("cache invalidation sentinel"),
  "context cache invalidates on a new HEAD",
);
const tricky =
  "## Repo tree\n- src/\nLiteral 'quote', `backtick`, ${notCode} and \\ path";
const withContext = await execute(
  renderWorkflowSource({
    cfg,
    planSlug: "001-auth",
    baseBranch: "main",
    tasks: [tasks[0]],
    skillName: "board-agent",
    context: tricky,
  }),
  outcomes[0],
);
check(
  withContext.prompt.includes("REPO CONTEXT") &&
    withContext.prompt.includes(tricky),
  "generated workflow executes context as literal data, including quotes and template syntax",
);
check(
  builderSource.includes('"context":null') &&
    !builder.prompt.includes("REPO CONTEXT"),
  "absent context stays null and adds no digest to the builder mission",
);

const pass = parseReviewOutput({
  verdict: "pass",
  summary: "Looks good",
  findings: [],
});
const fail = parseReviewOutput({
  verdict: "fail",
  summary: "Bug",
  findings: ["src/a.ts: missing guard"],
});
check(pass?.verdict === "pass", "review parser accepts a passing verdict");
check(fail?.findings.length === 1, "review parser preserves blocking findings");
check(
  parseReviewOutput({ verdict: "fail", summary: "Bug", findings: [] }) === null,
  "review failure requires findings",
);
const taskSha = git(repo, "rev-parse", "HEAD");
const review = await execute(
  renderReviewWorkflowSource({
    cwd: repo,
    taskKey: "T001",
    title: "Add guard",
    body: "- [ ] rejects invalid input",
    issueNumber: 42,
    baseBranch: "main",
    taskBranch: "task/issue-42",
    baseSha: taskSha,
    taskSha,
    model: "review-model",
    timeoutMs: 600000,
  }),
  pass,
);
check(
  review.options?.model === "review-model" &&
    review.prompt.includes("task/issue-42") &&
    review.prompt.includes("rejects invalid input") &&
    review.prompt.includes(taskSha),
  "executed review receives task, model, criteria, and exact SHA",
);
check(
  review.prompt.includes("Do not fetch or checkout another revision") &&
    review.prompt.includes("never edit, commit, merge, push"),
  "review stays on the host-prepared pinned checkout (no upstream worktree fallback)",
);
check(
  review.prompt.includes("MINIMALISM:") &&
    review.prompt.includes("not an idealized architecture"),
  "review does not demand speculative architecture",
);
const reviewComment = renderReviewComment(fail!);
check(
  reviewComment.includes("AI review") &&
    reviewComment.includes("src/a.ts") &&
    reviewComment.includes("Ready"),
  "failed review comment explains findings and the Ready retry lane",
);

check(
  mdToHtml(
    "### Titolo\n- item one\n- item two\n**bold**\nplain <tag> & stuff",
  ) ===
    "<b>Titolo</b>\n• item one\n• item two\n<b>bold</b>\nplain &lt;tag&gt; &amp; stuff",
  "notification renderer converts headers, bullets, bold, and HTML escaping",
);
check(
  _DEFAULTS.telegram.enabled &&
    _DEFAULTS.telegram.bot_token_env === "TELEGRAM_BOT_TOKEN" &&
    _DEFAULTS.telegram.chat_id_env === "TELEGRAM_CHAT_ID",
  "Telegram keeps environment-only credential defaults",
);
check(
  _DEFAULTS.telegram.on.includes("needs_human") &&
    !_DEFAULTS.telegram.on.includes("ci_fixed") &&
    !_DEFAULTS.telegram.on.includes("pr_opened"),
  "Telegram defaults to Task notifications, not retired PR/Story events",
);
check(_DEFAULTS.auto_start === false, "automatic startup remains opt-in");
check(
  (await makeNotifier(cfg)("needs_human", "disabled")) === false,
  "disabled notifier does not contact Telegram",
);
const enabled = {
  ...cfg,
  telegram: {
    ...cfg.telegram,
    enabled: true,
    bot_token_env: "OFFLINE_MISSING_TOKEN",
    chat_id_env: "OFFLINE_MISSING_CHAT",
  },
};
check(
  (await makeNotifier(enabled)("needs_human", "missing credentials")) ===
    false && (await makeNotifier(enabled)("unknown", "ignored")) === false,
  "notifier ignores missing credentials and unconfigured events",
);

// Shared slot matrix and real loop orchestration, not source-order substring tests.
for (const [max, active, pending, builders, reviewers] of [
  [2, 0, true, 1, 1],
  [2, 1, true, 0, 1],
  [2, 2, true, 0, 0],
  [2, 0, false, 2, 0],
  [2, 3, true, 0, 0],
  [1, 0, true, 0, 1],
] as const) {
  const slots = allocateWorkerSlots(max, active, pending);
  check(
    slots.builderSlots === builders && slots.foregroundSlots === reviewers,
    `shared slots max=${max}, active=${active}, review=${pending}`,
  );
}
let shutdowns = 0;
let tickUpdates = 0;
const executor: TicketExecutor = {
  reconcile: async () => ({
    active: [],
    resumed: 0,
    adopted: 0,
    needsHuman: 0,
    orphans: 0,
    errors: 0,
  }),
  launch: async () => ({ status: "skipped", reason: "fixture" }),
  finalizeClosed: async () => ({ status: "skipped", reason: "fixture" }),
  activeCount: () => 0,
  shutdown: async () => {
    shutdowns++;
  },
};
const messages: string[] = [];
const deps: LoopDeps = {
  cwd: repo,
  cfg: { ...cfg, tick_seconds: 9999 },
  repoOwner: "test",
  repoName: "repo",
  botLogin: "bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: (message) => {
    messages.push(message);
  },
  onTick: () => {
    tickUpdates++;
  },
  listCards: async () => [],
};
const state = createLoopState();
const loop = new BoardLoop(deps, state, executor);
try {
  await loop.start();
  check(state.running && loop.isRunning(), "loop.start sets running");
  check(
    tickUpdates === 1 && state.lastTickMs > 0,
    "loop tick refreshes persistent status",
  );
  await loop.start();
  check(state.tickCount === 1, "duplicate loop.start is a no-op");
} finally {
  await loop.stop();
}
check(
  !state.running && shutdowns === 1,
  "awaited loop.stop settles the executor and clears running",
);

const live = [
  card(1),
  card(2),
  card(3),
  card(42, { status: "Review" }),
  card(43, { status: "Review" }),
];
const worktrees = new TicketWorktrees(repo);
for (const c of live.slice(3))
  await worktrees.ensure(
    buildTasksForWave(cfg, "001-auth", [c])[0],
    "001-auth",
  );
let active = 0;
let reviewCalls = 0;
const events: string[] = [];
const current = (c: Card) =>
  live.find((candidate) => candidate.itemId === c.itemId)!;
const board: LoopBoardOps = {
  refresh: async (c) => structuredClone(current(c)),
  claim: async (c) => {
    current(c).assignees = ["bot"];
    events.push(`claim:${c.number}`);
    return true;
  },
  release: async (c) => {
    current(c).assignees = [];
    events.push(`release:${c.number}`);
  },
  listComments: async () => [],
  comment: async (c, body) => {
    events.push(`comment:${c.number}`);
    check(
      body.includes("missing guard"),
      "loop publishes actual blocking review findings",
    );
    return "COMMENT_1";
  },
  setStatus: async (c, status) => {
    current(c).status = status;
    events.push(`status:${status}`);
  },
};
const schedulingExecutor: TicketExecutor = {
  ...executor,
  activeCount: () => active,
  launch: async (c) => {
    active++;
    current(c).status = "In Progress";
    events.push(`build:${c.number}`);
    return { status: "launched", runId: `run-${c.number}`, worktree: repo };
  },
};
let entered!: () => void;
const enteredReview = new Promise<void>((resolve) => {
  entered = resolve;
});
let finishReview!: () => void;
const pendingReview = new Promise<void>((resolve) => {
  finishReview = resolve;
});
const schedulingState = createLoopState();
const schedulingLoop = new BoardLoop(
  {
    ...deps,
    cfg: { ...cfg, max_workers: 2, review: { ...cfg.review } },
    listCards: async () => structuredClone(live),
    boardOps: board,
    review: async (input) => {
      reviewCalls++;
      events.push(`review:${input.issueNumber}`);
      entered();
      await pendingReview;
      active = 0; // A background builder finished while the reviewer was awaited.
      return reviewCalls === 1
        ? { verdict: "pass", summary: "ok", findings: [], taskSha }
        : {
            verdict: "fail",
            summary: "Bug",
            findings: ["src/a.ts: missing guard"],
            taskSha,
          };
    },
  },
  schedulingState,
  schedulingExecutor,
  worktrees,
);
let tickSettled = false;
const tick = schedulingLoop.tickNow().then(() => {
  tickSettled = true;
});
await Promise.race([enteredReview, tick]);
check(
  events[0] === "build:1" && reviewCalls === 1 && active === 1,
  "background builder starts before the one reserved reviewer",
);
check(
  !tickSettled &&
    schedulingState.reviewingTask === "T042" &&
    !events.includes("build:2"),
  "loop awaits the reviewer and exposes its active task before any refill",
);
finishReview();
await tick;
check(
  reviewCalls === 1 && !events.includes("claim:43"),
  "loop reviews at most one claimed card per tick",
);
check(
  live[3].status === "Done" &&
    !live[3].closed &&
    worktrees.read(live[3].itemId)?.reviewedTaskSha === taskSha &&
    messages.some((m) => m.includes("close issue #42")),
  "accepted review records the exact SHA, moves to Done, and waits for manual closure",
);
check(
  events.indexOf("build:2") > events.indexOf("release:42") &&
    events.includes("build:3") &&
    active === 2,
  "review completion recounts active builders before filling both newly available slots",
);
check(
  schedulingState.reviewingTask === null && schedulingState.wavesLaunched === 3,
  "review indicator is cleared and only launched builders count as waves",
);
active = 0;
await schedulingLoop.tickNow();
check(
  Number(reviewCalls) === 2 &&
    live[4].status === "Ready" &&
    events.indexOf("comment:43") < events.indexOf("status:Ready") &&
    events.includes("release:43"),
  "failed review posts findings before returning the card to Ready and releasing its claim",
);
await schedulingLoop.stop();
// Wiring guard complements the rendered entry-point checks in test-capacity-widget.
const indexSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
check(
  indexSource.includes("executor.observation") &&
    indexSource.includes("builderSlots + (foreground ? 1 : 0)") &&
    indexSource.includes("slots occupied · ${runningModels} models running") &&
    indexSource.includes("${foreground.label} [${foreground.kind}]"),
  "persistent widget separates occupied slots from running models and includes every foreground lane",
);
assert.equal(process.exitCode ?? 0, 0, "core regressions failed");
