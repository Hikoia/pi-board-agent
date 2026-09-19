import assert from "node:assert/strict";
import { observeOperation, activityLines, type OperationObservation } from "../src/operation.js";
import { readRuntimeStatus, writeRuntimeStatus } from "../src/runtime.js";

let clock = 0, published = 0;
const state: OperationObservation = { lastBlocker: "old failure" };
const observation = observeOperation(state, "finalization", () => { published++; }, { itemId: "I", issueNumber: 7 }, () => clock);
assert.equal(published, 1); assert.equal(state.lastBlocker, undefined);
observation.onProgress({ phase: "verify-backup", completed: 0, total: 100, unit: "bytes" });
assert.equal(published, 2, "phase changes publish immediately");
for (let i = 1; i < 100; i++) { clock = i * 10; observation.onProgress({ phase: "verify-backup", completed: i, total: 100, unit: "bytes" }); }
assert.equal(published, 2); assert.equal(state.activity!.lastProgressAt, 990);
clock = 1000;
observation.onProgress({ phase: "verify-backup", completed: 99, total: 100, unit: "bytes" });
assert.equal(published, 3); assert.equal(state.activity!.lastProgressAt, 990, "heartbeat-like repeats are not progress");
assert.match(activityLines(state, 90, 301_000).join("\n"), /#7.*verify-backup.*MiB/);
assert.match(activityLines(state, 90, 301_000).join("\n"), /STALE PROGRESS/);
assert.ok(!activityLines(state, 200, 301_000).join("\n").includes("STALE"));
observation.finish("network unavailable");
assert.equal(published, 4); assert.equal(state.activity, undefined);
assert.deepEqual(activityLines(state, 90), ["Maintenance blocked: network unavailable"]);
const next = observeOperation(state, "migration", () => { published++; }, {}, () => clock);
assert.equal(state.lastBlocker, undefined);
next.onProgress({ phase: "read-evidence", itemId: "NEXT", issueNumber: 8, completed: 0, total: 1, unit: "items" });
assert.equal(published, 6, "ticket change is immediately observable");
next.finish(); assert.equal(state.activity, undefined);
console.log("PASS: observational progress is 1Hz except stage/ticket/end, distinguishes heartbeat/stall and clears activity while retaining blockers");

const cwd = process.env.TMP_DIR!;
assert.ok(cwd);
const old = writeRuntimeStatus(cwd, { expectedRevision: null, loadedRevision: null, diskRevision: null, dirty: false, pid: process.pid, state: "running", startedAt: new Date().toISOString() });
assert.equal(old.schemaVersion, 1); assert.equal(readRuntimeStatus(cwd)?.activity, undefined);
for (const lifecycle of ["starting", "stopping"] as const) {
  writeRuntimeStatus(cwd, { ...old, state: lifecycle, activity: { kind: "migration", phase: "read-evidence", startedAt: 1, lastProgressAt: 2 }, lastBlocker: "retained" });
  const current = readRuntimeStatus(cwd)!;
  assert.equal(current.schemaVersion, 1); assert.equal(current.state, lifecycle);
  assert.equal(current.activity?.lastProgressAt, 2); assert.equal(current.lastBlocker, "retained");
}
console.log("PASS: schema-1 runtime remains compatible without activity and round-trips starting/stopping and progress");
