import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { UsageLimitScheduler, WorkflowError, WorkflowErrorCode, type WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";
const timers = new Set<() => void>(), globals = globalThis as any;
globals.__coldScheduler = class extends UsageLimitScheduler {
  constructor(manager: WorkflowManager, options: object) { super(manager, { ...options, setTimer: (cb) => { timers.add(cb); return cb; }, clearTimer: (cb) => { timers.delete(cb as () => void); } }); }
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@quintinshaw/pi-dynamic-workflows" && context.parentURL === new URL("../src/ticket-executor.ts", import.meta.url).href) return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("@quintinshaw/pi-dynamic-workflows"))}; export const UsageLimitScheduler = globalThis.__coldScheduler;`)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { fixture, settle } = await import("./conflict-handoff-fixture.js");
try {
  const f = await fixture();
  f.setBuilder(async () => { throw new WorkflowError("offline quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }); });
  try {
    await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await new Promise((r) => setImmediate(r));
    assert.equal(f.runs()[0].status, "paused"); assert.equal(timers.size, 1);
    await f.loop.stop(); assert.equal(timers.size, 0);
    f.setHook((event) => { if (event === "read:card") throw new Error("fresh identity unavailable"); });
    const next = f.make();
    try {
      await next.loop.tickNow(); await new Promise((r) => setImmediate(r));
      assert.equal(next.executor.activeCount(), 1, "uncertain paused repair keeps its slot");
      assert.equal(timers.size, 0, "capacity observation cannot arm automatic repair recovery before fresh authorization");
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      console.log("PASS: cold usage-limit repair recovery with invalid ticket identity retains capacity but cannot arm the scheduler from an observation");
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
} finally { hooks.deregister(); delete globals.__coldScheduler; }
