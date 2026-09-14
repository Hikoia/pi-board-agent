import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, git, dispose } from "./cleanup-fixture.js";
const { legacyReceipt } = await import("./legacy-cleanup-fixture.js");
try {
  for (const missing of ["remote", "local", "path", "record", "residual", "admin"] as const) {
    const f = await integrationFixture(true);
    try {
      const receipt = await legacyReceipt(f, { strategy: "squash", backup: missing === "residual" });
      const bytes = readFileSync(f.receipt), original = readFileSync(f.recordFile);
      if (missing === "remote" || missing === "record") git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
      if (missing === "local") git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      if (missing === "path" || missing === "record") git(f.repo, "worktree", "remove", f.record.path);
      if (missing === "record") { git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha); unlinkSync(f.recordFile); f.card.status = f.cfg.columns.ready; }
      if (missing === "residual") f.vanish();
      if (missing === "admin") { rmSync(f.record.path, { recursive: true }); unlinkSync(`${f.admin}/gitdir`); }
      calls.length = 0;
      await f.tick();
      assert.equal(existsSync(f.recordFile), false, f.notices.join("\n"));
      assert.equal(existsSync(f.record.path), false); assert.equal(existsSync(f.admin), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(f.tip(), receipt.resultSha); assert.deepEqual(readFileSync(f.receipt), bytes);
      if (missing !== "record") assert.deepEqual(readFileSync(f.recordFile + ".v3.bak"), original);
      assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
      calls.length = 0;
      await f.tick(); await f.tick();
      assert.equal(existsSync(f.recordFile), false, "read-only receipt must not resurrect completed work on restart");
      assert.deepEqual(readFileSync(f.receipt), bytes); assert.equal(f.tip(), receipt.resultSha);
      console.log(`PASS: legacy squash receipt missing ${missing}: original result, native/positively verified residual cleanup, immutable evidence; restarts do not re-adopt completion`);
    } finally { f.ownerLock!.release(); }
  }
  {
    const f = await integrationFixture(true);
    try {
      git(f.repo, "worktree", "remove", f.record.path); unlinkSync(f.recordFile);
      const receipt = await legacyReceipt(f, { nullRecord: true });
      await f.tick(); assert.equal(existsSync(f.recordFile), false, f.notices.join("\n"));
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined); assert.equal(f.tip(), receipt.resultSha);
      await f.tick(); assert.equal(existsSync(f.recordFile), false);
      assert.equal(existsSync(f.recordFile + ".v3.bak"), false);
      console.log("PASS: null-record old receipt restores only cleanup identity, removes the last ref and never fabricates a backup or re-adopts completion");
    } finally { f.ownerLock!.release(); }
  }
} finally { dispose(); }
