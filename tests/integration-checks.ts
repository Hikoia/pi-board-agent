import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, git, dispose } from "./cleanup-fixture.js";

const mergeCalls = () => calls.filter((a) => ["merge-tree", "commit-tree"].includes(a[0])).length;
const basePush = (a: string[]) => a[0] === "push" && a.some((s) => s.endsWith(":refs/heads/main"));
const deleting = (a: string[]) => a[0] === "push" && a.some((s) => s.startsWith(":refs/heads/task/"));
const removed = (f: Awaited<ReturnType<typeof integrationFixture>>) => {
  assert.equal(existsSync(f.recordFile), false, f.notices.join("\n"));
  assert.equal(existsSync(f.record.path), false); assert.equal(existsSync(f.admin), false);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
  assert.equal(git(f.origin, "for-each-ref", `refs/heads/${f.task.taskBranch}`), "");
  assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.done);
  assert.equal(existsSync(f.receipt), false);
  assert.equal(existsSync(join(f.repo, ".pi/board-agent/cleanup-backups")), false);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base, "main HEAD untouched");
};
export async function integrationChecks(group: "push" | "cleanup" | "settlement" | "project") { try {
  if (group === "push") {
    const f = await integrationFixture();
    writeFileSync(join(f.repo, "main-uncommitted.txt"), "main stays byte-identical\n");
    const index = readFileSync(join(f.repo, ".git/index"));
    calls.length = 0;
    faults.beforeGit = (args) => {
      if (basePush(args)) {
        const saved = JSON.parse(readFileSync(f.recordFile, "utf8"));
        assert.deepEqual(Object.keys(saved.integration).sort(), ["baseSha", "resultSha", "taskSha"]);
        assert.equal(saved.integration.baseSha, f.base); assert.equal(saved.integration.taskSha, f.taskSha);
        assert.equal(saved.integration.resultSha, args.at(-1)!.split(":")[0]);
        assert.equal(saved.retry.stage, "integrate"); assert.equal(f.tip(), f.base);
      }
      if (deleting(args)) assert.equal(f.store.read(f.task.itemId)?.retry?.stage, "cleanup");
    };
    await f.tick(); faults.beforeGit = undefined;
    removed(f);
    assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${f.base} ${f.taskSha}`);
    assert.deepEqual(readFileSync(join(f.repo, ".git/index")), index);
    assert.equal(readFileSync(join(f.repo, "main-uncommitted.txt"), "utf8"), "main stays byte-identical\n");
    const order = calls.map((a) => deleting(a) ? "remote" : a[0] === "worktree" && a[1] === "remove" ? "remove" : a[0] === "update-ref" ? "local" : "").filter(Boolean);
    assert.deepEqual(order, ["remote", "remove", "local"]);
    assert.equal(mergeCalls(), 2); console.log("PASS: merge-only base+task parents, atomic integration before push, native ordered cleanup including ignored lockfiles, no new receipt/backups and main unchanged");
  }
  if (group === "push") for (const cut of ["lost-response", "before-push"] as const) {
    const f = await integrationFixture(); calls.length = 0;
    if (cut === "lost-response") faults.afterGit = (args, result) => {
      if (basePush(args)) { assert.ok(result.ok); faults.afterGit = undefined; throw new Error("lost push response"); }
    };
    else faults.beforeGit = (args) => { if (basePush(args)) throw new Error("transport failed before push"); };
    await f.tick(); faults.beforeGit = faults.afterGit = undefined;
    if (cut === "before-push") {
      const result = f.store.read(f.task.itemId)?.integration?.resultSha;
      assert.ok(result); assert.equal(f.tip(), f.base); assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.card.closed, true);
      const before = mergeCalls(); await f.tick(); assert.equal(mergeCalls(), before); assert.equal(f.tip(), result);
    }
    removed(f); assert.equal(mergeCalls(), 2);
    console.log(`PASS: ${cut}: freshly observed remote separates push success from a prepared result; restart retries only I/O with zero duplicate merge/models`);
  }
  if (group === "push") {
    const f = await integrationFixture(); calls.length = 0;
    let advanced = "";
    faults.beforeGit = (a) => {
      if (!basePush(a)) return; faults.beforeGit = undefined;
      advanced = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "independent base advance");
      git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
    };
    await f.tick();
    assert.equal(f.tip(), advanced); assert.equal(f.card.status, f.cfg.columns.ready);
    assert.equal(f.store.read(f.task.itemId)?.integration?.baseSha, advanced);
    assert.equal(f.store.read(f.task.itemId)?.retry?.stage, "integrate");
    const merges = mergeCalls(); await f.tick(); removed(f);
    assert.equal(mergeCalls(), merges); assert.equal(merges, 4);
    assert.equal(git(f.repo, "show", "-s", "--format=%P", f.tip()), `${advanced} ${f.taskSha}`);
    console.log("PASS: advancing-base normal non-FF rejection prepares one fresh integration and next tick pushes it; no builder or lost base work");
  }
  if (group === "cleanup") for (const cut of ["remote", "remove-before", "remove-after", "local", "record"] as const) {
    const f = await integrationFixture(); calls.length = 0;
    const hit = (a: string[]) => cut === "remote" ? deleting(a) : cut.startsWith("remove") ? a[0] === "worktree" && a[1] === "remove" : a[0] === "update-ref";
    if (cut === "record") faults.beforeFs = (op, path) => { if (op === "unlink" && path === f.recordFile) throw new Error("record unlink failed"); };
    else if (cut === "remove-before") faults.beforeGit = (a) => { if (hit(a)) throw new Error("remove failed before mutation"); };
    else faults.afterGit = (a, result) => { if (hit(a)) { assert.ok(result.ok); throw new Error(`${cut} lost response`); } };
    await f.tick(); faults.beforeGit = faults.afterGit = faults.beforeFs = undefined;
    assert.equal(f.store.read(f.task.itemId)?.retry?.stage, "cleanup", f.notices.join("\n"));
    const result = f.tip(), merges = mergeCalls();
    assert.equal(f.card.status, f.cfg.columns.ready, f.notices.join("\n")); assert.equal(f.card.closed, true);
    await f.tick(); removed(f); assert.equal(f.tip(), result); assert.equal(mergeCalls(), merges);
    console.log(`PASS: ${cut} partial cleanup survives restart/missing refs/path, keeps closed approval + Ready retry and finishes without second merge/models`);
  }
  for (const operation of ["comment", "ready", "release", "done"] as const) {
    if ((group === "project" && operation === "done") || (group === "settlement" && operation !== "done")) for (const after of [false, true]) {
      const f = await integrationFixture(); f.card.assignees = ["bot"];
      let blocked = true;
      const fail = async (run: () => Promise<void>) => { if (after) await run(); if (blocked) throw new Error(`${operation} unavailable`); if (!after) await run(); };
      const comment = f.board.comment, status = f.board.setStatus, release = f.board.release;
      if (operation === "comment") f.board.comment = (c,b) => fail(() => comment(c,b));
      if (operation === "release") f.board.release = (c) => fail(() => release(c));
      if (operation === "ready" || operation === "done") f.board.setStatus = (id,s) =>
        s === (operation === "ready" ? f.cfg.columns.ready : f.cfg.columns.done) ? fail(() => status(id,s)) : status(id,s);
      faults.beforeGit = (a) => { if (a[0] === "worktree" && a[1] === "remove") throw new Error("native remove unavailable"); };
      calls.length = 0; await f.tick(); faults.beforeGit = undefined;
      const result = f.tip(), merges = mergeCalls();
      assert.equal(f.card.closed, true); assert.ok(existsSync(f.recordFile));
      if (operation === "done") await f.tick();
      assert.ok(existsSync(f.recordFile), "record retained until Project Done observed");
      blocked = false;
      for (let n = 0; n < 3 && existsSync(f.recordFile); n++) await f.tick();
      removed(f); assert.equal(f.tip(), result); assert.equal(mergeCalls(), merges);
      assert.ok(new Set(f.comments).size === f.comments.length, "lost comments observed, not duplicated");
      console.log(`PASS: ${operation} ${after ? "lost response" : "failure"} retains staged closed retry, settles partial Project/comment/release writes before I/O, no duplicate merge/models`);
    }
  }
  if (group === "project") {
    const f = await integrationFixture();
    faults.beforeGit = (a) => { if (a[0] === "worktree" && a[1] === "remove") throw new Error("hold cleanup"); };
    await f.tick(); faults.beforeGit = undefined;
    const result = f.tip(); git(f.origin, "update-ref", "refs/heads/main", f.base);
    calls.length = 0; await f.tick();
    assert.equal(mergeCalls(), 0); assert.ok(!calls.some(basePush)); assert.ok(existsSync(f.record.path));
    assert.equal(f.store.read(f.task.itemId)?.integration?.resultSha, result);
    git(f.origin, "update-ref", "refs/heads/main", result);
    await f.tick(); removed(f);
    console.log("PASS: once integrated, rewritten remote base blocks cleanup only; never rebuilds, remerges or pushes the result again");
  }
} finally { dispose(); }
}
