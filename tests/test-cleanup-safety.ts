import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, git, dispose } from "./cleanup-fixture.js";
try {
  const f = await integrationFixture();
  const kept = async (pattern: RegExp) => {
    calls.length = 0;
    await assert.rejects(f.finish(), pattern);
    assert.equal(f.tip(), f.base); assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.ok(existsSync(f.record.path)); assert.ok(existsSync(f.recordFile));
    assert.ok(!calls.some((a) => ["push", "commit-tree", "update-ref"].includes(a[0])));
  };
  writeFileSync(join(f.record.path, "feature.txt"), "user edit"); await kept(/Dirty/);
  writeFileSync(join(f.record.path, "feature.txt"), "feature\n");
  writeFileSync(join(f.record.path, "untracked.txt"), "uncommitted"); await kept(/Dirty/); unlinkSync(join(f.record.path, "untracked.txt"));
  git(f.repo, "worktree", "lock", f.record.path); await kept(/locked/i); git(f.repo, "worktree", "unlock", f.record.path);
  for (const lock of [join(f.admin, "index.lock"), join(f.repo, ".git/index.lock"), join(f.repo, ".git/refs/heads", `${f.task.taskBranch}.lock`)]) {
    writeFileSync(lock, "Git operation"); await kept(/Locked/); unlinkSync(lock);
  }
  const index = readFileSync(join(f.admin, "index")); writeFileSync(join(f.admin, "index"), "corrupt");
  await kept(/status/); writeFileSync(join(f.admin, "index"), index);
  for (const nested of ["dotgit", "bare"]) {
    const dir = join(f.record.path, "ignored", nested); mkdirSync(dir);
    if (nested === "dotgit") mkdirSync(join(dir, ".git"));
    else { mkdirSync(join(dir, "objects")); mkdirSync(join(dir, "refs")); writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main"); }
    await kept(/Nested Git/); rmSync(dir, { recursive: true }); // fixture reset only
  }
  const outside = join(f.repo, ".pi/external"); git(f.repo, "worktree", "move", f.record.path, outside);
  symlinkSync(outside, f.record.path, "junction"); await kept(/unmanaged|mismatched/i);
  assert.equal(readFileSync(join(outside, "feature.txt"), "utf8"), "feature\n"); unlinkSync(f.record.path);
  git(f.repo, "worktree", "move", outside, f.record.path);
  const original = readFileSync(f.recordFile);
  writeFileSync(f.recordFile, JSON.stringify({ ...f.record, activeRunId: "active", activeRunStartedAt: 1 })); await kept(/active/);
  writeFileSync(f.recordFile, "{corrupt");
  await assert.rejects(f.finish(), /Corrupt/); assert.equal(f.tip(), f.base); writeFileSync(f.recordFile, original);
  git(f.repo, "symbolic-ref", `refs/heads/${f.task.taskBranch}`, "refs/heads/main");
  await assert.rejects(f.finish(), /symbolic|ownership/); git(f.repo, "update-ref", "--no-deref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
  unlinkSync(f.recordFile); await assert.rejects(f.finish(), /Unknown\/unrecorded/); writeFileSync(f.recordFile, original);
  await assert.rejects(f.store.finalizeAccepted({ ...f.task, taskBranch: "main" }, "merge"), /must differ/);
  console.log("PASS: dirty/untracked, native/worktree/admin/common/ref locks, unreadable index, nested Git, external/junction, active/corrupt/unrecorded records and symbolic/base refs all preserve work before any push");
  await f.tick(); assert.equal(existsSync(f.record.path), false, f.notices.join("\n"));
  assert.equal(existsSync(f.receipt), false); assert.equal(existsSync(join(f.repo, ".pi/board-agent/cleanup-backups")), false);
  console.log("PASS: removing only fixture safety blockers permits native removal of ignored data with no snapshot or backup");

  const residual = await integrationFixture();
  faults.beforeGit = (a) => { if (a[0] === "worktree" && a[1] === "remove") throw new Error("hold remove"); };
  await residual.tick(); faults.beforeGit = undefined;
  const result = residual.tip(); residual.vanish(); calls.length = 0;
  await residual.tick();
  assert.equal(residual.tip(), result); assert.ok(existsSync(residual.record.path));
  assert.equal(residual.store.read(residual.task.itemId)?.retry?.stage, "cleanup");
  assert.ok(!calls.some((a) => ["merge-tree", "commit-tree", "update-ref"].includes(a[0])));
  console.log("PASS: unknown new registration-less leftovers are retained, never recursively erased or promoted to builder work");
} finally { dispose(); }
