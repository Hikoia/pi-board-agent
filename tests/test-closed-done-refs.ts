// Real loop/executor/store. Only isolated Git and in-memory GitHub boundaries.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type {
  TicketBoardAdapter,
  TicketWorkflowManager,
} from "../src/ticket-executor.js";
import { calls, dispose, faults, fixture, git } from "./cleanup-fixture.js";
const { BoardLoop, createLoopState } = await import("../src/loop.js");
const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
function harness(
  f: Awaited<ReturnType<typeof fixture>>,
  createManager: () => TicketWorkflowManager = () =>
    assert.fail("no builder manager"),
) {
  const cfg = structuredClone(_DEFAULTS);
  cfg.context.enabled =
    cfg.refine.enabled =
    cfg.review.enabled =
    cfg.watchdog.enabled =
    cfg.telegram.enabled =
      false;
  cfg.task_merge_strategy = "merge";
  cfg.columns.done = "Validated";
  cfg.columns.backlog = "Archive backlog";
  const card: Card = {
    itemId: f.task.itemId,
    number: f.task.issueNumber,
    title: f.task.title,
    body: f.task.body,
    contentType: "Issue",
    type: "Task",
    repoOwner: "owner",
    repoName: "repo",
    closed: true,
    status: cfg.columns.done,
    assignees: [],
  };
  const cards = [card],
    reads: string[] = [],
    writes: string[] = [],
    notices: string[] = [];
  const noWrite = async (): Promise<never> =>
    assert.fail("no claim, comment, reopen or builder");
  const board: TicketBoardAdapter = {
    getCard: async (id) => {
      reads.push(id);
      return structuredClone(cards.find((c) => c.itemId === id));
    },
    setStatus: async (id, status) => {
      writes.push(id);
      assert.equal(status, cfg.columns.backlog);
      cards.find((c) => c.itemId === id)!.status = status;
    },
    claim: noWrite,
    release: noWrite,
    comment: noWrite,
    listComments: noWrite,
  };
  const restart = () => {
    const callback = (message: string) => {
      notices.push(message);
    };
    const executor = new ManagedTicketExecutor({
      cwd: f.repo,
      cfg,
      board,
      worktrees: f.store,
      botLogin: "bot",
      repoOwner: "owner",
      repoName: "repo",
      callback,
      createManager,
    });
    const loop = new BoardLoop(
      {
        cwd: f.repo,
        cfg,
        botLogin: "bot",
        repoOwner: "owner",
        repoName: "repo",
        callback,
        meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
        listCards: async () => structuredClone(cards),
      },
      createLoopState(),
      executor,
      f.store,
    );
    return { loop, executor };
  };
  return {
    cfg,
    card,
    cards,
    reads,
    writes,
    notices,
    board,
    restart,
    ...restart(),
  };
}
function removeRefs(f: Awaited<ReturnType<typeof fixture>>) {
  git(f.repo, "push", "origin", "--delete", f.task.taskBranch);
  git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
}
try {
  {
    const f = await fixture(),
      h = harness(f);
    removeRefs(f);
    writeFileSync(join(f.record.path, "leftover.txt"), "unknown data\n");
    const bytes = readFileSync(f.recordFile);
    for (const [i, type] of ["Story", "Bug", undefined].entries())
      h.cards.push({
        ...h.card,
        itemId: `HISTORY_${i}`,
        number: 100 + i,
        type,
      });
    await h.loop.tickNow();
    assert.equal(h.writes.length, 4);
    assert.ok(
      h.cards.every((c) => c.closed && c.status === h.cfg.columns.backlog),
    );
    assert.equal(h.notices.filter((m) => m.startsWith("Backlogged")).length, 4);
    assert.deepEqual(readFileSync(f.recordFile), bytes);
    assert.equal(
      readFileSync(join(f.record.path, "leftover.txt"), "utf8"),
      "unknown data\n",
    );
    const reads = h.reads.length;
    calls.length = 0;
    await h.loop.tickNow();
    await h.loop.stop();
    Object.assign(h, h.restart());
    await h.loop.tickNow();
    assert.equal(
      h.reads.length,
      reads,
      "closed Backlog with idle record stops per-ticket polling, including restart",
    );
    assert.ok(
      !calls.some((a) =>
        ["ls-remote", "merge-tree", "push", "update-ref"].includes(a[0]),
      ),
    );
    assert.deepEqual(readFileSync(f.recordFile), bytes);
    await h.loop.stop();
    console.log(
      "PASS: all Issue Types (including unset) move to custom Backlog; history preserves idle records/unknown worktree files and stops polling next tick/restart",
    );
  }
  {
    const f = await fixture(),
      h = harness(f);
    h.cards.splice(
      0,
      1,
      ...[
        { closed: false },
        { status: h.cfg.columns.ready },
        { status: h.cfg.columns.backlog },
        { contentType: "PullRequest" },
        { contentType: "DraftIssue" },
        { repoOwner: "other" },
        { repoName: "other" },
        { number: undefined },
      ].map(
        (patch, i) =>
          ({ ...h.card, ...patch, itemId: `EXCLUDED_${i}` }) as Card,
      ),
    );
    await h.loop.tickNow();
    assert.deepEqual(h.writes, []);
    assert.equal(f.tip(), f.base);
    assert.ok(f.store.localBranchSha(f.task.taskBranch));
    await h.loop.stop();
    console.log(
      "PASS: open, non-Done, PR, Draft, foreign repository and invalid identity cards are excluded",
    );
  }
  {
    const f = await fixture(),
      h = harness(f);
    h.cfg.branches.task_prefix = "ops/ticket-";
    h.cards.splice(0, 1, {
      ...h.card,
      itemId: "CUSTOM",
      number: 900,
      type: "Story",
    });
    for (const branch of [
      "ops/ticket-issue-900",
      "ops/ticket-issue-900-extra",
      "ops/ticket-issue-9000",
      "task/issue-900",
    ])
      git(f.repo, "branch", branch, f.taskSha);
    await h.loop.tickNow();
    assert.equal(h.cards[0].status, h.cfg.columns.backlog);
    assert.equal(f.store.localBranchSha("ops/ticket-issue-900"), undefined);
    for (const branch of [
      "ops/ticket-issue-900-extra",
      "ops/ticket-issue-9000",
      "task/issue-900",
    ])
      assert.equal(f.store.localBranchSha(branch), f.taskSha);
    await h.loop.stop();
    console.log(
      "PASS: Story integrates only the exact configured branch prefix/issue number",
    );
  }
  for (const responseLost of [false, true]) {
    const f = await fixture(),
      h = harness(f),
      write = h.board.setStatus;
    let attempted = false;
    h.board.setStatus = async (id, status) => {
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(existsSync(f.receipt), false);
      if (!attempted) {
        attempted = true;
        if (responseLost) await write(id, status);
        throw new Error("Backlog response unavailable");
      }
      await write(id, status);
    };
    await h.loop.tickNow();
    const result = f.tip();
    assert.notEqual(result, f.base);
    assert.equal(
      h.notices.some((m) => /^(Finalized|Backlogged)/.test(m)),
      false,
    );
    await h.loop.stop();
    Object.assign(h, h.restart());
    calls.length = 0;
    await h.loop.tickNow();
    await h.loop.tickNow();
    assert.equal(h.card.status, h.cfg.columns.backlog);
    assert.equal(h.card.closed, true);
    assert.equal(f.tip(), result);
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    assert.equal(h.writes.length, 1);
    assert.equal(
      h.notices.filter((m) => /^(Finalized|Backlogged)/.test(m)).length,
      responseLost ? 0 : 1,
    );
    await h.loop.stop();
    console.log(
      `PASS: cleanup + ${responseLost ? "lost successful reply" : "failed Backlog write"} restarts without duplicate merge, write or success notification`,
    );
  }
  for (const change of ["reopen", "lane", "identity", "removed"] as const) {
    const f = await fixture(),
      h = harness(f),
      read = h.board.getCard;
    h.board.getCard = async (id) => {
      if (!f.store.localBranchSha(f.task.taskBranch)) {
        if (change === "reopen") h.card.closed = false;
        if (change === "lane") h.card.status = h.cfg.columns.ready;
        if (change === "identity") h.card.number = 999;
        if (change === "removed") h.cards.length = 0;
      }
      return read(id);
    };
    await h.loop.tickNow();
    assert.notEqual(f.tip(), f.base);
    assert.deepEqual(h.writes, []);
    assert.equal(
      h.notices.some((m) => m.startsWith("Finalized")),
      false,
    );
    await h.loop.stop();
    console.log(
      `PASS: ${change} after cleanup is freshly re-read and never overwritten by Backlog`,
    );
  }
  for (const race of ["local", "remote", "query failure"] as const) {
    const f = await fixture(),
      h = harness(f);
    removeRefs(f);
    let probes = 0;
    faults.beforeGit = (args) => {
      if (args[0] !== "ls-remote") return;
      if (race === "query failure") throw new Error("remote query unavailable");
      if (++probes !== 2) return;
      if (race === "local")
        git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      else
        git(
          f.origin,
          "update-ref",
          `refs/heads/${f.task.taskBranch}`,
          f.taskSha,
        );
    };
    await h.loop.tickNow();
    faults.beforeGit = undefined;
    assert.deepEqual(h.writes, []);
    assert.equal(h.card.status, h.cfg.columns.done);
    assert.equal(f.tip(), f.base);
    assert.ok(h.notices.some((m) => /blocked/.test(m)));
    await h.loop.stop();
    console.log(
      `PASS: historical ${race} blocks the move, never treats unknown or racing refs as absent`,
    );
  }
  for (const evidence of [
    "active",
    "launching",
    "finalization",
    "corrupt record",
    "corrupt receipt",
  ] as const) {
    const f = await fixture(),
      h = harness(f);
    removeRefs(f);
    if (evidence === "active") f.store.setActiveRun(f.task.itemId, "unsettled");
    if (evidence === "launching") f.store.beginLaunch(f.task.itemId);
    if (evidence === "finalization")
      f.store.update(f.task.itemId, (r) => ({
        ...r,
        finalization: {
          targetBranch: "main",
          baseSha: f.base,
          taskSha: f.taskSha,
        },
      }));
    if (evidence === "corrupt record") writeFileSync(f.recordFile, "broken");
    if (evidence === "corrupt receipt") writeFileSync(f.receipt, "broken");
    const before = readFileSync(f.recordFile);
    assert.equal((await h.executor.finalizeClosed(h.card)).status, "blocked");
    assert.deepEqual(h.writes, []);
    assert.deepEqual(readFileSync(f.recordFile), before);
    assert.ok(existsSync(f.record.path));
    await h.loop.stop();
    console.log(`PASS: no-ref ${evidence} cannot take the historical shortcut`);
  }
  {
    const f = await fixture(),
      h = harness(f, () => ({
        start: () => assert.fail("no builder start"),
        list: () => [],
        resume: async () => false,
        pauseAndWait: async () => {},
        stopAndWait: async () => {},
        dispose: () => {},
      }));
    removeRefs(f);
    f.store.setActiveRun(f.task.itemId, "unsettled");
    const record = readFileSync(f.recordFile);
    let releases = 0;
    h.board.release = async () => {
      releases++;
      throw new Error("release unavailable");
    };
    for (let tick = 1; tick <= 2; tick++) {
      await h.loop.tickNow();
      assert.equal(releases, tick);
      assert.deepEqual(readFileSync(f.recordFile), record);
      assert.deepEqual(h.writes, []);
    }
    await h.loop.stop();
    console.log(
      "PASS: no-ref active execution still reconciles/retries failed release, retaining evidence and Done",
    );
  }
} finally {
  dispose();
}
