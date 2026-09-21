import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, git, dispose } from "./cleanup-fixture.js";

try {
  for (const kind of ["admin-index", "admin-locked", "common", "ref"] as const)
  for (const afterPush of [false, true]) {
    const f = await fixture(false, true);
    const lock = kind === "admin-index" ? join(f.admin, "index.lock") : kind === "admin-locked" ? join(f.admin, "locked") :
      kind === "common" ? join(f.repo, ".git", "index.lock") : join(f.repo, ".git", "refs", "heads", `${f.task.taskBranch}.lock`);
    if (afterPush) faults.afterGit = (a) => { if (a[0] === "push" && a.at(-1)?.endsWith(`:refs/heads/${f.task.taskBranch}`)) { faults.afterGit = undefined; writeFileSync(lock, "occupied"); } };
    else writeFileSync(lock, "occupied");
    calls.length = 0;
    await assert.rejects(f.finish(), /Locked|locked/);
    assert.ok(existsSync(f.recordFile)); assert.ok(existsSync(f.record.path));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), afterPush ? (f.store.read(f.task.itemId)!.integration as import("../src/ticket-worktree.js").TicketPullRequestIntegration).preparedHeadSha : f.taskSha);
    assert.equal(calls.some((a) => a[0] === "update-ref" || a[0] === "worktree" && a[1] === "remove"), false);
    unlinkSync(lock); const integrated = f.tip(); calls.length = 0;
    assert.ok(await f.finish());
    if (afterPush) { assert.notEqual(f.tip(), integrated); assert.equal(calls.some((a) => a[0] === "commit-tree"), false); }
    console.log(`PASS: ${kind} lock ${afterPush ? "after" : "before"} push blocks cleanup, retains evidence and safely retries after release`);
  }
  {
    const f = await fixture(false, true);
    faults.afterGit = (a) => { if (a[0] === "push" && a.includes(`:refs/heads/${f.task.taskBranch}`)) { faults.afterGit = undefined; git(f.origin, "update-ref", "refs/heads/main", f.base); } };
    await assert.rejects(f.finish(), /no longer|absent|not on origin/);
    assert.ok(existsSync(f.recordFile)); assert.ok(existsSync(f.record.path));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    console.log("PASS: remote base rewrite during cleanup cannot delete the worktree/local retry ref or announce success");
  }
  for (const kind of ["tracked", "untracked"] as const) {
    const f = await fixture(false, true), path = join(f.record.path, kind === "tracked" ? "feature.txt" : "program.ts");
    faults.afterGit = (a) => { if (a[0] === "push" && a.includes(`:refs/heads/${f.task.taskBranch}`)) { faults.afterGit = undefined; writeFileSync(path, "preserve user program"); } };
    calls.length = 0; await assert.rejects(f.finish(), /dirty/);
    assert.equal(readFileSync(path, "utf8"), "preserve user program");
    assert.equal(calls.some((a) => a[0] === "worktree" && a[1] === "remove"), false);
    assert.ok(existsSync(f.recordFile));
    console.log(`PASS: ${kind} program change during remote deletion await vetoes normal worktree removal`);
  }
  {
    const f = await fixture(false, true); let cut = false;
    faults.beforeSyncFs = (op, path, to) => { if (op === "renameSync" && to === f.recordFile && JSON.parse(readFileSync(path, "utf8")).integration) { cut = true; throw new Error("publication refused"); } };
    calls.length = 0; await assert.rejects(f.finish(), /publication refused/);
    assert.ok(cut); assert.equal(calls.some((a) => a[0] === "push"), false);
    assert.ok(existsSync(f.record.path)); faults.beforeSyncFs = undefined;
    await f.finish(); assert.equal(existsSync(f.recordFile), false); assert.equal(existsSync(f.receipt), false);
    console.log("PASS: atomic integration publication failure prevents any push/cleanup and retries without legacy snapshots or receipts");
  }
} finally { dispose(); }
