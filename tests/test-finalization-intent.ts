// Main-agent acceptance: retry Git I/O without rebuilding; preserve old Done approval.
import assert from "node:assert/strict";
import { fixture, git, faults, dispose } from "./finalization-fixture.js";
const { LegacyTickets } = await import("../src/legacy-tickets.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");
let failed = false;
try {
  try {
    const f = await fixture();
    const advanced = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "nonconflicting base advance");
    faults.beforeGit = (args) => {
      if (args[0] === "push" && args.some((s) => s.endsWith(`:refs/heads/${f.task.taskBranch}`))) {
        faults.beforeGit = undefined;
        git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
        throw new Error("task publication unavailable after human base advance");
      }
    };
    await f.finish();
    assert.equal(f.recordNow().retry?.stage, "integrate");
    const prepared = f.prNow().preparedHeadSha;
    const outcome = await f.finish();
    assert.equal(outcome.status, "finalized", "a rejected task publication retries the same PR preparation, not the builder");
    assert.equal(f.card.closed, true);
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
    assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${advanced} ${prepared}`);
    console.log("PASS: nonconflicting base advance retries task publication for manual merge with unchanged human-approved task and no model/reopen");
  } catch (error) { failed = true; console.log(`FAIL: integration retry contract: ${String(error)}`); }
  try {
    const f = await fixture(true);
    f.store.legacyUpdate(f.task.itemId, (r) => ({ ...r, reviewedTaskSha: undefined }));
    const owner = f.owner;
    try {
      const legacy = new LegacyTickets({ worktrees: f.store, cfg: f.cfg, board: f.board, botLogin: "bot", repoOwner: "owner", repoName: "repo" });
      assert.deepEqual((await legacy.migrateV5(owner)).failures, []);
      const outcome = await f.finish();
      assert.equal(outcome.status, "finalized", "an existing v3 closed Done Task without optional old AI review is not stranded by upgrade");
      assert.equal(f.card.closed, true); assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
      console.log("PASS: existing v3 closed Done approval survives migration without manufacturing an old review marker");
    } finally { owner.release(); }
  } catch (error) { failed = true; console.log(`FAIL: legacy Done compatibility: ${String(error)}`); }
} finally { dispose(); }
if (failed) process.exitCode = 1;
