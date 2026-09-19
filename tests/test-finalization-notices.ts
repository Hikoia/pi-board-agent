// Notification deduplication is never retry authority.
import assert from "node:assert/strict";
import { fixture, calls, faults, dispose } from "./finalization-fixture.js";
try {
  const f = await fixture();
  f.failClaim(true);
  let reason = "offline fetch unavailable";
  faults.beforeGit = (a) => {
    if (a[0] === "fetch") throw new Error(reason);
  };
  const warnings = () =>
    f.notices.filter((s) => s.startsWith("Finalization blocked"));
  const tick = async (count: number) => {
    const before = calls.filter((a) => a[0] === "fetch").length;
    await f.loop.tickNow();
    assert.equal(
      calls.filter((a) => a[0] === "fetch").length,
      before + 1,
      "every tick retries the actual I/O",
    );
    assert.equal(warnings().length, count);
    assert.equal(f.starts(), 0);
  };
  try {
    await tick(1);
    await tick(1);
    await tick(1);
    reason = "offline fetch permission denied";
    await tick(2);
    await tick(2);
    reason = "offline fetch unavailable";
    await tick(3);
    f.card.type = "Story"; await tick(3); // Closed Done Issues of any Type still finalize.
    f.card.type = "Task"; await tick(3);
    for (const patch of [
      { closed: false },
      { status: "Needs Human" },
      { contentType: "PullRequest" },
      { repoOwner: "other" },
    ]) {
      const card = structuredClone(f.card),
        before = warnings().length;
      Object.assign(f.card, patch);
      await f.loop.tickNow();
      assert.equal(warnings().length, before);
      Object.assign(f.card, card);
      await tick(before + 1);
    }
    faults.beforeGit = undefined;
    f.failClaim(false);
    await f.loop.tickNow();
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(f.notices.filter((s) => s.startsWith("Finalized")).length, 1);
    console.log(
      "PASS: unchanged finalization blockers warn once but retry every tick; changed/returning reasons and re-eligible tickets warn again, then real recovery cleans up once",
    );
  } finally {
    await f.loop.stop();
  }

  const other = await fixture();
  other.failClaim(true);
  faults.beforeGit = (a) => {
    if (a[0] === "fetch") throw new Error("offline fetch unavailable");
  };
  try {
    await other.loop.tickNow();
    await other.loop.tickNow();
    assert.equal(
      other.notices.filter((s) => s.startsWith("Finalization blocked")).length,
      1,
    );
    assert.equal(other.starts(), 0);
    assert.equal(other.tip(), other.base);
    console.log(
      "PASS: a separate ticket/loop has independent blocker memory, never a persistent completed/failed cache",
    );
  } finally {
    await other.loop.stop();
  }
} finally {
  dispose();
}
