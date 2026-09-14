import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fixture, calls, faults, dispose } from "./cleanup-fixture.js";
try {
  for (const after of [false, true]) {
    const f = await fixture(), original = readFileSync(f.recordFile); calls.length = 0;
    const cut = (op: string) => { if (op === "rename") throw new Error("atomic integration publication cut"); };
    if (after) faults.afterSync = cut; else faults.beforeSync = cut;
    await assert.rejects(f.finish(), /atomic integration publication cut/);
    faults.beforeSync = faults.afterSync = undefined;
    assert.equal(f.tip(), f.base); assert.ok(existsSync(f.record.path));
    assert.ok(!calls.some((a) => a[0] === "push"));
    if (!after) assert.deepEqual(readFileSync(f.recordFile), original);
    else assert.ok(f.store.read(f.task.itemId)?.integration?.resultSha);
    assert.ok(!readdirSync(dirname(f.recordFile)).some((s) => s.endsWith(".tmp")));
    const merges = calls.filter((a) => a[0] === "commit-tree").length;
    await f.finish();
    if (after) assert.equal(calls.filter((a) => a[0] === "commit-tree").length, merges);
    assert.equal(existsSync(f.recordFile), false);
    console.log(`PASS: ${after ? "lost atomic rename response" : "failed atomic rename"} never pushes before complete integration publication, retains intact evidence and safely retries`);
  }
} finally { dispose(); }
