// Real executor/store/Git with disposable bare origins and explicit fake GitHub.
// Scope hooks to cleanup stages, not global Git/PR call counts. A skipped result
// alone is insufficient: assert that the next destructive operation never ran.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, git, dispose } from "./finalization-fixture.js";
import { useNativeGitFixture } from "./cleanup-fixture.js";

useNativeGitFixture();
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Boundary = "clean" | "link" | "remote" | "worktree" | "local" | "record";
const remoteDelete = (a: string[]) => a[0] === "push" && a.at(-1)!.startsWith(":");
const worktreeRemove = (a: string[]) => a[0] === "worktree" && a[1] === "remove";
const localDelete = (a: string[]) => a[0] === "update-ref" && a.includes("-d");

/** Reach the last yielded task-ref observation at each destructive boundary.
 * remote/worktree/local each have two stage-local observations: the scan or
 * explicit absence check, then cleanupGuard's final proof. The record hook is
 * tied to the real Backlog callback, so it exercises the SECOND proof only.
 */
function atBoundary(f: Fixture, boundary: Boundary, cut: () => void) {
  let stage: Boundary = "clean", scanning = false, observations = 0, hit = false;
  let completing = false, backlogConfirmed = false;
  const ignored = join(f.record.path, "ignored"), link = join(ignored, "late-link");
  const outside = join(f.repo, ".pi", "external");
  if (boundary === "link") {
    mkdirSync(outside); writeFileSync(join(outside, "keep.txt"), "external work\n");
  }
  faults.afterFs = (op, path) => {
    if (op === "readdir" && path === f.record.path) scanning = true;
  };
  faults.afterGit = (a) => {
    if (a[0] === "clean") {
      stage = boundary === "link" ? "link" : "remote"; observations = 0;
      if (boundary === "link") {
        mkdirSync(ignored);
        symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      }
    }
    if (remoteDelete(a)) { stage = "worktree"; observations = 0; }
    if (worktreeRemove(a)) { stage = "local"; observations = 0; }
  };
  const complete = f.store.completeFinalization.bind(f.store);
  f.store.completeFinalization = async (task, sha, backlog, ...rest) => {
    completing = true;
    return complete(task, sha, async () => { await backlog(); backlogConfirmed = true; }, ...rest);
  };
  const remote = f.store.remoteSha.bind(f.store);
  f.store.remoteSha = async (...args) => {
    const result = await remote(...args);
    const recordBoundary = boundary === "record" && completing && backlogConfirmed;
    const artifactBoundary = !completing && stage === boundary && scanning &&
      ++observations === (boundary === "clean" ? 1 : 2);
    if (!hit && (recordBoundary || artifactBoundary)) { hit = true; cut(); }
    return result;
  };
  return { hit: () => hit, link, outside };
}

function retained(f: Fixture, boundary: Boundary, start: number, unlinks: string[]) {
  const steps = calls.slice(start);
  assert.ok(f.store.has(f.task.itemId), "cleanup record must survive withdrawn authority");
  assert.ok(!unlinks.includes(f.recordFile), "must not attempt record unlink");
  assert.equal(f.prNow().phase, "merged", "immutable merged evidence survives withdrawal");
  if (boundary !== "record") {
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha, "local ref retained");
    assert.equal(steps.filter(localDelete).length, 0, "must not attempt local compare/delete");
  }
  if (!["local", "record"].includes(boundary)) {
    assert.ok(existsSync(f.record.path), "worktree retained");
    assert.equal(steps.filter(worktreeRemove).length, 0, "must not attempt worktree removal");
  }
  if (["clean", "link", "remote"].includes(boundary)) {
    assert.equal(steps.filter(remoteDelete).length, 0, "must not send even an exact-lease remote deletion");
    assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), f.prNow().preparedHeadSha);
  }
  if (boundary === "clean") {
    assert.equal(steps.filter(a => a[0] === "clean").length, 0);
    assert.deepEqual(readFileSync(join(f.record.path, "ignored", "cache.bin")), Buffer.from([0, 1, 2, 255]));
  }
}

const failures: unknown[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(error); console.error(`FAIL: ${name}`, error); }
  finally { faults.beforeGit = faults.afterGit = faults.beforeFs = faults.afterFs = faults.beforeSyncFs = undefined; }
}

try {
  // Includes both main acceptance repros: post-clean second ls-remote and the
  // second completeFinalization proof after a successful Backlog authorization.
  for (const boundary of ["remote", "record", "clean", "link", "worktree", "local"] as const) {
    await check(`Issue reopen after ${boundary} proof vetoes the actual deletion and retains remaining artifacts`, async () => {
      const f = await fixture(false, false); await f.finish(); f.prs.merge();
      const hook = atBoundary(f, boundary, () => { f.card.closed = false; });
      const unlinks: string[] = [];
      faults.beforeSyncFs = (op, path) => { if (op === "unlinkSync") unlinks.push(path); };
      const start = calls.length;
      const result = await f.make(undefined, f.store).finalizeClosed(structuredClone(f.card));
      assert.ok(hook.hit(), `must reach ${boundary}, not an earlier guard: ${JSON.stringify(result)}`);
      assert.notEqual(result.status, "finalized");
      retained(f, boundary, start, unlinks);
      if (boundary === "link") {
        assert.ok(lstatSync(hook.link).isSymbolicLink());
        assert.ok(!unlinks.includes(hook.link));
        assert.equal(readFileSync(join(hook.outside, "keep.txt"), "utf8"), "external work\n");
      }
    });
  }

  for (const [boundary, change] of [
    ["remote", "lane"], ["worktree", "claim"], ["local", "pr"], ["record", "pr"],
    ["remote", "owner"], ["record", "owner"], ["worktree", "stop"], ["record", "stop"],
  ] as const) {
    await check(`${change} withdrawal after ${boundary} observation vetoes deletion`, async () => {
      const f = await fixture(false, false); await f.finish(); f.prs.merge();
      let allowed = true;
      const hook = atBoundary(f, boundary, () => {
        if (change === "lane") f.card.status = f.cfg.columns.ready;
        if (change === "claim") f.card.assignees = ["human"];
        if (change === "pr") f.prs.prs[0].merged = false;
        if (change === "owner") f.owner.release();
        if (change === "stop") allowed = false;
      });
      const start = calls.length, unlinks: string[] = [];
      faults.beforeSyncFs = (op, path) => { if (op === "unlinkSync") unlinks.push(path); };
      const result = await f.make(undefined, f.store).finalizeClosed(structuredClone(f.card), () => true, () => allowed);
      assert.ok(hook.hit(), JSON.stringify(result)); assert.notEqual(result.status, "finalized");
      retained(f, boundary, start, unlinks);
    });
  }

  // A final awaited authorizer is not permission to trust earlier local checks.
  for (const [boundary, change] of [
    ["remote", "dirty"], ["remote", "record"], ["worktree", "source"],
    ["local", "worktree"], ["record", "source"], ["record", "owner"], ["record", "stop"],
  ] as const) {
    await check(`${change} changed DURING the final ${boundary} authorizer is rechecked before mutation`, async () => {
      const f = await fixture(false, false); await f.finish(); f.prs.merge();
      let armed = false, changed = false, allowed = true;
      const hook = atBoundary(f, boundary, () => { armed = true; });
      const extra = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.taskSha, "-m", "later local work");
      const unlinks: string[] = [];
      faults.beforeSyncFs = (op, path) => { if (op === "unlinkSync") unlinks.push(path); };
      f.prs.hooks.after = op => {
        if (!armed || changed || op !== "get") return;
        changed = true;
        if (change === "dirty") writeFileSync(join(f.record.path, "feature.txt"), "new uncommitted work\n");
        if (change === "record") writeFileSync(f.recordFile, JSON.stringify({ ...f.recordNow(), lastRunId: "other-execution" }));
        if (change === "source") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, extra);
        if (change === "worktree") {
          mkdirSync(f.record.path); writeFileSync(join(f.record.path, "keep.txt"), "unknown residual\n");
        }
        if (change === "owner") f.owner.release();
        if (change === "stop") allowed = false;
      };
      const start = calls.length;
      const result = await f.make(undefined, f.store).finalizeClosed(structuredClone(f.card), () => true, () => allowed);
      assert.ok(hook.hit() && changed, `must reach the final authorizer: ${JSON.stringify(result)}`);
      assert.notEqual(result.status, "finalized");
      assert.ok(f.store.has(f.task.itemId)); assert.ok(!unlinks.includes(f.recordFile));
      assert.equal(f.prNow().phase, "merged");
      if (boundary !== "record") assert.ok(!calls.slice(start).some(localDelete));
      if (boundary === "remote" || boundary === "worktree") {
        assert.ok(existsSync(f.record.path)); assert.ok(!calls.slice(start).some(worktreeRemove));
      }
      if (boundary === "remote") assert.ok(!calls.slice(start).some(remoteDelete));
      if (change === "source") assert.equal(f.store.localBranchSha(f.task.taskBranch), extra);
      if (change === "dirty") assert.equal(readFileSync(join(f.record.path, "feature.txt"), "utf8"), "new uncommitted work\n");
      if (change === "record") assert.equal(f.recordNow().lastRunId, "other-execution");
      if (change === "worktree") assert.equal(readFileSync(join(f.record.path, "keep.txt"), "utf8"), "unknown residual\n");
    });
  }
} finally { dispose(); }
if (failures.length) process.exitCode = 1;
