import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, calls, faults, dispose } from "./finalization-fixture.js";
import { historicalReceipt } from "./legacy-cleanup-fixture.js";
const { LegacyTickets } = await import("../src/legacy-tickets.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");
function adapter(f: Awaited<ReturnType<typeof fixture>>) {
  return new LegacyTickets({ worktrees: f.store, cfg: f.cfg, board: f.board, botLogin: "bot", repoOwner: "owner", repoName: "repo" });
}
try {
  for (const integrated of [false, true]) {
    const f = await fixture(true);
    const result = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base, "-m", "old squash");
    f.store.update(f.task.itemId, (r) => ({ ...r, finalization: { baseSha: f.base, taskSha: f.taskSha, targetBranch: "main", resultSha: result } }));
    if (integrated) {
      git(f.repo, "push", "origin", `${result}:refs/heads/main`);
      const advanced = git(f.repo, "commit-tree", `${result}^{tree}`, "-p", result, "-m", "later base");
      git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
    }
    const owner = acquireOwnerLock(f.repo, "bot");
    try {
      assert.deepEqual((await adapter(f).migrate(owner)).failures, []); calls.length = 0;
      const outcome = await f.finish(); assert.equal(outcome.status, "finalized", JSON.stringify(outcome));
      assert.equal(f.store.has(f.task.itemId), false); assert.equal(calls.filter((a) => a[0] === "commit-tree" || a[0] === "merge-tree").length, 0);
      assert.equal(git(f.repo, "show", "-s", "--format=%P", result), f.base, "old squash consumed, never recreated");
      assert.equal(git(f.repo, "merge-base", "--is-ancestor", result, "origin/main"), "");
      console.log(`PASS: converted ${integrated ? "already-integrated advanced-base" : "unpushed"} legacy squash finishes exact recorded result without a new merge/squash`);
    } finally { owner.release(); }
  }
  for (const fullyRemoved of [false, true]) {
    const f = await fixture(true);
    await historicalReceipt(f, fullyRemoved);
    f.card.status = f.cfg.columns.ready;
    const receipt = readFileSync(f.receipt), owner = acquireOwnerLock(f.repo, "bot");
    try {
      assert.deepEqual((await adapter(f).migrate(owner)).failures, []);
      assert.equal(f.recordNow().retry?.stage, "cleanup");
      // Regression: old receipt must not lock the published v4 ticket store.
      f.store.update(f.task.itemId, (r) => ({ ...r, retry: { stage: "cleanup", reason: "new v4 retry may update beside immutable old receipt" } }));
      if (!fullyRemoved) {
        const unknown = join(f.record.path, "new-program.ts"); writeFileSync(unknown, "valuable new program");
        await f.finish(); assert.equal(existsSync(unknown), true); assert.ok(f.store.has(f.task.itemId));
        assert.deepEqual(readFileSync(f.receipt), receipt); unlinkSync(unknown);
        let cut = false;
        faults.beforeFs = (op, path) => { if (op === "unlink" && path === join(f.record.path, "feature.txt") && !cut) { cut = true; throw new Error("offline partial legacy removal"); } };
        const partial = await f.finish(); assert.equal(cut, true, JSON.stringify(partial)); assert.ok(f.store.has(f.task.itemId)); faults.beforeFs = undefined;
      }
      f.failDone(true); await f.finish();
      assert.ok(f.store.has(f.task.itemId)); assert.equal(existsSync(f.record.path), false); assert.equal(f.card.closed, true);
      assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.recordNow().retry?.stage, "cleanup");
      f.failDone(false); calls.length = 0;
      const outcome = await f.finish(); assert.equal(outcome.status, "finalized", JSON.stringify(outcome));
      assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.store.has(f.task.itemId), false);
      assert.deepEqual(readFileSync(f.receipt), receipt, "no receipt GC or rewrite");
      for (let i = 0; i < 3; i++) {
        const report = await adapter(f).migrate(owner);
        assert.deepEqual(report.failures, []); assert.deepEqual(report.converted, []);
        assert.equal(f.store.has(f.task.itemId), false, "receipt-only completed ticket must not resurrect");
        assert.equal((await f.finish()).status, "skipped");
      }
      assert.equal(calls.filter((a) => a[0] === "commit-tree" || a[0] === "merge-tree" || a[0] === "push").length, 0);
      assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
      console.log(`PASS: ${fullyRemoved ? "receipt-only fully removed" : "verified partial legacy residual"} resumes v4 retry/Done failures, leaves old evidence read-only and never resurrects after fresh Done completion`);
    } finally { owner.release(); }
  }
  {
    const f = await fixture(true); await historicalReceipt(f, true);
    const bytes = readFileSync(f.receipt), owner = acquireOwnerLock(f.repo, "bot");
    try {
      faults.beforeGit = (args) => { if (args[0] === "fetch") throw new Error("offline completion observation"); };
      const report = await adapter(f).migrate(owner); assert.equal(report.failures.length, 1);
      assert.equal(f.store.has(f.task.itemId), false); assert.deepEqual(readFileSync(f.receipt), bytes);
      faults.beforeGit = undefined;
      assert.deepEqual((await adapter(f).migrate(owner)).converted, []);
      assert.equal(f.store.has(f.task.itemId), false);
      console.log("PASS: receipt-only completion requires a fresh remote observation; I/O failure retains evidence without guessing or resurrecting");
    } finally { owner.release(); }
  }
} finally { dispose(); }
