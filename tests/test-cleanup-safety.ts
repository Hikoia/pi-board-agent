import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, git, root, dispose } from "./cleanup-fixture.js";
import { historicalReceipt, migrateCleanup } from "./legacy-cleanup-fixture.js";
try {
  {
    const f = await fixture(true, true); calls.length = 0;
    assert.ok(await f.finish());
    assert.ok(calls.some((a) => a[0] === "worktree" && a[1] === "remove" && a.length === 3));
    assert.equal(existsSync(f.record.path), false); assert.equal(existsSync(f.recordFile), false);
    assert.equal(existsSync(f.receipt), false); assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    console.log("PASS: Cargo.lock, locked and ignored node_modules lockfiles permit normal removal; ignored files are explicitly discardable without new snapshots");
  }
  const f = await fixture(true);
  await historicalReceipt(f, false, true);
  const receipt = readFileSync(f.receipt), tip = f.tip();
  for (const change of [
    (r: any) => { r.schemaVersion = 2; }, (r: any) => { r.unexpected = true; },
    (r: any) => { delete r.taskSha; }, (r: any) => { r.itemId = "OTHER"; },
    (r: any) => { r.snapshots[0].entries[0].extra = 1; },
    (r: any) => { r.snapshots[0].entries[1].path = "../escape"; },
    (r: any) => { r.snapshots[0].entries.push(r.snapshots[0].entries[1]); },
    (r: any) => { r.record.activeRunId = "mixed"; r.record.activeRunStartedAt = 1; },
  ]) {
    const value = JSON.parse(receipt.toString()); change(value);
    writeFileSync(f.receipt, JSON.stringify(value)); calls.length = 0;
    await assert.rejects(migrateCleanup(f));
    assert.equal(calls.some((a) => ["push", "commit-tree", "update-ref"].includes(a[0])), false);
    assert.ok(existsSync(f.record.path)); assert.equal(f.store.read(f.task.itemId)?.schemaVersion, 3);
  }
  writeFileSync(f.receipt, "{corrupt");
  git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
  await assert.rejects(migrateCleanup(f)); assert.equal(f.tip(), tip);
  writeFileSync(f.receipt, receipt); git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
  console.log("PASS: migration rejects strict receipt version/identity/snapshot corruption, including missing local ref, without guessing cleanup authority");
  const finish = await migrateCleanup(f);
  const cache = join(f.record.path, "ignored", "cache.bin"), bytes = readFileSync(cache);
  const backup = JSON.parse(receipt.toString()).backup;
  const copy = join(backup, "0", "ignored", "cache.bin"), copyBytes = readFileSync(copy);
  writeFileSync(copy, "corrupt backup"); await assert.rejects(finish(), /backup/i);
  writeFileSync(copy, copyBytes);
  writeFileSync(cache, "mutated"); await assert.rejects(finish(), /changed/); writeFileSync(cache, bytes);
  const added = join(f.record.path, "ignored", "added");
  writeFileSync(added, "new ignored data"); await assert.rejects(finish(), /changed|added/); unlinkSync(added);
  const moved = join(root, "saved-cache"); renameSync(cache, moved); writeFileSync(cache, bytes);
  await assert.rejects(finish(), /changed/); unlinkSync(cache); renameSync(moved, cache);
  const saved = join(root, "saved-worktree"); renameSync(f.record.path, saved); cpSync(saved, f.record.path, { recursive: true });
  await assert.rejects(finish(), /changed/); rmSync(f.record.path, { recursive: true }); renameSync(saved, f.record.path);
  renameSync(f.record.path, saved); symlinkSync(saved, f.record.path, "junction");
  await assert.rejects(finish(), /unmanaged|symlink/i); unlinkSync(f.record.path); renameSync(saved, f.record.path);
  const nested = join(f.record.path, "ignored", "nested"); symlinkSync(root, nested, "junction");
  await assert.rejects(finish(), /symlink/i); unlinkSync(nested);
  mkdirSync(join(f.record.path, "ignored", ".git")); await assert.rejects(finish(), /Nested Git/);
  rmSync(join(f.record.path, "ignored", ".git"), { recursive: true });
  writeFileSync(join(f.repo, ".git", "index.lock"), "lock"); await assert.rejects(finish(), /Locked/); unlinkSync(join(f.repo, ".git", "index.lock"));
  assert.deepEqual(readFileSync(f.receipt), receipt); assert.equal(f.tip(), tip);
  console.log("PASS: migrated residual cleanup preserves changed backup/source, ignored additions, file/directory replacements, junctions, nested Git and Git locks");
  let mutated = false;
  faults.afterFs = (op, path) => { if (!mutated && op === "unlink" && path.startsWith(f.record.path)) { mutated = true; writeFileSync(added, "after checked delete"); } };
  await assert.rejects(finish(), /changed|added/); faults.afterFs = undefined;
  assert.ok(mutated); assert.equal(readFileSync(added, "utf8"), "after checked delete");
  assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
  unlinkSync(added); assert.equal(await finish(), tip);
  assert.equal(existsSync(f.record.path), false); assert.deepEqual(readFileSync(f.receipt), receipt);
  assert.ok(existsSync(backup)); assert.equal(existsSync(f.recordFile), false);
  console.log("PASS: existing legacy evidence rechecks each residual deletion, resumes partial removal without reintegration, and remains archived/read-only with no GC");
} finally { dispose(); }
