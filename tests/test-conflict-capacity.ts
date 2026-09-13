import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
import { buildTasksForWave } from "../src/workflow-prompt.js";
import { fixture, git, settle } from "./conflict-handoff-fixture.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

{
  const f = await fixture(); const entered = deferred(), release = deferred(); let active = 0, peak = 0;
  const other = { ...f.card, itemId: "OTHER", number: 900, title: "T900 other worker", body: "OTHER_CAPACITY_TICKET", closed: false, status: f.cfg.columns.ready, assignees: [] };
  f.cards.push(other);
  const task = buildTasksForWave(f.cfg, "demo", [other])[0];
  f.setBuilder(async (prompt) => {
    active++; peak = Math.max(peak, active);
    try {
      if (prompt.includes("OTHER_CAPACITY_TICKET")) { entered.resolve(); await release.promise; return { itemId: other.itemId, taskKey: task.taskKey, branch: task.taskBranch, status: "failure", error: "offline other task" }; }
      assert.equal(active, 1);
      return { itemId: f.card.itemId, taskKey: f.task.taskKey, branch: f.task.taskBranch, status: "failure", error: "offline repair" };
    } finally { active--; }
  });
  try {
    const launched = await f.executor.launch(other, "demo"); assert.equal(launched.status, "launched"); await entered.promise;
    await f.loop.tickNow(); await f.loop.tickNow();
    assert.equal(f.executor.activeCount(), 1); assert.equal(f.calls(), 1);
    assert.equal(f.card.status, f.cfg.columns.ready); assert.equal(f.card.closed, false);
    assert.equal(f.events.filter((e) => e === "consume-comment").length, 0, "queued repair does not claim/start outside the existing worker budget");
    release.resolve();
    const path = f.store.read(other.itemId)!.path;
    for (let i = 0; i < 300; i++) { if (createRunPersistence(path).list()[0]?.status === "completed") break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(createRunPersistence(path).list()[0]?.status, "completed");
    await f.loop.tickNow(); await settle(f); await f.loop.tickNow();
    assert.equal(f.calls(), 2); assert.equal(f.runs().length, 1); assert.equal(peak, 1);
    assert.ok((f.runs()[0].args as any).repair.requestKey.startsWith("conflict-"));
    console.log("PASS: max_workers=1 keeps repair queued behind a real occupied worker and launches through the original Ready scheduler only after release");
  } finally { release.resolve(); await f.loop.stop(); }
}

{
  const f = await fixture(); const entered = deferred(), cleaning = deferred(), drain = deferred(); let attempts = 0;
  f.setBuilder(async (_prompt, options) => {
    if (++attempts === 1) {
      git(f.record.path, "commit", "--allow-empty", "-m", "partial repair checkpoint");
      assert.throws(() => git(f.record.path, "merge", "--no-edit", f.baseSha));
      writeFileSync(join(f.record.path, "partial.txt"), "keep interrupted repair work\n");
      entered.resolve();
      try { await new Promise<never>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")), { once: true })); }
      finally { cleaning.resolve(); await drain.promise; }
    }
    assert.equal(git(f.record.path, "rev-parse", "MERGE_HEAD"), f.baseSha);
    assert.notEqual(git(f.record.path, "rev-parse", "HEAD"), f.taskSha);
    assert.equal(readFileSync(join(f.record.path, "partial.txt"), "utf8"), "keep interrupted repair work\n");
    return { itemId: f.card.itemId, taskKey: f.task.taskKey, branch: f.task.taskBranch, status: "failure", error: "preserved partial work for human decision" };
  });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await entered.promise;
    const original = f.runs()[0]; assert.equal(f.executor.activeCount(), 1);
    let stopped = false;
    const stopping = f.loop.stop().then(() => { stopped = true; });
    await cleaning.promise; await new Promise((r) => setImmediate(r));
    assert.equal(stopped, false); assert.equal(f.executor.activeCount(), 1);
    drain.resolve(); await stopping;
    assert.equal(f.runs()[0].status, "paused");
    const next = f.make();
    try {
      await next.loop.tickNow(); await settle(f); await next.loop.tickNow();
      assert.equal(f.runs().length, 1); assert.equal(f.runs()[0].runId, original.runId);
      assert.deepEqual(f.runs()[0].args, original.args); assert.equal(f.runs()[0].script, original.script);
      assert.equal(f.card.status, f.cfg.columns.needs_human); assert.equal(f.calls(), 2);
      assert.equal(readFileSync(join(f.record.path, "partial.txt"), "utf8"), "keep interrupted repair work\n");
      assert.equal(f.events.filter((e) => e === "request-comment").length, 1);
      console.log("PASS: full handoff pause/drain/restart resumes the same persistent request/run/script/worktree despite advanced HEAD and dirty merge");
    } finally { await next.loop.stop(); }
  } finally { drain.resolve(); await f.loop.stop(); }
}
