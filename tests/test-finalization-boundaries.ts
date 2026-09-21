import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  fixture,
  git,
  calls,
  faults,
  dispose,
} from "./finalization-fixture.js";
const basePush = (a: string[]) =>
  a[0] === "push" && a.some((s) => s.endsWith(":refs/heads/main"));
const deleting = (a: string[]) =>
  a[0] === "push" && a.some((s) => s.startsWith(":refs/heads/task/"));
try {
  for (const cut of ["prepare-save", "record-delete"] as const) {
    const f = await fixture();
    calls.length = 0;
    faults.beforeSyncFs = (op, path, destination) => {
      if (
        cut === "prepare-save" &&
        op === "renameSync" &&
        destination === f.recordFile &&
        JSON.parse(readFileSync(path, "utf8")).integration
      )
        throw new Error("offline atomic integration publication failure");
      if (
        cut === "record-delete" &&
        op === "unlinkSync" &&
        path === f.recordFile
      ) {
        assert.equal(f.card.status, f.cfg.columns.backlog);
        throw new Error("offline final record unlink failure");
      }
    };
    await f.finish();
    assert.ok(f.store.has(f.task.itemId));
    if (cut === "prepare-save") {
      assert.equal(calls.filter(basePush).length, 0);
      assert.equal(f.recordNow().integration, undefined);
    } else assert.equal(f.recordNow().retry?.stage, "cleanup");
    faults.beforeSyncFs = undefined;
    const result = await f.finish();
    assert.equal(result.status, "finalized", JSON.stringify(result));
    assert.equal(f.store.has(f.task.itemId), false);
    f.noNewEvidence();
    console.log(
      `PASS: ${cut} failure retains retry; push cannot precede atomic save and record deletion cannot precede fresh Project Backlog`,
    );
  }
  {
    const f = await fixture(false, false); await f.finish();
    const prepared = f.prNow();
    f.card.closed = false; f.card.status = f.cfg.columns.ready; await f.finish();
    git(f.record.path, "merge", "--ff-only", prepared.preparedHeadSha);
    git(f.record.path, "commit", "--allow-empty", "-m", "renewed repair");
    const reviewed = git(f.record.path, "rev-parse", "HEAD");
    f.store.setReviewedTaskSha(f.task.itemId, reviewed);
    f.card.closed = true; f.card.status = f.cfg.columns.done; calls.length = 0;
    faults.beforeSyncFs = (op, path, destination) => {
      if (op === "renameSync" && destination === f.recordFile && JSON.parse(readFileSync(path, "utf8")).integration?.phase === "prepared")
        throw new Error("offline renewed preparation publication failure");
    };
    await f.finish();
    assert.equal(f.prNow().preparedHeadSha, prepared.preparedHeadSha); assert.equal(f.prNow().phase, "suspended");
    assert.equal(f.recordNow().reviewedTaskSha, reviewed); assert.equal(f.recordNow().retry?.stage, "integrate");
    assert.equal(calls.filter(a => a[0] === "push").length, 0);
    faults.beforeSyncFs = undefined;
    assert.equal((await f.finish()).status, "waiting"); assert.equal(f.prNow().prNumber, prepared.prNumber);
    f.prs.merge(); assert.equal((await f.finish()).status, "finalized");
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
    console.log("PASS: failed atomic renewal retains suspended source/PR identity; unpublished replacement is never pushed, and renewed approval reuses the PR");
  }
  for (const cut of [
    "remote-lease",
    "local-cas",
    "remote-reappears",
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
      "concurrent retained work",
    );
    faults.beforeGit = (a) => {
      if (cut === "remote-lease" && deleting(a)) {
        faults.beforeGit = undefined;
        git(
          f.repo,
          "push",
          "--force",
          "origin",
          `${newer}:refs/heads/${f.task.taskBranch}`,
        );
      }
      if (cut === "local-cas" && a[0] === "update-ref" && a.includes("-d")) {
        faults.beforeGit = undefined;
        git(
          f.repo,
          "update-ref",
          `refs/heads/${f.task.taskBranch}`,
          newer,
          f.taskSha,
        );
      }
    };
    faults.afterGit = (a) => {
      if (cut === "remote-reappears" && deleting(a)) {
        faults.afterGit = undefined;
        git(
          f.repo,
          "push",
          "--force",
          "origin",
          `${newer}:refs/heads/${f.task.taskBranch}`,
        );
      }
    };
    const result = await f.finish();
    assert.notEqual(result.status, "finalized");
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(
      f.store.localBranchSha(f.task.taskBranch),
      cut === "local-cas" ? newer : f.taskSha,
    );
    if (cut !== "local-cas") {
      assert.equal(existsSync(f.record.path), true);
      assert.equal(
        git(
          f.repo,
          "ls-remote",
          "origin",
          `refs/heads/${f.task.taskBranch}`,
        ).split(/\s+/)[0],
        newer,
      );
    }
    console.log(
      `PASS: ${cut} at destructive boundary retains concurrently changed refs/work instead of force deletion`,
    );
  }
  for (const missing of ["directory", "worktree", "refs-and-path"] as const) {
    const f = await fixture();
    faults.beforeGit = (a) => {
      if (deleting(a)) throw new Error("offline retain integrated progress");
    };
    const first = await f.finish();
    assert.equal(f.recordNow().retry?.stage, "cleanup", JSON.stringify(first));
    faults.beforeGit = undefined;
    if (missing === "directory")
      rmSync(f.record.path, { recursive: true }); // simulate vanished directory, Git registration remains
    else git(f.repo, "worktree", "remove", f.record.path);
    if (missing === "refs-and-path") {
      git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
      git(
        f.repo,
        "update-ref",
        "--no-deref",
        "-d",
        `refs/heads/${f.task.taskBranch}`,
        f.taskSha,
      );
    }
    const result = await f.finish();
    assert.equal(result.status, "finalized", JSON.stringify(result));
    assert.equal(f.store.has(f.task.itemId), false);
    console.log(
      `PASS: missing ${missing} resumes from recorded integration with normal Git operations only`,
    );
  }
  for (const prepared of [false, true]) {
    const f = await fixture();
    f.store.update(f.task.itemId, (r) => ({
      ...r,
      reviewedTaskSha: undefined,
    }));
    if (prepared) {
      const tree = git(f.repo, "merge-tree", "--write-tree", f.base, f.taskSha);
      const resultSha = git(
        f.repo,
        "commit-tree",
        tree,
        "-p",
        f.base,
        "-p",
        f.taskSha,
        "-m",
        "human-approved prepared result",
      );
      f.store.recordPullRequestPreparation(f.recordNow(), { scope: { owner: "owner", repo: "repo", base: "main", head: f.task.taskBranch },
        baseSha: f.base, taskSha: f.taskSha, remoteTaskSha: f.taskSha, preparedHeadSha: resultSha }, f.owner, () => {});
    }
    calls.length = 0;
    assert.equal((await f.finish()).status, "finalized");
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(
      calls.filter((a) => a[0] === "commit-tree").length,
      prepared ? 0 : 1,
    );
    console.log(
      `PASS: human-closed Done authorizes ${prepared ? "prepared" : "new"} integration without an AI-review marker`,
    );
  }
  {
    const f = await fixture();
    f.store.update(f.task.itemId, (r) => ({
      ...r,
      retry: {
        stage: "review",
        reason: "review setup failed after pinning SHA",
      },
    }));
    calls.length = 0;
    assert.equal((await f.finish()).status, "finalized");
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(f.reviews(), 0);
    console.log(
      "PASS: manual closed-Done approval supersedes an idle AI-review retry without invoking a reviewer",
    );
  }
  {
    const f = await fixture();
    calls.length = 0;
    git(f.repo, "push", "origin", `${f.taskSha}:refs/heads/main`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(f.recordFile, JSON.stringify({ ...f.record, schemaVersion: 3, reviewedTaskSha: f.taskSha,
      finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha, resultSha: f.taskSha } }));
    assert.deepEqual((await f.executor.migrateLegacy(f.owner)).failures, []);
    const outcome = await f.finish();
    assert.equal(outcome.status, "finalized", JSON.stringify(outcome));
    assert.equal(
      calls.filter((a) => a[0] === "commit-tree" || basePush(a)).length,
      0,
    );
    console.log(
      "PASS: already-integrated reviewed task only cleans up; no duplicate merge or main push",
    );
  }
  for (const step of ["fetch", "ls-remote", "rewrite"]) {
    const f = await fixture();
    faults.beforeGit = (a) => {
      if (deleting(a)) throw new Error("offline deletion retry");
    };
    await f.finish();
    const integration = f.recordNow().integration!;
    if (step === "rewrite") {
      faults.beforeGit = undefined;
      const other = git(
        f.repo,
        "commit-tree",
        `${f.base}^{tree}`,
        "-p",
        f.base,
        "-m",
        "rewritten to a different safe descendant",
      );
      git(f.origin, "fetch", f.repo, other); // transfer the fixture object before rewriting the bare ref
      git(
        f.origin,
        "update-ref",
        "refs/heads/main",
        other,
        f.mergedSha(),
      );
    } else
      faults.beforeGit = (a) => {
        if (a[0] === step)
          throw new Error(`offline ${step} observation failure`);
      };
    calls.length = 0;
    await f.finish();
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(existsSync(f.record.path), true);
    assert.deepEqual(f.recordNow().integration, integration);
    assert.equal(calls.filter(deleting).length, 0);
    assert.equal(
      calls.filter(
        (a) => a[0] === "merge-tree" || a[0] === "commit-tree" || basePush(a),
      ).length,
      0,
    );
    console.log(
      `PASS: ${step} cannot authorize cleanup from stale tracking refs or supersede a previously confirmed result`,
    );
  }
  {
    const f = await fixture();
    faults.beforeGit = (a) => {
      if (deleting(a)) throw new Error("offline deletion retry");
    };
    await f.finish();
    faults.beforeGit = undefined;
    const get = f.board.getCard;
    let withdrawn = false;
    faults.afterGit = (a) => {
      if (a[0] === "update-ref" && a.includes("-d")) {
        withdrawn = true;
        f.card.status = "Backlog";
      }
    };
    f.board.getCard = async (id) => get(id);
    await f.finish();
    assert.equal(withdrawn, true);
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(f.card.status, "Backlog");
    console.log(
      "PASS: fresh withdrawal after Git deletion retains the ticket and never overwrites changed human Project status",
    );
  }
} finally {
  dispose();
}
