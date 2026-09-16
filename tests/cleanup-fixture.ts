// Public TicketWorktrees/loop seams, real disposable Git, filesystem/process faults only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import type { BuilderTask } from "../src/workflow-prompt.js";
import {
  runProcess,
  runProcessSync,
  type ProcessCommand,
  type ProcessOptions,
} from "../src/process-runner.js";

export const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export const calls: string[][] = [];

export const faults: {
  beforeGit?: (args: string[], options: ProcessOptions) => void | Promise<void>;
  afterGit?: (args: string[], options: ProcessOptions) => void | Promise<void>;
  beforeSyncFs?: (operation: string, path: string, ...args: any[]) => void;
  beforeFs?: (operation: string, path: string) => void | Promise<void>;
  afterFs?: (operation: string, path: string) => void | Promise<void>;
} = {};
const globals = globalThis as any;
globals.__cleanupSyncFs = (op: "unlinkSync" | "renameSync", path: string, ...args: any[]) => {
  faults.beforeSyncFs?.(op, String(path), ...args);
  return (syncFs[op] as any)(path, ...args);
};
globals.__cleanupFs = async (
  operation: "unlink" | "link" | "open" | "readdir" | "readlink",
  path: string,
  ...args: any[]
) => {
  await faults.beforeFs?.(operation, String(path));
  const result = await (fs[operation] as any)(path, ...args);
  await faults.afterFs?.(operation, String(path));
  return result;
};
globals.__cleanupGit = (
  mode: "sync" | "async",
  command: ProcessCommand,
  args: string[],
  options: ProcessOptions = {},
) => {
  calls.push(args);
  assert.ok(
    !(args[0] === "worktree" && ["prune", "unlock"].includes(args[1])),
    "never prune/unlock",
  );
  assert.ok(
    !(
      args[0] === "worktree" &&
      args[1] === "remove" &&
      args.includes("--force")
    ),
    "normal remove only",
  );
  if (mode === "sync") return runProcessSync(command, args, options);
  return (async () => {
    await faults.beforeGit?.(args, options);
    const result = await runProcess(command, args, options);
    await faults.afterGit?.(args, options);
    return result;
  })();
};
const worktreeUrl = new URL("../src/ticket-worktree.ts", import.meta.url).href;
const runnerUrl = new URL("../src/process-runner.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === worktreeUrl && specifier === "node:fs")
      return { url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs';
        export const unlinkSync = (...args) => globalThis.__cleanupSyncFs('unlinkSync', ...args);
        export const renameSync = (...args) => globalThis.__cleanupSyncFs('renameSync', ...args);`)}`, shortCircuit: true };
    if (
      context.parentURL === worktreeUrl &&
      specifier === "./process-runner.js"
    )
      return {
        url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(runnerUrl)};
      export const runProcess = (...args) => globalThis.__cleanupGit('async', ...args);
      export const runProcessSync = (...args) => globalThis.__cleanupGit('sync', ...args);`)}`,
        shortCircuit: true,
      };
    if (
      [
        worktreeUrl,
        new URL("../src/cleanup-snapshot.ts", import.meta.url).href,
      ].includes(context.parentURL!) &&
      specifier === "node:fs/promises"
    )
      return {
        url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs/promises';
      export const unlink = (...args) => globalThis.__cleanupFs('unlink', ...args);
      export const link = (...args) => globalThis.__cleanupFs('link', ...args);
      export const open = (...args) => globalThis.__cleanupFs('open', ...args);
      export const readdir = (...args) => globalThis.__cleanupFs('readdir', ...args);
      export const readlink = (...args) => globalThis.__cleanupFs('readlink', ...args);`)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
export const { TicketWorktrees } = await import("../src/ticket-worktree.js");
let sequence = 0;
export async function fixture(lockfiles = false, current = false) {
  const dir = join(root, `case-${++sequence}`),
    repo = join(dir, "repo"),
    origin = join(dir, "origin.git");
  mkdirSync(repo, { recursive: true });
  git(dir, "init", "--bare", origin);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Offline");
  git(repo, "config", "user.email", "offline@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), ".pi/\nignored/\nnode_modules/\n");
  if (lockfiles) {
    writeFileSync(join(repo, "Cargo.lock"), "version = 4\n");
    writeFileSync(join(repo, "locked"), "ordinary tracked file\n");
  }
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  const task: BuilderTask = {
    itemId: `ITEM_${sequence}`,
    issueNumber: sequence,
    taskKey: `T${sequence}`,
    title: "Accepted",
    body: "acceptance",
    taskBranch: `task/issue-${sequence}`,
    baseBranch: "main",
  };
  const store = new TicketWorktrees(repo),
    record = { ...await store.ensure(task, "demo"), schemaVersion: current ? 4 as const : 3 as const };
  // Historical cleanup/receipt tests intentionally exercise the legacy finalizer.
  // New ensure/admission now produces v4; do not accidentally migrate this fixture.
  writeFileSync(store.recordPath(task.itemId), JSON.stringify(record, null, 2));
  writeFileSync(join(record.path, "feature.txt"), "feature\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "feature");
  git(record.path, "push", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  if (current) store.setReviewedTaskSha(task.itemId, taskSha);
  const admin = git(record.path, "rev-parse", "--absolute-git-dir");
  mkdirSync(join(record.path, "ignored", "empty"), { recursive: true });
  writeFileSync(
    join(record.path, "ignored", "cache.bin"),
    Buffer.from([0, 1, 2, 255]),
  );
  if (lockfiles) {
    mkdirSync(join(record.path, "node_modules", "uri-js"), { recursive: true });
    writeFileSync(
      join(record.path, "node_modules", "uri-js", "yarn.lock"),
      "# tiny ignored dependency lockfile\n",
    );
  }
  const receipt = join(
    repo,
    ".pi",
    "board-agent",
    "cleanup",
    `item_${sequence}.json`,
  );
  const recordFile = join(
    repo,
    ".pi",
    "board-agent",
    "ticket-worktrees",
    `item_${sequence}.json`,
  );
  const tip = () => git(origin, "rev-parse", "refs/heads/main");
  const finish = async (strategy: "merge" | "squash" = "merge") => {
    const result = await store.finalizeAccepted(task, strategy);
    if (result) await store.completeFinalization(task, result, async () => {});
    return result;
  };
  const vanish = () => {
    unlinkSync(join(record.path, ".git"));
    rmSync(admin, { recursive: true });
  };
  return {
    repo,
    origin,
    base,
    task,
    store,
    record,
    taskSha,
    admin,
    receipt,
    recordFile,
    tip,
    finish,
    vanish,
  };
}

export function legacy(
  f: Awaited<ReturnType<typeof fixture>>,
  strategy: "merge" | "squash",
  journal: "none" | "intent" | "result",
) {
  const result = git(
    f.repo,
    "commit-tree",
    `${f.taskSha}^{tree}`,
    "-p",
    f.base,
    ...(strategy === "merge" ? ["-p", f.taskSha] : []),
    "-m",
    "previously integrated",
  );
  git(f.repo, "push", "origin", `${result}:refs/heads/main`);
  if (journal !== "none")
    f.store.update(f.task.itemId, (record) => ({
      ...record,
      finalization: {
        targetBranch: "main",
        baseSha: f.base,
        taskSha: f.taskSha,
        ...(journal === "result" ? { resultSha: result } : {}),
      },
    }));
  f.vanish();
  return result;
}

export function dispose() {
  faults.beforeGit = faults.afterGit = faults.beforeFs = faults.afterFs = faults.beforeSyncFs = undefined;
  hooks.deregister();
  delete globals.__cleanupSyncFs;
  delete globals.__cleanupGit;
  delete globals.__cleanupFs;
}
