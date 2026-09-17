// Both integration-branch cleanup await boundaries on the merged v4 executor.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, git, dispose } from "./finalization-fixture.js";
try {
  for (const boundary of ["ignored clean", "remote deletion"] as const) {
    for (const race of ["dirty", "lock", "local", "base"] as const) {
      const f = await fixture(); let result = "";
      const file = join(f.record.path, "feature.txt");
      faults.afterGit = (a) => {
        if (boundary === "ignored clean" ? a[0] !== "clean" :
          a[0] !== "push" || !a.some((s) => s.startsWith(":refs/heads/task/"))) return;
        faults.afterGit = undefined; result = f.tip();
        if (race === "dirty") writeFileSync(file, "new uncommitted user code\n");
        if (race === "lock") writeFileSync(join(f.admin, "index.lock"), "new operation");
        if (race === "local") {
          const newer = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.taskSha, "-m", "new local work");
          git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer, f.taskSha);
        }
        if (race === "base") git(f.origin, "update-ref", "refs/heads/main", f.base);
      };
      try {
        calls.length = 0; await f.loop.tickNow();
        assert.ok(result, f.notices.join("\n")); assert.ok(existsSync(f.record.path), f.notices.join("\n"));
        assert.ok(!calls.some((a) => a[0] === "worktree" && a[1] === "remove"));
        assert.ok(existsSync(f.recordFile)); assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.ready);
        assert.ok(existsSync(join(f.record.path, ".git"))); assert.ok(existsSync(f.admin));
        if (boundary === "ignored clean") assert.equal(await f.store.remoteSha(f.task.taskBranch), f.taskSha);
        if (race === "dirty") { assert.equal(readFileSync(file, "utf8"), "new uncommitted user code\n"); writeFileSync(file, "feature\n"); }
        if (race === "lock") unlinkSync(join(f.admin, "index.lock"));
        if (race === "local") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
        if (race === "base") git(f.origin, "update-ref", "refs/heads/main", result);
        calls.length = 0; await f.loop.tickNow();
        assert.equal(existsSync(f.record.path), false, f.notices.join("\n"));
        assert.equal(f.card.status, f.cfg.columns.backlog);
        assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
        console.log(`PASS: ${race} race during ${boundary} await blocks removal; cleanup-only retry preserves code/locks/refs/approval and never remerges`);
      } finally { faults.afterGit = undefined; await f.loop.stop(); }
    }
  }
} finally { dispose(); }
