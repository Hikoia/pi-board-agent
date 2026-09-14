// Public worktree/review operations; wrap only the process boundary, never Git state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import {
  GIT_GH_TIMEOUT_MS,
  ProcessTimeoutError,
  runProcess,
  runProcessSync,
  type ProcessCommand,
  type ProcessOptions,
} from "../src/process-runner.js";
import type { BuilderTask } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const repo = join(root, "repo"),
  origin = join(root, "origin.git");
mkdirSync(repo);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), ".pi/\n");
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "base");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");
const task: BuilderTask = {
  itemId: "ASYNC",
  taskKey: "T001",
  issueNumber: 1,
  title: "Async Git",
  body: "Acceptance",
  baseBranch: "main",
  taskBranch: "task/issue-1",
};
const observations: Array<{
  label: string;
  mode: string;
  timer: Promise<boolean>;
}> = [];
let pending = 0;
let fault:
  | { source: string; command: string; kind: "timeout" | "exit" }
  | undefined;
const globals = globalThis as any;
const worktreeUrl = new URL("../src/ticket-worktree.ts", import.meta.url).href;
const reviewUrl = new URL("../src/review.ts", import.meta.url).href;
const runnerUrl = new URL("../src/process-runner.ts", import.meta.url).href;
const slow = (args: string[]) =>
  ["fetch", "push", "ls-remote"].includes(args[0]) ||
  (args[0] === "worktree" && ["add", "remove"].includes(args[1]));
function observed(
  source: string,
  mode: "async" | "sync",
  command: ProcessCommand,
  args: string[],
  options: ProcessOptions = {},
) {
  assert.equal(
    pending,
    0,
    "each Git command must settle before the next command (including cleanup)",
  );
  assert.equal(command, "git");
  assert.deepEqual(
    options.env,
    source === "review"
      ? { GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" }
      : { GIT_NO_REPLACE_OBJECTS: "1" },
  );
  assert.equal(
    options.timeoutMs,
    source === "review" ? undefined : GIT_GH_TIMEOUT_MS,
  );
  assert.equal(
    "signal" in options,
    false,
    "cleanup/finalization must not inherit loop abort",
  );
  if (
    fault?.source === source &&
    fault.command === args.slice(0, fault.command.split(" ").length).join(" ")
  ) {
    const kind = fault.kind;
    fault = undefined; // Fail only this command; normal cleanup still uses real Git.
    assert.equal(mode, "async");
    return runProcess(
      "node",
      [
        "-e",
        kind === "timeout"
          ? "setInterval(() => {}, 1000)"
          : "process.stderr.write('controlled runner failure'); process.exit(23)",
      ],
      {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: 2_000,
      },
    );
  }
  const actual = () =>
    mode === "async"
      ? runProcess(command, args, options)
      : runProcessSync(command, args, options);
  if (!slow(args)) {
    if (mode === "sync") return actual();
    pending++;
    return (async () => {
      try {
        return await actual();
      } finally {
        pending--;
      }
    })();
  }

  const done = join(root, `command-${observations.length}.done`);
  // Compare event order, NOT absolute latency: the child marks actual completion.
  const timer = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(!existsSync(done)), 0),
  );
  observations.push({
    label: `${source}: ${args.slice(0, 2).join(" ")}`,
    mode,
    timer,
  });
  const script = [
    "-e",
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(done)}, 'done'), 150)`,
  ];
  const childOptions = { cwd: options.cwd, env: options.env, timeoutMs: 5_000 };
  if (mode === "sync") {
    const result = runProcessSync("node", script, childOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    return actual();
  }
  pending++;
  return (async () => {
    try {
      const result = await runProcess("node", script, childOptions);
      assert.equal(result.ok, true, JSON.stringify(result));
      return await actual();
    } finally {
      pending--;
    }
  })();
}
globals.__asyncGit = observed;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const source =
      context.parentURL === worktreeUrl
        ? "worktree"
        : context.parentURL === reviewUrl
          ? "review"
          : undefined;
    if (source && specifier === "./process-runner.js")
      return {
        url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(runnerUrl)};
      export const runProcess = (...args) => globalThis.__asyncGit(${JSON.stringify(source)}, 'async', ...args);
      export const runProcessSync = (...args) => globalThis.__asyncGit(${JSON.stringify(source)}, 'sync', ...args);`)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
async function responsive(from: number) {
  const calls = observations.slice(from);
  assert.ok(calls.length, "operation must exercise the process boundary");
  for (const call of calls) {
    assert.equal(
      await call.timer,
      true,
      `${call.label}: timer must fire before controlled subprocess completion`,
    );
    assert.equal(
      call.mode,
      "async",
      `${call.label}: uses the existing async runner`,
    );
  }
  assert.equal(pending, 0);
}
try {
  const { TicketWorktrees } = await import("../src/ticket-worktree.js");
  const store = new TicketWorktrees(repo);
  const record = await store.ensure(task, "demo");
  assert.equal(record.itemId, task.itemId);
  assert.equal(store.check(record).ok, true);
  await responsive(0);
  console.log(
    "PASS: ensure fetch/ls-remote/worktree add yield to a timer before subprocess completion and preserve runner options",
  );

  let from = observations.length;
  assert.equal(await store.hasTaskDelta(record), false);
  await responsive(from);
  writeFileSync(join(record.path, "feature.txt"), "feature\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "feature");
  git(record.path, "push", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  from = observations.length;
  assert.equal(await store.hasTaskDelta(record), true);
  await responsive(from);
  console.log(
    "PASS: hasTaskDelta awaits fresh fetch and distinguishes an unchanged branch from local work",
  );

  fault = { source: "worktree", command: "fetch", kind: "exit" };
  await assert.rejects(
    store.hasTaskDelta(record),
    /git fetch failed: controlled runner failure/,
    "failed observation must preserve retryable launch evidence, not settle as either delta result",
  );
  fault = { source: "worktree", command: "fetch", kind: "timeout" };
  const otherTask = {
    ...task,
    itemId: "OTHER",
    issueNumber: 2,
    taskBranch: "task/issue-2",
  };
  await assert.rejects(store.ensure(otherTask, "demo"), (error: unknown) => {
    assert.ok(error instanceof ProcessTimeoutError);
    assert.equal(error.timeoutMs, GIT_GH_TIMEOUT_MS);
    assert.match(error.command, /^git fetch /);
    return true;
  });
  assert.equal(store.has(otherTask.itemId), false);
  assert.equal(store.localBranchSha(otherTask.taskBranch), undefined);
  console.log(
    "PASS: real runner timeout remains typed/observable and failed delta fetch propagates without authorizing settlement",
  );

  from = observations.length;
  const { runReview } = await import("../src/review.js");
  const review = await runReview(
    {
      ...task,
      cwd: repo,
      model: "never-called",
      timeoutMs: 5_000,
    },
    async (_source, { cwd }) => {
      assert.equal(git(cwd, "rev-parse", "HEAD"), taskSha);
      return { result: { verdict: "pass", summary: "offline", findings: [] } };
    },
  );
  assert.equal(review.taskSha, taskSha);
  await responsive(from);
  assert.equal(
    git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/board-agent/reviews/",
    ),
    "",
  );
  console.log(
    "PASS: review fetch/add/remove yield through setup and awaited cleanup without changing exact-SHA review",
  );

  fault = { source: "review", command: "fetch", kind: "exit" };
  await assert.rejects(
    runReview(
      { ...task, cwd: repo, model: "never-called", timeoutMs: 5_000 },
      async () => {
        assert.fail("failed fetch must not invoke a reviewer");
      },
    ),
    /git fetch .*failed: controlled runner failure/,
  );
  const controller = new AbortController();
  fault = { source: "review", command: "worktree remove", kind: "exit" };
  await assert.rejects(
    runReview(
      {
        ...task,
        cwd: repo,
        model: "never-called",
        timeoutMs: 5_000,
        signal: controller.signal,
      },
      async (_source, { signal }) => {
        assert.equal(signal, controller.signal);
        controller.abort(); // Abort model work, never Git cleanup.
        throw new Error("controlled reviewer abort");
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /controlled reviewer abort/);
      assert.match(error.message, /cleanup failed:.*controlled runner failure/);
      return true;
    },
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").includes("review-"),
    false,
  );
  assert.equal(
    git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/board-agent/reviews/",
    ),
    "",
  );
  console.log(
    "PASS: rejected async review setup/cleanup stays observable, aggregates errors, and still cleans after model abort",
  );

  const baseSha = git(repo, "rev-parse", "origin/main");
  fault = { source: "worktree", command: "push", kind: "exit" };
  await assert.rejects(
    store.finalizeAccepted(task, "merge"),
    /git push .*failed: controlled runner failure/,
  );
  assert.equal(
    git(repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0],
    baseSha,
  );
  assert.equal(store.localBranchSha(task.taskBranch), taskSha);
  assert.equal(existsSync(record.path), true);
  assert.equal(store.has(task.itemId), true);
  console.log(
    "PASS: rejected async push preserves branch, worktree and retry evidence before cleanup",
  );

  fault = { source: "worktree", command: "ls-remote", kind: "exit" };
  await assert.rejects(
    store.finalizeAccepted(task, "merge"),
    /git ls-remote .*failed: controlled runner failure/,
  );
  assert.equal(store.localBranchSha(task.taskBranch), taskSha);
  assert.equal(existsSync(record.path), true);
  assert.equal(store.has(task.itemId), true);
  const published = git(repo, "rev-parse", "origin/main");
  assert.notEqual(published, baseSha);
  console.log(
    "PASS: non-absence ls-remote failure after push retains the local cleanup/retry signal",
  );

  from = observations.length;
  const resultSha = await store.finalizeAccepted(task, "merge");
  assert.equal(store.has(task.itemId), true, "Git cleanup retains record for Project settlement");
  await store.completeFinalization(task, async () => {});
  assert.equal(
    resultSha,
    published,
    "retry must not create another integration commit",
  );
  assert.equal(
    git(repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0],
    resultSha,
  );
  assert.equal(store.localBranchSha(task.taskBranch), undefined);
  assert.equal(existsSync(record.path), false);
  assert.equal(store.has(task.itemId), false);
  await responsive(from);
  console.log(
    "PASS: finalization fetch/push/ls-remote/remove yield and settle serially before deleting completion evidence",
  );
} finally {
  hooks.deregister();
  delete globals.__asyncGit;
}
