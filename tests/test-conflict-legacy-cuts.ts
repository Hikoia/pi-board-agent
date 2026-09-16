import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fixture, faults, dispose } from "./finalization-fixture.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
try {
  for (const cut of ["before-archive", "after-archive", "before-publish"] as const) {
    const f = await fixture(true);
    f.store.update(f.task.itemId, (r) => ({ ...r, finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha } }));
    const bytes = readFileSync(f.recordFile), archive = join(f.repo, ".pi/board-agent/legacy-v3", basename(f.recordFile));
    const owner = acquireOwnerLock(f.repo, "bot"); let reached = false;
    const fail = () => { reached = true; throw new Error(cut); };
    if (cut === "before-publish") faults.beforeSyncFs = (op, from, to) => { if (op === "renameSync" && to === f.recordFile && JSON.parse(readFileSync(from, "utf8")).schemaVersion === 4) fail(); };
    else faults[cut === "before-archive" ? "beforeFs" : "afterFs"] = (op, path) => { if (op === "link" && path.includes("legacy-v3")) fail(); };
    try {
      const report = await f.executor.migrateLegacy(owner);
      assert.ok(reached); assert.equal(report.failures.length, 1);
      assert.deepEqual(readFileSync(f.recordFile), bytes); assert.equal(f.events.length, 0);
      if (cut !== "before-archive") assert.deepEqual(readFileSync(archive), bytes);
      faults.beforeFs = faults.afterFs = faults.beforeSyncFs = undefined;
      const next = f.make(); assert.deepEqual((await next.migrateLegacy(owner)).failures, []);
      assert.deepEqual(readFileSync(archive), bytes); assert.equal(f.recordNow().schemaVersion, 4);
      assert.equal((await next.finalizeClosed(f.card)).status, "finalized");
      assert.ok(existsSync(archive)); assert.equal(f.starts(), 0);
      console.log(`PASS: ${cut} pre-result migration interruption preserves exact raw intent, then reentrant conversion/finalization needs no old repair-intent clear protocol`);
    } finally { faults.beforeFs = faults.afterFs = faults.beforeSyncFs = undefined; owner.release(); }
  }
} finally { dispose(); }
