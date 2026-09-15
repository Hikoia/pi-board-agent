// Public BoardLoop + real executor/worktrees; only board/model/context I/O is fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import {
  ManagedTicketExecutor,
  type TicketBoardAdapter,
} from "../src/ticket-executor.js";
import {
  TicketWorktrees,
  type TicketExecutionRecord,
} from "../src/ticket-worktree.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const repo = join(root, "repo"),
  origin = join(root, "origin.git");
mkdirSync(repo);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore" });
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, "README.md"), "base\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "fixture");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");
const cfg = structuredClone(_DEFAULTS);
cfg.max_workers = 1;
cfg.tick_seconds = 9999;
cfg.safety.require_clean_worktree =
  cfg.context.enabled =
  cfg.telegram.enabled = false;
const worktrees = new TicketWorktrees(repo);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function check(change: string, patch?: Partial<Card>) {
  const original: Card = {
    itemId: "ITEM_1",
    number: 1,
    contentType: "Issue",
    type: "Task",
    title: "T001 contract",
    body: "Acceptance",
    plan: "demo",
    repoOwner: "owner",
    repoName: "repo",
    closed: false,
    assignees: [],
    status: cfg.columns.ready,
  };
  let card: Card | undefined = structuredClone(original);
  let starts = 0,
    unreadable = false,
    failRelease = false,
    contextDone = false,
    lateReads = 0;
  let run: PersistedRunState | undefined;
  let contextRecord: TicketExecutionRecord | undefined;
  const entered = deferred(),
    finish = deferred();
  const readEntered = deferred(),
    readFinish = deferred();
  const writes: string[] = [],
    releases: Card[] = [],
    notices: string[] = [];
  const callback = (message: string) => {
    notices.push(message);
  };
  const board: TicketBoardAdapter = {
    getCard: async () => {
      if (contextDone) lateReads++;
      if (contextDone && change.endsWith("during-read") &&
          (!change.includes("-final-") || lateReads === 2)) {
        readEntered.resolve();
        await readFinish.promise;
      }
      if (unreadable) throw new Error("fresh read unavailable");
      return structuredClone(card);
    },
    claim: async () => {
      card!.assignees = ["bot"];
      return true;
    },
    release: async (target) => {
      releases.push(structuredClone(target));
      if (failRelease) throw new Error("claim release unavailable");
      card!.assignees = card!.assignees.filter((login) => login !== "bot");
    },
    setStatus: async (_id, status) => {
      writes.push(status);
      card!.status = status;
    },
    listComments: async () => [],
    comment: async () => {
      writes.push("comment");
    },
  };
  const executor = new ManagedTicketExecutor({
    cwd: repo,
    cfg,
    worktrees,
    board,
    botLogin: "bot",
    repoOwner: "owner",
    repoName: "repo",
    callback,
    context: async (record) => {
      contextRecord = record;
      entered.resolve();
      await finish.promise;
      contextDone = true;
      return "offline context";
    },
    createManager: () => {
      return {
      start: (_script, args) => {
        starts++;
        run = { runId: "run-1", args, status: "running" } as PersistedRunState;
        return run.runId;
      },
      list: () => (run ? [run] : []),
      resume: async () => false,
      pauseAndWait: async () => {
        if (run) run.status = "paused";
      },
      stopAndWait: async () => {
        if (run) run.status = "aborted";
      },
      dispose: () => {},
      };
    },
  });
  const state = createLoopState();
  const loop = new BoardLoop(
    {
      cwd: repo,
      cfg,
      botLogin: "bot",
      repoOwner: "owner",
      repoName: "repo",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      callback,
      listCards: async () => [structuredClone(original)],

    },
    state,
    executor,
    worktrees,
  );
  const tick = loop.tickNow();
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([
      entered.promise,
      tick.then(() => {
        throw new Error("context barrier not reached");
      }),
    ]);
    assert.equal(starts, 0);
    assert.equal(
      executor.observation.active[0]?.status,
      "launching",
      "executor publishes launch observation before context waits",
    );
    executor.observation = { active: [], occupiedSlots: 0 }; // Display is never capacity authority.
    assert.equal(
      executor.activeCount(),
      1,
      "launch preparation already owns its capacity slot",
    );
    const record = worktrees.read(original.itemId)!;
    // beginLaunch's optional undefined fields are omitted by JSON persistence.
    assert.deepEqual(
      JSON.parse(JSON.stringify(contextRecord ?? null)),
      record,
      "context receives the actual prepared execution record, including launch evidence",
    );
    assert.ok(record.launchingAt);
    assert.deepEqual(writes, [cfg.columns.building]);
    writes.length = 0;
    if (change === "admission") loop.disableAdmissions();
    else if (change === "missing") card = undefined;
    else if (change === "read-error") unreadable = true;
    else if (patch) Object.assign(card!, patch);
    if (change === "release-error") failRelease = true;
    if (change === "stop-human") stopping = loop.stop();
    let before = structuredClone(card);
    finish.resolve();
    if (change.endsWith("during-read")) {
      await Promise.race([
        readEntered.promise,
        tick.then(() => {
          throw new Error("actual-start fresh read not reached");
        }),
      ]);
      if (change === "stop-during-read" || change === "stop-final-during-read") {
        Object.assign(card!, { status: cfg.columns.backlog, body: "Withdrawn during stop" });
        before = structuredClone(card);
        stopping = loop.stop();
      } else if (change.startsWith("record-")) {
        worktrees.setActiveRun(original.itemId, "replacement-run");
      } else if (change.startsWith("card-")) {
        Object.assign(card!, { status: cfg.columns.backlog, body: "Withdrawn contract", assignees: ["human"] });
        before = structuredClone(card);
      } else loop.disableAdmissions();
      readFinish.resolve();
    }
    const error = await tick.then(
      () => undefined,
      (error: Error) => error,
    );
    await stopping;
    assert.equal(
      starts,
      change.startsWith("unchanged") ? 1 : 0,
      `${change} during context: no stale ACTUAL builder start`,
    );
    assert.equal(state.wavesLaunched, starts);
    assert.ok(
      existsSync(record.path),
      "persistent worktree is never discarded",
    );
    if (change.startsWith("unchanged")) {
      assert.equal(worktrees.read(original.itemId)?.activeRunId, "run-1");
      assert.deepEqual(releases, []);
      assert.deepEqual(writes, []);
    } else if (change.startsWith("admission")) {
      assert.equal(loop.isAdmittingNewWork(), false);
      assert.equal(card!.status, cfg.columns.ready);
      assert.deepEqual(writes, ["comment", cfg.columns.ready]);
      assert.equal(worktrees.read(original.itemId)?.retry?.stage, "build");
      assert.equal(releases.length, 1);
      assert.deepEqual(card!.assignees, []);
      assert.equal(worktrees.read(original.itemId)?.launchingAt, undefined);
      await loop.tickNow();
      assert.equal(
        starts,
        0,
        "a later tick cannot reopen disabled admissions",
      );
    } else if (change.startsWith("record-")) {
      assert.equal(worktrees.read(original.itemId)?.activeRunId, "replacement-run");
      assert.deepEqual(writes, [], "replaced execution cannot authorize stale settlement");
      assert.deepEqual(releases, []);
    } else if (change === "read-error") {
      assert.match(
        error?.message ?? notices.join("\n"),
        /fresh read unavailable/,
      );
      assert.deepEqual(
        worktrees.read(original.itemId),
        record,
        "failed fresh read retains exact launch evidence",
      );
      assert.equal(
        executor.activeCount(),
        1,
        "uncertain launch never lends its occupied slot",
      );
      assert.deepEqual(writes, []);
      assert.deepEqual(
        releases,
        [],
        "failed observation cannot authorize stale claim cleanup",
      );
      assert.deepEqual(card, before);
      // Existing reconciliation owns retry: after a confirmed human state, only
      // release/clear, not another builder or a stale Ready/blocker write.
      unreadable = false;
      card!.status = cfg.columns.needs_human;
      const summary = await executor.reconcile([original]);
      assert.equal(summary.errors, 0);
      assert.equal(card!.status, cfg.columns.needs_human);
      assert.equal(releases.length, 1);
      assert.deepEqual(writes, []);
      assert.equal(worktrees.read(original.itemId)?.launchingAt, undefined);
    } else if (change === "release-error") {
      assert.match(error?.message ?? "", /claim release unavailable/);
      assert.deepEqual(
        worktrees.read(original.itemId),
        record,
        "release failure retains exact launch evidence",
      );
      assert.deepEqual(card, before);
      assert.equal(executor.activeCount(), 1);
      assert.deepEqual(writes, []);
      assert.equal(releases.length, 1);
      failRelease = false;
      card!.status = cfg.columns.done;
      card!.body = "Maintainer changed the contract after failed cleanup";
      assert.equal((await executor.reconcile([original])).errors, 0);
      assert.equal(card!.status, cfg.columns.done);
      assert.deepEqual(card!.assignees, []);
      assert.equal(
        releases.length,
        2,
        "reconcile retries only the incomplete release",
      );
      assert.deepEqual(
        writes,
        [],
        "settlement retry never replays status or comments",
      );
      assert.equal(worktrees.read(original.itemId)?.launchingAt, undefined);
      assert.equal(starts, 0);
    } else {
      assert.deepEqual(
        writes,
        [],
        "stale contract/ownership/human state never authorizes status or comment writes",
      );
      assert.equal(card?.status, before?.status, "human status is preserved");
      const foreign = change === "missing" || change.startsWith("identity-");
      const owned = !foreign && before!.assignees.includes("bot");
      assert.equal(
        releases.length,
        owned ? 1 : 0,
        "only a verified original target with our claim authorizes release",
      );
      if (owned)
        assert.deepEqual(
          releases[0],
          before,
          "cleanup uses the fresh card, never the pre-context snapshot",
        );
      assert.deepEqual(
        card?.assignees,
        owned
          ? before!.assignees.filter((login) => login !== "bot")
          : before?.assignees,
      );
      assert.equal(
        worktrees.read(original.itemId)?.launchingAt,
        undefined,
        "confirmed stale launch is settled locally",
      );
      if (foreign)
        assert.match(
          notices.join("\n"),
          /claim.*manual|manual.*claim/i,
          "unverifiable original claim requires explicit manual cleanup notice",
        );
    }
    console.log(
      `PASS: builder actual-start ${change} gate preserves capacity, fresh-state authority and claim/recovery evidence`,
    );
  } finally {
    finish.resolve();
    readFinish.resolve();
    unreadable = failRelease = false;
    await tick.catch(() => {});
    await loop.stop();
    // Reuse only the disposable fixture's persistent worktree across scenarios.
    worktrees.clearExecution(original.itemId);
    worktrees.update(original.itemId, (record) => ({ ...record, retry: undefined })); // independent fixture case, not production settlement

  }
}

const failures: unknown[] = [];
for (const [change, patch] of [
  ["unchanged"],
  ["admission"],
  ["admission-during-read"],
  ["admission-final-during-read"],
  ["stop-during-read"],
  ["stop-final-during-read"],
  ["card-during-read"],
  ["card-final-during-read"],
  ["record-during-read"],
  ["record-final-during-read"],
  ["missing"],
  ["read-error"],
  ["release-error", { status: cfg.columns.needs_human }],
  ["identity-item", { itemId: "REPLACEMENT" }],
  ["identity-number", { number: 2 }],
  ["identity-owner", { repoOwner: "foreign" }],
  ["identity-repo", { repoName: "foreign" }],
  ["identity-kind", { contentType: "PullRequest" }],
  ["identity-type", { type: "Story" }],
  ["human-backlog", { status: cfg.columns.backlog }],
  ["human-ready", { status: cfg.columns.ready }],
  ["human-review", { status: cfg.columns.review }],
  ["human-needs-human", { status: cfg.columns.needs_human }],
  ["human-done", { status: cfg.columns.done }],
  ["human-closed", { closed: true }],
  ["stop-human", { status: cfg.columns.backlog, body: "Changed contract" }],
  ["contract-body", { body: "Changed contract" }],
  ["contract-title", { title: "Changed title" }],
  ["contract-plan", { plan: "other" }],
  ["ownership-other", { assignees: ["bot", "human"] }],
  ["ownership-lost", { assignees: [] }],
] as Array<[string, Partial<Card>?]>) {
  try {
    await check(change, patch);
  } catch (error) {
    console.error(`FAIL: builder actual-start ${change}`, error);
    failures.push(error);
  }
}
if (failures.length) throw new AggregateError(failures);
