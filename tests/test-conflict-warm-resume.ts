// A02 F1: installed scheduler/manager; only the timer and offline I/O are controlled.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { UsageLimitScheduler, WorkflowManager, WorkflowError, WorkflowErrorCode } from "@quintinshaw/pi-dynamic-workflows";
const timers = new Set<() => void>(), attempts = new Set<Promise<boolean>>(), globals = globalThis as any;
let raw!: WorkflowManager, scheduled!: { resume(id: string): Promise<boolean> };
globals.__repairResumeManager = class extends WorkflowManager {
  constructor(options: ConstructorParameters<typeof WorkflowManager>[0]) { super(options); raw = this; }
};
globals.__repairResumeScheduler = class extends UsageLimitScheduler {
  constructor(manager: ConstructorParameters<typeof UsageLimitScheduler>[0], options: object) {
    const resume = manager.resume.bind(manager);
    manager.resume = (id) => { const pending = resume(id); attempts.add(pending); return pending; };
    super(manager, { ...options, setTimer: (cb) => { timers.add(cb); return cb; }, clearTimer: (cb) => { timers.delete(cb as () => void); } });
    scheduled = manager;
  }
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@quintinshaw/pi-dynamic-workflows" && context.parentURL === new URL("../src/ticket-executor.ts", import.meta.url).href)
    return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(import.meta.resolve("@quintinshaw/pi-dynamic-workflows"))}; export const UsageLimitScheduler = globalThis.__repairResumeScheduler; export const WorkflowManager = globalThis.__repairResumeManager;`)}`, shortCircuit: true };
  return next(specifier, context);
} });
const { fixture, settle } = await import("./conflict-handoff-fixture.js");
const flush = () => new Promise<void>((done) => setImmediate(done));
async function fire() {
  assert.equal(timers.size, 1, "existing scheduler retains its retry timer");
  for (const cb of [...timers]) { timers.delete(cb); cb(); }
  await Promise.all(attempts); attempts.clear(); await flush();
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
try {
  {
    const f = await fixture();
    f.setBuilder(async () => { throw new WorkflowError("offline quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false }); });
    try {
      await f.loop.tickNow(); await f.loop.tickNow(); await settle(f); await flush();
      const original = f.runs()[0]; assert.equal(f.calls(), 1); assert.equal(original.status, "paused");
      for (const mode of ["identity", "unknown", "revision", "late-revision"] as const) {
        const calls = f.calls(), writes = f.events.length;
        if (mode === "identity") { f.setHook((event) => { if (event === "read:card") throw new Error("fresh identity unavailable"); }); await f.loop.tickNow(); }
        if (mode === "unknown") f.setHook((event) => { if (event === "read:card") throw new Error("offline comments unavailable"); });
        if (mode === "revision") f.setRevision(false);
        if (mode === "late-revision") f.setHook((event) => { if (event === "read:card") f.setRevision(false); });
        await fire(); await settle(f);
        assert.equal(f.calls(), calls, `${mode}: an already-armed timer must freshly authorize the bound repair`);
        assert.equal(f.executor.activeCount(), 1, "denied repair retains its occupied slot");
        assert.equal(f.store.read(f.card.itemId)?.activeRunId, original.runId);
        assert.equal(f.runs()[0].status, "paused"); assert.equal(f.runs().length, 1);
        assert.equal(f.events.length, writes, "denial cannot mutate the board");
        f.setHook(() => {}); f.setHook(() => {}); f.setRevision(true); f.loop.enableAdmissions();
        await fire(); await settle(f); await flush();
        assert.equal(f.calls(), calls + 1, "confirmed recovery resumes the same run normally");
        assert.equal(f.runs()[0].runId, original.runId); assert.deepEqual(f.runs()[0].args, original.args);
        console.log(`PASS: warm ${mode} denial blocks the existing timer; confirmed recovery resumes the same occupied repair run`);
      }
      const stale = [...timers][0], calls = f.calls(), reading = deferred(), finishRead = deferred();
      f.setHook(async (event) => { if (event === "read:card") { reading.resolve(); await finishRead.promise; } });
      const firing = fire(); await reading.promise;
      try { await f.loop.stop(); assert.equal(timers.size, 0); }
      finally { finishRead.resolve(); await firing; }
      stale(); await flush(); assert.equal(f.calls(), calls);
      console.log("PASS: shutdown blocks a resume awaiting fresh authority and disposes the delivered stale timer");
    } catch (error) { console.error(error); console.log("FAIL: warm repair auto-resume authority"); process.exitCode = 1; }
    finally { await f.loop.stop(); }
  }
  {
    const f = await fixture(), entered = deferred(), cleanup = deferred(), finish = deferred();
    f.setBuilder(async (_prompt, options) => {
      if (f.calls() > 1) throw new WorkflowError("offline quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
      entered.resolve();
      try { await new Promise<never>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")), { once: true })); }
      finally { cleanup.resolve(); await finish.promise; }
    });
    try {
      await f.loop.tickNow(); await f.loop.tickNow(); await entered.promise;
      const id = f.runs()[0].runId;
      assert.equal(raw.pause(id), true); await cleanup.promise;
      const pending = scheduled.resume(id); // actual upstream async settlement boundary
      await flush(); f.setHook((event) => { if (event === "read:card") throw new Error("fresh identity unavailable"); });
      await f.loop.tickNow(); finish.resolve(); await pending; await settle(f); await flush();
      assert.equal(f.calls(), 1, "resume already awaiting cooperative settlement must reauthorize after the wait");
      assert.equal(f.executor.activeCount(), 1); assert.equal(f.store.read(f.card.itemId)?.activeRunId, id);
      f.setHook(() => {});
      await f.loop.tickNow(); await settle(f);
      assert.equal(f.calls(), 2); assert.equal(f.runs()[0].runId, id); assert.equal(f.runs().length, 1);
      console.log("PASS: in-flight repair resume cannot outlive authority rejection; same run resumes after confirmation");
    } catch (error) { console.error(error); console.log("FAIL: in-flight repair resume authority"); process.exitCode = 1; }
    finally { finish.resolve(); await f.loop.stop(); }
  }
} finally { hooks.deregister(); delete globals.__repairResumeScheduler; delete globals.__repairResumeManager; }
