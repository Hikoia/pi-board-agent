import assert from "node:assert/strict";
import { fixture, settle } from "./conflict-handoff-fixture.js";

{
  const f = await fixture();
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.stop();
    const run = f.runs()[0];
    // Model the ticket-record side of an interrupted persistence boundary: the
    // independently durable run survived, but v4 is launching.
    f.store.clearExecution(f.card.itemId);
    f.store.beginLaunch(f.card.itemId, Date.parse(run.startedAt));
    const next = f.make();
    try {
      await next.loop.tickNow();
      assert.equal(f.store.read(f.card.itemId)?.lastRunId, run.runId, "adopt the already-bound run, not an unidentified-launch fallback");
      assert.equal(f.runs().length, 1); assert.equal(f.calls(), 1);
      assert.equal(f.card.status, f.cfg.columns.ready);
      console.log("PASS: a unique persisted run plus interrupted v4 launching association adopts exactly the same run across restart");
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}
