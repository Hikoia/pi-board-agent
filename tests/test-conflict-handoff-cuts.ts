import assert from "node:assert/strict";
import { fixture, settle, advanceBase, git } from "./conflict-handoff-fixture.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";

for (const target of ["ordinary-comment", "status:Ready", "reopen", "release", "claim"])
for (const edge of ["before", "after"] as const) {
  const f = await fixture(); let cut = false;
  f.setHook((event) => { if (!cut && event === `${edge}:${target}`) { cut = true; throw new Error(`offline ${event}`); } });
  try {
    await f.loop.tickNow(); assert.ok(cut, `${edge}:${target}`);
    assert.equal(f.calls(), 0);
    assert.ok(f.store.read(f.card.itemId)?.retry);
    await f.loop.stop(); f.setHook(() => {});
    const advanced = advanceBase(f), next = f.make();
    try {
      // Re-observe/write back only; even a completed write cannot launch twice.
      await next.loop.tickNow();
      assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready);
      assert.equal(f.calls(), 0);
      assert.equal(pendingTicketWrite(f.store.read(f.card.itemId)!), undefined);
      assert.equal(f.comments.filter((c) => c.body.includes("Merge conflict")).length, 1);
      await next.loop.tickNow(); await settle(f);
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal((f.runs()[0].args as any).repair, undefined);
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), advanced);
      console.log(`PASS: ${edge} ${target} conflict I/O cut survives restart/base advance, settles once and launches only on a later tick`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}

for (const target of ["read:comments", "read:card"]) {
  const f = await fixture(); let fail = false;
  f.setHook((event) => {
    if (event === "after:claim") fail = true;
    if (fail && event === target) throw new Error("unavailable observation");
  });
  try {
    await f.loop.tickNow(); await f.loop.tickNow();
    assert.equal(f.calls(), 0); assert.ok(f.store.read(f.card.itemId)?.retry);
    f.setHook(() => {});
    await f.loop.tickNow();
    assert.equal(f.calls(), 0); assert.equal(f.card.closed, false);
    assert.equal(f.card.status, f.cfg.columns.ready);
    console.log(`PASS: conflict ${target} failure preserves I/O retry and never launches from an unreadable outcome`);
  } finally { await f.loop.stop(); }
}
