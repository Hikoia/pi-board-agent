/// <reference types="node" />
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { listIssueComments } from "../src/gh.js";

const check = (condition: boolean, label: string) => console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);
const root = process.env.TMP_DIR!;
const bin = join(root, "bin");
const capture = join(root, "gh-args.json");
mkdirSync(bin, { recursive: true });

const mock = `
const fs = require("node:fs");
fs.writeFileSync(process.env.MOCK_GH_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.MOCK_GH_RESPONSE);
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
process.env.MOCK_GH_CAPTURE = capture;
process.env.MOCK_GH_RESPONSE = JSON.stringify({
  data: {
    repository: {
      issue: {
        comments: {
          nodes: [
            { id: "later", body: "second", createdAt: "2026-09-02T18:01:00Z", authorAssociation: "MEMBER", author: { login: "maintainer" } },
            { id: "earlier", body: "first", createdAt: "2026-09-02T18:00:00Z", authorAssociation: "OWNER", author: { login: "owner" } },
          ],
        },
      },
    },
  },
});

const comments = await listIssueComments("owner", "repo", 79);
const args = JSON.parse(readFileSync(capture, "utf8")) as string[];
const query = args.find((arg) => arg.startsWith("query=")) ?? "";
check(query.includes("comments(first: 50)") && !query.includes("orderBy") && !query.includes("CREATED_AT"), "issue comment query uses the supported GitHub connection shape");
check(comments.map((comment) => comment.id).join(",") === "earlier,later", "issue comments are sorted oldest-first after an unordered GraphQL response");
