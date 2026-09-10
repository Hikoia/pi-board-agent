import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { listIssueComments, listPrComments } from "../src/gh.js";

const check = (condition: boolean, label: string) => {
  assert.ok(condition, label);
  console.log(`PASS: ${label}`);
};
const previousCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "board-gh-comments-"));
const bin = join(root, "bin");
const statePath = join(root, "gh-state.json");
const responsePath = join(root, "responses.json");
mkdirSync(bin);
process.on("exit", () => { process.chdir(previousCwd); rmSync(root, { recursive: true, force: true }); });
for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete process.env[name];
process.env.GH_CONFIG_DIR = join(root, "gh-config");
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
process.stdout.write(JSON.stringify(response));
`;
if (process.platform === "win32") {
  copyFileSync(process.execPath, join(bin, "gh.exe"));
  writeFileSync(join(root, "api"), mock);
  process.chdir(root);
} else {
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\n${mock}`);
  chmodSync(join(bin, "gh"), 0o755);
}
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
const calls = () => (JSON.parse(readFileSync(statePath, "utf8")) as { calls: string[][] }).calls;
const resetMock = (responses: unknown[]) => {
  writeFileSync(statePath, JSON.stringify({ calls: [] }));
  writeFileSync(responsePath, JSON.stringify(responses));
};
const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  data: { repository: { issue: { comments: { nodes, pageInfo: { hasNextPage, endCursor } } } } },
});
const comment = (id: string, second: number, authorAssociation = "MEMBER") => ({
  id, body: `comment ${id}`, createdAt: new Date(second * 1000).toISOString(),
  authorAssociation, author: { login: "maintainer" },
});

resetMock([
  page([comment("later", 3)], true, "CURSOR_1"),
  page([comment("middle", 2, "COLLABORATOR"), comment("earlier", 1, "OWNER")], false, null),
]);
const comments = await listIssueComments("owner", "repo", 79);
const query = calls()[0].find((arg) => arg.startsWith("query=")) ?? "";
check(query.includes("comments(first: 100, after: $after)") && query.includes("pageInfo { hasNextPage endCursor }"),
  "issue comment query requests 100 comments and GraphQL pageInfo");
check(calls().length === 2 && calls()[1].includes("after=CURSOR_1"), "the second comment query receives the first page cursor");
check(comments.map((item) => item.id).join(",") === "earlier,middle,later", "comments from every page are returned oldest-first");
check(query.includes("authorAssociation") && comments[0].authorAssociation === "OWNER" && comments[1].authorAssociation === "COLLABORATOR",
  "comment author associations are requested and retained across pages");

for (const [number, responses, label] of [
  [80, [page([], true, "CURSOR_LOOP"), page([], true, "CURSOR_LOOP")], "repeated"],
  [81, [page([], true, null)], "missing"],
  [82, [page([], true, "A"), page([], true, "B"), page([], true, "A")], "cyclic"],
] as const) {
  resetMock([...responses]);
  await assert.rejects(listIssueComments("owner", "repo", number), new RegExp(`owner/repo#${number}.*missing or repeated cursor`));
  check(calls().length === responses.length, `a ${label} pagination cursor fails explicitly without retry`);
}
for (const response of [
  { data: { repository: { issue: null } } },
  { data: { repository: { issue: { comments: { nodes: [] } } } } },
  page([null], false, null),
  page([comment("same", 1), comment("same", 2)], false, null),
  { data: null },
  { data: { repository: null }, errors: [{ message: "permission denied" }] },
]) {
  resetMock([response]);
  await assert.rejects(listIssueComments("owner", "repo", 83));
  check(calls().length === 1, "ambiguous/partial issue comment data is not an empty thread or a retry");
}

const restPage = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
  id: start + index, body: "@board-bot clarify", created_at: new Date((start + index) * 1000).toISOString(),
  user: { login: "maintainer" }, author_association: "COLLABORATOR",
}));
resetMock([[restPage(1, 100), restPage(101, 100), restPage(201, 1)]]);
const prs = await listPrComments("origin-owner", "repo", 7);
check(calls()[0].includes("--paginate") && calls()[0].includes("--slurp") && calls()[0].some((arg) => arg.includes("repos/origin-owner/repo/issues/7/comments?per_page=100")),
  "PR mentions delegate every REST Link page to gh with per_page=100 and slurp");
check(prs.length === 201 && prs.at(-1)?.id === "201" && prs.at(-1)?.authorAssociation === "COLLABORATOR",
  "PR mention #201 and its trust metadata survive full REST pagination");
for (const response of [[], [{}], { message: "denied" }, [[{ id: 1 }]], [restPage(1, 1), restPage(1, 1)]]) {
  resetMock([response]);
  await assert.rejects(listPrComments("owner", "repo", 7));
  check(calls().length === 1, "malformed or duplicate REST comments fail closed without replay bootstrap");
}
