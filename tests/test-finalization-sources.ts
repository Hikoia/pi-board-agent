// All refs, worktrees, hooks and faults are in isolated offline fixtures.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calls, dispose, faults, fixture, git } from "./cleanup-fixture.js";

function remoteCommit(
  f: Awaited<ReturnType<typeof fixture>>,
  parent: string,
  file: string,
  content: string,
) {
  const path = join(f.repo, ".pi", "remote-author");
  git(f.repo, "worktree", "add", "--detach", path, parent);
  writeFileSync(join(path, file), content);
  git(path, "add", ".");
  git(path, "commit", "-m", "remote change");
  const sha = git(path, "rev-parse", "HEAD");
  git(path, "push", "origin", `${sha}:refs/heads/${f.task.taskBranch}`);
  git(f.repo, "worktree", "remove", path);
  return sha;
}

try {
  for (const strategy of ["merge", "squash"] as const) {
    for (const shape of [
      "local-only",
      "remote-only",
      "equal",
      "local-ahead",
      "remote-ahead",
      "diverged",
    ] as const) {
      const f = await fixture();
      let local = f.taskSha,
        remote: string | null = f.taskSha;
      if (shape === "remote-ahead" || shape === "diverged")
        remote = remoteCommit(f, f.taskSha, "remote.txt", "remote content\n");
      if (shape === "local-ahead" || shape === "diverged") {
        writeFileSync(join(f.record.path, "local.txt"), "local content\n");
        git(f.record.path, "add", ".");
        git(f.record.path, "commit", "-m", "local change");
        local = git(f.record.path, "rev-parse", "HEAD");
      }
      if (shape === "local-only") {
        git(f.repo, "push", "origin", "--delete", f.task.taskBranch);
        remote = null;
      }
      if (shape === "remote-only") {
        git(f.repo, "worktree", "remove", f.record.path);
        git(
          f.repo,
          "update-ref",
          "-d",
          `refs/heads/${f.task.taskBranch}`,
          local,
        );
        rmSync(f.recordFile);
      }
      const index =
        shape === "remote-only"
          ? undefined
          : readFileSync(join(f.admin, "index"));
      // Cut after receipt publication, before ANY deletion, and inspect immutable sources.
      faults.beforeGit = (args) => {
        if (args[0] === "fetch" && existsSync(f.receipt))
          throw new Error("receipt cut");
      };
      await assert.rejects(f.finish(strategy), /receipt cut/);
      faults.beforeGit = undefined;
      const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      assert.equal(receipt.schemaVersion, 2);
      assert.equal(receipt.taskSha, local);
      assert.equal(receipt.remoteTaskSha, remote);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
      if (index) {
        assert.deepEqual(readFileSync(join(f.admin, "index")), index);
        assert.equal(git(f.record.path, "rev-parse", "HEAD"), local);
      }
      const result = f.tip();
      assert.equal(git(f.repo, "show", `${result}:feature.txt`), "feature");
      if (["local-ahead", "diverged"].includes(shape))
        assert.equal(
          git(f.repo, "show", `${result}:local.txt`),
          "local content",
        );
      if (["remote-ahead", "diverged"].includes(shape))
        assert.equal(
          git(f.repo, "show", `${result}:remote.txt`),
          "remote content",
        );
      if (strategy === "merge") {
        git(f.repo, "merge-base", "--is-ancestor", local, result);
        if (remote) git(f.repo, "merge-base", "--is-ancestor", remote, result);
      } else
        assert.equal(git(f.repo, "show", "-s", "--format=%P", result), f.base);
      calls.length = 0;
      assert.equal(await f.finish(strategy), result);
      assert.ok(
        !calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])),
      );
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), undefined);
      assert.equal(existsSync(f.record.path), false);
      assert.equal(existsSync(f.receipt), false);
      console.log(
        `PASS: ${strategy}/${shape} preserves both sources and the original worktree/index, publishes exact v2 evidence and resumes cleanup-only`,
      );
    }
  }

  for (const strategy of ["merge", "squash"] as const) {
    const f = await fixture();
    remoteCommit(f, f.taskSha, "remote.txt", "remote\n");
    writeFileSync(join(f.record.path, "local.txt"), "local\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "local");
    faults.beforeFs = (op, path) => {
      if (op === "link" && path.startsWith(f.receipt))
        throw new Error("publish cut");
    };
    await assert.rejects(f.finish(strategy), /publish cut/);
    faults.beforeFs = undefined;
    const integrated = f.tip();
    assert.equal(existsSync(f.receipt), false);
    assert.equal(
      await f.finish(strategy),
      integrated,
      "retry before receipt cannot duplicate integration",
    );
    console.log(
      `PASS: ${strategy} divergent-source retry before receipt uses source ancestry/tree equality, not temporary commit identity`,
    );
  }

  {
    const f = await fixture();
    const remote = remoteCommit(f, f.taskSha, "base.txt", "remote edit\n");
    writeFileSync(join(f.record.path, "base.txt"), "local edit\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "conflict");
    const local = git(f.record.path, "rev-parse", "HEAD"),
      index = readFileSync(join(f.admin, "index"));
    calls.length = 0;
    await assert.rejects(
      f.finish(),
      (error: any) =>
        error.repairable === false && /sources conflict/.test(error.message),
    );
    assert.equal(f.tip(), f.base);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), remote);
    assert.deepEqual(readFileSync(join(f.admin, "index")), index);
    assert.ok(
      !calls.some((a) => ["commit-tree", "push", "update-ref"].includes(a[0])),
    );
    console.log(
      "PASS: divergent-source conflict never pushes, deletes, changes the original index/ref or authorizes repair",
    );
  }

  for (const drift of ["changed", "new"] as const) {
    const f = await fixture();
    if (drift === "new")
      git(f.repo, "push", "origin", "--delete", f.task.taskBranch);
    faults.beforeGit = (args) => {
      if (args[0] === "fetch" && existsSync(f.receipt))
        throw new Error("receipt cut");
    };
    await assert.rejects(f.finish(), /receipt cut/);
    faults.beforeGit = undefined;
    const bytes = readFileSync(f.receipt),
      base = f.tip();
    const newer = git(
      f.repo,
      "commit-tree",
      `${f.taskSha}^{tree}`,
      "-p",
      f.taskSha,
      "-m",
      "racing ref",
    );
    git(f.repo, "push", "origin", `${newer}:refs/heads/${f.task.taskBranch}`);
    await assert.rejects(f.finish(), /unmerged work/);
    assert.equal(f.tip(), base);
    assert.deepEqual(readFileSync(f.receipt), bytes);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), newer);
    assert.ok(existsSync(f.record.path));
    console.log(
      `PASS: v2 receipt refuses ${drift} remote ref even with identical content; exact evidence stays unchanged`,
    );
  }

  {
    const f = await fixture();
    faults.beforeGit = (args) => {
      if (args[0] === "fetch" && existsSync(f.receipt))
        throw new Error("receipt cut");
    };
    await assert.rejects(f.finish(), /receipt cut/);
    faults.beforeGit = undefined;
    const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
    receipt.schemaVersion = 1;
    delete receipt.remoteTaskSha;
    writeFileSync(f.receipt, JSON.stringify(receipt));
    const bytes = readFileSync(f.receipt),
      result = f.tip();
    faults.beforeGit = (args) => {
      if (args[0] === "push") {
        assert.deepEqual(readFileSync(f.receipt), bytes);
        throw new Error("legacy lease cut");
      }
    };
    await assert.rejects(f.finish(), /legacy lease cut/);
    faults.beforeGit = undefined;
    calls.length = 0;
    assert.equal(await f.finish(), result);
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    console.log(
      "PASS: strict v1 receipt resumes under its original rules without rewriting evidence or reintegration",
    );
  }
  {
    const f = await fixture();
    git(f.repo, "worktree", "remove", f.record.path);
    git(
      f.repo,
      "update-ref",
      "-d",
      `refs/heads/${f.task.taskBranch}`,
      f.taskSha,
    );
    const newer = git(
      f.repo,
      "commit-tree",
      `${f.taskSha}^{tree}`,
      "-p",
      f.taskSha,
      "-m",
      "competing local ref",
    );
    const record = readFileSync(f.recordFile);
    faults.beforeGit = (args) => {
      if (args[0] === "update-ref" && args.at(-1) === "0".repeat(40)) {
        faults.beforeGit = undefined;
        git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer);
      }
    };
    await assert.rejects(f.finish(), /update-ref/);
    faults.beforeGit = undefined;
    assert.equal(f.store.localBranchSha(f.task.taskBranch), newer);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(f.tip(), f.base);
    assert.deepEqual(readFileSync(f.recordFile), record);
    assert.equal(existsSync(f.receipt), false);
    console.log(
      "PASS: remote-only compare-and-create never overwrites a racing local ref",
    );
  }
} finally {
  dispose();
}
