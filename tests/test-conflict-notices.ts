import assert from "node:assert/strict";
import { fixture, git } from "./conflict-handoff-fixture.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";

for (const target of ["read:comments", "read:card"] as const) {
  const f = await fixture();
  let reads = 0;
  f.setHook((event) => {
    if (event === target && pendingTicketWrite(f.store.read(f.task.itemId)!)) {
      reads++;
      throw new Error("offline writeback observation unavailable");
    }
  });
  try {
    for (let tick = 0; tick < 3; tick++) {
      const before = reads;
      await f.loop.tickNow();
      assert.ok(reads > before);
      assert.equal(f.calls(), 0);
      assert.equal(f.runs().length, 0);
      assert.ok(pendingTicketWrite(f.store.read(f.task.itemId)!));
      assert.equal(f.card.closed, true);
      assert.equal(f.card.status, f.cfg.columns.done);
      assert.equal(f.comments.length, 0);
    }
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
    f.setHook(() => {});
    await f.loop.tickNow();
    assert.equal(f.calls(), 0);
    assert.equal(f.comments.length, 1);
    assert.equal(f.card.closed, false);
    assert.equal(f.card.status, f.cfg.columns.ready);
    console.log(
      `PASS: ${target} failure remains a visible local I/O retry, never falsely reports Ready or repeats a model; fresh recovery settles one conflict notice`,
    );
  } finally {
    await f.loop.stop();
  }
}
