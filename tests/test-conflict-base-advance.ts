import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fixture, advanceBase, git, settle, repairResult } from "./conflict-handoff-fixture.js";

const f = await fixture();
f.setBuilder((prompt, options) => repairResult(f, prompt, options));
try {
  await f.loop.tickNow(); assert.equal(f.card.closed, false);
  const retry = f.store.read(f.task.itemId)!.retry;
  assert.equal(retry?.stage, "build");
  await f.loop.stop();
  const advanced = advanceBase(f), next = f.make();
  try {
    await next.loop.tickNow(); await settle(f); await next.loop.tickNow();
    assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
    assert.equal(f.store.read(f.task.itemId)?.path, f.record.path);
    assert.equal(f.card.status, f.cfg.columns.review); assert.equal(f.card.closed, false);
    assert.ok(existsSync(f.record.path));
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), advanced);
    const result = git(f.record.path, "rev-parse", "HEAD");
    git(f.repo, "merge-base", "--is-ancestor", f.baseSha, result);
    git(f.repo, "merge-base", "--is-ancestor", f.taskSha, result);
    assert.match(f.runs()[0].script, new RegExp(f.baseSha));
    assert.equal((f.runs()[0].args as any).repair, undefined);
    console.log("PASS: conflict retry survives stopped restart/base fast-forward with original diagnostics/branch/worktree and one run, then waits in open Review");
  } finally { await next.loop.stop(); }
} finally { await f.loop.stop(); }

for (const mode of ["claim", "type", "closed", "lane", "revision"] as const) {
  const f = await fixture();
  try {
    await f.loop.tickNow(); await f.loop.stop();
    if (mode === "claim") f.card.assignees = ["maintainer"];
    if (mode === "type") f.card.type = "Story";
    if (mode === "closed") { f.card.closed = true; f.card.status = f.cfg.columns.needs_human; }
    if (mode === "lane") f.card.status = f.cfg.columns.needs_human;
    if (mode === "revision") f.setRevision(false);
    const next = f.make(), before = f.events.length;
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.calls(), 0); assert.equal(f.events.length, before);
      assert.ok(existsSync(f.record.path));
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
      console.log(`PASS: resumed conflict ${mode} withdrawal prevents new builder/remote mutation without discarding work`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}
