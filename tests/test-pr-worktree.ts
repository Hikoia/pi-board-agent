// Public v5 Git seams, real disposable bare remotes; PR observations/human squash
// are supplied by this harness. No gh client, production credentials or live refs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnerLock } from "../src/owner-lock.js";
import type { PullRequestInfo } from "../src/gh.js";
import type { TicketExecutionRecordV5, TicketPullRequestIntegration } from "../src/ticket-worktree.js";
import { calls, dispose, faults, fixture, git, TicketWorktrees, useNativeGitFixture } from "./cleanup-fixture.js";

useNativeGitFixture();
// owner-lock imports the store through unsupported-state; load after fixture hooks.
const { acquireOwnerLock } = await import("../src/owner-lock.js");

const owners: OwnerLock[] = [];
const noop = () => {};
const publish = (a: string[]) => a[0] === "push" && !a.at(-1)!.startsWith(":");
const remoteDelete = (a: string[]) => a[0] === "push" && a.at(-1)!.startsWith(":");
const remove = (a: string[]) => a[0] === "worktree" && a[1] === "remove";
const localDelete = (a: string[]) => a[0] === "update-ref" && a.includes("-d");

async function make() {
  const f = await fixture(false, true);
  const owner = acquireOwnerLock(f.repo, "offline-bot");
  owners.push(owner);
  unlinkSync(f.recordFile);
  const record: TicketExecutionRecordV5 = { ...f.record, schemaVersion: 5, integration: undefined };
  f.store.createV5(record, owner, noop);
  const scope = { owner: "offline-owner", repo: "offline-repo", base: "main", head: f.task.taskBranch };
  const flags = { approved: true, stopped: false };
  const control = { check: () => { if (flags.stopped) throw new Error("offline stopped"); } };
  const current = async () => { if (!flags.approved) throw new Error("approval withdrawn"); };
  const now = () => f.store.readV5(f.task.itemId)!;
  const preparation = () => now().integration as TicketPullRequestIntegration;
  const prepare = () => f.store.preparePullRequest(f.task, scope, owner, current, control);
  const clean = (info: PullRequestInfo) => f.store.cleanupMergedPullRequest(f.task, info, owner, current, control);
  const complete = (sha: string, backlog = current) => f.store.completeFinalization(f.task, sha, backlog, control, owner);
  return { ...f, owner, scope, flags, control, current, now, preparation, prepare, clean, complete };
}
type Fixture = Awaited<ReturnType<typeof make>>;
function info(f: Fixture, head = f.preparation().preparedHeadSha): PullRequestInfo {
  return { scope: f.scope, number: 7, url: "https://github.com/offline-owner/offline-repo/pull/7",
    body: "Refs #1", state: "open", merged: false, headSha: head, mergeCommitSha: null };
}
function open(f: Fixture) {
  const pr = info(f);
  f.store.progressPullRequest(f.now(), { ...f.preparation(), phase: "open", prNumber: pr.number, prUrl: pr.url }, undefined, f.owner, noop);
  return pr;
}
function commit(f: Fixture, parent: string, label: string) {
  return git(f.repo, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", label);
}
function change(f: Fixture, parent: string, file: string) {
  const path = join(f.repo, ".pi", "author");
  git(f.repo, "worktree", "add", "--detach", path, parent);
  writeFileSync(join(path, file), file + "\n");
  git(path, "add", "."); git(path, "commit", "-m", file);
  const sha = git(path, "rev-parse", "HEAD");
  git(f.repo, "worktree", "remove", path);
  return sha;
}
function squash(f: Fixture, head = f.preparation().preparedHeadSha) {
  const pr = info(f, head);
  const sha = git(f.repo, "commit-tree", `${head}^{tree}`, "-p", f.tip(), "-m", "human squash");
  // Only the harness acts as the human merging base or GitHub keeping PR refs.
  git(f.repo, "push", "origin", `${sha}:refs/heads/main`, `${head}:refs/pull/7/head`);
  const merged: PullRequestInfo = { ...pr, state: "closed", merged: true, mergeCommitSha: sha };
  f.store.progressPullRequest(f.now(), { ...f.preparation(), phase: "merged", prNumber: pr.number, prUrl: pr.url,
    mergedHeadSha: head, mergeCommitSha: sha }, undefined, f.owner, noop);
  return merged;
}
function kept(f: Fixture, remote?: string) {
  assert.ok(f.store.has(f.task.itemId));
  assert.ok(existsSync(f.record.path));
  assert.ok(f.store.localBranchSha(f.task.taskBranch));
  if (remote) assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), remote);
}

try {
  for (const shape of ["equal", "local-only", "remote-only", "local-ahead", "remote-ahead", "divergent"] as const) {
    const f = await make();
    let local = f.taskSha, remote: string | null = f.taskSha;
    if (shape === "remote-ahead" || shape === "divergent") {
      remote = change(f, f.taskSha, "remote.txt");
      git(f.repo, "push", "origin", `${remote}:refs/heads/${f.task.taskBranch}`);
    }
    if (shape === "local-ahead" || shape === "divergent") {
      writeFileSync(join(f.record.path, "local.txt"), "local content\n");
      git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "local work");
      local = git(f.record.path, "rev-parse", "HEAD");
    }
    if (shape === "local-only") {
      git(f.origin, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, remote!);
      remote = null;
    }
    if (shape === "remote-only") {
      git(f.repo, "worktree", "remove", f.record.path);
      git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, local);
    }
    const index = existsSync(f.record.path) ? readFileSync(join(f.admin, "index")) : undefined;
    const mainIndex = readFileSync(join(f.repo, ".git", "index"));
    writeFileSync(join(f.repo, "base.txt"), "dirty main is untouched\n");
    const start = calls.length;
    faults.beforeGit = (a) => {
      if (publish(a)) {
        const saved = f.preparation();
        assert.equal(saved.phase, "prepared");
        assert.equal(saved.taskSha, local);
        assert.equal(saved.remoteTaskSha, remote);
        assert.equal(a.at(-1), `${saved.preparedHeadSha}:refs/heads/${f.task.taskBranch}`);
      }
      if (remoteDelete(a) && index) assert.ok(existsSync(f.record.path));
      if (remove(a)) assert.equal(git(f.repo, "ls-remote", "origin", `refs/heads/${f.task.taskBranch}`), "");
      if (localDelete(a)) { assert.equal(existsSync(f.record.path), false); assert.ok(existsSync(f.recordFile)); }
    };
    await f.prepare();
    assert.equal(f.tip(), f.base, "bot never pushes base");
    assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
    const prepared = f.preparation();
    if (index) {
      assert.deepEqual(readFileSync(join(f.admin, "index")), index);
      assert.equal(git(f.record.path, "rev-parse", "HEAD"), local);
    }
    git(f.repo, "merge-base", "--is-ancestor", local, prepared.preparedHeadSha);
    if (remote) git(f.repo, "merge-base", "--is-ancestor", remote, prepared.preparedHeadSha);
    if (["divergent", "remote-ahead"].includes(shape)) assert.equal(git(f.repo, "show", `${prepared.preparedHeadSha}:remote.txt`), "remote.txt");
    if (["divergent", "local-ahead"].includes(shape)) assert.equal(git(f.repo, "show", `${prepared.preparedHeadSha}:local.txt`), "local content");
    open(f);
    const waiting = readFileSync(f.recordFile), waitingCalls = calls.length;
    await assert.rejects(f.prepare(), /initial\/re-approved/);
    assert.deepEqual(readFileSync(f.recordFile), waiting);
    assert.ok(!calls.slice(waitingCalls).some(publish));
    const merged = squash(f);
    assert.equal(f.store.isAncestor(local, merged.mergeCommitSha!), false, "squash proof must not require task ancestry in main");
    assert.equal(await f.clean(merged), merged.mergeCommitSha);
    await assert.rejects(f.complete(merged.mergeCommitSha!, async () => { throw new Error("Backlog not confirmed"); }), /Backlog/);
    assert.ok(f.store.has(f.task.itemId));
    await f.complete(merged.mergeCommitSha!);
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(await f.store.remoteSha(f.task.taskBranch), undefined);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.equal(existsSync(f.record.path), false);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base);
    assert.deepEqual(readFileSync(join(f.repo, ".git", "index")), mainIndex);
    assert.equal(readFileSync(join(f.repo, "base.txt"), "utf8"), "dirty main is untouched\n");
    const steps = calls.slice(start);
    if (index) assert.ok(steps.findIndex(remoteDelete) < steps.findIndex(remove));
    assert.ok(steps.findIndex(remoteDelete) < steps.findIndex(localDelete));
    if (index) assert.ok(steps.findIndex(remove) < steps.findIndex(localDelete));
    faults.beforeGit = undefined;
    console.log(`PASS: ${shape} exact sources saved before task-only push, HEAD/index retained; waiting never updates, real squash cleans in order and Backlog deletes record last`);
  }

  for (const cut of ["reply", "reference-save", "before-push", "preparation-save"] as const) {
    const f = await make(), start = calls.length;
    if (cut === "reply") faults.afterGit = (a) => { if (publish(a)) throw new Error("lost push response"); };
    if (cut === "before-push") faults.beforeGit = (a) => { if (publish(a)) throw new Error("rejected push"); };
    if (cut === "preparation-save") faults.beforeSyncFs = (op) => { if (op === "renameSync") throw new Error("preparation save failed"); };
    if (cut === "reference-save") {
      await f.prepare();
      faults.beforeSyncFs = (op) => { if (op === "renameSync") throw new Error("reference save failed"); };
      assert.throws(() => open(f), /reference save/);
    } else await assert.rejects(f.prepare(), /lost push|rejected push|preparation save/);
    faults.afterGit = faults.beforeGit = faults.beforeSyncFs = undefined;
    const saved = f.now().integration;
    if (cut === "preparation-save") {
      assert.equal(saved, undefined);
      assert.equal(calls.slice(start).filter(publish).length, 0);
    } else assert.equal(saved?.kind, "pr");
    if (cut === "reply") {
      const appended = commit(f, f.preparation().preparedHeadSha, "human append after lost reply");
      git(f.repo, "push", "origin", `${appended}:refs/heads/${f.task.taskBranch}`);
      git(f.record.path, "merge", "--ff-only", appended); // Human, not the publisher, advances HEAD.
    }
    const localBeforeRetry = git(f.record.path, "rev-parse", "HEAD");
    const retryStart = calls.length;
    await new TicketWorktrees(f.repo).preparePullRequest(f.task, f.scope, f.owner, f.current, f.control);
    if (saved) {
      assert.deepEqual(f.now().integration, saved);
      assert.ok(!calls.slice(retryStart).some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    }
    if (cut === "reply" || cut === "reference-save") assert.ok(!calls.slice(retryStart).some(publish));
    assert.equal(f.tip(), f.base);
    assert.equal(git(f.record.path, "rev-parse", "HEAD"), localBeforeRetry);
    console.log(`PASS: ${cut} loss retains atomic preparation; restart observes accepted remote before retry, without a force update or duplicate preparation/push`);
  }

  for (const shape of ["appended", "update-branch", "missing-head"] as const) {
    const f = await make(); await f.prepare(); open(f);
    const prepared = f.preparation().preparedHeadSha;
    let head = commit(f, prepared, "human appended work");
    if (shape === "update-branch") {
      const base = change(f, f.base, "base-advance.txt");
      git(f.repo, "push", "origin", `${base}:refs/heads/main`);
      const tree = await f.store.resultTree({ baseSha: base, taskSha: head });
      head = git(f.repo, "commit-tree", tree, "-p", head, "-p", base, "-m", "human merge Update branch");
    }
    if (shape === "missing-head") {
      // Construct the appended commit on the bare server; the client has no object.
      head = git(f.origin, "-c", "user.name=Human", "-c", "user.email=human@example.test", "commit-tree", `${prepared}^{tree}`, "-p", prepared, "-m", "server-only append");
      git(f.origin, "update-ref", "refs/pull/7/head", head);
      const merge = git(f.origin, "-c", "user.name=Human", "-c", "user.email=human@example.test", "commit-tree", `${head}^{tree}`, "-p", f.base, "-m", "server squash");
      git(f.origin, "update-ref", "refs/heads/main", merge);
      git(f.origin, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, prepared);
      f.store.progressPullRequest(f.now(), { ...f.preparation(), phase: "merged", prNumber: 7, prUrl: info(f).url,
        mergedHeadSha: head, mergeCommitSha: merge }, undefined, f.owner, noop);
      assert.throws(() => git(f.repo, "cat-file", "-t", head));
      const start = calls.length;
      const pr: PullRequestInfo = { ...info(f, head), merged: true, state: "closed", mergeCommitSha: merge };
      // A mismatched PR ref cannot supply the observed missing head.
      git(f.origin, "update-ref", "refs/pull/7/head", prepared);
      await assert.rejects(f.clean(pr), /Fetched PR head differs/);
      kept(f);
      git(f.origin, "update-ref", "refs/pull/7/head", head);
      assert.equal(await f.clean(pr), merge);
      assert.ok(calls.slice(start).some((a) => a[0] === "fetch" && a.includes("refs/pull/7/head")));
      assert.ok(!calls.slice(start).some(remoteDelete), "human-deleted task ref needs no deletion push");
      await f.complete(merge);
    } else {
      git(f.repo, "push", "origin", `${head}:refs/heads/${f.task.taskBranch}`);
      // Both current local/remote ahead tips are covered by the merged PR head.
      git(f.record.path, "merge", "--ff-only", head);
      const pr = squash(f, head);
      assert.equal(await f.clean(pr), pr.mergeCommitSha);
      await f.complete(pr.mergeCommitSha!);
    }
    console.log(`PASS: ${shape} retains required ancestry; squash cleanup accepts covered human work and fetches/verifies an absent PR head even after human remote deletion`);
  }

  {
    const f = await make(); await f.prepare(); open(f);
    const good = squash(f), saved = readFileSync(f.recordFile), remote = f.preparation().preparedHeadSha;
    for (const wrong of [
      { ...good, merged: false }, { ...good, state: "open" as const }, { ...good, number: 8 },
      { ...good, scope: { ...good.scope, repo: "other" } }, { ...good, url: good.url.replace("7", "8") },
      { ...good, headSha: f.taskSha }, { ...good, mergeCommitSha: null }, { ...good, mergeCommitSha: f.base },
    ]) {
      await assert.rejects(f.clean(wrong), /Exact recorded merged PR proof/);
      kept(f, remote); assert.deepEqual(readFileSync(f.recordFile), saved);
    }
    const mergedRecord = f.now();
    for (const phase of ["prepared", "open"] as const) {
      const { mergedHeadSha: _head, mergeCommitSha: _merge, ...rest } = mergedRecord.integration as TicketPullRequestIntegration & { phase: "merged" };
      writeFileSync(f.recordFile, JSON.stringify({ ...mergedRecord, integration: { ...rest, phase } }));
      await assert.rejects(f.clean(good), /recorded merged PR proof/);
    }
    writeFileSync(f.recordFile, saved);
    // A missing task remote (or even all missing artifacts) never means historical completion.
    git(f.origin, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, remote);
    await assert.rejects(f.clean({ ...good, merged: false }), /recorded merged PR proof/);
    git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, remote);
    // A recorded test-merge SHA not actually on main must not authorize cleanup.
    git(f.origin, "update-ref", "refs/heads/main", f.base);
    await assert.rejects(f.clean(good), /Actual PR merge commit/);
    git(f.origin, "update-ref", "refs/heads/main", good.mergeCommitSha!);
    // Equivalent content on a rewritten PR head is not source ancestry.
    const rewritten = git(f.repo, "commit-tree", `${remote}^{tree}`, "-p", f.base, "-m", "rewritten head");
    writeFileSync(f.recordFile, JSON.stringify({ ...mergedRecord, integration: { ...mergedRecord.integration, mergedHeadSha: rewritten } }));
    await assert.rejects(f.clean({ ...good, headSha: rewritten }), /does not cover/);
    writeFileSync(f.recordFile, saved);
    for (const kind of ["dirty", "untracked", "extra-local", "extra-remote", "nested-git", "bare-git", "locked", "admin-lock", "ref-lock", "stopped", "owner", "withdrawn", "unregistered", "symlink"] as const) {
      let undo = noop;
      const start = calls.length;
      if (kind === "dirty") { const path = join(f.record.path, "feature.txt"); writeFileSync(path, "new work"); undo = () => writeFileSync(path, "feature\n"); }
      if (kind === "untracked") { const path = join(f.record.path, "new-work.ts"); writeFileSync(path, "precious"); undo = () => unlinkSync(path); }
      if (kind === "extra-local") { git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, commit(f, f.taskSha, "extra local")); undo = () => { git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha); }; }
      if (kind === "extra-remote") { git(f.repo, "push", "origin", `${commit(f, remote, "extra remote")}:refs/heads/${f.task.taskBranch}`); undo = () => { git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, remote); }; }
      if (kind === "nested-git" || kind === "bare-git") { const path = join(f.record.path, "ignored", "nested"); mkdirSync(path, { recursive: true }); git(path, "init", ...(kind === "bare-git" ? ["--bare"] : [])); undo = () => rmSync(path, { recursive: true }); }
      if (kind === "locked") { git(f.repo, "worktree", "lock", f.record.path); undo = () => { git(f.repo, "worktree", "unlock", f.record.path); }; }
      if (kind === "admin-lock" || kind === "ref-lock") { const path = kind === "admin-lock" ? join(f.admin, "index.lock") : join(f.repo, ".git", "refs", "heads", f.task.taskBranch + ".lock"); writeFileSync(path, "occupied"); undo = () => unlinkSync(path); }
      if (kind === "stopped") { f.flags.stopped = true; undo = () => { f.flags.stopped = false; }; }
      if (kind === "withdrawn") { f.flags.approved = false; undo = () => { f.flags.approved = true; }; }
      if (kind === "owner") { const bytes = readFileSync(f.owner.path); f.owner.release(); undo = () => writeFileSync(f.owner.path, bytes); }
      if (kind === "unregistered") { const adminBackup = join(f.repo, ".pi", "admin-saved"); const pointer = readFileSync(join(f.record.path, ".git")); const { renameSync } = await import("node:fs"); renameSync(f.admin, adminBackup); unlinkSync(join(f.record.path, ".git")); undo = () => { renameSync(adminBackup, f.admin); writeFileSync(join(f.record.path, ".git"), pointer); }; }
      if (kind === "symlink") { const outside = join(f.repo, "outside"); git(f.repo, "worktree", "move", f.record.path, outside); symlinkSync(outside, f.record.path, "junction"); undo = () => { unlinkSync(f.record.path); git(f.repo, "worktree", "move", outside, f.record.path); }; }
      try {
        await assert.rejects(f.clean(good));
        assert.ok(!calls.slice(start).some((a) => remoteDelete(a) || remove(a) || localDelete(a)), kind);
        assert.deepEqual(readFileSync(f.recordFile), saved);
        assert.ok(f.store.localBranchSha(f.task.taskBranch));
      } finally { undo(); }
      kept(f, remote);
      console.log(`PASS: ${kind} blocks PR cleanup without deleting work/refs/evidence`);
    }
    await assert.rejects(f.store.finalizeAccepted(f.task, "merge"), /PR executor|direct integration/);
    await assert.rejects(f.store.cleanupLegacyCompleted(f.task, f.owner, f.current), /legacy completion/);
    assert.equal(await f.clean(good), good.mergeCommitSha);
    await f.complete(good.mergeCommitSha!);
    console.log("PASS: exact merged proof, fresh actual base commit and source ancestry are mandatory; missing remote never bypasses PR proof, and v5 cannot enter the direct path");
  }

  for (const boundary of ["clean", "remote", "remove", "local"] as const) {
    const f = await make(); await f.prepare(); const pr = squash(f), start = calls.length;
    faults.afterGit = (a) => {
      if ((boundary === "clean" && a[0] === "clean") || (boundary === "remote" && remoteDelete(a)) ||
          (boundary === "remove" && remove(a)) || (boundary === "local" && localDelete(a))) {
        faults.afterGit = undefined;
        throw new Error("lost cleanup response");
      }
    };
    await assert.rejects(f.clean(pr), /lost cleanup response/);
    faults.afterGit = undefined;
    assert.ok(f.now().integration?.kind === "pr" && f.preparation().phase === "merged");
    const cut = calls.length;
    await f.clean(pr); await f.complete(pr.mergeCommitSha!);
    assert.ok(!calls.slice(start).some(publish));
    assert.ok(!calls.slice(cut).some((a) => ["commit-tree", "merge-tree"].includes(a[0])));
    console.log(`PASS: lost ${boundary} cleanup response retries proof-based removal only, never preparation or task publication`);
  }

  for (const race of ["local", "remote-lease", "base", "owner", "stop", "proof-record", "dirty", "remote-reappeared"] as const) {
    const f = await make(); await f.prepare(); const pr = squash(f), start = calls.length;
    const remote = f.preparation().preparedHeadSha;
    const newer = commit(f, remote, "concurrent work");
    if (race === "remote-lease" || race === "remote-reappeared") git(f.repo, "push", "origin", `${newer}:refs/heads/race-object`);
    const mutate = () => {
      if (race === "local") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer);
      if (race === "remote-lease" || race === "remote-reappeared") git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, newer);
      if (race === "base") git(f.origin, "update-ref", "refs/heads/main", f.base);
      if (race === "owner") f.owner.release();
      if (race === "stop") f.flags.stopped = true;
      if (race === "proof-record") writeFileSync(f.recordFile, JSON.stringify({ ...f.now(), integration: { ...f.preparation(), mergeCommitSha: f.base } }));
      if (race === "dirty") writeFileSync(join(f.record.path, "feature.txt"), "concurrent uncommitted work");
    };
    if (race === "remote-lease") faults.beforeGit = (a) => { if (remoteDelete(a)) { faults.beforeGit = undefined; mutate(); } };
    else faults.afterGit = (a) => {
      if (race === "remote-reappeared" ? remoteDelete(a) : a[0] === "clean") { faults.afterGit = undefined; mutate(); }
    };
    await assert.rejects(f.clean(pr));
    faults.afterGit = faults.beforeGit = undefined;
    kept(f);
    assert.ok(!calls.slice(start).some(remove));
    assert.ok(!calls.slice(start).some(localDelete));
    console.log(`PASS: ${race} race at cleanup yield/lease preserves later work and never removes the worktree/local ref`);
  }

  {
    const f = await make(), original = readFileSync(f.recordFile), owner = readFileSync(f.owner.path);
    const extra = commit(f, f.taskSha, "concurrent source");
    for (const race of ["local", "remote", "owner", "stop", "record", "withdrawn"] as const) {
      const start = calls.length;
      faults.afterGit = (a) => {
        if (a[0] !== "commit-tree") return;
        faults.afterGit = undefined;
        if (race === "local") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, extra);
        if (race === "remote") git(f.repo, "push", "origin", `${extra}:refs/heads/${f.task.taskBranch}`);
        if (race === "owner") f.owner.release();
        if (race === "stop") f.flags.stopped = true;
        if (race === "record") writeFileSync(f.recordFile, JSON.stringify({ ...f.now(), lastRunId: "other-execution" }));
        if (race === "withdrawn") f.flags.approved = false;
      };
      await assert.rejects(f.prepare());
      faults.afterGit = undefined;
      assert.equal(f.now().integration, undefined);
      assert.ok(!calls.slice(start).some(publish), "preparation races cannot push");
      if (race !== "record") assert.deepEqual(readFileSync(f.recordFile), original);
      else assert.equal(f.now().lastRunId, "other-execution", "do not overwrite the concurrent record");
      writeFileSync(f.recordFile, original); writeFileSync(f.owner.path, owner);
      f.flags.stopped = false; f.flags.approved = true;
      git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      kept(f, f.taskSha);
      console.log(`PASS: ${race} movement during preparation prevents publication/save and preserves source/owner authority`);
    }
  }

  {
    const f = await make();
    writeFileSync(join(f.record.path, "base.txt"), "task side\n"); git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "task conflict"); git(f.record.path, "push", "origin", f.task.taskBranch);
    const task = git(f.record.path, "rev-parse", "HEAD");
    writeFileSync(join(f.repo, "base.txt"), "base side\n"); git(f.repo, "add", "base.txt"); git(f.repo, "commit", "-m", "base conflict"); git(f.repo, "push", "origin", "main");
    const start = calls.length;
    await assert.rejects(f.prepare(), (e: any) => e.name === "MergeConflictError" && e.repairable === true && e.taskSha === task);
    assert.equal(f.now().integration, undefined);
    assert.ok(!calls.slice(start).some((a) => publish(a) || remove(a) || a[0] === "commit-tree"));
    kept(f, task);
    console.log("PASS: initial deterministic base conflict preserves original repairable handoff and never publishes a task head");
  }

  {
    const f = await make(), bytes = readFileSync(f.recordFile);
    git(f.repo, "worktree", "remove", f.record.path);
    git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    const newer = commit(f, f.taskSha, "competing local ref"), start = calls.length;
    faults.beforeGit = (a) => {
      if (a[0] === "update-ref" && a.at(-1) === "0".repeat(40)) {
        faults.beforeGit = undefined;
        git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer);
      }
    };
    await assert.rejects(f.prepare(), /update-ref/);
    faults.beforeGit = undefined;
    assert.equal(f.store.localBranchSha(f.task.taskBranch), newer);
    assert.deepEqual(readFileSync(f.recordFile), bytes);
    assert.ok(!calls.slice(start).some(publish));
    assert.equal(existsSync(f.record.path), false);
    console.log("PASS: remote-only compare/create preserves a racing local ref without moving/creating a worktree or publishing a task head");
  }

  {
    const f = await make(); await f.prepare(); const pr = open(f), initial = f.preparation().initialPreparedHeadSha;
    f.store.progressPullRequest(f.now(), { ...f.preparation(), phase: "suspended" }, undefined, f.owner, noop);
    const newer = commit(f, f.taskSha, "renewed local work");
    git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer);
    await f.prepare();
    assert.equal(f.preparation().initialPreparedHeadSha, initial);
    assert.equal(f.preparation().prNumber, pr.number);
    assert.equal(f.preparation().taskSha, newer);
    assert.equal(git(f.record.path, "rev-parse", "HEAD"), newer);
    console.log("PASS: explicit suspended/re-approved preparation updates the same task PR while retaining its original marker and worktree HEAD");
  }

  {
    const f = await make();
    const result = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base, "-m", "historical direct squash");
    git(f.repo, "push", "origin", `${result}:refs/heads/main`);
    writeFileSync(f.recordFile, JSON.stringify({ ...f.now(), integration: { kind: "legacy-completed", scope: f.scope,
      baseSha: f.base, taskSha: f.taskSha, remoteTaskSha: f.taskSha, resultSha: result } }));
    const start = calls.length;
    await assert.rejects(f.prepare(), /initial\/re-approved/);
    assert.equal(await f.store.cleanupLegacyCompleted(f.task, f.owner, f.current, undefined, f.control), result);
    await f.complete(result);
    assert.ok(!calls.slice(start).some(publish));
    console.log("PASS: v5 legacy-completed seam is cleanup-only and confirms Backlog before deletion, without enabling legacy direct push on v5");
  }

  {
    const f = await make(); await f.prepare(); const pr = squash(f);
    const extra = commit(f, f.preparation().preparedHeadSha, "work during Backlog confirmation");
    git(f.repo, "push", "origin", `${extra}:refs/heads/extra-object`);
    await f.clean(pr);
    const bytes = readFileSync(f.recordFile), owner = readFileSync(f.owner.path);
    for (const race of ["remote", "base", "owner", "stop"] as const) {
      await assert.rejects(f.complete(pr.mergeCommitSha!, async () => {
        if (race === "remote") git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, extra);
        if (race === "base") git(f.origin, "update-ref", "refs/heads/main", f.base);
        if (race === "owner") f.owner.release();
        if (race === "stop") f.flags.stopped = true;
      }));
      assert.deepEqual(readFileSync(f.recordFile), bytes);
      if (race === "remote") {
        await assert.rejects(f.clean(pr), /does not cover/);
        git(f.origin, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, extra);
      }
      git(f.origin, "update-ref", "refs/heads/main", pr.mergeCommitSha!);
      writeFileSync(f.owner.path, owner); f.flags.stopped = false;
    }
    await f.complete(pr.mergeCommitSha!);
    console.log("PASS: remote/base/owner/stop changes during Backlog confirmation retain the immutable cleanup record; uncovered later work requires a new PR");
  }

  for (const a of calls.filter((a) => a[0] === "push")) {
    assert.equal(a[1], "origin");
    if (remoteDelete(a)) {
      const ref = a.at(-1)!.slice(1);
      assert.match(ref, /^refs\/heads\/task\/issue-\d+$/);
      assert.match(a[2], new RegExp(`^--force-with-lease=${ref}:[0-9a-f]{40}$`));
      assert.equal(a.length, 4);
    } else {
      assert.equal(a.length, 3);
      assert.match(a[2], /^[0-9a-f]{40}:refs\/heads\/task\/issue-\d+$/);
    }
  }
  console.log("PASS: every captured production push targets only a task head; no base pushes, force updates, PR merge calls or live GitHub");
} finally {
  faults.beforeGit = faults.afterGit = faults.beforeSyncFs = undefined;
  for (const owner of owners) owner.release();
  dispose();
}
