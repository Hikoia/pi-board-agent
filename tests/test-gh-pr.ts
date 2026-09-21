import assert from "node:assert/strict";
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
import {
  createPullRequest,
  findPullRequests,
  getPullRequest,
  type PullRequestInfo,
  type PullRequestScope,
} from "../src/gh.js";
import { GIT_GH_TIMEOUT_MS, ProcessTimeoutError } from "../src/process-runner.js";

assert.equal(process.env.PI_OFFLINE, "1", "Use tests/run-offline.sh");
assert.ok(process.env.TMP_DIR, "Use tests/run-offline.sh");
const previousCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "board-gh-pr-"));
const bin = join(root, "bin");
const statePath = join(root, "calls.json");
const responsePath = join(root, "responses.json");
mkdirSync(bin);
process.on("exit", () => {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});
for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
  delete process.env[name];
for (const name of ["HOME", "USERPROFILE", "GH_CONFIG_DIR", "PI_CODING_AGENT_DIR"])
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
if (response.__error) { process.stderr.write(response.__error); process.exit(1); }
if (response.__hang) setInterval(() => {}, 1000);
else process.stdout.write(response.__raw ?? JSON.stringify(response));
`;
if (process.platform === "win32") {
  copyFileSync(process.execPath, join(bin, "gh.exe"));
  for (const command of ["api", "issue", "pr", "repo"])
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
const fields = (args: string[]) => Object.fromEntries(
  args.filter((arg) => arg.includes("=")).map((arg) => {
    const index = arg.indexOf("=");
    return [arg.slice(0, index), arg.slice(index + 1)];
  }),
);
type Command = "find" | "get" | "repository" | "create";
const captured: string[][] = [];
const verifyCalls = (expected: Command[]) => {
  const actual = calls();
  assert.equal(actual.length, expected.length, "no fallback or replay");
  actual.forEach((args, index) => {
    captured.push(args);
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    for (let i = 2; i < args.length; i += 2) {
      assert.ok(["-f", "-F"].includes(args[i]), "only GraphQL variable flags");
      assert.ok(args[i + 1]?.includes("="));
    }
    const variables = fields(args);
    const query = variables.query;
    const kind: Command = query.includes("createPullRequest(input:") ? "create"
      : query.includes("pullRequests(first:") ? "find"
      : query.includes("pullRequest(number:") ? "get" : "repository";
    assert.equal(kind, expected[index]);
    assert.match(query, kind === "create" ? /^\s*mutation\(/ : /^\s*query\(/);
    assert.doesNotMatch(query, /mergePullRequest|enablePullRequestAutoMerge|closePullRequest|reopenPullRequest|convert|update|delete|issueId|issue\(/i);
    assert.deepEqual(Object.keys(variables).sort(), {
      find: ["query", "owner", "repo", "base", "head", "after"],
      get: ["query", "owner", "repo", "number"],
      repository: ["query", "owner", "repo"],
      create: ["query", "repositoryId", "base", "head", "title", "body"],
    }[kind].sort());
    if (kind !== "repository") {
      for (const field of ["number", "url", "body", "state", "merged", "headRefOid", "baseRefName", "headRefName", "mergeCommit { oid }", "repository { name owner { login } }", "baseRepository", "headRepository"])
        assert.ok(query.includes(field), `PR query requests ${field}`);
    }
    if (kind === "find") {
      assert.match(query, /states: \[OPEN, CLOSED, MERGED\]/);
      assert.match(query, /first: 100, after: \$after/);
      assert.match(query, /baseRefName: \$base, headRefName: \$head/);
      assert.match(query, /pageInfo \{ hasNextPage endCursor \}/);
    }
  });
  return actual.map(fields);
};
const rejected = async (
  operation: () => Promise<unknown>,
  responses: unknown[],
  expected: Command[],
  error?: RegExp,
) => {
  reset(responses);
  if (error) await assert.rejects(operation, error);
  else await assert.rejects(operation);
  verifyCalls(expected);
};
const pass = (message: string) => console.log(`PASS: ${message}`);
const scope: PullRequestScope = { owner: "owner", repo: "repo", base: "main", head: "task/issue-7" };
const repository = () => ({ id: "R_REPO", name: scope.repo, owner: { login: scope.owner } });
const headSha = "a".repeat(40);
const testMergeSha = "b".repeat(40);
const actualMergeSha = "c".repeat(40);
const raw = (number = 7, state = "OPEN", merged = false) => ({
  id: `PR_${number}`, number,
  url: `https://github.example.test/owner/repo/pull/${number}`,
  body: "Refs #7\n\nHuman-maintained body: 保留\n<!-- managed marker -->",
  state, merged, headRefOid: headSha,
  baseRefName: scope.base, headRefName: scope.head,
  mergeCommit: merged ? { oid: actualMergeSha } : null,
  repository: repository(), baseRepository: repository(), headRepository: repository(),
});
const page = (nodes: unknown[], next: string | null = null) => ({
  data: { repository: { ...repository(), pullRequests: {
    nodes, pageInfo: { hasNextPage: next !== null, endCursor: next },
  } } },
});
const read = (node: unknown) => ({ data: { repository: { ...repository(), pullRequest: node } } });
const lookup = () => ({ data: { repository: repository() } });
const created = (node: unknown) => ({ data: { createPullRequest: { pullRequest: node } } });

reset([
  page([{ ...raw(), mergeCommit: { oid: testMergeSha } }], "PAGE_2"),
  page([raw(8, "CLOSED")], "PAGE_3"),
  { data: { repository: { ...repository(), pullRequests: {
    nodes: [raw(9, "MERGED", true)],
    pageInfo: { hasNextPage: false, endCursor: "LAST" },
  } } } },
]);
const found = await findPullRequests(scope);
assert.deepEqual(found.map((pr) => [pr.number, pr.state, pr.merged, pr.mergeCommitSha]), [
  [7, "open", false, testMergeSha],
  [8, "closed", false, null],
  [9, "closed", true, actualMergeSha],
]);
assert.ok(found.every((pr) => pr.body === raw().body && pr.headSha === headSha));
assert.deepEqual(found.map((pr) => pr.scope), [scope, scope, scope]);
const pages = verifyCalls(["find", "find", "find"]);
assert.deepEqual(pages.map((call) => call.after), ["null", "PAGE_2", "PAGE_3"]);
assert.ok(pages.every((call) => call.owner === scope.owner && call.repo === scope.repo && call.base === scope.base && call.head === scope.head));
pass("all-state discovery reads every page, including later closed-unmerged and merged PRs; test merge SHA is not merged evidence");

reset([page([])]);
assert.deepEqual(await findPullRequests(scope), []);
verifyCalls(["find"]);
pass("only a confirmed complete empty connection is absence");

for (const node of [raw(), raw(7, "CLOSED"), raw(7, "MERGED", true), { ...raw(7, "CLOSED"), mergeCommit: { oid: testMergeSha } }]) {
  reset([read(node)]);
  const result: PullRequestInfo = await getPullRequest(scope, 7);
  assert.deepEqual(result, {
    scope, number: 7, url: node.url, body: node.body,
    state: node.state === "OPEN" ? "open" : "closed",
    merged: node.merged, headSha, mergeCommitSha: node.mergeCommit?.oid ?? null,
  });
  assert.equal(verifyCalls(["get"])[0].number, "7");
}
reset([read({ ...raw(), body: "" })]);
assert.equal((await getPullRequest({ ...scope, owner: "OWNER", repo: "REPO" }, 7)).body, "");
verifyCalls(["get"]);
pass("known-number reads preserve empty/human bodies, explicit merged=false and repository case-insensitivity");

const title = 'T007: "quoted" --admin';
const body = `${raw().body}\nmutation { mergePullRequest }\n--issue 7`;
reset([lookup(), created({ ...raw(), body })]);
const made = await createPullRequest(scope, title, body);
assert.equal(made.body, body);
assert.equal(made.state, "open");
assert.equal(made.merged, false);
const creation = verifyCalls(["repository", "create"]);
assert.deepEqual({ ...creation[1], query: undefined }, {
  query: undefined, repositoryId: "R_REPO", base: scope.base, head: scope.head, title, body,
});
assert.ok(!creation[1].query.includes(body), "body is data, never GraphQL source");
pass("creation is one same-repository mutation with exact title/body variables, no Issue conversion or human-body update");

for (const [operation, responses, expected] of [
  [(input: PullRequestScope) => findPullRequests(input), [page([raw()])], ["find"]],
  [(input: PullRequestScope) => getPullRequest(input, 7), [read(raw())], ["get"]],
  [(input: PullRequestScope) => createPullRequest(input, title, body), [lookup(), created(raw())], ["repository", "create"]],
] as const) {
  const input = { ...scope, query: "mutation { mergePullRequest }" };
  reset([...responses]);
  const pending = operation(input);
  input.head = "fork-owner:task/issue-7";
  const result = await pending;
  assert.deepEqual(Array.isArray(result) ? result[0].scope : result.scope, scope);
  for (const call of verifyCalls([...expected]))
    if (call.head !== undefined) assert.equal(call.head, scope.head);
}
pass("each API snapshots the validated scope; extra properties cannot replace the GraphQL query or mutate the head during I/O");

// Every field is mandatory, including explicit null for an absent merge commit.
for (const field of Object.keys(raw())) {
  const node: Record<string, unknown> = { ...raw() };
  delete node[field];
  await rejected(() => getPullRequest(scope, 7), [read(node)], ["get"]);
}
for (const node of [
  null, {}, [],
  { ...raw(), id: " " },
  { ...raw(), number: 0 },
  { ...raw(), number: "7" },
  { ...raw(), number: 7.5 },
  { ...raw(), number: Number.MAX_SAFE_INTEGER + 1 },
  raw(8),
  { ...raw(), url: "" },
  { ...raw(), url: "not a URL" },
  { ...raw(), url: ` ${raw().url} ` },
  { ...raw(), url: `${raw().url}?other=identity` },
  { ...raw(), url: `${raw().url}#fragment` },
  { ...raw(), url: "https://github.example.test/owner/other/pull/7" },
  { ...raw(), url: "https://github.example.test/owner/repo/pull/8" },
  { ...raw(), url: "https://github.example.test/owner/repo/issues/7" },
  { ...raw(), url: "http://github.example.test/owner/repo/pull/7" },
  { ...raw(), url: "https://user:pass@github.example.test/owner/repo/pull/7" },
  { ...raw(), body: null },
  { ...raw(), state: "open" },
  { ...raw(), state: "UNKNOWN" },
  { ...raw(), merged: null },
  { ...raw(), merged: "false" },
  { ...raw(), merged: 0 },
  raw(7, "OPEN", true),
  raw(7, "CLOSED", true),
  raw(7, "MERGED", false),
  { ...raw(), headRefOid: null },
  { ...raw(), headRefOid: "abcd" },
  { ...raw(), headRefOid: "g".repeat(40) },
  { ...raw(), mergeCommit: {} },
  { ...raw(), mergeCommit: { oid: null } },
  { ...raw(), mergeCommit: { oid: "abcd" } },
  { ...raw(7, "MERGED", true), mergeCommit: null },
  { ...raw(), baseRefName: "MAIN" },
  { ...raw(), headRefName: "other-branch" },
]) await rejected(() => getPullRequest(scope, 7), [read(node)], ["get"]);
pass("missing/malformed identity, URL, body, state, explicit merged boolean and SHA data throw; known-number mismatch never falls back");

for (const field of ["repository", "baseRepository", "headRepository"]) {
  for (const value of [null, {}, { name: "repo" }, { owner: { login: "owner" } },
    { name: "repo", owner: { login: "fork-owner" } },
    { name: "fork-repo", owner: { login: "owner" } }]) {
    const node = { ...raw(), [field]: value };
    await rejected(() => getPullRequest(scope, 7), [read(node)], ["get"], /PR repository/);
  }
}
for (const node of [
  { ...raw(), headRepository: { name: "repo", owner: { login: "fork-owner" } } },
  { ...raw(), baseRepository: null },
  { ...raw(), headRefName: "other-task" },
  { ...raw(), merged: undefined, mergeCommit: { oid: testMergeSha } },
]) {
  await rejected(() => findPullRequests(scope), [page([node])], ["find"]);
  await rejected(() => createPullRequest(scope, title, body), [lookup(), created(node)], ["repository", "create"]);
}
pass("fork candidates and unknown/wrong repository or branch identities fail closed in find, get and create");

for (const response of [
  { data: null },
  { data: {} },
  { data: { repository: null } },
  { data: { repository: { ...repository(), name: "wrong" } } },
  { data: { repository: { ...repository(), owner: null } } },
  { data: { repository: { ...repository(), pullRequests: null } } },
  { data: { repository: { ...repository(), pullRequests: {} } } },
  { data: { repository: { ...repository(), pullRequests: { nodes: [] } } } },
  { data: { repository: { ...repository(), pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } },
  { data: { repository: { ...repository(), pullRequests: { nodes: [], pageInfo: { hasNextPage: "false", endCursor: null } } } } },
  { data: { repository: { ...repository(), pullRequests: { nodes: null, pageInfo: { hasNextPage: false, endCursor: null } } } } },
  page([null]), page([{}]),
  { ...page([]), errors: [{ message: "partial permission failure" }] },
]) await rejected(() => findPullRequests(scope), [response], ["find"]);
pass("missing repository/connection/page metadata, partial GraphQL errors and malformed nodes are errors, not absence");

for (const responses of [
  [page([raw(), raw()])],
  [page([raw(), { ...raw(8), id: raw().id }])],
  [page([raw(), { ...raw(), id: "OTHER_ID" }])],
  [page([raw()], "A"), page([raw()], "B")],
  [page([raw()], "A"), page([raw()])],
  [page([], "A"), page([], "A")],
  [page([], "A"), page([], "B"), page([], "A")],
  [page([], "")],
  [page([], "   ")],
  [{ data: { repository: { ...repository(), pullRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }],
  [page([], "A"), { data: { repository: { ...repository(), pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "A" } } } } }],
]) await rejected(() => findPullRequests(scope), responses, responses.map(() => "find"), /duplicate PR|missing or repeated cursor/);
await rejected(() => findPullRequests(scope), [page([raw()], "A"), { data: { repository: null } }], ["find", "find"]);
pass("duplicate IDs/numbers/pages, repeated/cyclic/terminal cursors and later-page failures never return partial recovery results");

for (const response of [
  { data: { repository: null } },
  { data: { repository: { ...repository(), name: "wrong" } } },
  { data: { repository: { ...repository(), pullRequest: null } } },
  { data: { repository: repository() } },
  { ...read(raw()), errors: [{ message: "partial data" }] },
]) await rejected(() => getPullRequest(scope, 7), [response], ["get"]);
for (const response of [
  { data: {} },
  { data: { repository: null } },
  { data: { repository: { ...repository(), id: undefined } } },
  { data: { repository: { ...repository(), name: "wrong" } } },
]) await rejected(() => createPullRequest(scope, title, body), [response], ["repository"]);
for (const response of [
  { data: {} },
  { data: { createPullRequest: null } },
  created(null), created(raw(7, "CLOSED")), created(raw(7, "MERGED", true)),
  { ...created(raw()), errors: [{ message: "ambiguous create" }] },
  { __raw: "{" },
]) await rejected(() => createPullRequest(scope, title, body), [lookup(), response], ["repository", "create"]);
pass("known reads reject disappearance; creation validates repository before writing and never replays an ambiguous acknowledgement");

for (const invalid of [
  { ...scope, owner: "" }, { ...scope, repo: " " },
  { ...scope, owner: "owner/other" }, { ...scope, repo: "repo\\other" },
  { ...scope, head: "fork-owner:task/issue-7" },
  { ...scope, base: "other:main" }, { ...scope, head: "bad\nbranch" },
  { ...scope, head: scope.base },
]) {
  await rejected(() => findPullRequests(invalid), [], []);
  await rejected(() => getPullRequest(invalid, 7), [], []);
  await rejected(() => createPullRequest(invalid, title, body), [], []);
}
for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
  await rejected(() => getPullRequest(scope, number), [], []);
await rejected(() => createPullRequest(scope, " ", body), [], []);
await rejected(() => createPullRequest(scope, title, null as unknown as string), [], []);
pass("invalid scope, cross-repository head syntax, PR numbers and creation inputs issue zero commands");

const forbidden = { __error: "HTTP 403: Resource not accessible by integration" };
for (const [operation, responses, expected] of [
  [() => findPullRequests(scope), [forbidden], ["find"]],
  [() => getPullRequest(scope, 7), [forbidden], ["get"]],
  [() => createPullRequest(scope, title, body), [forbidden], ["repository"]],
  [() => createPullRequest(scope, title, body), [lookup(), forbidden], ["repository", "create"]],
] as const) {
  await rejected(operation, [...responses], [...expected], /HTTP 403/);
}
await rejected(() => findPullRequests(scope), [{ __raw: "not JSON" }], ["find"], /invalid JSON/);
await rejected(() => getPullRequest(scope, 7), [{ __raw: "not JSON" }], ["get"], /invalid JSON/);
pass("403 and invalid JSON propagate from the real gh process/JSON adapter with no fallback or retry");

// Exercise the production deadline and Windows containment, not a fake timer or
// replaced process adapter. A timed-out create may already exist: do not replay.
reset([lookup(), { __hang: true }]);
await assert.rejects(createPullRequest(scope, title, body), (error: unknown) =>
  error instanceof ProcessTimeoutError && error.timeoutMs === GIT_GH_TIMEOUT_MS);
verifyCalls(["repository", "create"]);
pass("a timed-out create uses the production process deadline and is never blindly retried");
assert.ok(captured.length > 0);
pass(`${captured.length} captured commands are exclusively PR observations/repository lookup or single create mutations; no merge, auto-merge, admin, close/reopen or Issue operations`);
