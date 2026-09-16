// A02 F2: losing completed-run evidence must not select ordinary Review/Ready.
import assert from "node:assert/strict";
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runReview } from "../src/review.js";
import { fixture, settle, repairResult, git } from "./conflict-handoff-fixture.js";

for (const verdict of ["pass", "fail"] as const) {
  const f = await fixture(); let testedSha = "", reviews = 0;
  f.setBuilder(async (prompt, options) => {
    const result = await repairResult(f, prompt, options);
    testedSha = result.testEvidence.resultSha; return result;
  });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.equal(f.card.status, f.cfg.columns.review);
    const run = f.runs()[0]; await f.loop.stop();
    const persistence = createRunPersistence(f.record.path);
    assert.equal(persistence.delete(run.runId), true);
    assert.equal(persistence.load(run.runId), null);
    if (verdict === "pass") {
      writeFileSync(join(f.record.path, "value.json"), '{"task":true,"base":false}\n');
      git(f.record.path, "add", "value.json"); git(f.record.path, "commit", "-m", "later untested task change");
      git(f.record.path, "push", "origin", f.task.taskBranch);
      assert.notEqual(git(f.record.path, "rev-parse", "HEAD"), testedSha);
    }

    f.setReview(async (input) => {
      reviews++;
      return runReview(input, async () => ({ result: { verdict, summary: "offline verdict", findings: verdict === "pass" ? [] : ["Missing repair tests"] } }));
    });
    const next = f.make();
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.card.status, f.cfg.columns.needs_human, `missing bound run cannot use ordinary ${verdict} Review`);
      assert.equal(f.store.read(f.card.itemId)?.reviewedTaskSha, undefined, "no untested newer SHA approval");
      assert.equal(f.store.read(f.card.itemId)?.lastRunId, run.runId);
      assert.equal(f.calls(), 1, "Review cannot automatically launch an ordinary retry");
      assert.equal(reviews, 0, "required missing evidence blocks before model invocation");
      assert.equal(f.card.closed, false);
      console.log(`PASS: missing completed repair run blocks ${verdict} Review and automatic Ready/retry despite surviving binding`);
      if (verdict === "fail") {
        // Explicit maintainer Ready is still the existing ordinary retry path.
        f.card.status = f.cfg.columns.ready;
        f.setBuilder(async () => ({ taskKey: f.task.taskKey, itemId: f.card.itemId, branch: f.task.taskBranch, status: "success" }));
        await next.loop.tickNow(); await settle(f);
        const retry = f.runs()[0];
        assert.notEqual(retry.runId, run.runId); assert.equal((retry.args as any).repair, undefined);
        await next.loop.tickNow(); await next.loop.tickNow();
        assert.equal(f.calls(), 2); assert.equal(reviews, 1, "the later ordinary run is not bound to the old repair");
        assert.equal(f.card.status, f.cfg.columns.ready, "ordinary Review failure retains normal retry behavior");
        console.log("PASS: explicit maintainer retry gets a new ordinary run and ordinary Review behavior");
      }
    } finally { await next.loop.stop(); }
  } catch (error) { console.error(error); console.log(`FAIL: missing repair evidence ${verdict}`); process.exitCode = 1; }
  finally { await f.loop.stop(); }
}
