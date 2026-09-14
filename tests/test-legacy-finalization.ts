import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, git, dispose } from "./cleanup-fixture.js";
try {
  for (const strategy of ["merge", "squash"] as const) for (const pushed of [false, true]) {
    const f = await integrationFixture(true);
    try {
      const resultSha = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base,
        ...(strategy === "merge" ? ["-p", f.taskSha] : []), "-m", "old approved result");
      if (pushed) {
        git(f.repo, "push", "origin", `${resultSha}:refs/heads/main`);
        // Later conflicting base edits must never cause the old result to be remerged.
        const later = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", resultSha, "-m", "later base edit");
        git(f.repo, "push", "origin", `${later}:refs/heads/main`);
      }
      const old = { ...f.record, schemaVersion: 3, reviewedTaskSha: f.taskSha,
        finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha, resultSha } };
      writeFileSync(f.recordFile, JSON.stringify(old, null, "\t") + "\r\n"); const original = readFileSync(f.recordFile);
      calls.length = 0; await f.tick();
      assert.equal(existsSync(f.record.path), false, f.notices.join("\n")); assert.equal(existsSync(f.recordFile), false);
      assert.deepEqual(readFileSync(f.recordFile + ".v3.bak"), original);
      git(f.repo, "merge-base", "--is-ancestor", resultSha, "refs/remotes/origin/main");
      assert.ok(!calls.some((a) => a[0] === "commit-tree"));
      assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base);
      await f.tick(); assert.equal(existsSync(f.recordFile), false);
      console.log(`PASS: old ${strategy} ${pushed ? "integrated with later conflicting base" : "prepared before push"}: adopts original result exactly, no new commit or main checkout edit`);
    } finally { f.ownerLock!.release(); }
  }
  for (const converted of [false, true]) {
    const f = await integrationFixture(true);
    try {
      const old = { ...f.record, schemaVersion: 3, finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha } };
      const original = Buffer.from(JSON.stringify(old, null, "\t") + "\r\n");
      writeFileSync(f.recordFile, original);
      if (converted) f.store.publishLegacy({ ...old, schemaVersion: 4, retry: { stage: "integrate", reason: "T002 pre-result seam" } }, original);
      await f.tick();
      assert.equal(existsSync(f.recordFile), false, f.notices.join("\n"));
      assert.deepEqual(readFileSync(f.recordFile + ".v3.bak"), original);
      assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${f.base} ${f.taskSha}`);
      assert.equal(existsSync(join(f.repo, ".pi/board-agent/repair-intent-backups")), false);
      console.log(`PASS: ${converted ? "T002 already-v4" : "v3"} pre-result intent converts with exact original backup and uses ordinary merge-only integration, no new archive`);
    } finally { f.ownerLock!.release(); }
  }
} finally { dispose(); }
