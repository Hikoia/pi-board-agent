import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TicketExecutionRecordV4 } from "../src/ticket-worktree.js";

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
const itemId = "PVTI_ATOMIC";
const integration = { baseSha: "a".repeat(40), taskSha: "b".repeat(40), resultSha: "c".repeat(40) };
const progress = { integration, retry: { stage: "integrate" as const, reason: "push observation pending" } };

try {
  if (process.argv[2] === "crash") {
    const store = new TicketWorktrees(process.argv[3]);
    cut = (operation) => {
      if (operation === process.argv[4]) process.exit(73);
    };
    store.update(itemId, (r) => ({ ...r, ...progress }));
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
