// Ported from integration/ticket-simplification onto the v4 fixture.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, git, dispose } from "./cleanup-fixture.js";
try {
  for (const race of ["file", "directory", "parent", "ignore rule"] as const) {
    const f = await fixture(false, true), ignored = join(f.record.path, "ignored"), link = join(ignored, "link");
    const outside = join(f.repo, ".pi/external"); mkdirSync(outside); git(outside, "init");
    const target = join(outside, "keep.txt"); writeFileSync(target, "external data\n");
    const head = readFileSync(join(outside, ".git/HEAD"));
    let scanned = false, changed = false;
    // Introduce a real late link after native clean; never traverse its target.
    faults.afterGit = (a) => {
      if (a[0] !== "clean") return;
      faults.afterGit = undefined;
      assert.equal(existsSync(ignored), false);
      mkdirSync(ignored);
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      faults.afterFs = (op, path) => { if (op === "readdir" && path === ignored) scanned = true; };
    };
    calls.length = 0;
    await assert.rejects(f.store.finalizeAccepted(f.task, "merge", async () => {
      if (!scanned || changed) return;
      changed = true; faults.afterFs = undefined;
      if (race === "file" || race === "directory") {
        unlinkSync(link);
        if (race === "file") writeFileSync(link, "replacement data\n");
        else { mkdirSync(link); writeFileSync(join(link, "new.txt"), "replacement data\n"); }
      } else if (race === "parent") {
        renameSync(ignored, join(f.repo, ".pi/saved-ignored"));
        symlinkSync(outside, ignored, process.platform === "win32" ? "junction" : "dir");
      } else writeFileSync(join(f.record.path, ".gitignore"), ".pi/\nnode_modules/\n");
    }), /Ignored link changed|symbolic link|Dirty worktree/i);
    assert.ok(changed, "race occurs after metadata scan");
    assert.equal(readFileSync(target, "utf8"), "external data\n");
    assert.deepEqual(readFileSync(join(outside, ".git/HEAD")), head);
    if (race === "file") assert.equal(readFileSync(link, "utf8"), "replacement data\n");
    if (race === "directory") assert.equal(readFileSync(join(link, "new.txt"), "utf8"), "replacement data\n");
    if (race === "parent") assert.ok(lstatSync(ignored).isSymbolicLink());
    if (race === "ignore rule") assert.ok(lstatSync(link).isSymbolicLink());
    assert.ok(existsSync(join(f.record.path, ".git"))); assert.ok(existsSync(f.admin));
    assert.equal(await f.store.remoteSha(f.task.taskBranch), f.taskSha);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(f.store.read(f.task.itemId)?.retry?.stage, "cleanup");
    assert.ok(!calls.some((a) => a[0] === "worktree" && a[1] === "remove"));
    assert.equal(existsSync(f.receipt), false);
    console.log(`PASS: ignored link ${race} race preserves replacement/external data and registered ownership/record/refs before native removal`);
  }
} finally { dispose(); }
