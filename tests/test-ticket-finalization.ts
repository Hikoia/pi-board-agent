import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, calls, faults, dispose } from "./finalization-fixture.js";
const basePush = (a: string[]) => a[0] === "push" && a.some((s) => s.endsWith(":refs/heads/main"));
const remoteDelete = (a: string[]) => a[0] === "push" && a.some((s) => s.startsWith(":refs/heads/task/"));
const remove = (a: string[]) => a[0] === "worktree" && a[1] === "remove";
const localDelete = (a: string[]) => a[0] === "update-ref" && a.includes("-d");
try {
  {
    const f = await fixture();
    writeFileSync(join(f.repo, "base.txt"), "uncommitted main work\n");
    writeFileSync(join(f.repo, "main-untracked.txt"), "keep\n");
    const head = git(f.repo, "rev-parse", "HEAD"), index = readFileSync(join(f.repo, ".git", "index"));
    calls.length = 0;
    faults.beforeGit = (args) => {
      if (basePush(args)) {
        const state = f.recordNow().integration!;
        assert.ok(state, "integration is atomically durable BEFORE push");
        assert.ok(args.includes(`${state.resultSha}:refs/heads/main`));
        assert.equal(git(f.repo, "show", "-s", "--format=%P", state.resultSha), `${f.base} ${f.taskSha}`);
      }
      if (remoteDelete(args)) assert.ok(existsSync(f.record.path));
      if (remove(args)) assert.equal(git(f.repo, "ls-remote", "origin", `refs/heads/${f.task.taskBranch}`), "");
      if (localDelete(args)) { assert.equal(existsSync(f.record.path), false); assert.ok(f.store.has(f.task.itemId)); }
    };
    const outcome = await f.finish(); assert.equal(outcome.status, "finalized", JSON.stringify(outcome));
    assert.equal(git(f.repo, "rev-parse", "HEAD"), head); assert.deepEqual(readFileSync(join(f.repo, ".git", "index")), index);
    assert.equal(readFileSync(join(f.repo, "base.txt"), "utf8"), "uncommitted main work\n");
    assert.equal(readFileSync(join(f.repo, "main-untracked.txt"), "utf8"), "keep\n");
    assert.equal(f.store.has(f.task.itemId), false); assert.equal(existsSync(f.record.path), false, "ignored files are discardable by normal remove");
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1);
    assert.ok(calls.findIndex(remoteDelete) < calls.findIndex(remove)); assert.ok(calls.findIndex(remove) < calls.findIndex(localDelete));
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0); f.noNewEvidence();
    console.log("PASS: native merge has base/task parents, saves before normal push, preserves dirty main/index, orders expected-SHA cleanup, discards ignored files and creates no receipts/snapshots");
  }
  {
    const f = await fixture(); calls.length = 0;
    faults.afterGit = (args) => { if (basePush(args)) { faults.afterGit = undefined; throw new Error("offline accepted push with lost response"); } };
    await f.loop.tickNow(); const result = f.recordNow().integration!.resultSha;
    assert.equal(f.tip(), result); assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.card.closed, true);
    assert.equal(existsSync(f.record.path), true); assert.equal(f.recordNow().retry?.stage, "integrate");
    await f.loop.tickNow();
    assert.equal(f.store.has(f.task.itemId), false); assert.equal(f.card.status, f.cfg.columns.done);
    assert.equal(calls.filter(basePush).length, 1); assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1);
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0); await f.loop.stop(); f.noNewEvidence();
    console.log("PASS: accepted push/lost response resumes closed Ready by fresh integration proof, without another merge, push, builder or reviewer");
  }
  {
    const f = await fixture(); calls.length = 0;
    const advanced = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "concurrent base advance");
    faults.beforeGit = (args) => { if (basePush(args)) { faults.beforeGit = undefined; git(f.repo, "push", "origin", `${advanced}:refs/heads/main`); } };
    await f.finish(); const prepared = f.recordNow().integration!;
    assert.equal(f.tip(), advanced); assert.equal(f.card.closed, true); assert.equal(f.recordNow().retry?.stage, "integrate");
    const raw = readFileSync(f.recordFile);
    faults.beforeGit = (args) => { if (args[0] === "fetch") throw new Error("offline cannot observe base"); };
    await f.finish(); assert.deepEqual(f.recordNow().integration, prepared); assert.equal(existsSync(f.record.path), true);
    faults.beforeGit = undefined; f.failClaim(true);
    await f.finish(); assert.equal(f.recordNow().integration, undefined); assert.equal(f.recordNow().retry?.stage, "build");
    assert.equal(f.card.closed, true, "failed claim retains unsettled build handoff");
    f.failClaim(false); await f.finish();
    assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.recordNow().reviewedTaskSha, undefined);
    assert.equal(f.recordNow().path, f.record.path); assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1); assert.equal(calls.filter(remoteDelete).length, 0);
    assert.match(f.comments.join("\n"), /renewed manual close/); assert.notDeepEqual(readFileSync(f.recordFile), raw);
    const fresh = { ...f.card, status: f.cfg.columns.done, closed: true }; Object.assign(f.card, fresh);
    // A bypassed build/review cannot reuse the old acceptance.
    const result = await f.finish(); assert.notEqual(result.status, "finalized"); assert.ok(f.store.has(f.task.itemId));
    // Emulate the successful original builder + renewed review, not a second
    // finalizer-created worktree or a fresh branch. Done stays open until close.
    git(f.record.path, "merge", "--no-edit", advanced);
    git(f.record.path, "push", "origin", f.task.taskBranch);
    const renewed = git(f.record.path, "rev-parse", "HEAD");
    f.store.setReviewedTaskSha(f.task.itemId, renewed);
    f.store.update(f.task.itemId, (r) => ({ ...r, retry: undefined }));
    f.card.status = f.cfg.columns.done; f.card.closed = false;
    await f.loop.tickNow(); assert.equal(f.tip(), advanced); assert.ok(f.store.has(f.task.itemId));
    f.card.closed = true;
    const accepted = await f.finish(); assert.equal(accepted.status, "finalized", JSON.stringify(accepted));
    assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${advanced} ${renewed}`);
    await f.loop.stop(); f.noNewEvidence();
    console.log("PASS: base-advance rejected push retains prepared result until fresh observation, then original build/renewed-review/manual-close completes; failed claim cannot reintegrate");
  }
  {
    const f = await fixture();
    writeFileSync(join(f.record.path, "base.txt"), "task side\n"); git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "task conflict"); git(f.record.path, "push", "origin", f.task.taskBranch);
    f.store.setReviewedTaskSha(f.task.itemId, git(f.record.path, "rev-parse", "HEAD"));
    writeFileSync(join(f.repo, "base.txt"), "base side\n"); git(f.repo, "add", "base.txt"); git(f.repo, "commit", "-m", "base conflict"); git(f.repo, "push", "origin", "main");
    calls.length = 0; await f.finish();
    assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.recordNow().retry?.stage, "build");
    assert.match(f.comments.join("\n"), /MERGE_HEAD/); assert.equal(calls.filter((a) => a[0] === "commit-tree" || a[0] === "push").length, 0);
    assert.equal(f.recordNow().path, f.record.path); f.noNewEvidence();
    console.log("PASS: genuine merge-tree conflict reopens Ready with original-branch diagnostics and renewed review/close, without a result commit or push");
  }
  for (const step of ["remote", "local", "worktree", "done", "lost-done"] as const) {
    const f = await fixture(); calls.length = 0;
    if (step === "done" || step === "lost-done") { f.card.status = f.cfg.columns.ready; f.store.update(f.card.itemId, (r) => ({ ...r, retry: { stage: "integrate", reason: "prior Git retry" } })); }
    f.failDone(step === "done"); f.loseDone(step === "lost-done");
    faults.afterGit = (args) => {
      if ((step === "remote" && remoteDelete(args)) || (step === "local" && localDelete(args))) {
        faults.afterGit = undefined; throw new Error(`offline lost ${step} deletion response`);
      }
    };
    faults.beforeGit = (args) => { if (step === "worktree" && remove(args)) throw new Error("offline worktree remove failed"); };
    await f.finish();
    assert.ok(f.store.has(f.task.itemId)); assert.equal(f.recordNow().retry?.stage, "cleanup"); assert.equal(f.card.closed, true);
    assert.equal(existsSync(f.record.path), step === "remote" || step === "worktree");
    if (step === "worktree") assert.ok(f.store.localBranchSha(f.task.taskBranch), "normal remove failure never falls back to recursive removal/local deletion");
    faults.beforeGit = faults.afterGit = undefined; f.failDone(false); f.loseDone(false);
    const result = await f.finish(); assert.equal(result.status, "finalized", JSON.stringify(result));
    assert.equal(f.store.has(f.task.itemId), false); assert.equal(f.card.status, f.cfg.columns.done);
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1); assert.equal(calls.filter(basePush).length, 1);
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0); f.noNewEvidence();
    console.log(`PASS: ${step} I/O cut retains record/closed approval and resumes ordered cleanup/Done only, with missing refs/path handled safely`);
  }
  for (const kind of ["dirty", "tracked", "locked", "admin-lock", "unknown-admin", "outside", "symlink", "git-symlink", "active", "other-owner", "unregistered"] as const) {
    const f = await fixture(); calls.length = 0;
    if (kind === "dirty") writeFileSync(join(f.record.path, "program.ts"), "valuable untracked program");
    if (kind === "tracked") writeFileSync(join(f.record.path, "feature.txt"), "valuable tracked changes");
    if (kind === "locked") git(f.repo, "worktree", "lock", f.record.path);
    if (kind === "admin-lock") writeFileSync(join(f.admin, "index.lock"), "occupied");
    if (kind === "unknown-admin") mkdirSync(join(f.repo, ".git", "worktrees", "unknown"));
    if (kind === "git-symlink") {
      const pointer = join(f.repo, "saved-git-pointer"); renameSync(join(f.record.path, ".git"), pointer);
      symlinkSync(pointer, join(f.record.path, ".git"), "file");
    }
    if (kind === "outside" || kind === "symlink") {
      const outside = join(f.repo, "external"); git(f.repo, "worktree", "move", f.record.path, outside);
      if (kind === "symlink") symlinkSync(outside, f.record.path, "junction");
    }
    if (kind === "active") f.store.setActiveRun(f.task.itemId, "original-active");
    if (kind === "other-owner") f.store.create({ ...f.recordNow(), schemaVersion: 4, itemId: "OTHER", issueNumber: 2000 });
    if (kind === "unregistered") f.vanish();
    const result = await f.finish(); assert.notEqual(result.status, "finalized");
    assert.ok(f.store.has(f.task.itemId)); assert.equal(f.tip(), f.base);
    assert.ok(f.store.localBranchSha(f.task.taskBranch)); assert.equal(calls.filter((a) => a[0] === "push").length, 0);
    console.log(`PASS: ${kind} worktree/ownership retains original work without push or cleanup`);
  }
  for (const kind of ["local", "remote", "withdraw", "retype", "claim", "record", "stop"] as const) {
    const f = await fixture(); calls.length = 0;
    const newer = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.taskSha, "-m", "concurrent work");
    let allowed = true;
    faults.afterGit = (args) => {
      if (!basePush(args)) return; faults.afterGit = undefined;
      if (kind === "local") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer, f.taskSha);
      if (kind === "remote") git(f.repo, "push", "origin", `${newer}:refs/heads/${f.task.taskBranch}`);
      if (kind === "withdraw") f.card.closed = false;
      if (kind === "retype") f.card.type = "Story";
      if (kind === "claim") f.card.assignees = ["human"];
      if (kind === "record") f.store.update(f.task.itemId, (r) => ({ ...r, retry: { stage: "cleanup", reason: "concurrent replacement" } }));
      if (kind === "stop") allowed = false;
    };
    const result = await f.make().finalizeClosed(structuredClone(f.card), () => true, () => allowed);
    assert.notEqual(result.status, "finalized"); assert.ok(f.store.has(f.task.itemId)); assert.equal(existsSync(f.record.path), true);
    assert.equal(calls.filter(remoteDelete).length, 0); assert.equal(calls.filter(remove).length, 0);
    if (kind === "record") assert.equal(f.recordNow().retry?.reason, "concurrent replacement");
    if (kind === "retype" || kind === "withdraw" || kind === "claim" || kind === "stop") assert.equal(f.comments.length, 0);
    console.log(`PASS: concurrent ${kind} change after push prevents cleanup and preserves fresh authority`);
  }
} finally { dispose(); }
