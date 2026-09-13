import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { UsageLimitScheduler, WorkflowError, WorkflowErrorCode, type WorkflowManager, type WorkflowManagerOptions } from "@quintinshaw/pi-dynamic-workflows";

const timers = new Set<() => void>();
let managed!: WorkflowManager;
const globals = globalThis as any;
globals.__shutdownScheduler = class extends UsageLimitScheduler {
  constructor(manager: WorkflowManager, options: object) {
    super(manager, {
      ...options,
      setTimer: (callback) => { timers.add(callback); return callback; },
      clearTimer: (handle) => { timers.delete(handle as () => void); },
    });
    managed = manager;
  }
};
const shim = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(import.meta.resolve("@quintinshaw/pi-dynamic-workflows"))};
export const UsageLimitScheduler = globalThis.__shutdownScheduler;
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@quintinshaw/pi-dynamic-workflows" && context.parentURL === new URL("../src/ticket-executor.ts", import.meta.url).href)
      return { url: shim, shortCircuit: true };
    return next(specifier, context);
  },
});
const { createWorkflowManagerAdapter } = await import("../src/ticket-executor.js");

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const source = `export const meta = { name: 'offline-drain', description: 'cooperative cleanup' };
return await agent('wait for cancellation', { model: 'offline-model', label: 'drain' });`;
try {
for (const action of ["pauseAndWait", "stopAndWait"] as const) {
  const path = join(cwd, action);
  mkdirSync(path);
  const entered = deferred();
  const cleanup = deferred();
  const finish = deferred();
  let cleanups = 0;
  const manager = createWorkflowManagerAdapter({
    cwd: path, defaultAgentRetries: 0, callback: () => {},
    agent: {
      async run(_prompt, options) {
        assert.ok(options?.signal);
        entered.resolve();
        try {
          await new Promise<never>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
          });
        } finally {
          cleanups++;
          cleanup.resolve();
          await finish.promise;
        }
      },
    } as NonNullable<WorkflowManagerOptions["agent"]>,
  });
  const runId = manager.start(source, { itemId: "PVTI_1", issueNumber: 1, taskKey: "T001" }, { maxAgents: 1, concurrency: 1, agentRetries: 0 });
  await entered.promise;
  let settled = false;
  const drain = manager[action](runId).then(() => { settled = true; });
  try {
    await cleanup.promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(settled, false, `${action} must await actual cleanup, not an early released upstream lease`);
  } finally {
    finish.resolve();
    await drain;
    manager.dispose();
  }
  assert.equal(cleanups, 1);
  assert.equal(manager.list().find((run) => run.runId === runId)?.status, action === "pauseAndWait" ? "paused" : "aborted");
  console.log(`PASS: actual installed WorkflowManager ${action} waits for cooperative agent finally exactly once`);
}

// A resume already inside upstream's settlement await can outlive scheduler
// disposal. It must be paused before executeRun can start another model.
{
  const path = join(cwd, "resume-race");
  mkdirSync(path);
  const entered = deferred();
  const cleanup = deferred();
  const finish = deferred();
  let calls = 0;
  const adapter = createWorkflowManagerAdapter({
    cwd: path, defaultAgentRetries: 0, callback: () => {},
    agent: {
      async run(_prompt, options) {
        if (++calls > 1) return "must not launch after stop";
        entered.resolve();
        try {
          await new Promise<never>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")), { once: true });
          });
        } finally {
          cleanup.resolve();
          await finish.promise;
        }
      },
    } as NonNullable<WorkflowManagerOptions["agent"]>,
  });
  const id = adapter.start(source, { itemId: "PVTI_3", issueNumber: 3, taskKey: "T003" }, { maxAgents: 1, concurrency: 1, agentRetries: 0 });
  await entered.promise;
  const drain = adapter.pauseAndWait(id);
  await cleanup.promise;
  const resuming = managed.resume(id); // same boundary used by UsageLimitScheduler
  adapter.stopScheduling!();
  finish.resolve();
  try {
    await resuming;
    await drain;
    await adapter.pauseAndWait(id);
    assert.equal(calls, 1, "in-flight resume cannot launch a model after stopScheduling");
    console.log("PASS: an upstream resume already awaiting settlement cannot launch another model while stopping");
  } finally {
    adapter.dispose();
  }
}

// The real scheduler is run with a manual clock, never a provider or live timer.
const path = join(cwd, "scheduler");
mkdirSync(path);
let calls = 0;
const paused = deferred();
const adapter = createWorkflowManagerAdapter({
  cwd: path, defaultAgentRetries: 0, callback: () => {},
  agent: {
    async run() {
      calls++;
      throw new WorkflowError("offline quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
    },
  } as NonNullable<WorkflowManagerOptions["agent"]>,
});
managed.on("paused", () => paused.resolve());
const id = adapter.start(source, { itemId: "PVTI_2", issueNumber: 2, taskKey: "T002" }, { maxAgents: 1, concurrency: 1, agentRetries: 0 });
await paused.promise;
await new Promise<void>((done) => setImmediate(done));
assert.equal(timers.size, 1, "actual scheduler arms a usage-limit retry");
try {
  const staleTimer = [...timers][0];
  adapter.stopScheduling!();
  assert.equal(timers.size, 0, "stopping clears auto-resume before draining");
  staleTimer(); // A callback already delivered by the event loop is harmless too.
  assert.equal(await adapter.resume(id), false, "explicit recovery stays closed");
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(calls, 1);
  await adapter.pauseAndWait(id);
  console.log("PASS: stopping disables the real usage-limit scheduler and explicit recovery, including an already-delivered timer");
} finally {
  adapter.dispose();
}
} finally {
  hooks.deregister();
  delete globals.__shutdownScheduler;
}
