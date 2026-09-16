// Real loop/executor/worktrees; only Git, filesystem and offline board boundaries are observed.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketBoardAdapter } from "../src/ticket-executor.js";
import { fixture, calls, faults, git, dispose } from "./cleanup-fixture.js";

const { BoardLoop, createLoopState } = await import("../src/loop.js");
const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");

function harness(f: Awaited<ReturnType<typeof fixture>>) {
  const cfg = structuredClone(_DEFAULTS);
  cfg.context.enabled = cfg.telegram.enabled = false;
  cfg.task_merge_strategy = "merge";
  const card: Card = {
    itemId: f.task.itemId, number: f.task.issueNumber, title: f.task.title, body: f.task.body,
    contentType: "Issue", type: "Task", repoOwner: "owner", repoName: "repo", plan: "demo",
    closed: true, status: cfg.columns.done, assignees: [],
  };
  const cards = [card], reads: string[] = [];
  const warnings: string[] = [], successes: string[] = [];
  const noWrite = async (): Promise<never> => { assert.fail("finalization must not mutate the board or launch work"); };
  const board: TicketBoardAdapter = {
    getCard: async (id) => { reads.push(id); return structuredClone(cards.find((c) => c.itemId === id)); },
    claim: noWrite, release: noWrite, comment: noWrite, setStatus: noWrite, listComments: noWrite,
  };
  const restart = () => {
    const state = createLoopState();
    const executor = new ManagedTicketExecutor({
      cwd: f.repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", board, worktrees: f.store,
      callback: (message, level = "info") => { assert.equal(level, "info", "executor must return blockers, not notify them"); successes.push(message); },
      createManager: () => { assert.fail("unexpected model manager"); },
    });
    const loop = new BoardLoop({
      cwd: f.repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      listCards: async () => structuredClone(cards),
      callback: (message, level) => { if (level === "warn") warnings.push(message); },
    }, state, executor, f.store);
    return { loop, state };
  };
  return { cfg, card, cards, reads, warnings, successes, restart, ...restart() };
}

try {
  const f = await fixture();
  writeFileSync(join(f.record.path, "base.txt"), "task edit\n");
  git(f.record.path, "add", "base.txt"); git(f.record.path, "commit", "-m", "task conflict");
  git(f.record.path, "push", "origin", f.task.taskBranch);
  const taskSha = git(f.record.path, "rev-parse", "HEAD");
  writeFileSync(join(f.repo, "base.txt"), "base edit\n");
  git(f.repo, "add", "base.txt"); git(f.repo, "commit", "-m", "base conflict");
  git(f.repo, "push", "origin", "main");
  const baseSha = f.tip(), remoteRefs = git(f.origin, "show-ref"), recordBytes = readFileSync(f.recordFile);
  const h = harness(f);
  try {
    calls.length = 0;
    for (let tick = 1; tick <= 3; tick++) {
      await h.loop.tickNow();
      assert.equal(calls.filter((args) => args[0] === "merge-tree").length, tick, "EVERY tick retries the real conflicting merge check");
      assert.equal(calls.filter((args) => args[0] === "for-each-ref").length, tick, "refs are refreshed, never cached as authority");
      assert.equal(h.reads.length, tick * 2, "reconcile AND finalization read fresh approval each tick");
    }
    assert.equal(h.warnings.length, 1, "three real conflict checks must emit just one loop warning");
    assert.match(h.warnings[0], /Finalization conflict.*#1/);
    assert.match(h.warnings[0], /CONFLICT \(content\): Merge conflict in base\.txt/);
    for (const value of [baseSha, taskSha, f.task.taskBranch]) assert.ok(h.warnings[0].includes(value));
    assert.deepEqual(h.successes, []);
    assert.equal(h.state.tickCount, 3); assert.equal(h.state.wavesLaunched, 0); assert.equal(h.state.foreground, null);
    assert.equal(git(f.origin, "show-ref"), remoteRefs);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), taskSha);
    assert.deepEqual(readFileSync(f.recordFile), recordBytes);
    assert.equal(existsSync(f.record.path), true); assert.equal(existsSync(f.receipt), false);
    assert.ok(!calls.some((args) => ["commit-tree", "push", "update-ref"].includes(args[0]) || (args[0] === "worktree" && args[1] !== "list")));
    console.log("PASS: three real loop/executor/local-branch conflicts recheck three times but warn once, preserving approval, refs, worktree and v3 record");

    const tick = async (merges: number, warnings: number, label: string) => {
      const beforeCalls = calls.length, beforeWarnings = h.warnings.length;
      await h.loop.tickNow();
      assert.equal(calls.slice(beforeCalls).filter((args) => args[0] === "merge-tree").length, merges, `${label}: retry checks`);
      assert.equal(h.warnings.length - beforeWarnings, warnings, `${label}: new warnings`);
      assert.deepEqual(h.successes, []); assert.equal(h.state.wavesLaunched, 0);
    };
    const diagnostic = h.warnings[0].slice(h.warnings[0].indexOf("\n") + 1);
    faults.beforeGit = (args) => { if (args[0] === "merge-tree") throw new Error(diagnostic); };
    await tick(1, 1, "same reason but conflict -> blocked");
    assert.equal(h.warnings.at(-1), `Finalization blocked for "${h.card.title}": ${diagnostic}`);
    await tick(1, 0, "same blocked outcome");
    faults.beforeGit = undefined;
    await tick(1, 1, "same reason but blocked -> conflict");
    await tick(1, 0, "same conflict again");
    console.log("PASS: category alone distinguishes an ordinary process failure from a conflict with the identical diagnostic");

    let reason = "fetch temporarily unavailable";
    faults.beforeGit = (args) => { if (args[0] === "fetch") throw new Error(reason); };
    await tick(0, 1, "first fetch failure");
    await tick(0, 0, "same fetch failure is still retried");
    reason = "fetch permission denied";
    await tick(0, 1, "changed reason with same SHAs");
    await tick(0, 0, "same changed reason");
    reason = "fetch temporarily unavailable";
    await tick(0, 1, "return to an earlier reason is a new incident, not an ever-seen set");
    faults.beforeGit = undefined;
    await tick(1, 1, "fetch recovery reveals conflict again");
    console.log("PASS: unchanged ordinary blockers warn once; changed or returning reasons warn again without suppressing retries");

    git(f.repo, "commit", "--allow-empty", "-m", "new base SHA, same conflicting content");
    git(f.repo, "push", "origin", "main");
    const nextBase = f.tip();
    await tick(1, 1, "changed base SHA");
    assert.ok(h.warnings.at(-1)!.includes(nextBase)); assert.ok(h.warnings.at(-1)!.includes(taskSha));
    await tick(1, 0, "same new base SHA");
    git(f.record.path, "commit", "--allow-empty", "-m", "new task SHA, same conflicting content");
    git(f.record.path, "push", "origin", f.task.taskBranch);
    const nextTask = git(f.record.path, "rev-parse", "HEAD");
    await tick(1, 1, "changed task SHA");
    assert.ok(h.warnings.at(-1)!.includes(nextBase)); assert.ok(h.warnings.at(-1)!.includes(nextTask));
    await tick(1, 0, "same new task SHA");
    console.log("PASS: advancing either real base or task SHA reports the new conflict once");

    const other = { ...h.card, itemId: "ITEM_OTHER", number: 101 };
    git(f.repo, "branch", "task/issue-101", nextTask);
    h.cards.push(other);
    await tick(2, 1, "different ticket with identical conflict SHAs/reason");
    assert.match(h.warnings.at(-1)!, /Finalization conflict for #101/);
    await tick(2, 0, "both tickets keep their own last blocker");
    h.cards.pop();
    await tick(1, 0, "other ticket does not replace original ticket fingerprint");
    await h.loop.stop(); Object.assign(h, h.restart());

    await tick(1, 1, "new loop lifetime with same files and blocker");
    await tick(1, 0, "restarted loop deduplicates independently");
    assert.equal("enabled" in h.cfg.review, false);
    console.log("PASS: identical blockers on different tickets notify independently; a fresh loop warns again with mandatory review unchanged");

    // Board snapshot and reconciliation see closed-Done; the actual finalizer must
    // honor the later fresh approval read, and that skipped result ends the incident.
    faults.beforeGit = (args) => { if (args[0] === "for-each-ref") h.card.closed = false; };
    await tick(0, 0, "fresh reopened approval skips finalization");
    faults.beforeGit = undefined; h.card.closed = true;
    await tick(1, 1, "same failure after a skipped outcome");
    await tick(1, 0, "same post-skip failure");
    console.log("PASS: skipped fresh approval clears the previous blocker so the same later failure warns anew");

    const eligible = structuredClone(h.card);
    const ineligible: Array<[string, Partial<Card>]> = [
      ["open issue", { closed: false }], ["different lane", { status: h.cfg.columns.needs_human }],
      ["Story", { type: "Story" }], ["pull request", { contentType: "PullRequest" }],
      ["foreign repository", { repoOwner: "other" }], ["missing issue identity", { number: undefined }],
    ];
    for (const [label, patch] of ineligible) {
      Object.assign(h.card, patch);
      const beforeCalls = calls.length;
      await tick(0, 0, `${label} is ineligible`);
      assert.ok(!calls.slice(beforeCalls).some((args) => args[0] === "for-each-ref"), "no local-ref query for an ineligible board");
      Object.assign(h.card, eligible);
      await tick(1, 1, `same failure after ${label} is eligible again`);
    }
    h.cards.pop();
    await tick(0, 0, "ticket removed from board");
    h.cards.push(h.card);
    await tick(1, 1, "same failure after ticket returns");
    console.log("PASS: irrelevant entries are pruned for open, changed-lane/type/repository/identity and missing tickets, including an empty candidate list");

    git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, nextTask);
    const beforeReads = h.reads.length;
    await tick(0, 0, "local branch absent without receipt");
    assert.equal(h.reads.length - beforeReads, 1, "only reconcile reads; no-ref/no-receipt filter still skips the finalizer");
    git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, nextTask);
    await tick(1, 1, "same failure after local branch returns");
    await tick(1, 0, "same returning branch failure");
    console.log("PASS: a no-ref/no-receipt tick clears the irrelevant blocker without bypassing the existing negative filter");
  } finally { faults.beforeGit = undefined; await h.loop.stop(); }

  {
    const f = await fixture(), h = harness(f);
    const failFetch = (args: string[]) => { if (args[0] === "fetch") throw new Error("fetch offline"); };
    try {
      faults.beforeGit = failFetch;
      await h.loop.tickNow(); await h.loop.tickNow();
      assert.equal(h.warnings.length, 1);
      faults.beforeGit = undefined;
      await h.loop.tickNow();
      assert.equal(h.successes.length, 1); assert.equal(existsSync(f.record.path), false);
      assert.equal(existsSync(f.receipt), false); assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      // No no-ref/ineligible tick in between: success itself must clear the blocker.
      git(f.repo, "branch", f.task.taskBranch, f.taskSha);
      faults.beforeGit = failFetch;
      await h.loop.tickNow(); await h.loop.tickNow();
      assert.equal(h.warnings.length, 2, "same failure after successful finalization must notify again");
      assert.equal(h.warnings[0], h.warnings[1]); assert.equal(h.successes.length, 1);
      console.log("PASS: successful real integration/cleanup clears the blocker before an identical later failure");
    } finally { faults.beforeGit = undefined; await h.loop.stop(); }
  }

  {
    const f = await fixture(), h = harness(f);
    let attempts = 0, reason = "cleanup record is locked";
    faults.beforeFs = (operation, path) => {
      if (operation === "unlink" && path === f.recordFile) { attempts++; throw new Error(reason); }
    };
    try {
      calls.length = 0;
      for (let tick = 1; tick <= 3; tick++) {
        await h.loop.tickNow();
        assert.equal(attempts, tick, "receipt retries EVERY tick even after local-ref deletion");
        assert.equal(h.warnings.length, 1, "repeated cleanup blocker warns once");
        assert.ok(existsSync(f.receipt)); assert.ok(existsSync(f.recordFile));
        assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
        assert.equal(existsSync(f.record.path), false); assert.deepEqual(h.successes, []);
      }
      const integrated = f.tip();
      reason = "cleanup record still locked";
      await h.loop.tickNow(); assert.equal(attempts, 4); assert.equal(h.warnings.length, 2);
      faults.beforeFs = undefined;
      await h.loop.tickNow();
      assert.equal(h.successes.length, 1); assert.equal(existsSync(f.receipt), false); assert.equal(existsSync(f.recordFile), false);
      assert.equal(f.tip(), integrated, "cleanup retries must not integrate again");
      assert.equal(calls.filter((args) => args[0] === "commit-tree").length, 1);
      await h.loop.tickNow(); assert.equal(h.successes.length, 1); assert.equal(h.warnings.length, 2);
      console.log("PASS: no-ref cleanup receipts bypass the negative filter on every tick, deduplicate blockers, report changed reasons and finish without duplicate integration");
    } finally { faults.beforeFs = undefined; await h.loop.stop(); }
  }
} finally { dispose(); }
