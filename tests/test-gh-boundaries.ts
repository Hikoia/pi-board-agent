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
  getCard,
  getProjectMetadata,
  isTargetIssue,
  listCards,
  release,
  resolveIssueId,
  setStatus,
  tryClaim,
  validateProjectMetadata,
  type Card,
} from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import type { TicketExecutor } from "../src/ticket-executor.js";
import {
  GIT_GH_TIMEOUT_MS,
  ProcessTimeoutError,
} from "../src/process-runner.js";

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
if (process.platform === "win32") args[0] = require("node:path").basename(args[0]);
const response = responses[state.calls.length];
state.calls.push(args);
fs.writeFileSync(process.env.MOCK_GH_STATE, JSON.stringify(state));
if (response === undefined) throw Error("Unexpected gh call: " + args.join(" "));
if (response.__error) { process.stderr.write("simulated failure"); process.exit(1); }
if (response.__hang) setInterval(() => {}, 1000);
else process.stdout.write(JSON.stringify(response));
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
          [{ id: "S", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "R", name: "Ready" }] }],
          "FIELDS_2",
        ),
      },
    },
  },
  {
    data: {
      node: {
        fields: connection([
          { id: "K", name: "Kind", dataType: "SINGLE_SELECT", options: [{ id: "T", name: "Task" }] },
          { id: "L", name: "Plan", dataType: "TEXT" },
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
assert.partialDeepStrictEqual(metadata, {
  statusFieldType: "SINGLE_SELECT",
  planFieldType: "TEXT",
  typeFieldType: "SINGLE_SELECT",
});
console.log("PASS: Project metadata retains explicit GraphQL field types, not option-presence guesses");

{
  const status = { id: "S", name: "Status", dataType: "SINGLE_SELECT", options: Object.values(_DEFAULTS.columns).map((name) => ({ name, id: name })) };
  const plan = { id: "L", name: "Plan", dataType: "TEXT" };
  const type = { id: "K", name: "Kind", dataType: "SINGLE_SELECT", options: [{ id: "TASK", name: "Task" }, { id: "STORY", name: "Story" }] };
  for (const [label, fields, error] of [
    ["missing Status", [plan, type], /Status field/],
    ["wrong Status despite options", [{ ...status, dataType: "TEXT" }, plan, type], /Status field/],
    ["missing Type", [status, plan], /Type.*SINGLE_SELECT/],
    ["text Type", [status, plan, { ...type, dataType: "TEXT", options: undefined }], /Type.*SINGLE_SELECT/],
    ["missing Type option", [status, plan, { ...type, options: [{ id: "STORY", name: "Story" }] }], /Type.*Task/],
  ] as const) {
    reset([
      { data: { repositoryOwner: { projectV2: { id: "P" } } } },
      { data: { node: { fields: connection([...fields]) } } },
    ]);
    await assert.rejects(async () => validateProjectMetadata(
      await getProjectMetadata("project-org", 17, "Status", "Plan", "Kind"), _DEFAULTS,
    ), error, label);
    assert.equal(calls().length, 2, `${label}: only metadata queries, no schema mutation`);
    assert.ok(calls().every((args) => !args.some((arg) => /mutation\(/.test(arg))));
  }
  console.log("PASS: real metadata adapter + lane validation reject missing/wrong raw GraphQL fields and Type options using read-only queries");
}
for (const planFieldType of [undefined, "TEXT", "SINGLE_SELECT", "NUMBER"]) {
  reset([
    { data: { repositoryOwner: { projectV2: { id: "P" } } } },
    { data: { node: { fields: connection([
      { id: "S", name: "Status", dataType: "SINGLE_SELECT", options: ["Ready", "In Progress", "Review", "Done", "Needs Human"].map(name => ({ name, id: name })) },
      { id: "K", name: "Kind", dataType: "SINGLE_SELECT", options: [{ name: "Task", id: "TASK" }] },
      ...(planFieldType ? [{ id: "L", name: "Plan", dataType: planFieldType, ...(planFieldType === "SINGLE_SELECT" ? { options: [] } : {}) }] : []),
    ]) } } },
  ]);
  validateProjectMetadata(await getProjectMetadata("project-org", 17, "Status", "Plan", "Kind"), _DEFAULTS);
  assert.equal(calls().length, 2);
  assert.ok(calls().every(args => !args.some(arg => /mutation\(/.test(arg))));
  console.log(`PASS: Task-only metadata with Plan=${planFieldType ?? "absent"} needs no Story/Backlog/Needs Design or schema mutation`);
}
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
// Exercise release -> runGh -> the real process supervisor, including its
// production deadline. Never replace the adapter or disable Windows containment.
const releaseFailures: unknown[] = [];
for (const mode of ["exit1", "timeout"] as const) {
  reset([mode === "exit1" ? { __error: true } : { __hang: true }]);
  try {
    await assert.rejects(
      release(target, "bot"),
      mode === "exit1"
        ? { name: "GhError", exitCode: 1, stderr: "simulated failure" }
        : (error: unknown) =>
            error instanceof ProcessTimeoutError &&
            error.timeoutMs === GIT_GH_TIMEOUT_MS,
    );
    assert.deepEqual(calls(), [
      ["issue", "edit", "7", "--repo", "origin-owner/repo", "--remove-assignee", "bot"],
    ]);
    console.log(`PASS: production release rejects ${mode} without replay`);
  } catch (error) {
    console.error(`FAIL: production release must reject ${mode}`, error);
    releaseFailures.push(error);
  }
}
if (releaseFailures.length) throw new AggregateError(releaseFailures);

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

for (const operation of [
  () => resolveIssueId("owner", "repo", 1),
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
reset([{ data: { node: { items: { nodes: [] } } } }]);
await assert.rejects(listCards("P", "Status"));
assert.equal(calls().length, 1);
console.log("PASS: missing Project connections fail closed, not an empty board");
reset([projectItems([], "A"), projectItems([], "B"), projectItems([], "A")]);
await assert.rejects(listCards("P", "Status"), /missing or repeated cursor/);
assert.equal(calls().length, 3);
console.log("PASS: multi-page Project cursor cycles fail explicitly without partial data");
