import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runReview } from "../src/review.js";
import { fixture, git, settle, repairResult } from "./conflict-handoff-fixture.js";

for (const verdict of ["pass", "fail"] as const) {
  const f = await fixture(); let sha = "", reviews = 0;
  f.setBuilder(async (prompt, options) => {
    const result = await repairResult(f, prompt, options);
    sha = git(f.record.path, "rev-parse", "HEAD"); return result;
  });
  f.setReview(async (input) => {
    reviews++; assert.equal("repair" in input, false);
    return runReview(input, async (_source, options) => {
      assert.equal(git(options.cwd, "rev-parse", "HEAD"), sha);
      return { result: { verdict, summary: verdict, findings: verdict === "pass" ? [] : ["Fix the missing requirement"] } };
    });
  });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.equal(f.card.status, f.cfg.columns.review);
    assert.equal(f.card.closed, false); assert.equal(reviews, 0, "settlement and review use separate ticks");
    git(f.repo, "merge-base", "--is-ancestor", f.taskSha, sha);
    git(f.repo, "merge-base", "--is-ancestor", f.baseSha, sha);
    await f.loop.tickNow(); assert.equal(reviews, 1);
    assert.equal(f.calls(), 1, "review failure cannot retry build in the same tick");
    assert.equal(f.card.closed, false);
    assert.equal(f.card.status, verdict === "pass" ? f.cfg.columns.done : f.cfg.columns.ready);
    assert.equal(existsSync(f.record.path), true);
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
    if (verdict === "pass") {
      await f.loop.tickNow(); assert.equal(existsSync(f.record.path), true, "Done stays open and unmerged");
      f.card.closed = true; // the human's renewed approval, never the builder's
      await f.loop.tickNow(); await f.loop.tickNow();
      assert.equal(existsSync(f.record.path), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      git(f.origin, "merge-base", "--is-ancestor", sha, "refs/heads/main");
    } else assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "build");
    assert.equal(f.calls(), 1);
    console.log(`PASS: real conflict resolution/tests/push/WorkflowManager/Review(${verdict}) preserves manual close; findings retry build on the original branch`);
  } finally { await f.loop.stop(); }
}
