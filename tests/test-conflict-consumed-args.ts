// A02 F3: the durable binding, not an optional run field, identifies repair.
import assert from "node:assert/strict";
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
import { fixture, settle, git, repairResult } from "./conflict-handoff-fixture.js";

for (const mode of ["missing", "nonconflict"] as const) {
  const f = await fixture();
  f.setBuilder(mode === "missing"
    ? async () => ({ taskKey: f.task.taskKey, itemId: f.card.itemId, branch: f.task.taskBranch, status: "success", summary: "No merge, tests or push performed" })
    : (prompt, options) => repairResult(f, prompt, options));
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f);
    const run = f.runs()[0];
    assert.ok((run.args as any).repair);
    assert.equal(f.store.read(f.card.itemId)?.activeRunId, run.runId);
    await f.loop.stop();
    if (mode === "missing") delete (run.args as any).repair;
    else (run.args as any).repair.requestKey = "unrelated-trusted-input";
    createRunPersistence(f.record.path).save(run);
    const next = f.make();
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.card.status, f.cfg.columns.needs_human, "consumed repair args cannot downgrade to ordinary success");
      assert.equal(f.store.read(f.card.itemId)?.lastRunId, run.runId);
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal(f.comments.some((c) => c.body.includes(`board-agent-run:${run.runId}:success`)), false);
      assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), git(f.record.path, "rev-parse", "HEAD"));
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
      console.log(`PASS: consumed bound run with ${mode} repair args fails closed without success or automatic retry`);
    } finally { await next.loop.stop(); }
  } catch (error) { console.error(error); console.log(`FAIL: consumed ${mode} repair args`); process.exitCode = 1; }
  finally { await f.loop.stop(); }
}
