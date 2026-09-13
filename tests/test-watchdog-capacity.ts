// Real BoardLoop -> Watchdog -> runWorkflow (and CI Git isolation).
// Only remote board I/O and the model are fake; process containment is unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { WorkflowAgent } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { runProcess } from "../src/process-runner.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "--bare", join(cwd, "origin.git"));
git("init", "-b", "main");
git("config", "user.name", "Offline");
git("config", "user.email", "offline@example.test");
writeFileSync(join(cwd, ".gitignore"), ".pi/\norigin.git/\n");
writeFileSync(join(cwd, "README.md"), "base\n");
git("add", ".gitignore", "README.md");
git("commit", "-m", "fixture");
git("remote", "add", "origin", join(cwd, "origin.git"));
git("branch", "task/issue-7");
git("push", "origin", "main", "task/issue-7");
const sha = git("rev-parse", "HEAD");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
let mode: "reply" | "fix" = "reply";
let prNumbers = [7];
let onRead = () => {};
let beforeModel = () => {};
let onPost = () => {};
let afterPrepare = () => {};
let calls = 0, posts = 0;
let hold: Promise<void> = Promise.resolve();
const state = createLoopState();
const events: string[] = [];
const globals = globalThis as any;
globals.__watchdogCapacity = {
  listPrsWithLabel: async () => {
    assert.equal(state.foreground, null, "PR reads do not occupy a model slot");
    events.push("watchdog-read");
    return prNumbers.map((number) => ({ number, headRefName: "task/issue-7", headRefOid: sha, isCrossRepository: false, url: `offline:pr-${number}` }));
  },
  listPrComments: async () => {
    assert.equal(state.foreground, null, "comment reads do not occupy a model slot");
    onRead();
    return mode === "reply" ? [1, 2].map((n) => ({ id: `mention-${n}`, author: "owner", authorAssociation: "OWNER", body: "@bot explain", createdAt: `2025-01-0${n}` })) : [];
  },
  getCheckRuns: async () => {
    assert.equal(state.foreground, null, "CI observations do not occupy a model slot");
    onRead();
    return [{ name: "tests", status: "completed", conclusion: mode === "fix" ? "failure" : "success" }];
  },
  resolvePullRequestId: async () => "PR_7",
  createComment: async () => { posts++; onPost(); return "POST"; },
  runProcess: async (...args: Parameters<typeof runProcess>) => {
    assert.equal(state.foreground, null, "CI Git preparation/verification is not a model invocation");
    const result = await runProcess(...args);
    if (args[1]?.join(" ") === "rev-parse HEAD" && args[2]?.cwd?.includes("watchdog-")) afterPrepare();
    return result;
  },
};
const watch = new URL("../src/watchdog.ts", import.meta.url).href;
const shim = (path: string, names: string[]) => `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(new URL(path, watch).href)};
${names.map((name) => `export const ${name} = globalThis.__watchdogCapacity.${name};`).join("\n")}
`)}`;
const stubs: Record<string, string> = {
  "./gh.js": shim("gh.ts", ["listPrsWithLabel", "listPrComments", "getCheckRuns", "resolvePullRequestId", "createComment"]),
  "./process-runner.js": shim("process-runner.ts", ["runProcess"]),
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  return context.parentURL === watch && stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context);
} });
const original = WorkflowAgent.prototype.run;
WorkflowAgent.prototype.run = (async () => {
  calls++;
  beforeModel();
  await hold;
  return mode === "reply" ? { reply: "offline answer" } : { status: "failure" };
}) as typeof original;
const { WatchdogStateStore } = await import(watch) as typeof import("../src/watchdog.js");
const store = new WatchdogStateStore(cwd);
mkdirSync(join(cwd, ".pi", "worktrees"), { recursive: true });
const cleanFixFixture = () => {
  const dir = join(cwd, ".pi", "worktrees");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (name.startsWith("watchdog-")) git("worktree", "remove", join(dir, name));
};
function harness(builders: number) {
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = 2;
  cfg.safety.require_clean_worktree = cfg.context.enabled = cfg.refine.enabled = cfg.review.enabled = cfg.telegram.enabled = false;
  cfg.watchdog.enabled = true;
  cfg.watchdog.respond_to_mentions = mode === "reply";
  const cards: Card[] = Array.from({ length: Math.max(1, builders) }, (_, i) => ({
    itemId: `ITEM_${i + 1}`, contentType: "Issue", number: i + 1, type: "Task", title: "Task", body: "Acceptance", plan: "demo",
    repoOwner: "owner", repoName: "repo", closed: false, assignees: [], status: builders ? cfg.columns.ready : cfg.columns.backlog,
  }));
  let active = 0, revision = true;
  const loop = new BoardLoop({
    cwd, cfg, repoOwner: "owner", repoName: "repo", botLogin: "bot",
    meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, callback: () => {},
    listCards: async () => structuredClone(cards), revisionCheck: () => ({ ok: revision }),
  }, state, {
    reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
    activeCount: () => active,
    launch: async (c) => { active++; cards.find((card) => card.itemId === c.itemId)!.status = cfg.columns.building; events.push("builder"); return { status: "launched", runId: "run", worktree: cwd }; },
    finalizeClosed: async () => { throw new Error("unexpected finalization"); }, shutdown: async () => {},
  }, new TicketWorktrees(cwd));
  return { loop, setActive: (n: number) => { active = n; }, active: () => active, setRevision: (ok: boolean) => { revision = ok; } };
}
try {
  for (mode of ["reply", "fix"] as const) {
    calls = posts = 0;
    events.length = 0;
    store.update(7, { fixAttempts: 0, lastFixAtMs: undefined, needsHuman: false, lastSeenCommentId: "" });
    const h = harness(2);
    try {
      await h.loop.tickNow();
      assert.deepEqual(events.slice(0, 3), ["builder", "builder", "watchdog-read"], "watchdog is LAST and never reserves ahead of Ready builders");
      assert.equal(calls, 0, `${mode}: full shared capacity defers the watchdog model`);
      assert.equal(store.get(7).fixAttempts, 0, "deferral consumes no fix attempt");
      assert.equal(store.get(7).lastSeenCommentId, "", "deferred mention stays pending");
      assert.equal(state.foreground, null);
      assert.equal(readdirSync(join(cwd, ".pi", "worktrees")).filter((n) => n.startsWith("watchdog-")).length, 0, "capacity deferral leaves no empty CI worktree blocking retry");
      console.log(`PASS: ${mode} watchdog reads at full capacity but never reserves or invokes a model, consumes intent, or strands CI setup`);

      h.setActive(1);
      const entered = deferred(), finish = deferred();
      hold = finish.promise;
      beforeModel = () => {
        assert.equal(h.active() + 1, 2);
        assert.equal(state.foreground?.kind, "watchdog");
        entered.resolve();
      };
      // Capacity may change between two mentions; only the first may run now.
      onPost = () => { h.setActive(2); };
      const tick = h.loop.tickNow();
      try {
        await Promise.race([entered.promise, tick.then(() => { throw new Error(`${mode}: no model reached with free capacity`); })]);
        assert.equal(calls, 1);
      } finally { finish.resolve(); await tick; }
      assert.equal(calls, 1, "recheck free capacity before EACH invocation, not once per watchdog tick");
      assert.equal(state.foreground, null);
      assert.equal(store.get(7).fixAttempts, mode === "fix" ? 1 : 0);
      if (mode === "reply") assert.equal(store.get(7).lastSeenCommentId, "mention-1");
      console.log(`PASS: ${mode} uses one visible foreground model only while running and rechecks capacity before subsequent work`);
    } finally { hold = Promise.resolve(); beforeModel = onPost = () => {}; await h.loop.stop(); cleanFixFixture(); }
  }
  // The first PR's invocation grants no permission to run a later PR's model.
  mode = "fix";
  prNumbers = [7, 8];
  calls = 0;
  store.update(7, { fixAttempts: 0, lastFixAtMs: undefined });
  store.update(8, { fixAttempts: 0, lastFixAtMs: undefined });
  {
    const h = harness(0);
    let checks = 0;
    onRead = () => { if (++checks === 2) h.setActive(2); };
    try {
      await h.loop.tickNow();
      assert.equal(calls, 1);
      assert.equal(store.get(7).fixAttempts, 1);
      assert.equal(store.get(8).fixAttempts, 0);
      assert.equal(state.foreground, null);
      console.log("PASS: each PR fix rechecks actual capacity; an earlier invocation never admits a later full-pool model");
    } finally { prNumbers = [7]; onRead = () => {}; await h.loop.stop(); cleanFixFixture(); }
  }
  // A slot observed free before async CI setup can disappear before execute.
  mode = "fix";
  for (const change of ["full", "revision", "stop"] as const) {
    calls = 0;
    store.update(7, { fixAttempts: 0, lastFixAtMs: undefined });
    const h = harness(0);
    let stopping: Promise<void> | undefined;
    afterPrepare = () => {
      if (change === "full") h.setActive(2);
      else if (change === "revision") h.setRevision(false);
      else stopping = h.loop.stop();
    };
    try {
      await h.loop.tickNow();
      await stopping;
      assert.equal(calls, 0, `CI ${change} after Git setup must be checked at real invocation`);
      assert.equal(store.get(7).fixAttempts, 0);
      assert.equal(state.foreground, null);
      if (change === "revision") {
        h.setRevision(true);
        await h.loop.tickNow();
        assert.equal(calls, 0, "revision latch stays closed");
        assert.equal(h.loop.isAdmittingNewWork(), false);
      }
      console.log(`PASS: CI ${change} during async Git preparation prevents the actual model invocation`);
    } finally { afterPrepare = () => {}; await h.loop.stop(); cleanFixFixture(); }
  }
  mode = "reply";
  for (const change of ["revision", "stop"] as const) {
    calls = posts = 0;
    store.update(7, { lastSeenCommentId: "" });
    const h = harness(0);
    let stopping: Promise<void> | undefined;
    onRead = () => {
      if (change === "revision") h.setRevision(false);
      else stopping = h.loop.stop();
    };
    try {
      await h.loop.tickNow();
      await stopping;
      assert.equal(calls + posts, 0);
      assert.equal(store.get(7).lastSeenCommentId, "");
      if (change === "revision") {
        h.setRevision(true);
        await h.loop.tickNow();
        assert.equal(calls + posts, 0);
        assert.equal(h.loop.isAdmittingNewWork(), false);
      }
      console.log(`PASS: reply ${change} during comment reads neither invokes/posts nor consumes the pending mention`);
    } finally { onRead = () => {}; await h.loop.stop(); }
  }

} finally {
  WorkflowAgent.prototype.run = original;
  hooks.deregister();
  delete globals.__watchdogCapacity;
}
