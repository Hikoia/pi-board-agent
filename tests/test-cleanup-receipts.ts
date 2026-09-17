import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, dispose } from "./cleanup-fixture.js";
import { historicalReceipt, migrateCleanup } from "./legacy-cleanup-fixture.js";
try {
  {
    const f = await fixture(false, true);
    faults.beforeGit = (a) => { if (a[0] === "worktree" && a[1] === "remove") { faults.beforeGit = undefined; f.vanish(); throw new Error("partial worktree removal"); } };
    await assert.rejects(f.finish(), /partial worktree removal/);
    const integrated = f.tip(); assert.notEqual(integrated, f.base);
    assert.equal(f.store.read(f.task.itemId)?.retry?.stage, "cleanup");
    mkdirSync(join(f.record.path, "unknown-empty"));
    writeFileSync(join(f.record.path, "program.ts"), "preserve residual source");
    calls.length = 0;
    await assert.rejects(f.finish(), /Unregistered residual/);
    assert.equal(f.tip(), integrated); assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.ok(existsSync(f.recordFile)); assert.ok(existsSync(f.record.path));
    assert.equal(existsSync(f.receipt), false);
    assert.equal(existsSync(join(f.repo, ".pi/board-agent/cleanup-backups")), false);
    assert.equal(calls.some((a) => ["merge-tree", "commit-tree", "update-ref"].includes(a[0])), false);
    console.log("PASS: partial normal removal retains v4 cleanup progress, unknown files/directories and refs; no new snapshot, backup or recursive fallback can invent ownership");
  }
  {
    const f = await fixture(false, true);
    faults.beforeSyncFs = (op, path) => { if (op === "unlinkSync" && path === f.recordFile) throw new Error("record unlink failure"); };
    await assert.rejects(f.finish(), /record unlink failure/); faults.beforeSyncFs = undefined;
    assert.equal(existsSync(f.record.path), false); assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.ok(existsSync(f.recordFile)); const integrated = f.tip(); calls.length = 0;
    assert.equal(await f.finish(), integrated); assert.equal(f.tip(), integrated);
    assert.equal(calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])), false);
    assert.equal(existsSync(f.recordFile), false);
    console.log("PASS: final record unlink failure resumes after missing refs/path without a duplicate merge; the single v4 record is deleted last");
  }
  {
    const f = await fixture(); await historicalReceipt(f);
    const receipt = readFileSync(f.receipt), finish = await migrateCleanup(f);
    let cut = false;
    faults.beforeFs = (op, path) => { if (!cut && op === "unlink" && path.startsWith(f.record.path)) { cut = true; throw new Error("legacy partial unlink"); } };
    await assert.rejects(finish(), /legacy partial unlink/); assert.ok(cut); faults.beforeFs = undefined;
    const integrated = f.tip(); assert.equal(await finish(), integrated);
    assert.deepEqual(readFileSync(f.receipt), receipt); assert.equal(existsSync(f.record.path), false);
    assert.equal(existsSync(f.recordFile), false);
    console.log("PASS: pre-existing receipted legacy residual resumes partial cleanup without reintegration or deleting/rewriting its archived source");
  }
} finally { dispose(); }
