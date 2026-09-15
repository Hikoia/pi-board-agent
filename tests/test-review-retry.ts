import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runReview, parseReviewOutput } from "../src/review.js";
import { fixture, settle } from "./conflict-handoff-fixture.js";

{
  const f = await fixture(false);
  f.card.closed = false; f.card.status = f.cfg.columns.review;
  f.store.setReviewedTaskSha(f.card.itemId, f.taskSha);
  let models = 0, scratch = "";
  f.setReview((input) => runReview(input, async (_source, { cwd }) => {
    models++; scratch = cwd;
    writeFileSync(join(cwd, "unfinished-review.txt"), "preserve these uncommitted bytes\n");
    return { result: { verdict: "pass", summary: "Verified exact SHA before cleanup", findings: [] } };
  }));
  try {
    await f.loop.tickNow();
    assert.equal(models, 1); assert.equal(f.card.status, f.cfg.columns.review);
    assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "review");
    assert.match(f.store.read(f.card.itemId)!.retry!.reason, /AI review passed/);
    assert.equal(readFileSync(join(scratch, "unfinished-review.txt"), "utf8"), "preserve these uncommitted bytes\n");
    assert.deepEqual(f.card.assignees, ["bot"]);
    await f.loop.tickNow();
    assert.equal(models, 1, "failed native cleanup retries I/O before any review model");
    assert.equal(f.card.status, f.cfg.columns.review); assert.ok(existsSync(scratch));
    assert.notEqual(f.card.status, f.cfg.columns.needs_human);
    // Explicit fixture/user cleanup, not an automation reset/discard fallback.
    unlinkSync(join(scratch, "unfinished-review.txt"));
    await f.loop.tickNow();
    assert.equal(models, 1); assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.card.closed, false);
    assert.deepEqual(f.card.assignees, []); assert.equal(existsSync(scratch), false);
    assert.ok(existsSync(f.record.path)); assert.equal(f.store.read(f.card.itemId)?.reviewedTaskSha, f.taskSha);
    console.log("PASS: managed review persists PASS before cleanup I/O; dirty scratch is never forced away, cleanup retries without model/claim replay and only then settles open Done");
  } finally { await f.loop.stop(); }
}
{
  const f = await fixture(false);
  f.card.closed = false; f.card.status = f.cfg.columns.ready;
  let mission = "";
  f.setBuilder(async (prompt) => {
    if (f.calls() === 1) return { itemId: f.card.itemId, taskKey: f.task.taskKey, status: "needs_decision",
      question: "Which deployment is authorized?", context: "Deployment changes cost and access.",
      options: ["Staging", "Production after approval"], recommendation: "Use staging first." };
    mission = prompt;
    return { itemId: f.card.itemId, taskKey: f.task.taskKey, status: "failure", error: "offline fixture stops after reading the decision" };
  });
  try {
    await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.equal(f.card.status, f.cfg.columns.needs_human);
    f.comments.push({ id: "trusted", author: "maintainer", authorAssociation: "MEMBER", body: "APPROVED_STAGING_ONLY", createdAt: "1" },
      { id: "untrusted", author: "outsider", authorAssociation: "NONE", body: "UNTRUSTED_PRODUCTION_OVERRIDE", createdAt: "2" });
    await f.loop.tickNow(); assert.equal(f.calls(), 1, "a trusted reply alone does not resume");
    f.card.status = f.cfg.columns.ready;
    await f.loop.tickNow(); await settle(f);
    assert.equal(f.calls(), 2); assert.match(mission, /APPROVED_STAGING_ONLY/); assert.doesNotMatch(mission, /UNTRUSTED_PRODUCTION_OVERRIDE/);
    assert.equal(f.runs().length, 2); assert.ok(f.runs().every((r) => !(r.args as any).repair));
    console.log("PASS: actual builder mission receives only trusted maintainer replies after manual Ready; comments alone do not resume and no repair args are generated");
  } finally { await f.loop.stop(); }
}
{
  const complete = { verdict: "needs_decision", question: "Choose approved cost?", context: "Budget not specified.",
    options: ["Low-cost staging", "Higher-cost production"], recommendation: "Staging." };
  assert.equal(parseReviewOutput(complete)?.verdict, "needs_decision");
  assert.equal(parseReviewOutput({ ...complete, options: [] }), null);
  assert.equal(parseReviewOutput({ ...complete, options: ["same", " SAME "] }), null);
  assert.equal(parseReviewOutput({ ...complete, recommendation: "" }), null);
  assert.equal(parseReviewOutput({ verdict: "fail", summary: "tool timeout", findings: [] }), null);
  console.log("PASS: review requires a complete concrete decision; incomplete decisions and missing findings remain technical execution errors");
}
