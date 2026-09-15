import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, calls, faults, dispose } from "./finalization-fixture.js";
const basePush = (a: string[]) => a[0] === "push" && a.some((s) => s.endsWith(":refs/heads/main"));
const deleting = (a: string[]) => a[0] === "push" && a.some((s) => s.startsWith(":refs/heads/task/"));
try {
  for (const cut of ["prepare-save", "record-delete"] as const) {
    const f = await fixture(); calls.length = 0;
    faults.beforeSyncFs = (op, path, destination) => {
      if (cut === "prepare-save" && op === "renameSync" && destination === f.recordFile && JSON.parse(readFileSync(path, "utf8")).integration)
        throw new Error("offline atomic integration publication failure");
      if (cut === "record-delete" && op === "unlinkSync" && path === f.recordFile) {
        assert.equal(f.card.status, f.cfg.columns.done); throw new Error("offline final record unlink failure");
      }
    };
    await f.finish(); assert.ok(f.store.has(f.task.itemId));
    if (cut === "prepare-save") { assert.equal(calls.filter(basePush).length, 0); assert.equal(f.recordNow().integration, undefined); }
    else assert.equal(f.recordNow().retry?.stage, "cleanup");
    faults.beforeSyncFs = undefined;
    const result = await f.finish(); assert.equal(result.status, "finalized", JSON.stringify(result));
    assert.equal(f.store.has(f.task.itemId), false); f.noNewEvidence();
    console.log(`PASS: ${cut} failure retains retry; push cannot precede atomic save and record deletion cannot precede fresh Project Done`);
  }
  for (const cut of ["remote-lease", "local-cas", "remote-reappears"] as const) {
    const f = await fixture(); calls.length = 0;
    const newer = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.taskSha, "-m", "concurrent retained work");
    faults.beforeGit = (a) => {
      if (cut === "remote-lease" && deleting(a)) { faults.beforeGit = undefined; git(f.repo, "push", "origin", `${newer}:refs/heads/${f.task.taskBranch}`); }
      if (cut === "local-cas" && a[0] === "update-ref" && a.includes("-d")) { faults.beforeGit = undefined; git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, newer, f.taskSha); }
    };
    faults.afterGit = (a) => { if (cut === "remote-reappears" && deleting(a)) { faults.afterGit = undefined; git(f.repo, "push", "origin", `${newer}:refs/heads/${f.task.taskBranch}`); } };
    const result = await f.finish(); assert.notEqual(result.status, "finalized"); assert.ok(f.store.has(f.task.itemId));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), cut === "local-cas" ? newer : f.taskSha);
    if (cut !== "local-cas") { assert.equal(existsSync(f.record.path), true); assert.equal(git(f.repo, "ls-remote", "origin", `refs/heads/${f.task.taskBranch}`).split(/\s+/)[0], newer); }
    console.log(`PASS: ${cut} at destructive boundary retains concurrently changed refs/work instead of force deletion`);
  }
  for (const missing of ["directory", "worktree", "refs-and-path"] as const) {
    const f = await fixture();
    faults.beforeGit = (a) => { if (deleting(a)) throw new Error("offline retain integrated progress"); };
    await f.finish(); assert.equal(f.recordNow().retry?.stage, "cleanup"); faults.beforeGit = undefined;
    if (missing === "directory") rmSync(f.record.path, { recursive: true }); // simulate vanished directory, Git registration remains
    else git(f.repo, "worktree", "remove", f.record.path);
    if (missing === "refs-and-path") {
      git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
      git(f.repo, "update-ref", "--no-deref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    }
    const result = await f.finish(); assert.equal(result.status, "finalized", JSON.stringify(result)); assert.equal(f.store.has(f.task.itemId), false);
    console.log(`PASS: missing ${missing} resumes from recorded integration with normal Git operations only`);
  }
  {
    const f = await fixture(); f.store.update(f.task.itemId, (r) => ({ ...r, reviewedTaskSha: undefined }));
    calls.length = 0; await f.finish(); assert.equal(f.tip(), f.base); assert.ok(f.store.has(f.task.itemId));
    assert.equal(calls.filter((a) => a[0] === "commit-tree" || a[0] === "push").length, 0);
    console.log("PASS: closed Done without exact review SHA cannot integrate even with legacy review config disabled");
  }
  {
    const f = await fixture();
    f.store.update(f.task.itemId, (r) => ({ ...r, retry: { stage: "review", reason: "review setup failed after pinning SHA" } }));
    calls.length = 0;
    for (let i = 0; i < 2; i++) assert.equal((await f.finish()).status, "skipped");
    assert.equal(f.recordNow().retry?.stage, "review"); assert.equal(f.tip(), f.base);
    assert.equal(calls.filter((a) => a[0] === "push" || a[0] === "commit-tree").length, 0);
    console.log("PASS: manually closing Done during a pinned-but-failed review cannot bypass mandatory review or replace review retry with integration");
  }
  {
    const f = await fixture(); calls.length = 0;
    git(f.repo, "push", "origin", `${f.taskSha}:refs/heads/main`);
    const outcome = await f.finish(); assert.equal(outcome.status, "finalized", JSON.stringify(outcome));
    assert.equal(calls.filter((a) => a[0] === "commit-tree" || basePush(a)).length, 0);
    console.log("PASS: already-integrated reviewed task only cleans up; no duplicate merge or main push");
  }
  for (const step of ["fetch", "ls-remote", "rewrite"]) {
    const f = await fixture();
    faults.beforeGit = (a) => { if (deleting(a)) throw new Error("offline deletion retry"); };
    await f.finish(); const integration = f.recordNow().integration!;
    if (step === "rewrite") { faults.beforeGit = undefined; git(f.origin, "update-ref", "refs/heads/main", f.base, integration.resultSha); }
    else faults.beforeGit = (a) => { if (a[0] === step) throw new Error(`offline ${step} observation failure`); };
    calls.length = 0; await f.finish();
    assert.ok(f.store.has(f.task.itemId)); assert.equal(existsSync(f.record.path), true); assert.deepEqual(f.recordNow().integration, integration);
    assert.equal(calls.filter(deleting).length, 0);
    console.log(`PASS: ${step} cannot authorize cleanup from stale tracking refs or recorded integration alone`);
  }
  {
    const f = await fixture();
    faults.beforeGit = (a) => { if (deleting(a)) throw new Error("offline deletion retry"); }; await f.finish(); faults.beforeGit = undefined;
    const get = f.board.getCard; let withdrawn = false;
    faults.afterGit = (a) => { if (a[0] === "update-ref" && a.includes("-d")) { withdrawn = true; f.card.status = "Backlog"; } };
    f.board.getCard = async (id) => get(id);
    await f.finish(); assert.equal(withdrawn, true); assert.ok(f.store.has(f.task.itemId)); assert.equal(f.card.status, "Backlog");
    console.log("PASS: fresh withdrawal after Git deletion retains the ticket and never overwrites human Project status with Done");
  }
} finally { dispose(); }
