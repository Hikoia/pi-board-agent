import assert from "node:assert/strict";
import { fixture, settle, repairResult } from "./conflict-handoff-fixture.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";

for (const outcome of ["failure", "success"])
for (const write of ["notice", "status", "release"])
for (const edge of ["before", "after"] as const) {
  const f = await fixture(); let cut = false;
  const destination = outcome === "failure" ? f.cfg.columns.ready : f.cfg.columns.review;
  const target = write === "notice" ? "ordinary-comment" : write === "status" ? `status:${destination}` : "release";
  if (outcome === "success") f.setBuilder((prompt, options) => repairResult(f, prompt, options));
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f);
    f.setHook((event) => { if (!cut && event === `${edge}:${target}`) { cut = true; throw new Error(`ambiguous ${event}`); } });
    await f.loop.tickNow(); assert.ok(cut); assert.ok(pendingTicketWrite(f.store.read(f.task.itemId)!));
    await f.loop.stop(); f.setHook(() => {});
    const next = f.make();
    try {
      await next.loop.tickNow();
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal(f.card.status, destination); assert.equal(f.card.closed, false);
      assert.equal(f.store.read(f.task.itemId)?.activeRunId, undefined);
      assert.equal(pendingTicketWrite(f.store.read(f.task.itemId)!), undefined);
      assert.equal(f.comments.length, 2, "conflict and result each appear once, including a lost comment response");
      console.log(`PASS: ${outcome} ${edge} ${write} restart retries only pending I/O, drains/releases before clearing, and never repeats the builder on that tick`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}
for (const change of ["owner", "lane", "body"]) {
  const f = await fixture(); let changed = false;
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f);
    f.setHook((event) => { if (!changed && event === "after:ordinary-comment") { changed = true;
      if (change === "owner") f.card.assignees = ["maintainer"];
      if (change === "lane") f.card.status = "Human Hold";
      if (change === "body") f.card.body += " new acceptance";
    } });
    await f.loop.tickNow(); assert.ok(changed);
    assert.equal(f.card.status, change === "lane" ? "Human Hold" : f.cfg.columns.building);
    assert.equal(f.calls(), 1);
    assert.equal(f.events.slice(f.events.lastIndexOf("ordinary-comment") + 1).some((e) => e.startsWith("status:")), false);
    console.log(`PASS: later human ${change} after result notice prevents stale status writeback; only a freshly owned claim may be released`);
  } finally { await f.loop.stop(); }
}
