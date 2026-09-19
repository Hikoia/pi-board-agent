// Whole adapter check complements primitive N/2N counters with real Git/owner/state.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, faults, calls, dispose } from "./finalization-fixture.js";
import { historicalReceipt } from "./legacy-cleanup-fixture.js";
// Load after the fixture installs its Git/FS hooks (owner-lock imports the store).
const { acquireOwnerLock, assertOwnerLock } = await import("../src/owner-lock.js");

try {
  const f = await fixture(true), receipt = await historicalReceipt(f, false, true);
  const bytes = readFileSync(f.receipt), manifest = join(receipt.backup!, "verified.json");
  const backup = readFileSync(manifest), owner = acquireOwnerLock(f.repo, "bot");
  const check = () => assertOwnerLock(owner, f.repo);
  try {
    assert.deepEqual((await f.executor.migrateLegacy(owner)).failures, []);
    let validations = 0, deleted = 0;
    const controller = new AbortController();
    faults.beforeFs = (op, path) => { if (op === "open" && path === manifest) validations++; };
    faults.afterFs = (op, path) => { if (op === "unlink" && path.startsWith(f.record.path) && ++deleted === 1) controller.abort(); };
    const stopped = await f.executor.finalizeClosed(structuredClone(f.card), undefined, undefined, { signal: controller.signal, check });
    assert.equal(stopped.status, "skipped", JSON.stringify(stopped));
    assert.equal(deleted, 1); assert.equal(validations, 1);
    assert.equal(f.card.status, "Done"); assert.equal(f.card.closed, true);
    assert.deepEqual(f.events, []); assert.deepEqual(f.comments, []);
    assert.ok(existsSync(f.recordFile)); assert.ok(existsSync(f.record.path));
    check();
    console.log("PASS: owner-held legacy adapter stops after partial unlink without writeback, retains evidence and closes the attempt");

    validations = 0; faults.afterFs = undefined;
    const result = await f.executor.finalizeClosed(structuredClone(f.card), undefined, undefined, { check });
    assert.equal(result.status, "finalized", JSON.stringify(result));
    assert.equal(validations, 2, "whole cleanup attempt validates the complete backup only at prepare/finish");
    assert.equal(f.card.status, "Backlog"); assert.equal(f.card.closed, true);
    assert.equal(existsSync(f.record.path), false); assert.equal(existsSync(f.recordFile), false);
    assert.deepEqual(readFileSync(f.receipt), bytes); assert.deepEqual(readFileSync(manifest), backup);
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
    check();
    console.log("PASS: real adapter resumes partial deletion with fresh preparation, exactly two backup validations, unchanged historical evidence and no model work");
  } finally { faults.beforeFs = faults.afterFs = undefined; await f.loop.stop(); owner.release(); }

  const native = await fixture(), controller = new AbortController();
  faults.afterFs = (op, path) => { if (op === "readdir" && path === native.record.path) controller.abort(); };
  calls.length = 0;
  try {
    const stopped = await native.executor.finalizeClosed(structuredClone(native.card), undefined, undefined, { signal: controller.signal });
    assert.equal(stopped.status, "skipped"); assert.ok(controller.signal.aborted);
    assert.equal(native.card.status, "Done"); assert.ok(existsSync(native.record.path));
    assert.ok(!calls.some((a) => a[0] === "clean" || a[0] === "worktree" && a[1] === "remove" || a[0] === "push" && a.some((v) => v.startsWith(":refs/heads/task/"))));
    faults.afterFs = undefined;
    assert.equal((await native.finish()).status, "finalized");
    console.log("PASS: native nested-Git enumeration observes stop before scanning the next entry or starting cleanup, then safely retries");
  } finally { faults.afterFs = undefined; await native.loop.stop(); }
} finally { dispose(); }
