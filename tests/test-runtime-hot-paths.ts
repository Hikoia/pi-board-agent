// Real entry/loop/runtime/state/lock/store with observable offline board/model boundaries.
import assert from "node:assert/strict";
import { until } from "./async-loop-fixture.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { BoardLoop, LoopDeps, LoopState } from "../src/loop.js";
import { observeOperation } from "../src/operation.js";
import { runProcess, runProcessSync, type ProcessOptions } from "../src/process-runner.js";
import type { TicketExecutor } from "../src/ticket-executor.js";
import type { TicketWorktrees } from "../src/ticket-worktree.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const pkg = join(root, "package"), cwd = join(root, "project");
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
mkdirSync(cwd); mkdirSync(pkg);
cpSync(new URL("../src", import.meta.url), join(pkg, "src"), { recursive: true });
writeFileSync(join(pkg, "package.json"), '{"type":"module"}\n');
writeFileSync(join(pkg, ".gitignore"), "node_modules/\n");
symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(pkg, "node_modules"), process.platform === "win32" ? "junction" : "dir");
git(pkg, "init", "-b", "main"); git(pkg, "add", ".");
git(pkg, "-c", "user.name=Offline", "-c", "user.email=offline@example.test", "commit", "-m", "fixture");
const sha = git(pkg, "rev-parse", "HEAD");
writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ packages: [`git:github.com/Hikoia/pi-board-agent@${sha}`] }));
git(cwd, "init", "-b", "main"); git(cwd, "remote", "add", "origin", "https://github.com/owner/repo.git");
mkdirSync(join(cwd, ".pi"));
writeFileSync(join(cwd, ".pi", "board-agent.yml"), "project:\n  owner: owner\n  number: 1\nbot_identity: bot\ntick_seconds: 9999\ncontext:\n  enabled: false\nrefine:\n  enabled: false\nreview:\n  enabled: false\nwatchdog:\n  enabled: false\n");
// Clean admission is deliberately enabled. Only disposable .pi state is ignored.
writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
git(cwd, "add", "."); git(cwd, "-c", "user.name=Offline", "-c", "user.email=offline@example.test", "commit", "-m", "fixture");
const calls: Array<{ mode: string; command: string; args: string[]; cwd?: string }> = [];
const entry = pathToFileURL(join(pkg, "src", "index.ts")).href;
const moduleUrl = (name: string) => new URL(name, entry).href;
const globals = globalThis as any;
let loop!: BoardLoop, deps!: LoopDeps, state!: LoopState, loopStore!: TicketWorktrees, executorStore: TicketWorktrees | undefined;
let occupied = 0, launches = 0, occupancyReads = 0, cards: Card[] = [];
let observation = { active: [{ itemId: "OBS", taskKey: "T099", runId: "observed", status: "paused", worktree: cwd }], occupiedSlots: 1 };
const executor: TicketExecutor = {
  migrateLegacy: async () => ({ converted: [], failures: [] }),
  get observation() { return observation; },
  reconcile: async () => ({ active: observation.active, resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
  activeCount: () => { occupancyReads++; return occupied; },
  launch: async () => { launches++; return { status: "skipped", reason: "offline" }; },
  finalizeClosed: async () => { throw new Error("unexpected finalization"); }, shutdown: async () => {},
};
globals.__hotPath = {
  captureLoop: (args: any[], instance: BoardLoop) => { [deps, state, , loopStore] = args; loop = instance; },
  getProjectMetadata: async () => ({ projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT", statusOptions: Object.fromEntries(Object.values(_DEFAULTS.columns).map((name) => [name, name])), planFieldId: "PLAN", planFieldType: "TEXT", typeFieldId: "TYPE", typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK", Story: "STORY" } }),
  listCards: async () => structuredClone(cards),
  createProductionTicketExecutor: (options: any) => { executorStore = options.worktrees; return executor; },
  runProcess: (command: any, args: string[], options: ProcessOptions = {}) => { calls.push({ mode: "async", command, args, cwd: options.cwd }); return runProcess(command, args, options); },
  runProcessSync: (command: any, args: string[], options: ProcessOptions = {}) => { calls.push({ mode: "sync", command, args, cwd: options.cwd }); return runProcessSync(command, args, options); },
};
const shim = (file: string, names: string[]) => `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(moduleUrl(file))};\n${names.map((name) => `export const ${name} = globalThis.__hotPath.${name};`).join("\n")}`)}`;
const stubs: Record<string, string> = {
  "./gh.js": shim("gh.ts", ["getProjectMetadata", "listCards"]),
  "./ticket-executor.js": shim("ticket-executor.ts", ["createProductionTicketExecutor"]),
  "./process-runner.js": shim("process-runner.ts", ["runProcess", "runProcessSync"]),
};
const wrappedLoop = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(moduleUrl("loop.ts"))}; import { BoardLoop as Real } from ${JSON.stringify(moduleUrl("loop.ts"))}; export class BoardLoop extends Real { constructor(...args) { super(...args); globalThis.__hotPath.captureLoop(args, this); } }`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === entry && specifier === "./loop.js") return { url: wrappedLoop, shortCircuit: true };
  if (context.parentURL?.startsWith(new URL(".", entry).href) && stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
  return next(specifier, context);
} });
const previousCwd = process.cwd();
const messages: string[] = [];
let widget: string[] | undefined, command!: (name: string, ctx: any) => Promise<void>;
const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "hot-path" }, ui: { notify: (text: string) => messages.push(text), setWidget: (_id: string, lines: string[] | undefined) => { widget = lines; } } };
const lockPath = join(cwd, ".pi", "board-agent", "owner.lock"), runtimePath = join(cwd, ".pi", "board-agent", "runtime.json");
const discovery = () => calls.filter((call) => call.command === "git" && call.args.includes("--show-toplevel") && !call.args.includes("HEAD"));
try {
  process.chdir(cwd);
  (await import(entry)).default({ on: () => {}, registerCommand: (_name: string, opts: any) => { command = opts.handler; } });
  await command("run", ctx);
  await until(() => !!loop?.isRunning());
  await loop.tickNow();
  assert.ok(loop?.isRunning(), messages.join("\n"));
  assert.equal(calls.filter((call) => call.mode === "sync" && resolve(call.cwd!) === resolve(pkg)).length, 2, "only immutable loaded identity capture uses synchronous package Git");
  calls.length = 0;
  for (let i = 0; i < 3; i++) deps.callback(`offline notification ${i}`);
  assert.deepEqual([...calls], [], "notifications render executor observations without Git/store rediscovery");
  for (let i = 0; i < 3; i++) await deps.revisionCheck!();
  assert.deepEqual(discovery(), [], "repeated heartbeat writes reuse this owner's resolved Git root");
  assert.equal(calls.filter((call) => call.mode === "sync").length, 0, "heartbeats run no synchronous package Git");
  assert.equal(executorStore, loopStore, "executor and loop share one owner-lifetime worktree store");
  assert.ok(widget?.includes("  T099 [paused]"));
  observation = { ...observation, active: [{ ...observation.active[0], status: "running" }] };
  deps.callback("new display observation");
  assert.ok(widget?.includes("  T099 [running]"));
  assert.equal(calls.length, 0, "heartbeats reuse startup identity without package HEAD/status or settings scans");
  assert.ok(calls.every((call) => resolve(call.cwd!) === resolve(pkg)));
  const before = occupancyReads;
  let clock = Date.now();
  const progress = observeOperation(state, "finalization", () => deps.onActivity!(), { issueNumber: 7 }, () => clock);
  progress.onProgress({ phase: "remove", completed: 0, total: 100, unit: "items" });
  for (let i = 1; i <= 100; i++) { clock += 1000; progress.onProgress({ phase: "remove", completed: i, total: 100, unit: "items" }); }
  assert.ok(widget?.some((line) => line.includes("Cleanup #7") && line.includes("100 / 100 items")));
  assert.equal(JSON.parse(readFileSync(runtimePath, "utf8")).activity.completed, 100);
  assert.equal(occupancyReads, before, "progress never scans model capacity");
  await deps.revisionCheck!();
  assert.equal(JSON.parse(readFileSync(runtimePath, "utf8")).activity.lastProgressAt, clock, "heartbeat does not fabricate progress");
  progress.finish("offline blocker");
  assert.ok(widget?.includes("Maintenance blocked: offline blocker"));
  assert.equal(calls.length, 0, "progress publishing makes no Git/package/revision probes");
  assert.equal(occupancyReads, before + 1, "only the existing heartbeat performs its one capacity observation");
  console.log("PASS: notify/heartbeat/progress uses one owner store/root and cached revision, renders actual progress and never adds Git or capacity probes");

  calls.length = 0;
  await loop.tickNow();
  await command("status", ctx);
  assert.deepEqual(discovery(), [], "tick guard and explicit status reuse the active owner's paths/store too");
  const ready: Card = { itemId: "READY", number: 1, title: "Ready", body: "Acceptance", plan: "demo", contentType: "Issue", type: "Task", status: "Ready", closed: false, repoOwner: "owner", repoName: "repo", assignees: [] };
  cards = [ready];
  observation = { active: [], occupiedSlots: 0 }; // An empty display cannot lend capacity.
  occupied = _DEFAULTS.max_workers;
  deps.callback("optimistic display");
  await loop.tickNow();
  assert.equal(launches, 0, "only live executor occupancy admits work");
  occupied = 0;
  const dirty = join(cwd, "human-work.txt");
  writeFileSync(dirty, "preserve human work");
  await loop.tickNow();
  assert.equal(launches, 0, "optimistic display cannot bypass a newly dirty admission");
  rmSync(dirty);
  await loop.tickNow();
  assert.equal(launches, 1, "positive control admits the same candidate after the live clean gate passes");
  assert.equal(calls.filter((call) => resolve(call.cwd!) === resolve(pkg)).length, 0,
    "status, UI, heartbeat and ordinary admission never scan the package");
  console.log("PASS: display changes never authorize mutation/capacity; newly dirty admission remains live and fail closed");

  const legacy = join(cwd, ".pi", "board-agent", "inflight", "legacy.json");
  mkdirSync(join(legacy, ".."), { recursive: true });
  writeFileSync(legacy, "{}");
  const sentinel = '{"sentinel":"unchanged"}';
  writeFileSync(runtimePath, sentinel);
  await deps.revisionCheck!();
  await assert.rejects(loop.tickNow(), /Unsupported pre-0.2.0/);
  await command("run", ctx);
  await until(() => messages.some((s) => s.includes("Startup/recovery failed")));
  assert.equal(readFileSync(runtimePath, "utf8"), sentinel);
  assert.equal(readFileSync(legacy, "utf8"), "{}");
  assert.equal(launches, 1);
  rmSync(join(legacy, ".."), { recursive: true });
  const ownedLock = readFileSync(lockPath, "utf8");
  for (const replacement of [JSON.stringify({ ...JSON.parse(ownedLock), hostname: "foreign-host", token: "not-ours" }), "{corrupt"]) {
    writeFileSync(lockPath, replacement);
    await deps.revisionCheck!();
    assert.equal(readFileSync(runtimePath, "utf8"), sentinel, "live foreign/corrupt owner blocks heartbeat overwrite");
    assert.equal(readFileSync(lockPath, "utf8"), replacement);
  }
  writeFileSync(lockPath, ownedLock);
  await deps.revisionCheck!();
  assert.notEqual(readFileSync(runtimePath, "utf8"), sentinel, "an allowed writer rereads current lock contents without a TTL");
  console.log("PASS: mid-owner unsupported state blocks tick/promotion/heartbeat writes and foreign/corrupt locks block heartbeat writes without cached authorization");

  cards = [];
  const previousStore = loopStore;
  await command("stop", ctx);
  assert.equal(existsSync(lockPath), false);
  await command("run", ctx);
  await until(() => !!loop.isRunning());
  await loop.tickNow();
  assert.ok(loop.isRunning());
  assert.notEqual(loopStore, previousStore, "resources are not reused across owner lifetimes");
  assert.equal(executorStore, loopStore);
  calls.length = 0;
  const packageFile = join(pkg, "package.json");
  writeFileSync(packageFile, '{"type":"module","changed":true}');
  git(pkg, "add", ".");
  git(pkg, "-c", "user.name=Offline", "-c", "user.email=offline@example.test", "commit", "-m", "changed package");
  cards = [ready];
  assert.equal((await deps.revisionCheck!()).ok, true, "hot update is unsupported, not polled");
  await command("status", ctx);
  assert.equal(calls.filter((call) => resolve(call.cwd!) === resolve(pkg)).length, 0);
  await command("lint", ctx); // Explicit check detects the unsupported package change.
  assert.equal((await deps.revisionCheck!()).ok, false);
  await loop.tickNow();
  assert.equal(launches, 1, "explicit lint mismatch blocks new work");
  assert.equal(loop.isAdmittingNewWork(), false);
  git(pkg, "reset", "--hard", sha);
  assert.equal((await deps.revisionCheck!()).ok, false, "restoring package files cannot clear the process mismatch latch");
  assert.deepEqual(discovery(), []);
  assert.ok(calls.filter((call) => resolve(call.cwd!) === resolve(pkg)).every((call) => call.mode === "async"));
  console.log("PASS: explicit lint package mismatch closes admissions for the process lifetime, without root rediscovery");
} finally {
  await command?.("stop", ctx);
  hooks.deregister(); delete globals.__hotPath;
  process.chdir(previousCwd);
}
