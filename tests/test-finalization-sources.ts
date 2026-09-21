// Both main completion sources survive the v4 journal/native-cleanup refactor.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calls, dispose, faults, fixture, git } from "./cleanup-fixture.js";
import { historicalReceipt, migrateCleanup } from "./legacy-cleanup-fixture.js";

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
function cutCleanup(f: Awaited<ReturnType<typeof fixture>>) {
  faults.beforeGit = (args) => {
    if (
      args[0] === "fetch" &&
      f.store.read(f.task.itemId)?.retry?.stage === "cleanup"
    )
      throw new Error("cleanup cut");
  };
}
try {
  for (const shape of [
    "local-only",
    "remote-only",
    "unrecorded",
    "equal",
    "local-ahead",
    "remote-ahead",
    "diverged",
  ] as const) {
    const f = await fixture(false, true);
    f.store.update(f.task.itemId, (r) => ({
      ...r,
      reviewedTaskSha: undefined,
    }));
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
    const unrecorded = shape === "remote-only" || shape === "unrecorded";
    if (unrecorded) {
      git(f.repo, "worktree", "remove", f.record.path);
      if (shape === "remote-only")
        git(
          f.repo,
          "update-ref",
          "-d",
          `refs/heads/${f.task.taskBranch}`,
          local,
        );
      rmSync(f.recordFile);
    }
    const index = unrecorded ? undefined : readFileSync(join(f.admin, "index"));
    cutCleanup(f);
    await assert.rejects(f.finish("merge"), /cleanup cut/);
    faults.beforeGit = undefined;
    const record = f.store.read(f.task.itemId)!;
    assert.equal(record.schemaVersion, 5);
    assert.equal(record.integration?.taskSha, local);
    assert.equal(record.integration?.remoteTaskSha, remote);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
    if (index) {
      assert.deepEqual(readFileSync(join(f.admin, "index")), index);
      assert.equal(git(f.record.path, "rev-parse", "HEAD"), local);
    }
    const result = f.tip();
    assert.equal(git(f.repo, "show", `${result}:feature.txt`), "feature");
    if (["local-ahead", "diverged"].includes(shape))
      assert.equal(git(f.repo, "show", `${result}:local.txt`), "local content");
    if (["remote-ahead", "diverged"].includes(shape))
      assert.equal(
        git(f.repo, "show", `${result}:remote.txt`),
        "remote content",
      );
    git(f.repo, "merge-base", "--is-ancestor", local, result);
    if (remote) git(f.repo, "merge-base", "--is-ancestor", remote, result);
    calls.length = 0;
    assert.equal(await f.finish("merge"), result);
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), undefined);
    assert.equal(existsSync(f.record.path), false);
    assert.equal(existsSync(f.recordFile), false);
    assert.equal(existsSync(f.receipt), false);
    console.log(
      `PASS: ${shape} integrates both exact sources without review/record prerequisites, preserves task index, and retries native cleanup without another merge`,
    );
  }
  {
    const f = await fixture(false, true);
    remoteCommit(f, f.taskSha, "remote.txt", "remote\n");
    writeFileSync(join(f.record.path, "local.txt"), "local\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "local");
    faults.beforeGit = (a) => {
      if (a[0] === "push" && a.at(-1)?.endsWith(`:refs/heads/${f.task.taskBranch}`))
        throw new Error("before push");
    };
    await assert.rejects(f.finish(), /before push/);
    faults.beforeGit = undefined;
    const result = (f.store.read(f.task.itemId)!.integration as import("../src/ticket-worktree.js").TicketPullRequestIntegration).preparedHeadSha;
    calls.length = 0;
    assert.ok(await f.finish());
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    console.log(
      "PASS: divergent sources retain the same prepared result across a pre-push failure",
    );
  }
  {
    const f = await fixture(false, true);
    const remote = remoteCommit(f, f.taskSha, "remote.txt", "remote content\n");
    writeFileSync(join(f.record.path, "base.txt"), "local change\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "local change");
    const local = git(f.record.path, "rev-parse", "HEAD");
    writeFileSync(join(f.repo, "base.txt"), "future base conflict\n");
    git(f.repo, "add", "base.txt");
    git(f.repo, "commit", "-m", "base advance");
    const advanced = git(f.repo, "rev-parse", "HEAD");
    faults.beforeGit = (a) => {
      if (a[0] === "push" && a.at(-1)?.endsWith(`:refs/heads/${f.task.taskBranch}`)) {
        faults.beforeGit = undefined;
        git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
        throw new Error("offline task push cut");
      }
    };
    await assert.rejects(f.finish(), /push/);
    const prepared = f.store.read(f.task.itemId)!.integration;
    await assert.rejects(f.finish(), /merge-tree/);
    assert.deepEqual(f.store.read(f.task.itemId)!.integration, prepared);
    assert.equal(f.store.read(f.task.itemId)!.integration?.kind, "pr");
    assert.equal(f.tip(), advanced);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), (prepared as import("../src/ticket-worktree.js").TicketPullRequestIntegration).preparedHeadSha);
    console.log(
      "PASS: a later base conflict with combined sources retains both pins and never converts unrepairable integration into an automatic build retry",
    );
  }
  {
    const f = await fixture(false, true);
    const remote = remoteCommit(f, f.taskSha, "base.txt", "remote edit\n");
    writeFileSync(join(f.record.path, "base.txt"), "local edit\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "conflict");
    const local = git(f.record.path, "rev-parse", "HEAD"),
      index = readFileSync(join(f.admin, "index"));
    calls.length = 0;
    await assert.rejects(
      f.finish(),
      (e: any) => e.repairable === false && /sources conflict/.test(e.message),
    );
    assert.equal(f.tip(), f.base);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), remote);
    assert.deepEqual(readFileSync(join(f.admin, "index")), index);
    assert.ok(
      !calls.some((a) => ["commit-tree", "push", "update-ref"].includes(a[0])),
    );
    console.log(
      "PASS: divergent-source conflict preserves both refs and original index, never authorizing a repair builder",
    );
  }
  for (const drift of ["changed", "new"] as const) {
    const f = await fixture(false, true);
    if (drift === "new")
      git(f.repo, "push", "origin", "--delete", f.task.taskBranch);
    cutCleanup(f);
    await assert.rejects(f.finish(), /cleanup cut/);
    faults.beforeGit = undefined;
    const integration = f.store.read(f.task.itemId)!.integration,
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
    git(f.repo, "push", "--force", "origin", `${newer}:refs/heads/${f.task.taskBranch}`); // explicit external rewrite fixture
    await assert.rejects(f.finish(), /does not cover|source|Remote task ref changed/i);
    assert.equal(f.tip(), base);
    assert.deepEqual(f.store.read(f.task.itemId)!.integration, integration);
    assert.equal(await f.store.remoteBranchSha(f.task.taskBranch), newer);
    assert.ok(existsSync(f.record.path));
    console.log(
      `PASS: cleanup refuses a ${drift} remote source even with identical content, retaining exact integration evidence`,
    );
  }
  for (const version of [1, 2]) {
    const f = await fixture();
    await historicalReceipt(f);
    if (version === 2) {
      const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      writeFileSync(
        f.receipt,
        JSON.stringify({
          ...receipt,
          schemaVersion: 2,
          remoteTaskSha: f.taskSha,
        }),
      );
    }
    const bytes = readFileSync(f.receipt),
      finish = await migrateCleanup(f),
      result = f.tip();
    calls.length = 0;
    assert.equal(await finish(), result);
    assert.deepEqual(readFileSync(f.receipt), bytes);
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    console.log(
      `PASS: legacy v${version} receipt resumes cleanup-only without rewriting its original evidence`,
    );
  }
  {
    const f = await fixture(false, true);
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
    faults.beforeGit = (a) => {
      if (a[0] === "update-ref" && a.at(-1) === "0".repeat(40)) {
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
    console.log(
      "PASS: remote-only compare-and-create never overwrites a racing local ref or creates a builder/worktree",
    );
  }
} finally {
  dispose();
}
