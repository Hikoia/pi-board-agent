// Real entry/loop/runtime/state/lock/store with observable offline board/model boundaries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkflowAgent, createRunPersistence } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { BoardLoop, LoopDeps } from "../src/loop.js";
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
let loop!: BoardLoop, deps!: LoopDeps, loopStore!: TicketWorktrees, executorStore: TicketWorktrees | undefined;
let occupied = 0, launches = 0, cards: Card[] = [];
let actual = false;
let typeFieldId = "TYPE";
let realFactory: typeof import("../src/ticket-executor.js").createProductionTicketExecutor;
const comments: Array<{id: string; author: string; body: string; createdAt: string}> = [];
let observation = { active: [{ itemId: "OBS", taskKey: "T099", runId: "observed", status: "paused", worktree: cwd }], occupiedSlots: 1 };
const executor: TicketExecutor = {
  get observation() { return observation; },
  reconcile: async () => ({ active: observation.active, resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
  activeCount: () => occupied,
  launch: async () => { launches++; return { status: "skipped", reason: "offline" }; },
  finalizeClosed: async () => { throw new Error("unexpected finalization"); }, shutdown: async () => {},
};
globals.__hotPath = {
  captureLoop: (args: any[], instance: BoardLoop) => { [deps, , , loopStore] = args; loop = instance; },
  resolveOwner: () => ({ projectOwner: "owner", repoOwner: "owner", repoName: "repo" }),
  whoami: async () => "bot",
  getCard: async (id: string) => structuredClone(cards.find(c => c.itemId === id)),
  tryClaim: async (card: Card) => { cards.find(c => c.itemId === card.itemId)!.assignees = ["bot"]; return true; },
  release: async (card: Card) => { cards.find(c => c.itemId === card.itemId)!.assignees = []; },
  setStatus: async (_meta: unknown, id: string, status: string) => { cards.find(c => c.itemId === id)!.status = status; },
  listIssueComments: async () => structuredClone(comments),
  resolveIssueId: async () => "ISSUE",
  createComment: async (_id: string, body: string) => { const id = String(comments.length); comments.push({ id, body, author: "bot", createdAt: new Date().toISOString() }); return id; },
  getProjectMetadata: async () => ({ projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT", statusOptions: Object.fromEntries(Object.values(_DEFAULTS.columns).map((name) => [name, name])), typeFieldId, typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK" } }),
  listCards: async () => structuredClone(cards),
  createProductionTicketExecutor: (options: any) => { executorStore = options.worktrees; return actual ? realFactory(options) : executor; },
  runProcess: (command: any, args: string[], options: ProcessOptions = {}) => { calls.push({ mode: "async", command, args, cwd: options.cwd }); return runProcess(command, args, options); },
  runProcessSync: (command: any, args: string[], options: ProcessOptions = {}) => { calls.push({ mode: "sync", command, args, cwd: options.cwd }); return runProcessSync(command, args, options); },
};
const shim = (file: string, names: string[]) => `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(moduleUrl(file))};\n${names.map((name) => `export const ${name} = globalThis.__hotPath.${name};`).join("\n")}`)}`;
const stubs: Record<string, string> = {
  "./config.js": shim("config.ts", ["resolveOwner"]),
  "./gh.js": shim("gh.ts", ["getProjectMetadata", "listCards", "whoami", "getCard", "tryClaim", "release", "setStatus", "listIssueComments", "resolveIssueId", "createComment"]),
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
const events = new Map<string, Function>();
const originalRun = WorkflowAgent.prototype.run;
let widget: string[] | undefined, command!: (name: string, ctx: any) => Promise<void>;
const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "hot-path" }, ui: { notify: (text: string) => messages.push(text), setWidget: (_id: string, lines: string[] | undefined) => { widget = lines; } } };
const lockPath = join(cwd, ".pi", "board-agent", "owner.lock"), runtimePath = join(cwd, ".pi", "board-agent", "runtime.json");
const discovery = () => calls.filter((call) => call.command === "git" && call.args.includes("--show-toplevel") && !call.args.includes("HEAD"));
try {
  process.chdir(cwd);
  (await import(entry)).default({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (_name: string, opts: any) => { command = opts.handler; } });
  await command("run", ctx);
  assert.ok(loop?.isRunning(), messages.join("\n"));
  assert.equal(calls.filter((call) => call.mode === "sync" && resolve(call.cwd!) === resolve(pkg)).length, 2, "only immutable loaded identity capture uses synchronous package Git");
  calls.length = 0;
  for (let i = 0; i < 3; i++) deps.callback(`offline notification ${i}`);
  assert.deepEqual([...calls], [], "notifications render executor observations without Git/store rediscovery");
  for (let i = 0; i < 3; i++) await deps.onTick!();
  assert.deepEqual(discovery(), [], "repeated heartbeat writes reuse this owner's resolved Git root");
  assert.equal(calls.filter((call) => call.mode === "sync").length, 0, "heartbeats perform no synchronous Git");
  assert.equal(executorStore, loopStore, "executor and loop share one owner-lifetime worktree store");
  assert.ok(widget?.includes("  T099 [paused]"));
  observation = { ...observation, active: [{ ...observation.active[0], status: "running" }] };
  deps.callback("new display observation");
  assert.ok(widget?.includes("  T099 [running]"));
  assert.equal(calls.length, 0, "heartbeats do not inspect the package or settings");
  console.log("PASS: production notify/heartbeat uses one owner store/root and cached provenance; changed executor observations refresh the real widget without Git");

  calls.length = 0;
  await loop.tickNow();
  await command("status", ctx);
  assert.deepEqual(discovery(), [], "tick guard and explicit status reuse the active owner's paths/store too");
  const ready: Card = { itemId: "READY", number: 1, title: "T001 Ready", body: "Acceptance", contentType: "Issue", type: "Task", status: "Ready", closed: false, repoOwner: "owner", repoName: "repo", assignees: [] };
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
  assert.equal(calls.filter(c => c.cwd && resolve(c.cwd) === resolve(pkg)).length, 0, "tick/status/admission never inspect the package");
  console.log("PASS: display changes never authorize mutation/capacity; newly dirty admission remains live and fail closed");

  const legacy = join(cwd, ".pi", "board-agent", "inflight", "legacy.json");
  mkdirSync(join(legacy, ".."), { recursive: true });
  writeFileSync(legacy, "{}");
  const sentinel = '{"sentinel":"unchanged"}';
  writeFileSync(runtimePath, sentinel);
  await deps.onTick!();
  await assert.rejects(loop.tickNow(), /Unsupported pre-0.2.0/);
  await command("run", ctx);
  assert.equal(readFileSync(runtimePath, "utf8"), sentinel);
  assert.equal(readFileSync(legacy, "utf8"), "{}");
  assert.equal(launches, 1);
  rmSync(join(legacy, ".."), { recursive: true });
  const ownedLock = readFileSync(lockPath, "utf8");
  for (const replacement of [JSON.stringify({ ...JSON.parse(ownedLock), hostname: "foreign-host", token: "not-ours" }), "{corrupt"]) {
    writeFileSync(lockPath, replacement);
    await deps.onTick!();
    assert.equal(readFileSync(runtimePath, "utf8"), sentinel, "live foreign/corrupt owner blocks heartbeat overwrite");
    assert.equal(readFileSync(lockPath, "utf8"), replacement);
  }
  writeFileSync(lockPath, ownedLock);
  await deps.onTick!();
  assert.notEqual(readFileSync(runtimePath, "utf8"), sentinel, "an allowed writer rereads current lock contents without a TTL");
  console.log("PASS: mid-owner unsupported state blocks tick/promotion/heartbeat writes and foreign/corrupt locks block heartbeat writes without cached authorization");

  cards = [];
  const previousStore = loopStore;
  await command("stop", ctx);
  assert.equal(existsSync(lockPath), false);
  await command("run", ctx);
  assert.ok(loop.isRunning());
  assert.notEqual(loopStore, previousStore, "resources are not reused across owner lifetimes");
  assert.equal(executorStore, loopStore);

  const configPath = join(cwd, ".pi", "board-agent.yml");
  const originalConfig = readFileSync(configPath, "utf8");
  writeFileSync(configPath, originalConfig + "max_workers: 3\n");
  const retained = loopStore;
  await command("lint", ctx);
  assert.equal(loop.isAdmittingNewWork(), false, "lint disables stale configuration admissions");
  await command("run", ctx);
  assert.equal(loop.isAdmittingNewWork(), false, "promotion cannot reuse stale configuration");
  assert.equal(loopStore, retained, "failed preflight preserves owned resources");
  await command("stop", ctx); await command("lint", ctx); await command("run", ctx);
  assert.equal(deps.cfg.max_workers, 3); assert.notEqual(loopStore, retained);
  typeFieldId = "REPLACED_TYPE";
  await command("run", ctx);
  assert.equal(loop.isAdmittingNewWork(), false, "new schema IDs cannot promote old metadata");
  await command("stop", ctx); await command("run", ctx);
  assert.equal(deps.meta.typeFieldId, typeFieldId); assert.ok(loop.isAdmittingNewWork());
  console.log("PASS: lint/run reject config and metadata drift without replacing owned resources; successful stop permits a fresh snapshot");
  // Real production factory -> ManagedTicketExecutor -> WorkflowManager and
  // detached runReview, with only GitHub/provider I/O replaced. Git stays native.
  await command("stop", ctx);
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", origin);
  git(cwd, "remote", "set-url", "origin", origin);
  git(cwd, "config", "user.name", "Offline"); git(cwd, "config", "user.email", "offline@example.test");
  git(cwd, "push", "origin", "main");
  realFactory = (await import(moduleUrl("ticket-executor.ts"))).createProductionTicketExecutor;
  actual = true;
  let builders = 0, reviewers = 0;
  WorkflowAgent.prototype.run = (async function (this: WorkflowAgent, prompt, options) {
    const path = options?.cwd ?? (this as any).cwd;
    if (prompt.includes("independent senior code reviewer")) {
      reviewers++;
      return { verdict: "pass", summary: "offline accepted", findings: [] };
    }
    builders++;
    writeFileSync(join(path, "accepted.txt"), "accepted\n");
    git(path, "add", "accepted.txt"); git(path, "commit", "-m", "accepted");
    git(path, "push", "origin", "task/issue-1");
    return { taskKey: "T001", itemId: ready.itemId, status: "success", branch: "task/issue-1", summary: "accepted" };
  }) as typeof originalRun;
  cards = [];
  await command("run", ctx);
  assert.ok(loop.isRunning(), messages.join("\n"));
  calls.length = 0;
  const settings = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
  const settingsBytes = readFileSync(settings);
  writeFileSync(settings, "{changed-under-owner"); // Deliberate offline policy fault: no hot settings polling.
  cards = [structuredClone(ready)];
  await loop.tickNow();
  const path = loopStore.read(ready.itemId)!.path;
  for (let i = 0; i < 400 && !createRunPersistence(path).list().some(r => r.status === "completed"); i++)
    await new Promise(r => setTimeout(r, 20));
  assert.equal(createRunPersistence(path).list()[0]?.status, "completed");
  await loop.tickNow();
  assert.equal(cards[0].status, "Review", messages.join("\n"));
  await loop.tickNow();
  assert.equal(cards[0].status, "Done", messages.join("\n"));
  assert.equal(builders, 1); assert.equal(reviewers, 1); assert.equal(cards[0].closed, false);
  await command("status", ctx); await deps.onTick!();
  assert.equal(calls.filter(c => c.cwd && resolve(c.cwd) === resolve(pkg)).length, 0);
  assert.ok(loop.isAdmittingNewWork(), "package settings are not re-read on actual starts/UI/heartbeat");
  writeFileSync(settings, settingsBytes);
  console.log("PASS: production entry/loop/executor actual builder and detached reviewer starts perform zero package/settings inspections");

  // A current Done record is recovery even without active/retry/integration fields.
  await command("stop", ctx);
  const packageFile = join(pkg, "package.json");
  writeFileSync(packageFile, '{"type":"module","changed":true}');
  git(pkg, "add", ".");
  git(pkg, "-c", "user.name=Offline", "-c", "user.email=offline@example.test", "commit", "-m", "changed package");
  cards.push({ ...ready, itemId: "NEW", number: 2 });
  await events.get("session_start")!({}, ctx);
  assert.ok(loop.isRunning(), messages.join("\n"));
  assert.equal(loop.isAdmittingNewWork(), false, "startup mismatch allows recovery only");
  cards[0].closed = true; // Manual validation, never an autonomous close.
  calls.length = 0;
  await loop.tickNow();
  assert.equal(loopStore.has(ready.itemId), false, messages.join("\n"));
  assert.equal(existsSync(path), false);
  assert.equal(git(cwd, "ls-remote", "origin", "refs/heads/task/issue-1"), "");
  assert.equal(cards[1].status, "Ready"); assert.equal(builders, 1);
  await command("status", ctx); await deps.onTick!();
  assert.equal(calls.filter(c => c.cwd && resolve(c.cwd) === resolve(pkg)).length, 0);
  assert.ok(messages.some(m => m.includes("last startup/lint check; not live")));
  git(pkg, "reset", "--hard", sha);
  await command("run", ctx);
  assert.equal(loop.isAdmittingNewWork(), false, "restoring package files cannot clear startup's process mismatch latch");
  assert.equal(builders, 1);
  console.log("PASS: startup mismatch blocks new admissions, preserves the process latch, and still completes closed-Done recovery without hot package polling");

} finally {
  await command?.("stop", ctx);
  WorkflowAgent.prototype.run = originalRun;
  hooks.deregister(); delete globals.__hotPath;
  process.chdir(previousCwd);
}
