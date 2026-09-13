import assert from "node:assert/strict";
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, settle, repairResult } from "./conflict-handoff-fixture.js";

const f = await fixture(); let reviews = 0;
f.setBuilder((prompt, options) => repairResult(f, prompt, options));
try {
  await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.review);
  const original = f.runs()[0]; await f.loop.stop();
  const persistence = createRunPersistence(f.record.path);
  f.cfg.review.enabled = true;
  f.setReview(async () => { reviews++; return { verdict: "pass", summary: "must not review incomplete evidence", findings: [], taskSha: f.taskSha }; });
  for (const mode of ["corrupt-file", "missing-args", "stripped-repair", "replaced-repair", "missing-history"] as const) {
    const run = structuredClone(original);
    if (mode === "missing-args") delete run.args;
    if (mode === "stripped-repair") delete (run.args as any).repair;
    if (mode === "replaced-repair") (run.args as any).repair.requestKey = "unrelated-input";
    if (mode === "missing-history") run.agents.forEach((agent) => { delete agent.history; });
    persistence.save(run);
    if (mode === "corrupt-file") {
      // Upstream save refreshes BOTH primary and .bak with the same state.
      for (const suffix of [".json", ".json.bak"])
        writeFileSync(join(persistence.getRunsDir(), `${run.runId}${suffix}`), "{incomplete");
      assert.equal(persistence.load(run.runId), null);
    }
    f.card.status = f.cfg.columns.review; const next = f.make();
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.card.status, f.cfg.columns.needs_human, `${mode}: required bound repair evidence fails closed`);
      assert.equal(reviews, 0); assert.equal(f.calls(), 1);
      assert.equal(f.store.read(f.card.itemId)?.lastRunId, original.runId);
      assert.equal(f.store.read(f.card.itemId)?.reviewedTaskSha, undefined);
      assert.equal(f.card.closed, false);
      console.log(`PASS: Review ${mode} cannot erase a surviving consumed repair binding`);
    } catch (error) { console.error(error); console.log(`FAIL: Review ${mode}`); process.exitCode = 1; }
    finally { await next.loop.stop(); }
  }
  // Evidence loss does not authorize quarantine against unknown or later human authority.
  const body = f.card.body;
  for (const mode of ["author", "unknown", "owner", "revision", "late-body", "late-author"] as const) {
    f.card.status = f.cfg.columns.review; f.card.assignees = []; f.card.body = body;
    f.comments[0].author = "bot"; f.setRevision(true); f.setHook(() => {});
    if (mode === "author") f.comments[0].author = "attacker";
    if (mode === "owner") f.card.assignees = ["maintainer"];
    if (mode === "revision") f.setRevision(false);
    f.setHook((event) => {
      if (mode === "unknown" && event === "read:comments") throw new Error("offline comments unavailable");
      if (event === "after:ordinary-comment") {
        if (mode === "late-body") f.card.body += " changed by maintainer";
        if (mode === "late-author") f.comments[0].author = "attacker";
      }
    });
    const before = f.events.length, next = f.make();
    try {
      await next.loop.tickNow();
      assert.equal(f.card.status, f.cfg.columns.review, `${mode}: evidence blocker cannot override fresh authority`);
      assert.equal(f.events.slice(before).some((event) => event.startsWith("status:")), false);
      assert.equal(f.store.read(f.card.itemId)?.lastRunId, original.runId);
      assert.equal(reviews, 0); assert.equal(f.calls(), 1);
      console.log(`PASS: missing repair Review evidence respects ${mode} authority without fallback lane writes`);
    } finally { await next.loop.stop(); }
  }
} finally { await f.loop.stop(); }
