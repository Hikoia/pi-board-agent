// Explicit offline adapters. Only this test actor may simulate a human base merge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { acquireOwnerLock, ownerLockIsHeld, type OwnerLock } from "../src/owner-lock.js";
import type { PullRequestInfo, PullRequestScope } from "../src/gh.js";
import type { TicketExecutorDeps } from "../src/ticket-executor.js";
const owners = new Map<string, OwnerLock>();
export function testOwner(cwd: string): OwnerLock {
  assert.equal(process.env.PI_OFFLINE, "1");
  assert.equal(process.env.GIT_ALLOW_PROTOCOL, "file");
  const key = resolve(cwd), saved = owners.get(key);
  if (saved && ownerLockIsHeld(saved)) return saved;
  const owner = acquireOwnerLock(cwd, "bot"); owners.set(key, owner); return owner;
}
export const noPullRequests: TicketExecutorDeps["pullRequests"] = {
  findPullRequests: async () => { throw new Error("Unexpected offline PR lookup"); },
  createPullRequest: async () => { throw new Error("Unexpected offline PR create"); },
  getPullRequest: async () => { throw new Error("Unexpected offline PR read"); },
};
export function fakePullRequests(repo: string, autoMerge = false) {
  assert.equal(process.env.PI_OFFLINE, "1"); assert.equal(process.env.GIT_ALLOW_PROTOCOL, "file");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const prs: PullRequestInfo[] = [], calls: string[] = [];
  const hooks: { before?: (op: string) => void | Promise<void>; after?: (op: string) => void | Promise<void> } = {};
  function head(pr: PullRequestInfo) {
    if (!pr.merged) {
      const remote = git("ls-remote", "origin", `refs/heads/${pr.scope.head}`).split(/\s+/)[0];
      if (remote) pr.headSha = remote;
    }
    return pr;
  }
  function merge(pr = prs[0], squash = true) {
    head(pr);
    const base = git("ls-remote", "origin", `refs/heads/${pr.scope.base}`).split(/\s+/)[0];
    git("fetch", "--no-tags", "origin", base, pr.headSha);
    const tree = git("merge-tree", "--write-tree", base, pr.headSha);
    pr.mergeCommitSha = git("commit-tree", tree, "-p", base, ...(squash ? [] : ["-p", pr.headSha]), "-m", "Offline human merge");
    git("push", "origin", `${pr.mergeCommitSha}:refs/heads/${pr.scope.base}`, `${pr.headSha}:refs/pull/${pr.number}/head`);
    pr.state = "closed"; pr.merged = true;
    return pr.mergeCommitSha;
  }
  async function call<T>(op: string, fn: () => T): Promise<T> {
    calls.push(op); await hooks.before?.(op); const value = fn(); await hooks.after?.(op); return structuredClone(value);
  }
  const api: TicketExecutorDeps["pullRequests"] = {
    findPullRequests: (scope) => call("find", () => prs.filter((p) => JSON.stringify(p.scope) === JSON.stringify(scope)).map(head)),
    createPullRequest: (scope, _title, body) => call("create", () => {
      const pr: PullRequestInfo = { scope, body, number: prs.length + 1, url: `https://github.com/${scope.owner}/${scope.repo}/pull/${prs.length + 1}`,
        state: "open", merged: false, headSha: git("ls-remote", "origin", `refs/heads/${scope.head}`).split(/\s+/)[0], mergeCommitSha: null };
      prs.push(pr);
      if (autoMerge) merge(pr, false);
      return pr;
    }),
    getPullRequest: (scope: PullRequestScope, number: number) => call("get", () => {
      const pr = prs.find((p) => p.number === number);
      assert.ok(pr, "Offline PR not found"); return head(pr);
    }),
  };
  return { api, prs, calls, hooks, merge };
}
