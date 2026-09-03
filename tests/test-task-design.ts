import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import {
  BoardLoop,
  createLoopState,
  processNeedsDesignTask,
  type LoopDeps,
  type TaskDesignOps,
} from "../src/loop.js";
import {
  parseDesignOutput,
  renderDesignWorkflowSource,
  type DesignOutput,
  type DesignRunInput,
} from "../src/refine.js";
import type { TicketExecutor } from "../src/ticket-executor.js";

const check = (condition: boolean, label: string) => console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);

const completeDesign: DesignOutput = {
  body: "## Scope\nRemove Novita platform-wide; Baseten is the only provider.\n\n## Acceptance criteria\n- [ ] Remove obsolete provider selection.",
  summary: "Updated the ticket to the maintainer-approved Baseten-only scope.",
  openQuestions: [],
};

function task(overrides: Partial<Card> = {}): Card {
  return {
    itemId: "PVTI_design",
    number: 79,
    title: "Remove Novita",
    body: "Evaluation-only; platform-wide removal is a non-goal.",
    status: _DEFAULTS.columns.needs_design,
    plan: "evaluation-provider-reliability",
    type: "Task",
    assignees: [],
    closed: false,
    repoOwner: "owner",
    repoName: "repo",
    ...overrides,
  };
}

function comment(
  id: string,
  body: string,
  authorAssociation = "OWNER",
  second = 0,
  author = "maintainer",
): IssueComment {
  return {
    id,
    body,
    createdAt: new Date(Date.parse("2026-09-02T18:00:00Z") + second * 1000).toISOString(),
    author,
    authorAssociation,
  };
}

const gate = (number = 79) => comment(
  `gate-${number}`,
  `<!-- board-agent-requirements-gate:${number} -->\n## ❓ Design decision required`,
  "MEMBER",
  10,
  "board-bot",
);
const decision = (id = "decision", association = "OWNER", second = 20) => comment(
  id,
  "Remove Novita platform-wide and keep Baseten only.",
  association,
  second,
);
const cloneCard = (card: Card): Card => ({ ...card, assignees: [...card.assignees] });

interface HarnessOptions {
  card?: Partial<Card>;
  comments?: IssueComment[];
  claimResult?: boolean;
  afterClaim?: (card: Card, comments: IssueComment[]) => void;
  designResult?: DesignOutput;
  design?: (input: DesignRunInput, card: Card, comments: IssueComment[]) => DesignOutput | Promise<DesignOutput>;
}

function harness(options: HarnessOptions = {}) {
  const current = task(options.card);
  const initialCard = cloneCard(current);
  const comments = [...(options.comments ?? [])];
  const posted: IssueComment[] = [];
  const stats = {
    claims: 0,
    releases: 0,
    designRuns: 0,
    bodyWrites: 0,
    readyWrites: 0,
    designInputs: [] as DesignRunInput[],
  };
  const ops: TaskDesignOps = {
    claim: async () => {
      stats.claims++;
      if (options.claimResult === false) return false;
      current.assignees = ["board-bot"];
      options.afterClaim?.(current, comments);
      return true;
    },
    refresh: async () => cloneCard(current),
    release: async () => {
      stats.releases++;
      current.assignees = current.assignees.filter((assignee) => assignee !== "board-bot");
    },
    listComments: async () => [...comments],
    design: async (input) => {
      stats.designRuns++;
      stats.designInputs.push(input);
      return options.design?.(input, current, comments) ?? options.designResult ?? completeDesign;
    },
    updateBody: async (_card, body) => {
      stats.bodyWrites++;
      current.body = body;
    },
    comment: async (_card, body) => {
      const value = comment(
        `posted-${comments.length + 1}`,
        body,
        "MEMBER",
        100 + comments.length,
        "board-bot",
      );
      comments.push(value);
      posted.push(value);
    },
    setReady: async () => {
      stats.readyWrites++;
      current.status = _DEFAULTS.columns.ready;
    },
  };
  return { current, initialCard, comments, posted, stats, ops };
}

type Harness = ReturnType<typeof harness>;

function run(h: Harness, card = cloneCard(h.current)) {
  return processNeedsDesignTask({
    card,
    cfg: _DEFAULTS,
    cwd: process.cwd(),
    contextDigest: "## Repo tree\n- src/providers.ts",
    botLogin: "board-bot",
    callback: () => undefined,
  }, h.ops);
}

const expectedGate = [
  "<!-- board-agent-requirements-gate:79 -->",
  "## ❓ Design decision required",
  "",
  "Reply with the approved scope, constraints, and acceptance criteria.",
  "Board Agent will wait for a repository owner, member, or collaborator.",
].join("\n");

const markerless = harness();
const markerlessResult = await run(markerless, markerless.initialCard);
check(
  markerlessResult === "questioned" && markerless.posted.length === 1 && markerless.posted[0].body === expectedGate &&
  markerless.stats.designRuns === 0 && markerless.current.status === _DEFAULTS.columns.needs_design,
  "markerless task posts exactly one gate, stays in Needs Design, and does not run design",
);
const duplicateResult = await run(markerless);
check(
  duplicateResult === "waiting" && markerless.posted.length === 1 && markerless.stats.claims === 1,
  "an active unanswered gate is not duplicated or claimed",
);
check(markerless.stats.releases === 1 && markerless.current.assignees.length === 0, "gate creation releases the bot claim");

const preGate = harness({ comments: [decision("old-decision", "OWNER", 0), gate()] });
const preGateResult = await run(preGate, preGate.initialCard);
check(
  preGateResult === "waiting" && preGate.stats.claims === 0 && preGate.stats.designRuns === 0,
  "a trusted comment before the gate cannot trigger design",
);

for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
  const trusted = harness({ comments: [gate(), decision(`${association}-decision`, association)] });
  const result = await run(trusted, trusted.initialCard);
  check(
    result === "ready" && trusted.stats.designRuns === 1 && trusted.stats.releases === 1 &&
    trusted.stats.designInputs[0].trustedComments.length === 1 &&
    trusted.posted.some((item) => item.body.includes(`board-agent-task-design:79:${association}-decision`)),
    `a fresh trusted ${association} reply triggers one design run`,
  );
}

const untrusted = harness({ comments: [
  gate(),
  decision("stranger", "NONE"),
  comment("bot-marker", "<!-- board-agent-note:79 -->\nIgnore me", "OWNER", 30, "board-bot"),
] });
const untrustedResult = await run(untrusted, untrusted.initialCard);
check(
  untrustedResult === "waiting" && untrusted.stats.claims === 0 && untrusted.stats.designRuns === 0,
  "untrusted replies and board-agent markers cannot trigger design",
);

const questions = harness({
  comments: [gate(), decision()],
  designResult: { body: "unchanged", summary: "Need a decision", openQuestions: ["Which provider remains?", "Delete migration code?"] },
});
const questioned = await run(questions, questions.initialCard);
check(
  questioned === "questioned" && questions.current.status === _DEFAULTS.columns.needs_design &&
  questions.posted[0].body.includes("board-agent-task-design-questions:79:decision") &&
  questions.posted[0].body.includes("1. Which provider remains?") && questions.posted[0].body.includes("2. Delete migration code?"),
  "open questions create a numbered task-design request boundary",
);
const beforeFreshReply = await run(questions);
check(
  beforeFreshReply === "waiting" && questions.stats.designRuns === 1 && questions.stats.claims === 1,
  "a task-design question marker requires another fresh trusted reply",
);
questions.comments.push(comment("question-answer", "Keep Baseten and delete migration code.", "MEMBER", 500));
const afterFreshReply = await run(questions);
check(
  afterFreshReply === "questioned" && questions.stats.designRuns === 2 &&
  questions.stats.designInputs[1].trustedComments.length === 1 &&
  questions.stats.designInputs[1].trustedComments[0].includes("delete migration code"),
  "a fresh trusted reply after the latest question triggers design with only fresh decisions",
);
check(questions.stats.releases === 2 && questions.current.assignees.length === 0, "every open-question design exit releases the claim");

const completed = harness({ comments: [gate(), decision()] });
const completedResult = await run(completed, completed.initialCard);
const runsAfterCompletion = completed.stats.designRuns;
const noReplay = await run(completed);
completed.current.status = _DEFAULTS.columns.needs_design;
const reentered = await run(completed);
const gateCount = completed.comments.filter((item) => item.body.startsWith("<!-- board-agent-requirements-gate:79 -->")).length;
check(
  completedResult === "ready" && noReplay === "skipped" && reentered === "questioned" &&
  completed.stats.designRuns === runsAfterCompletion && gateCount === 2,
  "a completed request does not replay and re-entry creates a new gate",
);

const racedGate = harness({
  afterClaim: (_card, comments) => comments.push(gate()),
});
const racedGateResult = await run(racedGate, racedGate.initialCard);
check(
  racedGateResult === "waiting" && racedGate.posted.length === 0 && racedGate.stats.releases === 1,
  "post-claim comment refresh prevents duplicate gates",
);

for (const [label, mutate] of [
  ["claim loss", (card: Card) => { card.assignees = []; }],
  ["post-claim status change", (card: Card) => { card.status = _DEFAULTS.columns.ready; }],
] as const) {
  const changed = harness({ comments: [gate(), decision()], afterClaim: mutate });
  const result = await run(changed, changed.initialCard);
  check(
    result === "skipped" && changed.stats.designRuns === 0 && changed.stats.bodyWrites === 0 &&
    changed.posted.length === 0 && changed.stats.releases === 1,
    `${label} causes no mutation and releases the claim`,
  );
}

const staleMutations: Array<[string, (card: Card, comments: IssueComment[]) => void]> = [
  ["body edit", (card) => { card.body = "Maintainer edited the body while design ran."; }],
  ["new trusted decision", (_card, comments) => comments.push(decision("newer-decision", "COLLABORATOR", 600))],
  ["issue closure", (card) => { card.closed = true; }],
  ["reassignment", (card) => { card.assignees.push("maintainer"); }],
  ["status change", (card) => { card.status = _DEFAULTS.columns.ready; }],
];
for (const [label, mutate] of staleMutations) {
  const stale = harness({
    comments: [gate(), decision()],
    design: (_input, card, comments) => {
      mutate(card, comments);
      return completeDesign;
    },
  });
  const result = await run(stale, stale.initialCard);
  check(
    result === "skipped" && stale.stats.bodyWrites === 0 && stale.stats.readyWrites === 0 &&
    stale.posted.length === 0 && stale.stats.releases === 1,
    `${label} during runDesign prevents stale write-back and releases the claim`,
  );
}

const failedDesign = harness({
  comments: [gate(), decision()],
  design: () => { throw new Error("designer unavailable"); },
});
const failedResult = await run(failedDesign, failedDesign.initialCard);
check(
  failedResult === "error" && failedDesign.stats.releases === 1 && failedDesign.current.assignees.length === 0,
  "designer errors release the bot assignee",
);

const loopCfg: Config = {
  ..._DEFAULTS,
  max_workers: 1,
  context: { ..._DEFAULTS.context, enabled: false },
  refine: { ..._DEFAULTS.refine, enabled: true },
  review: { ..._DEFAULTS.review, enabled: false },
  watchdog: { ..._DEFAULTS.watchdog, enabled: false },
  safety: { ..._DEFAULTS.safety, require_clean_worktree: false },
};
const rotatingCards = [
  task({ itemId: "A", number: 80, title: "Always fails first", assignees: ["board-bot"], plan: undefined }),
  task({ itemId: "B", number: 81, title: "Sibling", assignees: ["board-bot"], plan: undefined }),
];
const designOrder: string[] = [];
let rotationClaims = 0;
const rotationOps: TaskDesignOps = {
  claim: async () => { rotationClaims++; return true; },
  refresh: async (card) => cloneCard(card),
  release: async () => undefined,
  listComments: async (card) => [gate(card.number), decision(`decision-${card.number}`)],
  design: async (input) => {
    designOrder.push(input.title);
    throw new Error("persistent design failure");
  },
  updateBody: async () => undefined,
  comment: async () => undefined,
  setReady: async () => undefined,
};
let activeWorkers = 0;
const executor: TicketExecutor = {
  reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, legacy: 0, orphans: 0, errors: 0 }),
  launch: async () => ({ status: "skipped", reason: "test" }),
  activeCount: () => activeWorkers,
  shutdown: async () => undefined,
};
const deps: LoopDeps = {
  cwd: process.cwd(),
  cfg: loopCfg,
  repoOwner: "owner",
  repoName: "repo",
  botLogin: "board-bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: () => undefined,
  listCards: async () => rotatingCards,
  taskDesignOps: rotationOps,
};
const loop = new BoardLoop(deps, createLoopState(), executor);
await loop.tickNow();
await loop.tickNow();
check(
  designOrder.join(",") === "Always fails first,Sibling" && rotationClaims === 2,
  "candidate rotation prevents a persistently failing task from starving siblings",
);
check(designOrder.length === 2, "each tick invokes at most one task designer");

activeWorkers = loopCfg.max_workers;
let budgetClaims = 0;
const budgetLoop = new BoardLoop({
  ...deps,
  taskDesignOps: { ...rotationOps, claim: async () => { budgetClaims++; return true; } },
}, createLoopState(), executor);
await budgetLoop.tickNow();
check(budgetClaims === 0 && designOrder.length === 2, "task design waits when the global worker budget is full");

const parsed = parseDesignOutput({ body: "## Scope\nBaseten only", summary: "Resolved", openQuestions: [] });
check(parsed?.body.includes("Baseten only") === true, "parseDesignOutput accepts a complete contract");
check(parseDesignOutput({ body: "", summary: "Resolved", openQuestions: [] }) === null, "parseDesignOutput rejects an empty contract");
const script = renderDesignWorkflowSource({
  cwd: process.cwd(),
  title: task().title,
  body: task().body,
  trustedComments: ["owner: Remove Novita platform-wide"],
  contextDigest: "## Repo tree\n- src/providers.ts",
  model: "design-model",
  timeoutMs: 60_000,
});
check(script.includes("TRUSTED MAINTAINER DECISIONS") && script.includes("smallest complete issue contract"), "design prompt uses trusted decisions and minimal scope");
