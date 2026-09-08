/// <reference types="node" />
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { listIssueComments } from "../src/gh.js";

const check = (condition: boolean, label: string) => console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);
const root = process.env.TMP_DIR!;
const bin = join(root, "bin");
const statePath = join(root, "gh-state.json");
mkdirSync(bin, { recursive: true });

const mock = `
const fs = require("node:fs");
const statePath = process.env.MOCK_GH_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { calls: [] };
const responses = JSON.parse(process.env.MOCK_GH_RESPONSES);
state.calls.push(process.argv.slice(2));
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(responses[Math.min(state.calls.length - 1, responses.length - 1)]));
`;
if (process.platform === "win32") {
  copyFileSync(process.execPath, join(bin, "gh.exe"));
  writeFileSync(join(root, "api"), mock);
  process.chdir(root);
} else {
  const executable = join(bin, "gh");
  writeFileSync(executable, `#!/usr/bin/env node\n${mock}`);
  chmodSync(executable, 0o755);
}

process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.MOCK_GH_STATE = statePath;

const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  data: {
    repository: {
      issue: {
        comments: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  },
});
const resetMock = (responses: unknown[]) => {
  writeFileSync(statePath, JSON.stringify({ calls: [] }));
  process.env.MOCK_GH_RESPONSES = JSON.stringify(responses);
};

resetMock([
  page([
    { id: "later", body: "third", createdAt: "2026-09-02T18:02:00Z", authorAssociation: "MEMBER", author: { login: "maintainer" } },
  ], true, "CURSOR_1"),
  page([
    { id: "middle", body: "second", createdAt: "2026-09-02T18:01:00Z", authorAssociation: "COLLABORATOR", author: { login: "collaborator" } },
    { id: "earlier", body: "first", createdAt: "2026-09-02T18:00:00Z", authorAssociation: "OWNER", author: { login: "owner" } },
  ], false, null),
]);
const comments = await listIssueComments("owner", "repo", 79);
const calls = (JSON.parse(readFileSync(statePath, "utf8")) as { calls: string[][] }).calls;
const query = calls[0].find((arg) => arg.startsWith("query=")) ?? "";
check(
  query.includes("comments(first: 100, after: $after)") && query.includes("pageInfo { hasNextPage endCursor }"),
  "issue comment query requests 100 comments and GraphQL pageInfo",
);
check(calls.length === 2 && calls[1].includes("after=CURSOR_1"), "the second comment query receives the first page cursor");
check(comments.map((item) => item.id).join(",") === "earlier,middle,later", "comments from every page are returned oldest-first");

resetMock([
  page([], true, "CURSOR_LOOP"),
  page([], true, "CURSOR_LOOP"),
]);
let repeatedError = "";
try {
  await listIssueComments("owner", "repo", 80);
} catch (error) {
  repeatedError = error instanceof Error ? error.message : String(error);
}
check(repeatedError.includes("missing or repeated cursor") && repeatedError.includes("owner/repo#80"), "a repeated pagination cursor fails explicitly");

resetMock([page([], true, null)]);
let missingError = "";
try {
  await listIssueComments("owner", "repo", 81);
} catch (error) {
  missingError = error instanceof Error ? error.message : String(error);
}
check(missingError.includes("missing or repeated cursor") && missingError.includes("owner/repo#81"), "a missing pagination cursor fails explicitly");
