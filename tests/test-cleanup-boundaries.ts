import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, git, dispose } from "./cleanup-fixture.js";
try {
  for (const race of ["dirty", "lock", "local", "base"] as const) {
    const f = await integrationFixture(); let result = "";
    const file = join(f.record.path, "feature.txt");
    faults.afterGit = (a, r) => {
      if (a[0] !== "push" || !a.some((s) => s.startsWith(":refs/heads/task/"))) return;
      assert.ok(r.ok); faults.afterGit = undefined; result = f.tip();
      if (race === "dirty") writeFileSync(file, "new uncommitted user code\n");
      if (race === "lock") writeFileSync(join(f.admin, "index.lock"), "new operation");
      if (race === "local") {
        const newer = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.taskSha, "-m", "new local work");
        git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer, f.taskSha);
      }
      if (race === "base") git(f.origin, "update-ref", "refs/heads/main", f.base);
    };
    calls.length = 0; await f.tick();
    assert.ok(result); assert.ok(existsSync(f.record.path), f.notices.join("\n"));
    assert.ok(!calls.some((a) => a[0] === "worktree" && a[1] === "remove"));
    assert.ok(existsSync(f.recordFile)); assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.ready);
    if (race === "dirty") { assert.equal(readFileSync(file, "utf8"), "new uncommitted user code\n"); writeFileSync(file, "feature\n"); }
    if (race === "lock") unlinkSync(join(f.admin, "index.lock"));
    if (race === "local") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    if (race === "base") git(f.origin, "update-ref", "refs/heads/main", result);
    calls.length = 0; await f.tick();
    assert.equal(existsSync(f.record.path), false, f.notices.join("\n"));
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    console.log(`PASS: ${race} race during remote deletion await blocks native removal; cleanup-only retry preserves code/locks/refs/approval and never remerges`);
  }
  {
    const f = await integrationFixture();
    const before = readFileSync(f.recordFile); f.card.assignees = ["maintainer"];
    calls.length = 0; await f.tick();
    assert.deepEqual(readFileSync(f.recordFile), before); assert.equal(f.tip(), f.base); assert.deepEqual(f.writes, []);
    f.card.assignees = [];
    faults.beforeGit = (a) => { if (a[0] === "merge-tree") { faults.beforeGit = undefined; f.card.body = "new requirements"; } };
    await f.tick(); assert.equal(f.tip(), f.base); assert.deepEqual(f.writes, []);
    assert.ok(existsSync(f.record.path)); assert.equal(f.store.read(f.task.itemId)?.integration, undefined);
    console.log("PASS: foreign claim and fresh requirements changes are not technical failures and cannot be overwritten or pushed");
  }
} finally { dispose(); }
