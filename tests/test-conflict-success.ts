import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runReview } from "../src/review.js";
import { fixture, git, settle, repairResult } from "./conflict-handoff-fixture.js";

for (const verdict of ["pass", "fail"] as const) {
  const f = await fixture(); let sha = "", reviews = 0;
  f.cfg.task_merge_strategy = "merge";
  f.setBuilder(async (prompt, options) => {
    const result = await repairResult(f, prompt, options);
    sha = result.testEvidence.resultSha;
    return result;
  });
  f.setReview(async (input) => {
    reviews++; assert.equal(input.repair?.testEvidence.resultSha, sha);
    return runReview(input, async (_source, options) => {
      assert.equal(git(options.cwd, "rev-parse", "HEAD"), sha);
      return { result: { verdict, summary: verdict, findings: verdict === "pass" ? [] : ["Needs human decision"] } };
    });
  });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.equal(f.card.status, f.cfg.columns.review, f.notices.join("\n"));
    assert.equal(f.card.closed, false); assert.equal(reviews, 0, "review.enabled authoritative");
    git(f.repo, "merge-base", "--is-ancestor", f.taskSha, sha); git(f.repo, "merge-base", "--is-ancestor", f.baseSha, sha);
    f.cfg.review.enabled = true;
    await f.loop.tickNow(); assert.equal(reviews, 1);
    assert.equal(f.card.closed, false, "neither builder nor Review closes repair");
    assert.equal(f.card.status, verdict === "pass" ? f.cfg.columns.done : f.cfg.columns.needs_human, "repair review failure never automatically retries Ready");
    if (verdict === "pass") {
      assert.equal(existsSync(f.record.path), true);
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
      f.card.closed = true; // explicit manual validation/approval, the only close
      await f.loop.tickNow(); await f.loop.tickNow();
      assert.equal(existsSync(f.record.path), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(f.store.hasCleanupReceipt(f.card.itemId), false);
      git(f.origin, "merge-base", "--is-ancestor", sha, "refs/heads/main");
    } else { await f.loop.tickNow(); assert.equal(f.card.status, f.cfg.columns.needs_human); }
    assert.equal(f.calls(), 1);
    console.log(`PASS: full real repair/tests/push/WorkflowManager/Review(${verdict}) chain retains manual close and no automatic failure retry`);
  } finally { await f.loop.stop(); }
}

{
  const f = await fixture();
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    const key = (f.runs()[0].args as any).repair.requestKey;
    f.card.closed = true; f.card.status = f.cfg.columns.done;
    await f.loop.tickNow(); await f.loop.tickNow();
    assert.equal(f.calls(), 1); assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.done);
    assert.equal(f.events.filter((e) => e === "request-comment").length, 1);
    await f.loop.stop(); const next = f.make();
    try {
      await next.loop.tickNow(); assert.equal(f.calls(), 1, "consumed request retained across restart");
      f.card.closed = false; f.card.status = f.cfg.columns.ready; // maintainer explicitly retries via existing flow
      await next.loop.tickNow(); await settle(f);
      assert.equal(f.calls(), 2); assert.equal(f.runs().length, 2);
      assert.equal(f.runs().filter((r) => (r.args as any).repair?.requestKey === key).length, 1);
      assert.equal(f.runs().filter((r) => !(r.args as any).repair).length, 1);
      console.log("PASS: consumed request cannot auto rerun at closed Done/restart; explicit maintainer reopen/Ready starts only the ordinary existing retry");
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}
