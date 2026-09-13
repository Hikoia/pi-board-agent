import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, renameSync } from "node:fs";
import { createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
let fault: (from: string, to: string, edge: string) => void = () => {};
const globals = globalThis as any;
globals.__handoffRename = (from: string, to: string) => { fault(from, to, "before"); renameSync(from, to); fault(from, to, "after"); };
const urls = [new URL("../src/ticket-worktree.ts", import.meta.url).href, new URL("../src/conflict-recovery.ts", import.meta.url).href];
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (urls.includes(context.parentURL!) && specifier === "node:fs") return { url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs'; export const renameSync = (...args) => globalThis.__handoffRename(...args);`)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { fixture, settle } = await import("./conflict-handoff-fixture.js");
try {
  for (const target of ["begin-launch", "manager-start", "active-record", "bound-ledger"]) for (const edge of ["before", "after"] as const) {
    const f = await fixture(); let cut = false;
    const trigger = () => { cut = true; throw new Error(`offline ${edge}:${target} cut`); };
    if (target === "manager-start") f.setManagerHook((event) => { if (!cut && event === `${edge}:start`) trigger(); });
    else fault = (from, to, when) => {
      if (cut || when !== edge) return;
      const bytes = readFileSync(when === "before" ? from : to, "utf8");
      const value = JSON.parse(bytes);
      if (target === "begin-launch" && value.launchingAt !== undefined || target === "active-record" && value.activeRunId || target === "bound-ledger" && value.step === "consumed" && value.runId) trigger();
    };
    try {
      await f.loop.tickNow(); await f.loop.tickNow().catch(() => {});
      assert.ok(cut, target);
      const originalRun = f.runs()[0]?.runId;
      await f.loop.stop(); fault = () => {}; f.setManagerHook(() => {});
      const next = f.make();
      try {
        await next.loop.tickNow();
        if (f.runs().length) await settle(f);
        await next.loop.tickNow();
        if (target === "begin-launch" || target === "manager-start" && edge === "before") {
          assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
          assert.equal(f.card.status, f.cfg.columns.needs_human, f.notices.join("\n"));
          // A consumed-but-unstarted attempt may be retried ONLY explicitly via
          // ordinary maintainer Ready, never silently as the same repair request.
        } else {
          assert.equal(f.runs().length, 1); assert.equal(f.runs()[0].runId, originalRun);
          assert.equal(f.calls(), 1, "no second workflow/agent invocation for the persisted cut");
          assert.ok((f.runs()[0].args as any).repair.requestKey.startsWith("conflict-"));
        }
        assert.equal(f.events.filter((e) => e === "request-comment").length, 1);
        console.log(`PASS: ${edge} ${target} restart preserves a unique bound persistent run, or quarantines proven unstarted consumption`);
      } finally { await next.loop.stop(); }
    } finally { fault = () => {}; await f.loop.stop(); }
  }

  const f = await fixture();
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await f.loop.stop();
    const persistence = createRunPersistence(f.record.path), run = f.runs()[0];
    (run.args as any).repair.requestKey = `conflict-${"0".repeat(64)}`;
    persistence.save(run);
    const next = f.make();
    try {
      await next.loop.tickNow();
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.equal(f.card.status, f.cfg.columns.needs_human);
      console.log("PASS: a persistent run with a different requestKey cannot be adopted/resumed as the queued repair");
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
} finally { hooks.deregister(); delete globals.__handoffRename; }
