import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TicketExecutionRecordV4, TicketExecutionRecordV5, TicketPullRequestIntegration } from "../src/ticket-worktree.js";

// Intercept the real filesystem boundary, not store methods. No live state or GitHub.
let cut: (operation: string) => void = () => {};
const globals = globalThis as any;
globals.__ticketStoreIO = {
  writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
    cut("write");
    fs.writeFileSync(...args);
  },
  fsyncSync(fd: number) {
    cut("flush");
    fs.fsyncSync(fd);
    cut("flushed");
  },
  renameSync(from: fs.PathLike, to: fs.PathLike) {
    cut("rename");
    fs.renameSync(from, to);
    cut("renamed");
  },
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === new URL("../src/ticket-worktree.ts", import.meta.url).href && specifier === "node:fs")
      return { url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs';
        export const { writeFileSync, fsyncSync, renameSync } = globalThis.__ticketStoreIO;`)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { TicketWorktrees } = await import("../src/ticket-worktree.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");
const itemId = "PVTI_ATOMIC";
const integration = { baseSha: "a".repeat(40), taskSha: "b".repeat(40), resultSha: "c".repeat(40) };
const progress = { integration, retry: { stage: "integrate" as const, reason: "push observation pending" } };
const pr: TicketPullRequestIntegration = {
  kind: "pr", phase: "prepared",
  scope: { owner: "offline-owner", repo: "offline-repo", base: "main", head: "task/issue-1" },
  baseSha: integration.baseSha, taskSha: integration.taskSha, remoteTaskSha: null,
  preparedHeadSha: integration.resultSha, initialPreparedHeadSha: integration.resultSha,
};
const opened: TicketPullRequestIntegration = {
  ...pr, phase: "open", prNumber: 1, prUrl: "https://github.com/offline-owner/offline-repo/pull/1",
};
const preparation = {
  scope: pr.scope, baseSha: pr.baseSha, taskSha: pr.taskSha,
  remoteTaskSha: pr.remoteTaskSha, preparedHeadSha: pr.preparedHeadSha,
};
const noop = () => {};

try {
  if (process.argv[2] === "crash") {
    const store = new TicketWorktrees(process.argv[3]);
    cut = (operation) => {
      if (operation === process.argv[4]) process.exit(73);
    };
    store.update(itemId, (r) => ({ ...r, ...progress }));
    throw new Error("Crash cut did not execute");
  }

  if (process.argv[2] === "crash-v5") {
    const store = new TicketWorktrees(process.argv[3]);
    const owner = acquireOwnerLock(store.repoRoot, "offline-bot");
    const original = store.read(itemId)!;
    const source = fs.readFileSync(store.recordPath(itemId));
    const next: TicketExecutionRecordV5 = { ...original, schemaVersion: 5, integration: pr };
    cut = (operation) => { if (operation === process.argv[4]) process.exit(73); };
    store.publishV5(original, next, source, owner, noop);
    throw new Error("Crash cut did not execute");
  }

  let sequence = 0;
  function fixture(version: 3 | 4 = 4, seed = true) {
    const repo = join(process.env.TMP_DIR!, `atomic-${++sequence}`);
    fs.mkdirSync(repo);
    const store = new TicketWorktrees(repo);
    const dir = join(repo, ".pi", "board-agent", "ticket-worktrees");
    const file = join(dir, "pvti_atomic.json");
    const record: TicketExecutionRecordV4 = {
      schemaVersion: 4, itemId, issueNumber: 1, taskKey: "T001",
      taskBranch: "task/issue-1", baseBranch: "main",
      path: join(repo, ".pi", "worktrees", "unused"), createdAt: 1,
    };
    if (seed) {
      if (version === 4) store.create(record);
      else fs.writeFileSync(file, JSON.stringify({ ...record, schemaVersion: 3, plan: "demo" }, null, 2));
    }
    return { repo, store, dir, file, record };
  }

  for (const version of [3, 4] as const) {
    for (const operation of ["write", "flush", "rename", "renamed"]) {
      const f = fixture(version);
      const before = fs.readFileSync(f.file);
      cut = (step) => { if (step === operation) throw new Error(`offline ${step} interruption`); };
      assert.throws(() => f.store.update(itemId, (r) => ({ ...r,
        ...(version === 4 ? progress : { reviewedTaskSha: integration.taskSha }),
      })), /offline .* interruption/);
      cut = () => {};
      const reopened = new TicketWorktrees(f.repo).read(itemId)!;
      assert.equal(reopened.schemaVersion, version);
      if (operation === "renamed") {
        if (version === 4) {
          assert.deepEqual(reopened.integration, integration);
          assert.deepEqual(reopened.retry, progress.retry);
        } else assert.equal(reopened.reviewedTaskSha, integration.taskSha);
      } else assert.deepEqual(fs.readFileSync(f.file), before);
      assert.deepEqual(fs.readdirSync(f.dir), ["pvti_atomic.json"], "failed writes remove only their own temporary");
    }
    console.log(`PASS: v${version} write/flush/rename failures throw and restart sees exactly the old or complete new record`);
  }

  for (const operation of ["write", "flush", "rename", "renamed"]) {
    const f = fixture(4, false);
    cut = (step) => { if (step === operation) throw new Error(`offline ${step} interruption`); };
    assert.throws(() => f.store.create(f.record), /offline .* interruption/);
    cut = () => {};
    const reopened = new TicketWorktrees(f.repo);
    if (operation === "renamed") assert.deepEqual(reopened.read(itemId), f.record);
    else {
      assert.equal(reopened.has(itemId), false);
      assert.equal(reopened.read(itemId), undefined);
      assert.throws(() => reopened.clearExecution(itemId), /missing or unsupported/);
    }
    assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
  }
  console.log("PASS: interrupted v4 creation throws and leaves either no record or one complete published record, never false completion");

  for (const operation of ["flushed", "renamed"]) {
    const f = fixture();
    const before = fs.readFileSync(f.file);
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "crash", f.repo, operation], {
      encoding: "utf8", env: process.env,
    });
    assert.equal(child.status, 73, child.stderr);
    const store = new TicketWorktrees(f.repo);
    if (operation === "flushed") {
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp")).length, 1);
      assert.equal(store.read(itemId)?.integration, undefined, "unpublished temporary is not adopted");
    } else {
      assert.deepEqual(store.read(itemId)?.integration, integration);
      assert.deepEqual(store.read(itemId)?.retry, progress.retry);
    }
    assert.equal(store.list().length, 1);
    console.log(`PASS: abrupt child exit 73 after ${operation} retains whole authoritative state and never adopts an orphan temporary`);
  }

  for (const change of ["missing", "corrupt", "newer"]) {
    const f = fixture();
    const newer = JSON.stringify({ ...f.store.read(itemId), lastRunId: "external-update" });
    cut = (operation) => {
      if (operation !== "flushed") return;
      if (change === "missing") fs.unlinkSync(f.file);
      else fs.writeFileSync(f.file, change === "corrupt" ? "{bad" : newer);
    };
    assert.throws(() => f.store.update(itemId, (r) => ({ ...r, ...progress })), /atomic write boundary/);
    cut = () => {};
    if (change === "missing") assert.equal(fs.existsSync(f.file), false);
    else assert.equal(fs.readFileSync(f.file, "utf8"), change === "corrupt" ? "{bad" : newer);
    assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
  }
  console.log("PASS: disappeared, corrupt or changed source at the atomic boundary is never overwritten or reported settled");

  for (const version of [3, 4] as const) {
    for (const operation of ["write", "flush", "rename", "renamed"]) {
      const f = fixture(version), owner = acquireOwnerLock(f.repo, "offline-bot");
      try {
        const original = f.store.read(itemId)!;
        const raw = Buffer.from(JSON.stringify(original, null, "\t").replaceAll("\n", "\r\n") + "\r\n\r\n");
        fs.writeFileSync(f.file, raw);
        const next: TicketExecutionRecordV5 = { ...original, schemaVersion: 5, integration: pr };
        cut = (step) => { if (step === operation) throw new Error(`offline ${step} interruption`); };
        assert.throws(() => f.store.publishV5(original, next, raw, owner, noop), /offline .* interruption/);
        cut = () => {};
        const reopened = new TicketWorktrees(f.repo);
        if (operation === "renamed") assert.deepEqual(reopened.readV5(itemId), next);
        else {
          assert.deepEqual(fs.readFileSync(f.file), raw, "prepublication failure preserves exact readable legacy bytes");
          assert.deepEqual(reopened.read(itemId), original);
        }
        assert.deepEqual(fs.readdirSync(f.dir), ["pvti_atomic.json"]);
      } finally { cut = () => {}; owner.release(); }
    }
    console.log(`PASS: owner-held v${version} to v5 write/flush/rename cuts preserve exact source bytes or one whole PR preparation, never a partial migration`);
  }

  for (const action of ["create", "update", "prepare", "observe", "renew", "merge"] as const) {
    for (const operation of ["write", "flush", "rename", "renamed"]) {
      const f = fixture(4, false), owner = acquireOwnerLock(f.repo, "offline-bot");
      try {
        const initial: TicketExecutionRecordV5 = { ...f.record, schemaVersion: 5, integration: undefined };
        let previous = initial;
        if (action !== "create") {
          if (action === "observe" || action === "renew" || action === "merge")
            previous = { ...initial, integration: action === "renew" ? { ...opened, phase: "suspended" } : pr };
          fs.writeFileSync(f.file, JSON.stringify(previous));
        }
        const before = action === "create" ? undefined : fs.readFileSync(f.file);
        const next: TicketExecutionRecordV5 = action === "update" ? { ...previous, lastRunId: "saved-builder" }
          : action === "observe" ? { ...previous, integration: opened }
          : action === "merge" ? { ...previous, integration: { ...opened, phase: "merged", mergedHeadSha: "d".repeat(40), mergeCommitSha: "e".repeat(40) } }
          : action === "prepare" ? { ...previous, integration: pr }
          : action === "renew" ? { ...previous, integration: { ...opened, phase: "prepared", taskSha: "d".repeat(40), preparedHeadSha: "e".repeat(40) } }
          : initial;
        cut = (step) => { if (step === operation) throw new Error(`offline ${step} interruption`); };
        assert.throws(() => {
          if (action === "create") f.store.createV5(initial, owner, noop);
          else if (action === "update") f.store.updateV5(previous, () => next, owner, noop);
          else if (action === "prepare") f.store.preparePullRequest(previous, preparation, owner, noop);
          else if (action === "renew") f.store.preparePullRequest(previous, { ...preparation, taskSha: "d".repeat(40), preparedHeadSha: "e".repeat(40) }, owner, noop);
          else f.store.progressPullRequest(previous, next.integration as TicketPullRequestIntegration, undefined, owner, noop);
        }, /offline .* interruption/);
        cut = () => {};
        const reopened = new TicketWorktrees(f.repo);
        if (operation === "renamed") assert.deepEqual(reopened.readV5(itemId), JSON.parse(JSON.stringify(next)));
        else if (before) assert.deepEqual(fs.readFileSync(f.file), before);
        else assert.equal(reopened.has(itemId), false);
        assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
      } finally { cut = () => {}; owner.release(); }
    }
    console.log(`PASS: v5 ${action} failures publish exactly old or complete new evidence, retaining PR/source/merge recovery through interrupted I/O`);
  }

  for (const operation of ["flushed", "renamed"]) {
    const f = fixture();
    const before = fs.readFileSync(f.file);
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "crash-v5", f.repo, operation], {
      encoding: "utf8", env: process.env,
    });
    assert.equal(child.status, 73, child.stderr);
    const reopened = new TicketWorktrees(f.repo);
    if (operation === "flushed") {
      assert.deepEqual(fs.readFileSync(f.file), before);
      assert.equal(reopened.read(itemId)?.schemaVersion, 4);
      assert.equal(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp")).length, 1);
    } else assert.deepEqual(reopened.readV5(itemId)?.integration, pr);
    assert.equal(reopened.listStored().length, 1);
  }
  console.log("PASS: real child exits after v5 flush/rename retain an authoritative old/new record; orphan temporaries never become approval or PR evidence");

  for (const api of ["migrate", "progress"] as const) {
    for (const change of ["missing", "corrupt", "newer", "format", "owner-lost", "stopped", "task-moved", "owner-lost-in-guard"]) {
      const f = fixture(), owner = acquireOwnerLock(f.repo, "offline-bot");
      try {
        const original = f.store.read(itemId)!;
        const next: TicketExecutionRecordV5 = { ...original, schemaVersion: 5, integration: pr };
        if (api === "progress") fs.writeFileSync(f.file, JSON.stringify(next));
        const raw = fs.readFileSync(f.file);
        const newer = JSON.stringify({ ...(api === "progress" ? next : original), lastRunId: "external-update" });
        let stopped = false, taskMoved = false, checks = 0;
        const guard = () => {
          if (stopped) throw new Error("offline stopped");
          if (taskMoved) throw new Error("offline task moved");
          if (++checks === 2 && change === "owner-lost-in-guard") owner.release();
        };
        cut = (operation) => {
          if (operation !== "flushed") return;
          if (change === "missing") fs.unlinkSync(f.file);
          if (change === "corrupt") fs.writeFileSync(f.file, "{external corrupt");
          if (change === "newer") fs.writeFileSync(f.file, newer);
          if (change === "format") fs.writeFileSync(f.file, raw.toString() + "\n");
          if (change === "owner-lost") owner.release();
          if (change === "stopped") stopped = true;
          if (change === "task-moved") taskMoved = true;
        };
        assert.throws(() => api === "migrate"
          ? f.store.publishV5(original, next, raw, owner, guard)
          : f.store.progressPullRequest(next, opened, undefined, owner, guard), /atomic write boundary|owner.lock|owner was lost|offline stopped|offline task moved/);
        cut = () => {};
        if (change === "missing") assert.equal(fs.existsSync(f.file), false);
        else assert.deepEqual(fs.readFileSync(f.file), Buffer.from(change === "corrupt" ? "{external corrupt" :
          change === "newer" ? newer : change === "format" ? raw.toString() + "\n" : raw));
        assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
      } finally { cut = () => {}; owner.release(); }
    }
    console.log(`PASS: v5 ${api} rechecks exact bytes, owner (including guard-time loss), stop and approved task sources at publication; no raced source is overwritten`);
  }

  {
    const f = fixture();
    const bytes = fs.readFileSync(f.file);
    const outside = `${f.dir}-preserved`;
    fs.renameSync(f.dir, outside);
    fs.symlinkSync(outside, f.dir, process.platform === "win32" ? "junction" : "dir");
    assert.equal(f.store.read(itemId), undefined);
    assert.throws(() => f.store.clearExecution(itemId), /missing or unsupported/);
    assert.throws(() => f.store.create({ ...JSON.parse(bytes.toString()), itemId: "NEW" }), /Symlinked ticket state/);
    assert.deepEqual(fs.readFileSync(join(outside, "pvti_atomic.json")), bytes);
    assert.deepEqual(fs.readdirSync(outside), ["pvti_atomic.json"]);
  }
  console.log("PASS: replacing a state directory with a symlink after construction cannot redirect store reads or writes");
} finally {
  hooks.deregister();
  delete globals.__ticketStoreIO;
}
