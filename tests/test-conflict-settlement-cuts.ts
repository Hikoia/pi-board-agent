import assert from "node:assert/strict";
import { fixture, settle, repairResult } from "./conflict-handoff-fixture.js";

{
  const f = await fixture(); let cut = false;
  f.setHook((event) => { if (!cut && event === "before:ordinary-comment") { cut = true; throw new Error("ambiguous failure notice creation"); } });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.ok(cut); await f.loop.stop(); f.setHook(() => {});
    const next = f.make();
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.events.filter((e) => e === "ordinary-comment").length, 1, "ambiguous nonidempotent repair notice cannot be blindly recreated");
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal(f.card.status, f.cfg.columns.building, "unconfirmed notice blocks settlement, never retries builder");
      console.log("PASS: ambiguous repair result notice is not blindly replayed across restart; execution/request stay consumed and blocked");
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}

for (const outcome of ["failure", "success"]) for (const write of ["notice", "status", "release"]) for (const edge of ["before", "after"] as const) {
  if (outcome === "failure" && write === "notice" && edge === "before") continue; // tracer above
  const f = await fixture(); let cut = false;
  const destination = outcome === "failure" ? f.cfg.columns.needs_human : f.cfg.columns.review;
  const target = write === "notice" ? "ordinary-comment" : write === "status" ? `status:${destination}` : "release";
  if (outcome === "success") f.setBuilder((prompt, options) => repairResult(f, prompt, options));
  f.setHook((event) => { if (!cut && event === `${edge}:${target}`) { cut = true; throw new Error(`ambiguous ${event}`); } });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.ok(cut, `${outcome} ${edge} ${target}`); await f.loop.stop(); f.setHook(() => {});
    const next = f.make();
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal(f.events.filter((e) => e === "ordinary-comment").length, 1, "never duplicate result notice");
      assert.equal(f.card.status, write === "notice" && edge === "before" ? f.cfg.columns.building : destination, f.notices.join("\n"));
      assert.equal(f.card.closed, false);
      assert.equal(f.events.filter((e) => e === "request-comment").length, 1);
      if (write !== "notice" || edge !== "before") assert.equal(f.store.read(f.card.itemId)?.activeRunId, undefined);
      console.log(`PASS: ${outcome} ${edge} ${write} restart confirms idempotent settlement or blocks ambiguity, with one persistent run/notice and no Ready retry`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}

for (const change of ["owner", "lane", "body"]) {
  const f = await fixture(); let changed = false;
  f.setHook((event) => { if (!changed && event === "after:ordinary-comment") { changed = true;
    if (change === "owner") f.card.assignees = ["maintainer"];
    if (change === "lane") f.card.status = "Human Hold";
    if (change === "body") f.card.body += " new acceptance";
  } });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.ok(changed);
    const index = f.events.indexOf("ordinary-comment"); assert.deepEqual(f.events.slice(index + 1), [], "no settlement write against a later human decision");
    assert.equal(f.card.status, change === "lane" ? "Human Hold" : f.cfg.columns.building);
    console.log(`PASS: later human ${change} after terminal notice blocks status/release writeback`);
  } finally { await f.loop.stop(); }
}
