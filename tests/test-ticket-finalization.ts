import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  fixture,
  git,
  calls,
  faults,
  dispose,
} from "./finalization-fixture.js";
const taskPush = (a: string[]) => a[0] === "push" && !a.at(-1)!.startsWith(":");
const remoteDelete = (a: string[]) =>
  a[0] === "push" && a.some((s) => s.startsWith(":refs/heads/task/"));
const remove = (a: string[]) => a[0] === "worktree" && a[1] === "remove";
const localDelete = (a: string[]) => a[0] === "update-ref" && a.includes("-d");
try {
  {
    const f = await fixture();
    writeFileSync(join(f.repo, "base.txt"), "uncommitted main work\n");
    writeFileSync(join(f.repo, "main-untracked.txt"), "keep\n");
    const head = git(f.repo, "rev-parse", "HEAD"),
      index = readFileSync(join(f.repo, ".git", "index"));
    calls.length = 0;
    faults.beforeGit = (args) => {
      if (taskPush(args)) {
        const state = f.prNow();
        assert.ok(state, "integration is atomically durable BEFORE push");
        assert.ok(args.includes(`${state.preparedHeadSha}:refs/heads/${f.task.taskBranch}`));
        assert.equal(
          git(f.repo, "show", "-s", "--format=%P", state.preparedHeadSha),
          `${f.base} ${f.taskSha}`,
        );
      }
      if (remoteDelete(args)) assert.ok(existsSync(f.record.path));
      if (remove(args))
        assert.equal(
          git(f.repo, "ls-remote", "origin", `refs/heads/${f.task.taskBranch}`),
          "",
        );
      if (localDelete(args)) {
        assert.equal(existsSync(f.record.path), false);
        assert.ok(f.store.has(f.task.itemId));
      }
    };
    const outcome = await f.finish();
    assert.equal(outcome.status, "finalized", JSON.stringify(outcome));
    assert.equal(git(f.repo, "rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(f.repo, ".git", "index")), index);
    assert.equal(
      readFileSync(join(f.repo, "base.txt"), "utf8"),
      "uncommitted main work\n",
    );
    assert.equal(
      readFileSync(join(f.repo, "main-untracked.txt"), "utf8"),
      "keep\n",
    );
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(
      existsSync(f.record.path),
      false,
      "ignored files are discardable by normal remove",
    );
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1);
    assert.ok(calls.findIndex(remoteDelete) < calls.findIndex(remove));
    assert.ok(calls.findIndex(remove) < calls.findIndex(localDelete));
    assert.equal(f.starts(), 0);
    assert.equal(f.reviews(), 0);
    f.noNewEvidence();
    console.log(
      "PASS: native merge has base/task parents, saves before normal push, preserves dirty main/index, orders expected-SHA cleanup, discards ignored files and creates no receipts/snapshots",
    );
  }
  {
    const f = await fixture();
    calls.length = 0;
    faults.afterGit = (args) => {
      if (taskPush(args)) {
        faults.afterGit = undefined;
        throw new Error("offline accepted push with lost response");
      }
    };
    await f.loop.tickNow();
    const result = f.prNow().preparedHeadSha;
    assert.equal(f.tip(), f.base);
    assert.equal(f.card.status, f.cfg.columns.done);
    assert.equal(f.card.closed, true);
    assert.equal(existsSync(f.record.path), true);
    assert.equal(f.recordNow().retry?.stage, "integrate");
    await f.loop.tickNow();
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(calls.filter(taskPush).length, 1);
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1);
    assert.equal(f.starts(), 0);
    assert.equal(f.reviews(), 0);
    await f.loop.stop();
    f.noNewEvidence();
    console.log(
      "PASS: accepted push/lost response preserves Done and resumes by fresh integration proof, without another merge, push, builder or reviewer",
    );
  }
  {
    const f = await fixture();
    calls.length = 0;
    writeFileSync(join(f.repo, "concurrent.txt"), "independent base change\n");
    git(f.repo, "add", "concurrent.txt");
    git(f.repo, "commit", "-m", "concurrent base advance");
    const advanced = git(f.repo, "rev-parse", "HEAD");
    faults.afterGit = (args) => {
      if (taskPush(args)) {
        faults.afterGit = undefined;
        git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
        throw new Error("lost prepared task push response");
      }
    };
    await f.finish();
    const prepared = f.prNow();
    assert.equal(f.tip(), advanced);
    assert.equal(f.recordNow().retry?.stage, "integrate");
    faults.beforeGit = (args) => { if (args[0] === "fetch") throw new Error("offline cannot observe base"); };
    await f.finish(); assert.deepEqual(f.recordNow().integration, prepared); assert.ok(existsSync(f.record.path));
    faults.beforeGit = undefined;
    const accepted = await f.finish();
    assert.equal(accepted.status, "finalized", JSON.stringify(accepted));
    assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${advanced} ${prepared.preparedHeadSha}`);
    assert.equal(f.events.includes("reopen"), false);
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1);
    assert.equal(calls.filter(taskPush).length, 1);
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0); f.noNewEvidence();
    console.log("PASS: base advance/observation failure retains the identical prepared task head; only a simulated human merges against the fresh base");
  }
  {
    const f = await fixture();
    writeFileSync(join(f.record.path, "base.txt"), "task side\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "task conflict");
    git(f.record.path, "push", "origin", f.task.taskBranch);
    f.store.setReviewedTaskSha(
      f.task.itemId,
      git(f.record.path, "rev-parse", "HEAD"),
    );
    writeFileSync(join(f.repo, "base.txt"), "base side\n");
    git(f.repo, "add", "base.txt");
    git(f.repo, "commit", "-m", "base conflict");
    git(f.repo, "push", "origin", "main");
    calls.length = 0;
    await f.finish();
    assert.equal(f.card.closed, false);
    assert.equal(f.card.status, f.cfg.columns.ready);
    assert.equal(f.recordNow().retry?.stage, "build");
    assert.match(f.comments.join("\n"), /MERGE_HEAD/);
    assert.equal(
      calls.filter((a) => a[0] === "commit-tree" || a[0] === "push").length,
      0,
    );
    assert.equal(f.recordNow().path, f.record.path);
    f.noNewEvidence();
    console.log(
      "PASS: genuine merge-tree conflict reopens Ready with original-branch diagnostics and renewed review/close, without a result commit or push",
    );
  }
  {
    const f = await fixture();
    writeFileSync(join(f.record.path, "base.txt"), "task side\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "approved task");
    git(f.record.path, "push", "origin", f.task.taskBranch);
    const taskSha = git(f.record.path, "rev-parse", "HEAD");
    f.store.setReviewedTaskSha(f.task.itemId, taskSha);
    writeFileSync(join(f.repo, "base.txt"), "base side\n");
    git(f.repo, "add", "base.txt");
    git(f.repo, "commit", "-m", "concurrent conflict");
    const advanced = git(f.repo, "rev-parse", "HEAD");
    calls.length = 0;
    faults.afterGit = (args) => {
      if (taskPush(args)) { faults.afterGit = undefined; git(f.repo, "push", "origin", `${advanced}:refs/heads/main`); }
    };
    assert.equal((await f.finish()).status, "blocked", "simulated human merge cannot resolve a conflict automatically");
    assert.equal((await f.finish()).status, "waiting");
    const pr = f.prNow();
    assert.equal(f.card.closed, true); assert.equal(f.comments.length, 0);
    assert.equal(calls.filter(remoteDelete).length, 0);
    f.card.closed = false; f.card.status = f.cfg.columns.ready;
    await f.finish(); assert.equal(f.prNow().phase, "suspended");
    git(f.record.path, "merge", "--ff-only", pr.preparedHeadSha);
    assert.throws(() => git(f.record.path, "merge", "--no-edit", advanced));
    writeFileSync(join(f.record.path, "base.txt"), "task and base resolved\n");
    git(f.record.path, "add", "base.txt"); git(f.record.path, "commit", "-m", "resolve conflict");
    git(f.record.path, "push", "origin", f.task.taskBranch);
    f.store.setReviewedTaskSha(f.task.itemId, git(f.record.path, "rev-parse", "HEAD"));
    f.card.status = f.cfg.columns.done; f.card.closed = false;
    await f.loop.tickNow(); assert.equal(f.tip(), advanced); assert.ok(f.store.has(f.task.itemId));
    f.card.closed = true; assert.equal((await f.finish()).status, "waiting");
    assert.equal(f.prNow().prNumber, pr.prNumber);
    f.prs.merge(); assert.equal((await f.finish()).status, "finalized");
    await f.loop.stop(); f.noNewEvidence();
    console.log("PASS: published PR conflicts wait without a builder; explicit withdrawal/repair/review/reclose reuse the same PR before human merge");
  }
  for (const step of [
    "remote",
    "local",
    "worktree",
    "done",
    "lost-done",
  ] as const) {
    const f = await fixture();
    calls.length = 0;
    if (step === "done" || step === "lost-done") {
      f.card.status = f.cfg.columns.done;
      f.store.update(f.card.itemId, (r) => ({
        ...r,
        retry: { stage: "integrate", reason: "prior Git retry" },
      }));
    }
    f.failDone(step === "done");
    f.loseDone(step === "lost-done");
    faults.afterGit = (args) => {
      if (
        (step === "remote" && remoteDelete(args)) ||
        (step === "local" && localDelete(args))
      ) {
        faults.afterGit = undefined;
        throw new Error(`offline lost ${step} deletion response`);
      }
    };
    faults.beforeGit = (args) => {
      if (step === "worktree" && remove(args))
        throw new Error("offline worktree remove failed");
    };
    await f.finish();
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(f.recordNow().retry?.stage, "cleanup");
    assert.equal(f.card.closed, true);
    assert.equal(
      existsSync(f.record.path),
      step === "remote" || step === "worktree",
    );
    if (step === "worktree")
      assert.ok(
        f.store.localBranchSha(f.task.taskBranch),
        "normal remove failure never falls back to recursive removal/local deletion",
      );
    faults.beforeGit = faults.afterGit = undefined;
    f.failDone(false);
    f.loseDone(false);
    const result = await f.finish();
    assert.equal(result.status, "finalized", JSON.stringify(result));
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(calls.filter((a) => a[0] === "commit-tree").length, 1);
    assert.equal(calls.filter(taskPush).length, 1);
    assert.equal(f.starts(), 0);
    assert.equal(f.reviews(), 0);
    f.noNewEvidence();
    console.log(
      `PASS: ${step} I/O cut retains record/closed approval and resumes ordered cleanup/Backlog only, with missing refs/path handled safely`,
    );
  }
  for (const kind of [
    "dirty",
    "tracked",
    "locked",
    "admin-lock",
    "unknown-admin",
    "outside",
    "symlink",
    "git-symlink",
    "active",
    "other-owner",
    "unregistered",
  ] as const) {
    const f = await fixture();
    calls.length = 0;
    if (kind === "dirty")
      writeFileSync(
        join(f.record.path, "program.ts"),
        "valuable untracked program",
      );
    if (kind === "tracked")
      writeFileSync(
        join(f.record.path, "feature.txt"),
        "valuable tracked changes",
      );
    if (kind === "locked") git(f.repo, "worktree", "lock", f.record.path);
    if (kind === "admin-lock")
      writeFileSync(join(f.admin, "index.lock"), "occupied");
    if (kind === "unknown-admin")
      mkdirSync(join(f.repo, ".git", "worktrees", "unknown"));
    if (kind === "git-symlink") {
      const pointer = join(f.repo, "saved-git-pointer");
      renameSync(join(f.record.path, ".git"), pointer);
      try {
        symlinkSync(pointer, join(f.record.path, ".git"), "file");
      } catch (error) {
        if (
          process.platform !== "win32" ||
          (error as NodeJS.ErrnoException).code !== "EPERM"
        )
          throw error;
        renameSync(pointer, join(f.record.path, ".git"));
        console.log(
          "SKIP: git-symlink worktree/ownership requires native file symlink privilege (Windows EPERM); remaining safety cases continue",
        );
        continue;
      }
    }
    if (kind === "outside" || kind === "symlink") {
      const outside = join(f.repo, "external");
      git(f.repo, "worktree", "move", f.record.path, outside);
      if (kind === "symlink") symlinkSync(outside, f.record.path, "junction");
    }
    if (kind === "active")
      f.store.setActiveRun(f.task.itemId, "original-active");
    if (kind === "other-owner")
      f.store.createV5({
        ...f.recordNow(),
        schemaVersion: 5,
        itemId: "OTHER",
        issueNumber: 2000,
      }, f.owner, () => {});
    if (kind === "unregistered") f.vanish();
    const result = await f.finish();
    assert.notEqual(result.status, "finalized");
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(f.tip(), f.base);
    assert.ok(f.store.localBranchSha(f.task.taskBranch));
    assert.equal(calls.filter((a) => a[0] === "push").length, 0);
    console.log(
      `PASS: ${kind} worktree/ownership retains original work without push or cleanup`,
    );
  }
  for (const kind of [
    "local",
    "remote",
    "withdraw",
    "retype",
    "claim",
    "record",
    "stop",
  ] as const) {
    const f = await fixture();
    calls.length = 0;
    const newer = git(
      f.repo,
      "commit-tree",
      `${f.taskSha}^{tree}`,
      "-p",
      f.taskSha,
      "-m",
      "concurrent work",
    );
    const commitRemote = () => git(f.repo, "commit-tree", `${newer}^{tree}`, "-p", f.prNow().preparedHeadSha, "-m", "concurrent remote work");
    let allowed = true;
    f.prs.hooks.after = (op) => {
      if (op !== "create") return;
      f.prs.hooks.after = undefined;
      if (kind === "local")
        git(
          f.repo,
          "update-ref",
          `refs/heads/${f.task.taskBranch}`,
          newer,
          f.taskSha,
        );
      if (kind === "remote")
        git(
          f.repo,
          "push",
          "origin",
          `${commitRemote()}:refs/heads/${f.task.taskBranch}`,
        );
      if (kind === "withdraw") f.card.closed = false;
      if (kind === "retype") f.card.type = "Story";
      if (kind === "claim") f.card.assignees = ["human"];
      if (kind === "record")
        f.store.update(f.task.itemId, (r) => ({
          ...r,
          retry: { stage: "integrate", reason: "concurrent replacement" },
        }));
      if (kind === "stop") allowed = false;
    };
    const result = await f.make().finalizeClosed(
      structuredClone(f.card),
      () => true,
      () => allowed,
    );
    assert.notEqual(result.status, "finalized");
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(existsSync(f.record.path), true);
    assert.equal(calls.filter(remoteDelete).length, 0);
    assert.equal(calls.filter(remove).length, 0);
    if (kind === "record")
      assert.equal(f.recordNow().retry?.reason, "concurrent replacement");
    if (
      kind === "retype" ||
      kind === "withdraw" ||
      kind === "claim" ||
      kind === "stop"
    )
      assert.equal(f.comments.length, 0);
    console.log(
      `PASS: concurrent ${kind} change after push prevents cleanup and preserves fresh authority`,
    );
  }
} finally {
  dispose();
}
