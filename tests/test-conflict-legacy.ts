import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fixture, git, calls, dispose } from "./finalization-fixture.js";
import { acquireOwnerLock } from "../src/owner-lock.js";

try {
  for (const kind of ["unknown-base", "rewritten-base", "unknown-result", "wrong-result", "review-mismatch", "old-task-mismatch"] as const) {
    const f = await fixture(true);
    const baseSha = kind === "unknown-base" ? "0".repeat(40) : kind === "rewritten-base" ? git(f.repo, "commit-tree", `${f.base}^{tree}`, "-m", "unrelated") : f.base;
    f.store.update(f.task.itemId, (r) => ({ ...r, reviewedTaskSha: kind === "review-mismatch" ? f.base : f.taskSha,
      finalization: { targetBranch: "main", baseSha, taskSha: kind === "old-task-mismatch" ? f.base : f.taskSha,
        ...(kind === "unknown-result" ? { resultSha: "0".repeat(40) } : kind === "wrong-result" ? { resultSha: f.base } : {}) } }));
    const bytes = readFileSync(f.recordFile), owner = acquireOwnerLock(f.repo, "bot");
    try {
      calls.length = 0;
      const report = await f.executor.migrateLegacy(owner);
      assert.equal(report.failures.length, 1, kind);
      assert.deepEqual(readFileSync(f.recordFile), bytes);
      assert.notEqual((await f.executor.finalizeClosed(f.card)).status, "finalized");
      assert.equal(f.tip(), f.base); assert.equal(f.comments.length, 0); assert.ok(existsSync(f.record.path));
      assert.equal(calls.some((a) => ["push", "commit-tree", "update-ref"].includes(a[0])), false);
      console.log(`PASS: legacy ${kind} stays byte-identical and blocked without inventing integration or cleanup authority`);
    } finally { owner.release(); }
  }
  {
    const f = await fixture(true);
    writeFileSync(join(f.record.path, "base.txt"), "task side"); git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "task"); git(f.record.path, "push", "origin", f.task.taskBranch);
    const taskSha = git(f.record.path, "rev-parse", "HEAD"); f.store.setReviewedTaskSha(f.task.itemId, taskSha);
    writeFileSync(join(f.repo, "base.txt"), "base side"); git(f.repo, "add", "base.txt"); git(f.repo, "commit", "-m", "base"); git(f.repo, "push", "origin", "main");
    const baseSha = f.tip();
    f.store.update(f.task.itemId, (r) => ({ ...r, finalization: { targetBranch: "main", baseSha, taskSha } }));
    const bytes = readFileSync(f.recordFile), owner = acquireOwnerLock(f.repo, "bot");
    try {
      assert.deepEqual((await f.executor.migrateLegacy(owner)).failures, []);
      assert.deepEqual(readFileSync(join(f.repo, ".pi/board-agent/legacy-v3", basename(f.recordFile))), bytes);
      await f.executor.finalizeClosed(f.card);
      assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready);
      assert.equal(f.recordNow().retry?.stage, "build"); assert.equal(f.recordNow().integration, undefined);
      assert.equal(f.starts(), 0); assert.equal(f.tip(), baseSha);
      console.log("PASS: valid pre-result v3 intent archives raw bytes before v4 conversion, then a real conflict reopens for original-branch build and renewed approval");
    } finally { owner.release(); }
  }
} finally { dispose(); }
