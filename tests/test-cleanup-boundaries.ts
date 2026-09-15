import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, dispose } from "./cleanup-fixture.js";
import { cleanupBoundaryChecks } from "./cleanup-boundary-checks.js";
try {
  await cleanupBoundaryChecks("remote deletion");
  {
    const f = await integrationFixture();
    const unknown = join(f.record.path, "new-user-data.txt");
    faults.afterGit = (a, r) => {
      if (a[0] !== "worktree" || a[1] !== "remove") return;
      assert.ok(r.ok); faults.afterGit = undefined;
      assert.equal(existsSync(f.admin), false);
      mkdirSync(f.record.path); writeFileSync(unknown, "late external data\n");
    };
    await f.tick(); const result = f.tip();
    assert.equal(f.store.read(f.task.itemId)?.retry?.stage, "cleanup");
    calls.length = 0; await f.tick();
    assert.equal(readFileSync(unknown, "utf8"), "late external data\n");
    assert.ok(existsSync(f.recordFile)); assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(f.tip(), result); assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.ready);
    assert.ok(!calls.some((a) => ["clean", "merge-tree", "commit-tree", "update-ref", "worktree"].includes(a[0]) &&
      !(a[0] === "worktree" && a[1] === "list")));
    console.log("PASS: late external data after actual native removal stays unregistered and preserved with record/local ref; no preprocessing, reintegration or invented recovery evidence");
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
