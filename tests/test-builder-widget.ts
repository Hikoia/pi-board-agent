// Actual entry-point widget + executor + WorkflowManager. Hold board I/O while
// a real (offline) builder runs, pauses and resumes; no tick may finish first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import {
  ManagedTicketExecutor,
  createWorkflowManagerAdapter,
} from "../src/ticket-executor.js";
import {
  TicketWorktrees,
  type TicketExecutionRecord,
} from "../src/ticket-worktree.js";

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
  "project:\n  owner: owner\n  number: 1\nbot_identity: bot\nmax_workers: 2\nsafety:\n  require_clean_worktree: false\ncontext:\n  enabled: false\nwatchdog:\n  enabled: false\n",
);
const worktrees = new TicketWorktrees(cwd);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const boardEntered = deferred(),
  boardRelease = deferred();
let agentEntered = deferred();
let agentRunning = false;
const manager = createWorkflowManagerAdapter({
  cwd,
  defaultAgentRetries: 0,
  deferScheduling: true,
  callback: () => {},
  agent: {
    async run(_prompt: unknown, options: any) {
      agentRunning = true;
      agentEntered.resolve();
      try {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("paused", "AbortError")),
            { once: true },
          );
        });
      } finally {
        agentRunning = false;
      }
      return {};
    },
  } as any,
});
const runId = manager.start(
  "export const meta = { name: 'widget-builder', description: 'Offline activity' }; return await agent('hold', { model: 'offline' });",
  { itemId: "ITEM_1", issueNumber: 1, taskKey: "T001" },
  { maxAgents: 1, concurrency: 1, agentRetries: 0 },
);
const record: TicketExecutionRecord = {
  schemaVersion: 3,
  itemId: "ITEM_1",
  issueNumber: 1,
  taskKey: "T001",
  plan: "demo",
  taskBranch: "task/issue-1",
  baseBranch: "main",
  path: cwd,
  createdAt: 1,
  activeRunId: runId,
  activeRunStartedAt: 1,
};
writeFileSync(
  join(cwd, ".pi", "board-agent", "ticket-worktrees", "item_1.json"),
  JSON.stringify(record),
);
let executor!: ManagedTicketExecutor;
let boardReads = 0;
const globals = globalThis as any;
globals.__builderWidget = {
  getProjectMetadata: async () => ({
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
  }),
  listCards: async () => {
    boardReads++;
    boardEntered.resolve();
    await boardRelease.promise;
    return [];
  },
  createProductionTicketExecutor: (options: any) =>
    (executor = new ManagedTicketExecutor({
      ...options,
      worktrees,
      createManager: () => manager,
      board: {
        getCard: async () => {
          throw new Error("board read must stay held");
        },
      },
    })),
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
  `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL(path, entry).href)};\n${names.map((name) => `export const ${name} = globalThis.__builderWidget.${name};`).join("\n")}`)}`;
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
    return [entry, new URL("loop.ts", entry).href].includes(
      context.parentURL ?? "",
    ) && stubs[specifier]
      ? { url: stubs[specifier], shortCircuit: true }
      : next(specifier, context);
  },
});
const originalInterval = globalThis.setInterval;
let heartbeat!: () => void;
globalThis.setInterval = ((
  callback: () => void,
  ms: number,
  ...args: any[]
) => {
  if (ms === 90_000) heartbeat = callback;
  return originalInterval(callback, ms, ...args);
}) as typeof setInterval;
let command!: (name: string, ctx: any) => Promise<void>;
let widget: string[] | undefined;
const messages: string[] = [];
const ctx = {
  cwd,
  hasUI: true,
  sessionManager: { getSessionId: () => "offline-builder-widget" },
  ui: {
    notify: (message: string) => messages.push(message),
    setWidget: (_id: string, lines: string[] | undefined) => {
      widget = lines;
    },
  },
};
let starting: Promise<void> | undefined;
const pulse = async () => {
  heartbeat();
  await new Promise<void>((done) => setImmediate(done));
};
try {
  await agentEntered.promise;
  (await import(entry)).default({
    on: () => {},
    registerCommand: (_name: string, options: any) => {
      command = options.handler;
    },
  });
  starting = command("run", ctx);
  await Promise.race([
    boardEntered.promise,
    starting.then(() => {
      throw new Error(messages.join("\n"));
    }),
  ]);
  assert.equal(agentRunning, true);
  assert.equal(
    widget?.[0],
    "Board Agent ● 1/2 slots occupied · 1 models running",
    "a live builder must not look idle while the first board read is pending",
  );
  assert.ok(widget?.includes("  T001 [running]"));

  await manager.pauseAndWait(runId);
  assert.equal(agentRunning, false);
  await pulse();
  assert.equal(
    widget?.[0],
    "Board Agent ● 1/2 slots occupied · 0 models running",
  );
  assert.ok(widget?.includes("  T001 [paused]"));
  agentEntered = deferred();
  assert.equal(await manager.resume(runId), true);
  await agentEntered.promise;
  await pulse();
  assert.equal(
    widget?.[0],
    "Board Agent ● 1/2 slots occupied · 1 models running",
    "busy-tick heartbeats must refresh a resumed builder without another admission tick",
  );
  assert.equal(boardReads, 1);
  assert.equal(
    executor.activeCount(),
    1,
    "UI refresh never changes occupied capacity",
  );
  console.log(
    "PASS: real widget reports a live builder before blocked board I/O finishes and refreshes pause/resume on busy-tick heartbeats without scheduling another tick",
  );
} finally {
  globalThis.setInterval = originalInterval;
  const stopping = command?.("stop", ctx);
  boardRelease.resolve();
  await Promise.all([starting, stopping]);
  await manager.pauseAndWait(runId);
  manager.dispose();
  hooks.deregister();
  delete globals.__builderWidget;
}
