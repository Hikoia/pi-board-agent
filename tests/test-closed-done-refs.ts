// Real loop/executor/store; observe only the process and GitHub boundaries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketBoardAdapter, TicketWorkflowManager } from "../src/ticket-executor.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";
import {
  GIT_GH_TIMEOUT_MS, runProcess, runProcessSync,
  type ProcessCommand, type ProcessOptions,
} from "../src/process-runner.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const calls: Array<{ mode: string; args: string[] }> = [];
const snapshots: string[] = [];
let afterRefs: (() => void | Promise<void>) | undefined;
let failRefs = false;
let slowRefs = false;
const refQueries = () => calls.filter((call) => call.args[0] === "for-each-ref").length;
const mutations = () => calls.filter((call) => ["fetch", "push", "merge-tree", "commit-tree", "update-ref"].includes(call.args[0]));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
function observed(mode: "async" | "sync", command: ProcessCommand, args: string[], options: ProcessOptions = {}) {
  assert.equal(command, "git");
  calls.push({ mode, args });
  if (args[0] === "for-each-ref") {
    assert.equal(mode, "async", "local ref snapshot must use the existing asynchronous runner");
    assert.equal(options.timeoutMs, GIT_GH_TIMEOUT_MS);
    assert.deepEqual(options.env, { GIT_NO_REPLACE_OBJECTS: "1" });
    assert.equal("signal" in options, false, "do not change Git containment/cancellation policy");
    return (async () => {
      if (slowRefs) {
        const done = join(root, "refs-child.done");
        const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(!existsSync(done)), 0));
        const delayed = await runProcess("node", ["-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(done)}, 'done'), 150)`], { cwd: options.cwd, timeoutMs: 5_000 });
        assert.equal(delayed.ok, true, JSON.stringify(delayed));
        assert.equal(await timer, true, "timer fires BEFORE subprocess completion, not an absolute latency budget");
      }
      const result = failRefs
        ? await runProcess("node", ["-e", "process.stderr.write('controlled refs failure'); process.exit(23)"], { cwd: options.cwd, timeoutMs: 5_000 })
        : await runProcess(command, args, options);
      snapshots.push(result.stdout);
      const after = afterRefs;
      afterRefs = undefined;
      await after?.();
      return result;
    })();
  }
  return mode === "async" ? runProcess(command, args, options) : runProcessSync(command, args, options);
}
const globals = globalThis as any;
globals.__closedDoneGit = observed;
const worktreeUrl = new URL("../src/ticket-worktree.ts", import.meta.url).href;
const runnerUrl = new URL("../src/process-runner.ts", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === worktreeUrl && specifier === "./process-runner.js") return {
    url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(runnerUrl)};
      export const runProcess = (...args) => globalThis.__closedDoneGit('async', ...args);
      export const runProcessSync = (...args) => globalThis.__closedDoneGit('sync', ...args);`)}`,
    shortCircuit: true,
  };
  return next(specifier, context);
} });
try {
  const { BoardLoop, createLoopState } = await import("../src/loop.js");
  const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
  const { TicketWorktrees } = await import("../src/ticket-worktree.js");
  let sequence = 0;
  function fixture(numbers: number[], prefix = "task/", createManager: () => TicketWorkflowManager = () => { throw new Error("unexpected model manager"); }) {
    const dir = join(root, `case-${++sequence}`), repo = join(dir, "repo"), origin = join(dir, "origin.git");
    mkdirSync(repo, { recursive: true });
    git(dir, "init", "--bare", origin); git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Offline"); git(repo, "config", "user.email", "offline@example.test");
    writeFileSync(join(repo, ".gitignore"), ".pi/\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
    const base = git(repo, "rev-parse", "HEAD");
    const cfg = structuredClone(_DEFAULTS);
    cfg.context.enabled = cfg.refine.enabled = cfg.review.enabled = cfg.watchdog.enabled = cfg.telegram.enabled = false;
    cfg.branches.task_prefix = prefix;
    cfg.task_merge_strategy = "merge";
    const cards: Card[] = numbers.map((number) => ({
      itemId: `ITEM_${number}`, number, contentType: "Issue", type: "Task", title: `Task ${number}`, body: "Acceptance",
      repoOwner: "owner", repoName: "repo", closed: true, status: cfg.columns.done, assignees: [],
    }));
    const reads: string[] = [], notices: Array<{ message: string; level: string }> = [];
    const callback = (message: string, level = "info") => { notices.push({ message, level }); };
    const board: TicketBoardAdapter = {
      getCard: async (id: string): Promise<Card | undefined> => { reads.push(id); return structuredClone(cards.find((card) => card.itemId === id)); },
      claim: async () => { assert.fail("unexpected claim"); },
      release: async () => { assert.fail("unexpected release"); },
      setStatus: async () => { assert.fail("unexpected status write"); },
      comment: async () => { assert.fail("unexpected comment"); },
      listComments: async (): Promise<string[]> => { assert.fail("unexpected comments read"); },
    };
    const store = new TicketWorktrees(repo);
    const executor = new ManagedTicketExecutor({ cwd: repo, cfg, worktrees: store, board, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback,
      createManager,
    });
    const state = createLoopState();
    let revisionChecks = 0;
    const loop = new BoardLoop({ cwd: repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, callback, listCards: async () => structuredClone(cards),
      revisionCheck: async () => { revisionChecks++; return { ok: true }; },
    }, state, executor, store);
    const branch = (number: number) => `${prefix}issue-${number}`;
    const addBranch = (number: number) => {
      const sha = git(repo, "commit-tree", `${base}^{tree}`, "-p", base, "-m", `accepted task ${number}`);
      git(repo, "update-ref", `refs/heads/${branch(number)}`, sha);
      return sha;
    };
    const tip = () => git(origin, "rev-parse", "refs/heads/main");
    return { repo, origin, base, cfg, cards, reads, notices, board, store, executor, state, loop, branch, addBranch, tip, revisionChecks: () => revisionChecks };
  }

  {
    const f = fixture(Array.from({ length: 100 }, (_, i) => i + 1));
    calls.length = 0;
    slowRefs = true;
    try {
      assert.deepEqual(f.store.list(), []);
      await f.loop.tickNow();
      assert.equal(f.reads.length, 0, "100 historical no-branch/no-record cards must not reach finalizer getCard");
      assert.equal(refQueries(), 1, "one local refs query per tick, not per card");
      assert.equal(calls.length, 1, "no per-card Git probes for historical cards");
      assert.deepEqual(f.notices, []);
      assert.equal(f.state.tickCount, 1);
      slowRefs = false;
      await f.loop.tickNow();
      assert.equal(f.reads.length, 0);
      assert.equal(refQueries(), 2, "refs are refreshed once on each tick, not cached indefinitely");
      assert.deepEqual(f.store.list(), [], "no completed-ticket records are added");
      console.log("PASS: 100 historical no-branch/no-record closed-Done Tasks use one responsive async refs query per tick and zero finalizer getCard calls");
    } finally { slowRefs = false; await f.loop.stop(); }
  }

  {
    const f = fixture([1, 2, 3, 4, 5, 6]);
    Object.assign(f.cards[0], { closed: false });
    Object.assign(f.cards[1], { status: f.cfg.columns.ready });
    Object.assign(f.cards[2], { type: "Story" });
    Object.assign(f.cards[3], { contentType: "PullRequest" });
    Object.assign(f.cards[4], { repoOwner: "other" });
    Object.assign(f.cards[5], { number: undefined });
    calls.length = 0;
    try {
      await f.loop.tickNow();
      assert.equal(refQueries(), 0, "no query unless closed-Done target Task candidates exist");
      assert.deepEqual(f.reads, []);
      console.log("PASS: no closed-Done target Task candidates means no refs query or finalizer reads");
    } finally { await f.loop.stop(); }
  }

  for (const prefix of ["task/", "ops/task-"]) {
    const f = fixture([1, 2, 3, 4, 5, 42, 7], prefix);
    const accepted = f.addBranch(7);
    for (const name of [`${prefix}issue-1-extra`, `${prefix}issue-2/nested`, `other/${prefix}issue-3`, `${prefix}issue-420`])
      git(f.repo, "branch", name, f.base);
    for (const number of [4, 7]) git(f.repo, "tag", f.branch(number), f.base);
    git(f.repo, "update-ref", `refs/remotes/origin/${f.branch(5)}`, f.base);
    calls.length = 0;
    try {
      await f.loop.tickNow();
      assert.equal(refQueries(), 1);
      assert.deepEqual(f.reads, ["ITEM_7"], "only the complete local branch name qualifies; no suffix, prefix, tag or remote matches");
      assert.notEqual(f.tip(), f.base);
      assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${f.base} ${accepted}`);
      assert.equal(f.store.localBranchSha(f.branch(7)), undefined);
      assert.equal(git(f.repo, "rev-parse", `refs/tags/${f.branch(7)}`), f.base, "same-name tag stays untouched and cannot make branch short-name ambiguous");
      assert.equal(f.notices.filter((notice) => notice.message.startsWith("Finalized #7")).length, 1);
      assert.deepEqual(f.store.list(), [], "no Plan/record/review SHA is required to integrate a local branch");
      console.log(`PASS: ${prefix} full local branch identity alone passes the negative filter and then fresh finalization; similarly named refs never qualify`);
    } finally { await f.loop.stop(); }
  }

  for (const change of ["reopened", "status", "identity", "removed", "unreadable", "vanished"] as const) {
    const f = fixture([1]);
    const accepted = f.addBranch(1), read = f.board.getCard;
    f.board.getCard = async (id) => {
      const fresh = await read(id);
      if (change === "reopened") fresh!.closed = false;
      if (change === "status") fresh!.status = f.cfg.columns.ready;
      if (change === "identity") fresh!.number = 2;
      if (change === "removed") return undefined;
      if (change === "unreadable") throw new Error("fresh approval read unavailable");
      if (change === "vanished") git(f.repo, "update-ref", "-d", "refs/heads/task/issue-1", accepted);
      return fresh;
    };
    calls.length = 0;
    try {
      await f.loop.tickNow();
      assert.equal(refQueries(), 1);
      assert.match(snapshots.at(-1)!, /^refs\/heads\/task\/issue-1\r?\n?$/);
      assert.deepEqual(f.reads, ["ITEM_1"], "branch presence must still trigger a fresh GitHub read");
      assert.equal(f.tip(), f.base, "stale presence/approval cannot integrate");
      assert.equal(f.store.localBranchSha(f.branch(1)), change === "vanished" ? undefined : accepted);
      assert.deepEqual(mutations(), [], "no integration/cleanup Git after changed approval or vanished actual ref");
      assert.equal(f.notices.some((notice) => notice.message.startsWith("Finalized")), false);
      if (change === "unreadable") assert.ok(f.notices.some((notice) => notice.level === "warn" && notice.message.includes("fresh approval read unavailable")));
      console.log(`PASS: ${change} after refs snapshot is revalidated by the original finalizer, never integrated`);
    } finally { await f.loop.stop(); }
  }

  {
    const f = fixture([1]);
    const accepted = f.addBranch(1);
    calls.length = 0;
    failRefs = true;
    try {
      await f.loop.tickNow();
      assert.equal(refQueries(), 1);
      assert.deepEqual(f.reads, []);
      assert.deepEqual(mutations(), []);
      assert.equal(f.tip(), f.base);
      assert.equal(f.store.localBranchSha(f.branch(1)), accepted);
      assert.equal(f.state.tickCount, 1);
      assert.equal(f.revisionChecks(), 1, "failed refs blocks this lane, not the rest of the tick");
      assert.equal(f.notices.length, 1);
      assert.equal(f.notices[0].level, "warn");
      assert.match(f.notices[0].message, /finalization blocked.*refs.*controlled refs failure/i);
      failRefs = false;
      await f.loop.tickNow();
      assert.equal(refQueries(), 2);
      assert.deepEqual(f.reads, ["ITEM_1"]);
      assert.notEqual(f.tip(), f.base, "later healthy query can retry normally");
      console.log("PASS: refs query failure explicitly warns/blocks only finalization, preserves work, and retries next tick");
    } finally { failRefs = false; await f.loop.stop(); }
  }

  {
    const f = fixture([1]);
    calls.length = 0;
    afterRefs = () => { f.addBranch(1); };
    try {
      await f.loop.tickNow();
      assert.equal(refQueries(), 1);
      assert.equal(snapshots.at(-1), "", "branch was created after the actual Git snapshot");
      assert.deepEqual(f.reads, []);
      assert.equal(f.tip(), f.base);
      assert.ok(f.store.localBranchSha(f.branch(1)));
      await f.loop.tickNow();
      assert.equal(refQueries(), 2);
      assert.deepEqual(f.reads, ["ITEM_1"]);
      assert.notEqual(f.tip(), f.base);
      assert.equal(f.store.localBranchSha(f.branch(1)), undefined);
      console.log("PASS: a branch created after the refs snapshot is deferred only until the next tick");
    } finally { afterRefs = undefined; await f.loop.stop(); }
  }

  {
    const f = fixture([1]), entered = deferred(), finish = deferred();
    f.addBranch(1);
    afterRefs = async () => { entered.resolve(); await finish.promise; };
    const tick = f.loop.tickNow();
    let stopping: Promise<void> | undefined, stopped = false;
    try {
      await Promise.race([entered.promise, tick.then(() => { throw new Error("refs query was not reached"); })]);
      stopping = f.loop.stop().then(() => { stopped = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(stopped, false, "stop drains the awaited query");
      finish.resolve();
      await tick; await stopping;
      assert.deepEqual(f.reads, [], "no finalizer is scheduled after stop during refs query");
      assert.equal(f.tip(), f.base);
      assert.ok(f.store.localBranchSha(f.branch(1)));
      console.log("PASS: stop drains a pending async refs query without admitting a finalizer afterwards");
    } finally { finish.resolve(); afterRefs = undefined; await tick; await f.loop.stop(); }
  }

  {
    const f = fixture([1], "task/", () => ({
      start: () => { throw new Error("unexpected model start"); }, list: () => [], resume: async () => false,
      pauseAndWait: async () => {}, stopAndWait: async () => {}, dispose: () => {},
    }));
    const record = await f.store.ensure(buildTasksForWave(f.cfg, "demo", f.cards)[0], "demo");
    f.store.setActiveRun(record.itemId, "unsettled");
    git(f.repo, "worktree", "remove", record.path);
    git(f.repo, "update-ref", "-d", `refs/heads/${record.taskBranch}`);
    const before = f.store.read(record.itemId);
    let releases = 0;
    f.board.release = async () => { releases++; throw new Error("unsettled release failed"); };
    calls.length = 0;
    try {
      for (let tick = 1; tick <= 2; tick++) {
        await f.loop.tickNow();
        assert.equal(refQueries(), tick);
        assert.equal(f.reads.length, tick, "no-branch filter must NOT skip reconcile's fresh read of unsettled records");
        assert.equal(releases, tick, "unsettled release is retried, not silently completed");
        assert.deepEqual(f.store.read(record.itemId), before, "failed release retains exact recovery evidence");
      }
      assert.equal(f.tip(), f.base);
      console.log("PASS: no-branch unsettled records still get fresh reconcile reads/retries and retain recovery evidence");
    } finally { await f.loop.stop(); }
  }
} finally {
  hooks.deregister(); delete globals.__closedDoneGit;
}
