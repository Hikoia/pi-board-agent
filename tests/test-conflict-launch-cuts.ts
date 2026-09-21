import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, renameSync } from "node:fs";
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
let fault: (from: string, to: string, edge: string) => void = () => {};
const globals = globalThis as any;
globals.__handoffRename = (from: string, to: string) => { fault(from, to, "before"); renameSync(from, to); fault(from, to, "after"); };
const urls = [new URL("../src/ticket-worktree.ts", import.meta.url).href];
const runner = new URL("../src/process-runner.ts", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (urls.includes(context.parentURL!) && specifier === "./process-runner.js") return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(runner)};
    export const runProcess = (...args) => globalThis.__handoffGit('async', ...args);
    export const runProcessSync = (...args) => globalThis.__handoffGit('sync', ...args);`)}`, shortCircuit: true };
  if (urls.includes(context.parentURL!) && specifier === "node:fs") return { url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs'; export const renameSync = (...args) => globalThis.__handoffRename(...args);`)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { fixture, settle } = await import("./conflict-handoff-fixture.js");
// Load transport after our observed store; keep rename cuts live on Windows.
const { fixtureProcess, dispose: disposeTransport } = await import("./cleanup-fixture.js");
globals.__handoffGit = fixtureProcess;
try {
  for (const target of ["begin-launch", "manager-start", "active-record"]) for (const edge of ["before", "after"] as const) {
    const f = await fixture(); let cut = false;
    const trigger = () => { cut = true; throw new Error(`offline ${edge}:${target} cut`); };
    if (target === "manager-start") f.setManagerHook((event) => { if (!cut && event === `${edge}:start`) trigger(); });
    else fault = (from, to, when) => {
      if (cut || when !== edge) return;
      const bytes = readFileSync(when === "before" ? from : to, "utf8");
      const value = JSON.parse(bytes);
      if (target === "begin-launch" && value.launchingAt !== undefined || target === "active-record" && value.activeRunId) trigger();
    };
    try {
      await f.loop.tickNow(); await f.loop.tickNow().catch(() => {});
      assert.ok(cut, target);
      const originalRun = f.runs()[0]?.runId;
      const interrupted = f.store.read(f.card.itemId)!;
      await f.loop.stop(); fault = () => {}; f.setManagerHook(() => {});
      const next = f.make();
      try {
        await next.loop.tickNow();
        if (f.runs().length) await settle(f);
        if (target === "begin-launch" && edge === "after" || target === "manager-start" && edge === "before") {
          assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
          assert.equal(f.card.status, target === "begin-launch" ? f.cfg.columns.ready : f.cfg.columns.building, f.notices.join("\n"));
          assert.notEqual(interrupted.launchingAt, undefined);
          assert.deepEqual(f.store.read(f.card.itemId), interrupted);
          assert.equal(next.executor.activeCount(), 1, "unknown launch retains capacity, not a product-decision lane");
          await next.loop.tickNow();
          assert.equal(f.calls(), 0); assert.deepEqual(f.store.read(f.card.itemId), interrupted, "zero journal matches remain uncertain on re-observation");
        } else {
          assert.equal(f.runs().length, 1); if (originalRun) assert.equal(f.runs()[0].runId, originalRun);
          assert.equal(f.calls(), 1, "no second workflow/agent invocation for the persisted cut");
          assert.equal((f.runs()[0].args as any).repair, undefined);
        }
        assert.equal(f.comments.filter((c) => c.body.includes("Merge conflict")).length, 1);
        console.log(`PASS: ${edge} ${target} restart preserves a unique original run or retains/reobserves an uncertain occupied launch without a replacement builder`);
      } finally { await next.loop.stop(); }
    } finally { fault = () => {}; await f.loop.stop(); }
  }

  const f = await fixture();
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.stop();
    const persistence = createRunPersistence(f.record.path), run = f.runs()[0];
    (run.args as any).itemId = "OTHER";
    persistence.save(run);
    const next = f.make();
    try {
      await next.loop.tickNow();
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal(f.card.status, f.cfg.columns.building);
      assert.equal(f.store.read(f.task.itemId)?.activeRunId, run.runId);
      console.log("PASS: a persistent run with a different ticket identity cannot be adopted/resumed or released");
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
} finally { hooks.deregister(); disposeTransport(); delete globals.__handoffRename; delete globals.__handoffGit; }
