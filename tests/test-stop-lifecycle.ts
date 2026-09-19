// Real entry point + BoardLoop, with offline board/executor/revision boundaries.
import assert from "node:assert/strict";
import { until } from "./async-loop-fixture.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { TicketExecutor } from "../src/ticket-executor.js";
import { assertOwnerLock } from "../src/owner-lock.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
execFileSync(
  "git",
  ["-C", cwd, "remote", "add", "origin", "https://github.com/owner/repo.git"],
  { stdio: "ignore" },
);
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(
  join(cwd, ".pi", "board-agent.yml"),
  `project:\n  owner: owner\n  number: 1\nbot_identity: bot\nauto_start: true\nsafety:\n  require_clean_worktree: false\n`,
);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise<void>((done) => setImmediate(done));
let read = async () => [];
let metadataWait = Promise.resolve();
let migrationWait = Promise.resolve();
let migrationEntered = () => {};
let drainWait = Promise.resolve();
let drainFailure = false;
let executors = 0;
let drains = 0;
const summary = {
  active: [],
  resumed: 0,
  adopted: 0,
  needsHuman: 0,
  orphans: 0,
  errors: 0,
};
const globals = globalThis as any;
globals.__stopTest = {
  getProjectMetadata: async () => {
    await metadataWait;
    return {
      projectId: "P",
      statusFieldId: "S",
      statusFieldType: "SINGLE_SELECT",
      statusOptions: Object.fromEntries(
        Object.values(_DEFAULTS.columns).map((name) => [name, name]),
      ),
      planFieldId: "PLAN",
      planFieldType: "TEXT",
      typeFieldId: "TYPE",
      typeFieldType: "SINGLE_SELECT",
      typeOptions: { Task: "TASK", Story: "STORY" },
    };
  },
  listCards: () => read(),
  createProductionTicketExecutor: (): TicketExecutor => {
    executors++;
    return {
      migrateLegacy: async (owner, canMigrate) => {
        assertOwnerLock(owner, cwd);
        migrationEntered();
        await migrationWait;
        if (canMigrate && !canMigrate()) throw new Error("Startup migration cancelled");
        assertOwnerLock(owner, cwd);
        return { converted: [], failures: [] };
      },
      reconcile: async () => summary,
      activeCount: () => 0,
      launch: async () => {
        throw new Error("unexpected launch");
      },
      finalizeClosed: async () => {
        throw new Error("unexpected finalization");
      },
      shutdown: async () => {
        drains++;
        await drainWait;
        if (drainFailure) throw new Error("unfinished manager drain");
      },
    };
  },
  captureRuntimeIdentity: () => ({ loadedRevision: "a".repeat(40) }),
  checkRuntimeRevisionAsync: () => ({
    ok: true,
    expectedRevision: "a".repeat(40),
    loadedRevision: "a".repeat(40),
    diskRevision: "a".repeat(40),
    dirty: false,
  }),
};
const entry = new URL("../src/index.ts", import.meta.url).href;
const shim = (path: string, names: string[]) =>
  `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(new URL(path, entry).href)};
${names.map((name) => `export const ${name} = globalThis.__stopTest.${name};`).join("\n")}
`)}`;
const stubs: Record<string, string> = {
  "./gh.js": shim("gh.ts", ["getProjectMetadata", "listCards"]),
  "./ticket-executor.js": shim("ticket-executor.ts", [
    "createProductionTicketExecutor",
  ]),
  "./runtime.js": shim("runtime.ts", [
    "captureRuntimeIdentity",
    "checkRuntimeRevisionAsync",
  ]),
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      (context.parentURL === entry ||
        context.parentURL === new URL("loop.ts", entry).href) &&
      stubs[specifier]
    )
      return { url: stubs[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});
const events = new Map<string, Function>();
let command!: (name: string, ctx: any) => Promise<void>;
const messages: string[] = [];
const ctx = {
  cwd,
  hasUI: false,
  ui: { notify: (message: string) => messages.push(message) },
  sessionManager: { getSessionId: () => "offline-stop" },
};
const invoke = (name: string) => command(name, ctx);
const event = (name: string) => events.get(name)!({}, ctx) as Promise<void>;
const lock = join(cwd, ".pi", "board-agent", "owner.lock");
const runtime = () =>
  JSON.parse(
    readFileSync(join(cwd, ".pi", "board-agent", "runtime.json"), "utf8"),
  ).state;
try {
  (await import(entry)).default({
    on: (name: string, handler: Function) => events.set(name, handler),
    registerCommand: (_name: string, options: any) => {
      command = options.handler;
    },
  });
  await invoke("run");
  await until(() => existsSync(lock) && runtime() === "running");
  assert.equal(executors, 1, messages.join("\n"));
  const gate = deferred();
  drainWait = gate.promise;
  const startMessage = messages.length;
  const stops = [invoke("stop"), invoke("stop"), event("session_shutdown")];
  let settled = 0;
  stops.forEach(
    (stop) =>
      void stop.then(() => {
        settled++;
      }),
  );
  try {
    await turn();
    assert.equal(
      settled,
      0,
      "stop/stop/session_shutdown all wait for the same drain",
    );
    assert.equal(drains, 1);
    assert.ok(existsSync(lock));
    await invoke("run");
    await event("session_start");
    assert.equal(executors, 1, "no restart or auto-recovery during stop");
    assert.notEqual(
      runtime(),
      "stopped",
      "runtime cannot claim cleanup finished",
    );
    assert.ok(
      !messages
        .slice(startMessage)
        .some((message) => /Loop stopped|No loop is running/.test(message)),
    );
  } finally {
    gate.resolve();
    await Promise.all(stops);
  }
  assert.equal(existsSync(lock), false);
  assert.equal(runtime(), "stopped");
  console.log(
    "PASS: entry point stop/stop/session shutdown retain the loop and wait for one cleanup barrier; restart/auto-start stay closed",
  );

  // Stop during the first awaited tick. Startup cleanup must not discard a
  // failed drain, or announce a loop that was cancelled before start returned.
  const readEntered = deferred();
  const readGate = deferred();
  read = async () => {
    readEntered.resolve();
    await readGate.promise;
    return [];
  };
  drainWait = Promise.resolve();
  drainFailure = true;
  const beforeStartup = messages.length;
  const starting = invoke("run");
  await readEntered.promise;
  const stopping = invoke("stop");
  readGate.resolve();
  await Promise.all([starting, stopping]);
  assert.ok(existsSync(lock), "failed startup drain keeps ownership");
  assert.equal(runtime(), "stopping");
  assert.ok(
    !messages
      .slice(beforeStartup)
      .some((message) => message.includes("started. Ticking")),
    "cancelled startup must not report success",
  );
  await invoke("run");
  await event("session_start");
  assert.equal(
    executors,
    2,
    "failed cleanup remains cached, not restarted/promoted",
  );
  const beforeRetry = drains;
  drainFailure = false;
  await invoke("stop");
  assert.equal(drains, beforeRetry + 1, "later stop retries retained cleanup");
  assert.equal(existsSync(lock), false);
  assert.equal(runtime(), "stopped");
  console.log(
    "PASS: a stop racing the startup tick retains failed cleanup for retry and never reports startup success",
  );

  // A metadata lookup owns no resources yet, but its continuation must not
  // acquire a lock after stop/session shutdown invalidates its generation.
  const metadataGate = deferred();
  metadataWait = metadataGate.promise;
  const pendingStart = invoke("run");
  await turn();
  const preflightStop = event("session_shutdown");
  let preflightStopped = false;
  void preflightStop.then(() => { preflightStopped = true; });
  await turn(); assert.equal(preflightStopped, false);
  assert.equal(runtime(), "stopping");
  metadataGate.resolve();
  await Promise.all([pendingStart, preflightStop]);
  metadataWait = Promise.resolve();
  assert.equal(executors, 2);
  assert.equal(existsSync(lock), false);
  console.log(
    "PASS: stop during startup metadata preflight prevents a later lock/loop launch",
  );

  // A rejected tick is a warning, NOT an incomplete drain: restart is safe once
  // the stop barrier has actually finished its finally cleanup.
  const failedRead = deferred();
  const failEntered = deferred();
  read = async () => {
    failEntered.resolve();
    await failedRead.promise;
    throw new Error("tick read failed");
  };
  const failureMessages = messages.length;
  const failingStart = invoke("run");
  await failEntered.promise;
  const failedStop = event("session_shutdown");
  failedRead.resolve();
  await Promise.all([failingStart, failedStop]);
  assert.equal(existsSync(lock), false);
  assert.equal(runtime(), "stopped");
  assert.ok(
    messages
      .slice(failureMessages)
      .some((message) => /(?:Shutdown completed|Startup cleanup completed) with tick warning/.test(message)),
    "session shutdown distinguishes a tick failure from incomplete cleanup",
  );
  assert.ok(
    !messages
      .slice(failureMessages)
      .some((message) => /cleanup failed|recovery failed/.test(message)),
    "completed startup/shutdown cleanup must not be reported as a drain failure",
  );
  read = async () => [];
  await invoke("run");
  await until(() => existsSync(lock) && runtime() === "running");
  assert.equal(
    executors,
    4,
    "tick failure with completed cleanup must not latch stopping",
  );
  await invoke("stop");
  console.log(
    "PASS: a tick failure that fully drains clears the module reference and permits a clean restart",
  );

  const migrating = deferred(), migrationGate = deferred();
  migrationEntered = migrating.resolve;
  migrationWait = migrationGate.promise;
  let ticks = 0;
  read = async () => { ticks++; return []; };
  const migrationStart = invoke("run");
  await migrating.promise;
  assert.ok(existsSync(lock), "conversion runs under exclusive ownership");
  await invoke("run"); // Duplicate run registers no second owner/executor.
  const count = executors;
  const migrationStop = invoke("stop");
  let migrationStopped = false;
  void migrationStop.then(() => { migrationStopped = true; });
  await turn(); assert.equal(migrationStopped, false);
  assert.ok(existsSync(lock)); assert.equal(runtime(), "stopping");
  migrationGate.resolve();
  await Promise.all([migrationStart, migrationStop]);
  assert.equal(executors, count);
  assert.equal(ticks, 0, "no executor reconciliation/model can race conversion");
  assert.equal(existsSync(lock), false);
  console.log("PASS: startup migration holds the owner before any tick and a stop during conversion prevents late loop/model startup");
} finally {
  drainFailure = false;
  drainWait = Promise.resolve();
  await event("session_shutdown");
  hooks.deregister();
  delete globals.__stopTest;
}
