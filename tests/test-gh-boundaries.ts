import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { _DEFAULTS, resolveOwner } from "../src/config.js";
import {
  createComment,
  findProjectItemByContent,
  getCard,
  getCheckRuns,
  getProjectMetadata,
  isTargetIssue,
  listCards,
  listPrComments,
  listPrsWithLabel,
  listSubIssues,
  release,
  resolveIssueId,
  resolvePullRequestId,
  setStatus,
  tryClaim,
  type Card,
} from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { Watchdog, WatchdogStateStore } from "../src/watchdog.js";
import type { TicketExecutor } from "../src/ticket-executor.js";

const previousCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "board-gh-boundaries-"));
const bin = join(root, "bin");
const statePath = join(root, "calls.json");
const responsePath = join(root, "responses.json");
mkdirSync(bin);
process.on("exit", () => {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});
for (const name of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
])
  delete process.env[name];
for (const name of [
  "HOME",
  "USERPROFILE",
  "GH_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
])
  process.env[name] = join(root, "home");
mkdirSync(join(root, "home"));
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(root, "no-global-config");
process.env.MOCK_GH_STATE = statePath;
process.env.MOCK_GH_RESPONSES = responsePath;
const mock = `
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.MOCK_GH_STATE, "utf8"));
const responses = JSON.parse(fs.readFileSync(process.env.MOCK_GH_RESPONSES, "utf8"));
const args = process.platform === "win32" ? process.argv.slice(1) : process.argv.slice(2);
const response = responses[state.calls.length];
state.calls.push(args);
fs.writeFileSync(process.env.MOCK_GH_STATE, JSON.stringify(state));
if (response === undefined) throw Error("Unexpected gh call: " + args.join(" "));
if (response.__error) { process.stderr.write("simulated failure"); process.exit(1); }
process.stdout.write(JSON.stringify(response));
`;
if (process.platform === "win32") {
  copyFileSync(process.execPath, join(bin, "gh.exe"));
  for (const command of ["api", "issue", "pr", "label"])
    writeFileSync(join(root, command), mock);
  process.chdir(root);
} else {
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\n${mock}`);
  chmodSync(join(bin, "gh"), 0o755);
}
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
const reset = (responses: unknown[]) => {
  writeFileSync(statePath, JSON.stringify({ calls: [] }));
  writeFileSync(responsePath, JSON.stringify(responses));
};
const calls = () =>
  (JSON.parse(readFileSync(statePath, "utf8")) as { calls: string[][] }).calls;
const check = (condition: boolean, label: string) => {
  assert.ok(condition, label);
  console.log(`PASS: ${label}`);
};
const connection = (nodes: unknown[], next: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});
const projectItems = (nodes: unknown[], next: string | null = null) => ({
  data: { node: { items: connection(nodes, next) } },
});
const subIssues = (nodes: unknown[], next: string | null = null) => ({
  data: { repository: { issue: { subIssues: connection(nodes, next) } } },
});
const field = (name: string, value: string) => ({
  name: value,
  field: { name },
});
const rawCard = (
  id: string,
  kind = "Issue",
  owner = "origin-owner",
  type = "Task",
  status = "Ready",
) => ({
  id,
  fieldValues: connection([
    field("Status", status),
    field("Kind", type),
    { text: "Release", field: { name: "Plan" } },
  ]),
  content: {
    __typename: kind,
    number: 7,
    title: "T007 task",
    body: "acceptance",
    url: "https://example.test/7",
    closed: status === "Done",
    assignees: { nodes: [] },
    repository: { owner: { login: owner }, name: "repo" },
  },
});
const child = (id: string) => ({
  id,
  number: 11,
  closed: false,
  title: "Task",
  body: `marker ${id}`,
  url: `https://example.test/${id}`,
  repository: { owner: { login: "origin-owner" }, name: "repo" },
});

const repo = join(root, "repo");
mkdirSync(repo);
execFileSync("git", ["init", repo], { stdio: "pipe" });
execFileSync(
  "git",
  ["remote", "add", "origin", "https://github.com/origin-owner/repo.git"],
  { cwd: repo, stdio: "pipe" },
);
const identity = resolveOwner(
  { ..._DEFAULTS, project: { owner: "project-org", number: 17 } },
  repo,
);
check(
  identity.projectOwner === "project-org" &&
    identity.repoOwner === "origin-owner" &&
    identity.repoName === "repo",
  "Project owner is independent of the origin repository owner",
);
reset([
  { data: { repositoryOwner: { projectV2: { id: "P" } } } },
  {
    data: {
      node: {
        fields: connection(
          [{ id: "S", name: "Status", options: [{ id: "R", name: "Ready" }] }],
          "FIELDS_2",
        ),
      },
    },
  },
  {
    data: {
      node: {
        fields: connection([
          { id: "K", name: "Kind", options: [{ id: "T", name: "Task" }] },
          { id: "L", name: "Plan" },
        ]),
      },
    },
  },
]);
const metadata = await getProjectMetadata(
  identity.projectOwner,
  17,
  "status",
  "plan",
  "kind",
);
check(
  calls()[0].includes("login=project-org") &&
    metadata.typeFieldId === "K" &&
    metadata.planFieldId === "L" &&
    calls()[2].includes("after=FIELDS_2"),
  "Project metadata uses Project owner and resolves canonical fields through all pages",
);
reset([
  {
    data: { repositoryOwner: null },
    errors: [{ message: "permission denied" }],
  },
]);
await assert.rejects(getProjectMetadata("project-org", 17, "Status"));
check(
  calls().length === 1,
  "ambiguous Project lookup does not blindly retry under another owner scope",
);
reset([
  { data: { repositoryOwner: { projectV2: { id: "P" } } } },
  {
    data: {
      node: {
        fields: connection([
          {
            id: "S",
            name: "Status",
            options: [
              { id: "R1", name: "Ready" },
              { id: "R2", name: "Ready" },
            ],
          },
        ]),
      },
    },
  },
]);
await assert.rejects(
  getProjectMetadata("project-org", 17, "Status"),
  /Ambiguous options/,
);
check(
  calls().length === 2,
  "duplicate option names are rejected before a map can silently overwrite their IDs",
);

const invalidRaw = [
  rawCard("PR", "PullRequest"),
  rawCard("DRAFT", "DraftIssue"),
  rawCard("CROSS", "Issue", "other"),
  rawCard("WRONG_TYPE", "Issue", "origin-owner", "Epic"),
  rawCard("UNTYPED", "Issue", "origin-owner", ""),
  rawCard("CLOSED_PR", "PullRequest", "origin-owner", "Task", "Done"),
  rawCard("REVIEW_DRAFT", "DraftIssue", "origin-owner", "Task", "Review"),
  rawCard("DESIGN_CROSS", "Issue", "other", "Task", "Needs Design"),
  rawCard("STORY_CROSS", "Issue", "other", "Story"),
];
reset([
  projectItems(invalidRaw.slice(0, 4), "ITEMS_2"),
  projectItems(invalidRaw.slice(4)),
]);
const invalid = await listCards("P", "Status", "Plan", "Kind");
check(
  invalid.length === invalidRaw.length &&
    calls()[0].some((arg) => arg.includes("__typename")) &&
    calls()[1].includes("cursor=ITEMS_2"),
  "all Project item pages preserve content __typename and repository identity",
);
let mutations = 0;
const executor = {
  reconcile: async () => ({
    active: [],
    resumed: 0,
    adopted: 0,
    needsHuman: 0,
    orphans: 0,
    errors: 0,
  }),
  activeCount: () => 0,
  shutdown: async () => undefined,
  launch: async () => {
    mutations++;
    return { status: "skipped", reason: "offline" };
  },
  finalizeClosed: async () => {
    mutations++;
    return { status: "skipped", reason: "offline" };
  },
} as TicketExecutor;
reset([]);
await new BoardLoop(
  {
    cwd: repo,
    cfg: {
      ..._DEFAULTS,
      watchdog: { ..._DEFAULTS.watchdog, enabled: false },
      safety: { ..._DEFAULTS.safety, require_clean_worktree: false },
    },
    repoOwner: identity.repoOwner,
    repoName: identity.repoName,
    botLogin: "bot",
    meta: metadata,
    callback: () => undefined,
    listCards: async () => invalid,
  },
  createLoopState(),
  executor,
).tickNow();
check(
  mutations === 0 && calls().length === 0,
  "hydrated cross-repo, PR, DraftIssue, and wrong-Type cards cause zero GitHub/agent mutations through BoardLoop",
);
for (const card of invalid.filter((card) => card.contentType !== "Issue")) {
  assert.equal(await tryClaim(card, "bot"), false);
  await release(card, "bot");
}
check(
  calls().length === 0,
  "claim and release helpers cannot mutate PR or DraftIssue cards",
);
const target = {
  ...invalid[0],
  contentType: "Issue",
  itemId: "TARGET",
  repoOwner: "origin-owner",
  repoName: "repo",
  number: 7,
  type: "Task",
} as Card;
check(
  isTargetIssue(target, "ORIGIN-OWNER", "REPO", "Task") &&
    !isTargetIssue(
      { ...target, number: Number.MAX_SAFE_INTEGER + 1 },
      "origin-owner",
      "repo",
      "Task",
    ),
  "target identity is case-insensitive and requires a safe positive issue number",
);
for (const state of [
  { state: "OPEN" },
  { state: "OPEN", assignees: [{}] },
  { assignees: [] },
]) {
  reset([state]);
  await assert.rejects(tryClaim(target, "bot"));
  check(
    calls().length === 1 && !calls().some((args) => args.includes("edit")),
    "incomplete claim state blocks assignment instead of interpreting unknown assignees as empty",
  );
}
reset([
  { state: "OPEN", assignees: [] },
  { __error: true },
  { state: "OPEN", assignees: [{ login: "BOT" }] },
]);
check(
  await tryClaim(target, "bot"),
  "ambiguous claim mutation is reconciled by reading the resulting assignee",
);
check(
  calls().filter((args) => args.includes("edit")).length === 1,
  "claim reconciliation never blindly repeats the edit",
);

const manyFields = rawCard("FIELDS");
manyFields.fieldValues = connection([field("Status", "Ready")], "FV_2");
reset([
  projectItems([manyFields]),
  {
    data: {
      node: {
        fieldValues: connection([
          field("Kind", "Task"),
          { text: "Release", field: { name: "Plan" } },
        ]),
      },
    },
  },
]);
const [complete] = await listCards("P", "Status", "Plan", "Kind");
check(
  complete.type === "Task" &&
    complete.plan === "Release" &&
    calls()[1].includes("after=FV_2"),
  "late Type and Plan field values are fetched rather than silently truncated",
);
reset([{ data: { node: { ...rawCard("OTHER") } } }]);
await assert.rejects(
  getCard("EXPECTED", "Status", "Plan", "Kind"),
  /different Project item/,
);
check(
  calls().length === 1,
  "fresh card reads reject a different stable item ID",
);

reset([
  subIssues(
    Array.from({ length: 100 }, (_, i) => child(`CHILD_${i}`)),
    "CHILDREN_2",
  ),
  subIssues([child("LAST_CHILD")]),
]);
const children = await listSubIssues("origin-owner", "repo", 1);
check(
  children.length === 101 &&
    children.at(-1)?.id === "LAST_CHILD" &&
    calls()[1].includes("after=CHILDREN_2"),
  "sub-issue recovery reads the child marker on page two before creation",
);
reset([subIssues([{ ...child("CLOSED"), closed: true }])]);
check(
  (await listSubIssues("origin-owner", "repo", 1))[0].closed === true &&
    calls()[0].some((arg) => arg.includes("number closed title")),
  "sub-issue reads request and preserve validated closed state",
);
reset([subIssues([{ ...child("UNKNOWN"), closed: undefined }])]);
await assert.rejects(
  listSubIssues("origin-owner", "repo", 1),
  /invalid sub-issue/,
);
check(
  calls().length === 1,
  "unknown sub-issue open state fails closed at the API boundary",
);
reset([
  projectItems(
    [{ id: "PR_ITEM", content: { __typename: "PullRequest", id: "ISSUE" } }],
    "ITEM_2",
  ),
  projectItems([
    { id: "FOUND", content: { __typename: "Issue", id: "ISSUE" } },
  ]),
]);
check(
  (await findProjectItemByContent("P", "ISSUE")) === "FOUND" &&
    calls()[1].includes("after=ITEM_2"),
  "Project content reconciliation scans later pages and matches only an Issue typename",
);
reset([
  projectItems(
    [{ id: "A", content: { __typename: "Issue", id: "ISSUE" } }],
    "ITEM_2",
  ),
  projectItems([{ id: "B", content: { __typename: "Issue", id: "ISSUE" } }]),
]);
await assert.rejects(findProjectItemByContent("P", "ISSUE"), /Ambiguous/);
check(
  calls().length === 2,
  "even an early match cannot hide ambiguous duplicate Project content on a later page",
);
for (const [operation, response] of [
  [
    () => listSubIssues("owner", "repo", 1),
    { data: { repository: { issue: null } } },
  ],
  [() => findProjectItemByContent("P", "ISSUE"), { data: { node: null } }],
  [
    () => listCards("P", "Status"),
    { data: { node: { items: { nodes: [] } } } },
  ],
] as const) {
  reset([response]);
  await assert.rejects(operation());
  check(
    calls().length === 1,
    "missing recovery connections are rejected, never interpreted as absence permitting creation",
  );
}
for (const [operation, page] of [
  [() => listSubIssues("owner", "repo", 1), subIssues],
  [() => findProjectItemByContent("P", "ISSUE"), projectItems],
  [() => listCards("P", "Status"), projectItems],
] as const) {
  reset([page([], "A"), page([], "B"), page([], "A")]);
  await assert.rejects(operation(), /missing or repeated cursor/);
  check(
    calls().length === 3,
    "multi-page recovery cycles terminate explicitly instead of looping or returning partial data",
  );
}

reset([
  { data: { repository: { pullRequest: { id: "PR_NODE" } } } },
  { data: { addComment: { commentEdge: { node: { id: "COMMENT" } } } } },
]);
const prId = await resolvePullRequestId("origin-owner", "repo", 7);
assert.equal(await createComment(prId, "reply"), "COMMENT");
check(
  calls()[0].some((arg) => arg.includes("pullRequest(number: $number)")) &&
    calls()[1].includes("issueId=PR_NODE"),
  "PR comments resolve PullRequest identity, not the unrelated issue(number:) query",
);
for (const operation of [
  () => resolveIssueId("owner", "repo", 1),
  () => resolvePullRequestId("owner", "repo", 1),
  () => createComment("NODE", "reply"),
  () => setStatus(metadata, "ITEM", "Ready"),
]) {
  reset([{ data: {} }]);
  await assert.rejects(operation());
  check(
    calls().length === 1,
    "missing identity/mutation acknowledgement fails explicitly without a blind retry",
  );
}
const rawPr = (number: number) => ({
  number,
  title: "PR",
  headRefName: `task/issue-${number}`,
  headRefOid: "a".repeat(40),
  url: "https://example.test/pr",
  isCrossRepository: false,
});
reset([
  { data: { repository: { pullRequests: connection([rawPr(1)], "PR_2") } } },
  { data: { repository: { pullRequests: connection([rawPr(2)]) } } },
]);
check(
  (await listPrsWithLabel("owner", "repo", "board-agent")).length === 2 &&
    calls()[1].includes("after=PR_2"),
  "watchdog PR listing has no fixed 50-PR cutoff",
);
reset([
  [
    {
      check_runs: [
        { name: "first", status: "completed", conclusion: "success" },
      ],
    },
    {
      check_runs: [
        { name: "late-failure", status: "completed", conclusion: "failure" },
      ],
    },
  ],
]);
check(
  (await getCheckRuns("owner", "repo", "a".repeat(40))).at(-1)?.conclusion ===
    "failure" && calls()[0].includes("--paginate"),
  "a failing CI check on a later REST page cannot be mistaken for green",
);
reset([{ __error: true }]);
await assert.rejects(getCheckRuns("owner", "repo", "a".repeat(40)));
check(
  calls().length === 1,
  "CI API failure propagates instead of masquerading as an empty green result",
);

const restComments = Array.from({ length: 201 }, (_, i) => ({
  id: i + 1,
  body: "@bot clarify",
  created_at: new Date((i + 1) * 1000).toISOString(),
  user: { login: "human" },
  author_association: i === 200 ? "COLLABORATOR" : "NONE",
}));
reset([
  [
    restComments.slice(0, 100),
    restComments.slice(100, 200),
    restComments.slice(200),
  ],
]);
new WatchdogStateStore(repo).update(7, { lastSeenCommentId: "100" });
let replies = 0;
let markedReply = "";
await new Watchdog({
  cwd: repo,
  cfg: {
    ..._DEFAULTS,
    watchdog: { ..._DEFAULTS.watchdog, respond_to_mentions: true },
    context: { ..._DEFAULTS.context, enabled: false },
  },
  repoOwner: "origin-owner",
  repoName: "repo",
  botLogin: "bot",
  meta: metadata,
  callback: () => undefined,
  mentionOps: {
    listComments: (number) => listPrComments("origin-owner", "repo", number),
    run: async () => {
      replies++;
      return { result: { reply: "offline reply" } };
    },
    post: async (_number, body) => {
      markedReply = body;
    },
  },
}).handleMentions(rawPr(7));
check(
  replies === 1 &&
    markedReply.startsWith("<!-- board-agent-mention:201 -->\n") &&
    new WatchdogStateStore(repo).get(7).lastSeenCommentId === "201",
  "real REST parser feeds Watchdog: trusted mention #201 is processed, earlier outsiders are skipped, cursor advances exactly once",
);
