/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import {
  BOARD_AGENT_SOURCE,
  captureRuntimeIdentity,
  checkRuntimeRevision,
  formatRevisionFailure,
  readRuntimeStatus,
  writeRuntimeStatus,
} from "../src/runtime.js";
import type { ReconcileSummary, TicketExecutor } from "../src/ticket-executor.js";

const check = (condition: boolean, label: string) => console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);
const root = process.env.TMP_DIR!;
const packageRoot = join(root, "package");
const projectRoot = join(root, "project");
const agentDir = join(root, "agent");
mkdirSync(packageRoot, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).trim();
git("init", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
writeFileSync(join(packageRoot, "package.json"), "{}\n");
git("add", ".");
git("commit", "-m", "initial");
const revisionA = git("rev-parse", "HEAD");
const revisionB = "b".repeat(40);
const globalSettings = (ref?: string) => writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ packages: ref ? [`${BOARD_AGENT_SOURCE}@${ref}`] : [] }),
);
const projectSettingsPath = join(projectRoot, ".pi", "settings.json");
const projectSettings = (value?: unknown) => {
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  if (value === undefined) rmSync(projectSettingsPath, { force: true });
  else writeFileSync(projectSettingsPath, JSON.stringify({ packages: [value] }));
};

globalSettings(revisionA);
const loaded = captureRuntimeIdentity(packageRoot, projectRoot, agentDir);
const valid = checkRuntimeRevision(projectRoot, loaded, agentDir);
check(valid.ok && valid.expectedRevision === revisionA && valid.loadedRevision === revisionA && valid.diskRevision === revisionA, "exact SHA and clean package checkout pass the revision gate");

const movableRefs = ["main", "v1.2.3", revisionA.slice(0, 8)];
check(movableRefs.every((ref) => {
  globalSettings(ref);
  return !checkRuntimeRevision(projectRoot, loaded, agentDir).ok;
}), "branch, tag, and short SHA refs are rejected");
globalSettings();
check(!checkRuntimeRevision(projectRoot, loaded, agentDir).ok, "missing Board Agent package entry is rejected");

globalSettings(revisionA);
projectSettings(`${BOARD_AGENT_SOURCE}@${revisionB}`);
const overridden = checkRuntimeRevision(projectRoot, loaded, agentDir);
check(!overridden.ok && overridden.expectedRevision === revisionB, "project-local Board Agent override wins and rejects a different SHA");
projectSettings({ source: `${BOARD_AGENT_SOURCE}@${revisionB}`, autoload: false });
check(checkRuntimeRevision(projectRoot, loaded, agentDir).ok, "autoload=false project delta keeps the effective global package pin");
projectSettings();

writeFileSync(join(packageRoot, "untracked.txt"), "dirty\n");
check(!checkRuntimeRevision(projectRoot, loaded, agentDir).ok, "a currently dirty package checkout is rejected");
const loadedDirty = captureRuntimeIdentity(packageRoot, projectRoot, agentDir);
rmSync(join(packageRoot, "untracked.txt"));
check(!checkRuntimeRevision(projectRoot, loadedDirty, agentDir).ok, "a package dirty at extension load remains rejected after cleanup");

writeFileSync(join(packageRoot, "package.json"), "{\"changed\":true}\n");
git("add", ".");
git("commit", "-m", "changed");
const changedOnDisk = checkRuntimeRevision(projectRoot, loaded, agentDir);
check(!changedOnDisk.ok && changedOnDisk.diskRevision !== revisionA, "disk revision change blocks new work");
git("reset", "--hard", revisionA);
const restoredButLatched = checkRuntimeRevision(projectRoot, loaded, agentDir, true);
check(!restoredButLatched.ok && restoredButLatched.reason?.includes("restart is required") === true, "restoring the old disk SHA does not clear a process mismatch latch");
check(formatRevisionFailure(changedOnDisk).includes("expected=") && formatRevisionFailure(changedOnDisk).includes("loaded=") && formatRevisionFailure(changedOnDisk).includes("pi install"), "revision failure includes identities and a repair command");

const startedAt = new Date(0).toISOString();
writeRuntimeStatus(projectRoot, {
  expectedRevision: revisionA,
  loadedRevision: revisionA,
  diskRevision: revisionA,
  dirty: false,
  pid: process.pid,
  sessionId: "session-test",
  state: "running",
  startedAt,
});
writeRuntimeStatus(projectRoot, {
  expectedRevision: revisionA,
  loadedRevision: revisionA,
  diskRevision: revisionA,
  dirty: false,
  pid: process.pid,
  sessionId: "session-test",
  state: "stopped",
  startedAt,
});
const runtime = readRuntimeStatus(projectRoot);
const runtimeDir = join(projectRoot, ".pi", "board-agent");
check(runtime?.schemaVersion === 1 && runtime.state === "stopped" && runtime.sessionId === "session-test", "runtime JSON atomically updates through stopped state");
check(readdirSync(runtimeDir).every((name) => !name.endsWith(".tmp")), "runtime JSON atomic rename leaves no temporary file");

const cfg: Config = {
  ..._DEFAULTS,
  project: { owner: "test", number: 1 },
  refine: { ..._DEFAULTS.refine, enabled: false },
  watchdog: { ..._DEFAULTS.watchdog, enabled: false },
  review: { ..._DEFAULTS.review, enabled: false },
  safety: { ..._DEFAULTS.safety, require_clean_worktree: false },
};
const ready: Card = {
  itemId: "PVTI_ready",
  number: 1,
  title: "Ready ticket",
  body: "acceptance",
  status: cfg.columns.ready,
  plan: "demo",
  type: "Task",
  assignees: [],
  closed: false,
};
let reconciles = 0;
let launches = 0;
const executor: TicketExecutor = {
  reconcile: async (): Promise<ReconcileSummary> => {
    reconciles++;
    return { active: [], resumed: 0, adopted: 0, needsHuman: 0, legacy: 0, orphans: 0, errors: 0 };
  },
  launch: async () => { launches++; return { status: "launched", runId: "unexpected", worktree: projectRoot }; },
  activeCount: () => 0,
  shutdown: async () => undefined,
};
const deps: LoopDeps = {
  cwd: projectRoot,
  cfg,
  repoOwner: "test",
  repoName: "repo",
  botLogin: "bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: () => undefined,
  listCards: async () => [ready],
  revisionCheck: () => ({ ok: false, reason: "test revision mismatch" }),
};
const boardLoop = new BoardLoop(deps, createLoopState(), executor);
await boardLoop.tickNow();
check(reconciles === 1 && launches === 0 && !boardLoop.isAdmittingNewWork(), "revision mismatch allows settlement reconcile but blocks new ticket launch");

const settledSummary: ReconcileSummary = { active: [], resumed: 0, adopted: 0, needsHuman: 0, legacy: 0, orphans: 0, errors: 0 };
let releaseReconcile = (_summary: ReconcileSummary): void => undefined;
let heartbeatChecks = 0;
const heartbeatLoop = new BoardLoop(
  {
    ...deps,
    cfg: { ...cfg, tick_seconds: 0.01 },
    listCards: async () => [],
    revisionCheck: () => { heartbeatChecks++; return { ok: true }; },
  },
  createLoopState(),
  {
    ...executor,
    reconcile: () => new Promise<ReconcileSummary>((resolve) => { releaseReconcile = resolve; }),
  },
);
const starting = heartbeatLoop.start();
await new Promise((resolve) => setTimeout(resolve, 45));
check(heartbeatChecks >= 2, "long-running ticks keep checking revision and refreshing the runtime heartbeat");
releaseReconcile(settledSummary);
await starting;
await heartbeatLoop.stop();

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const startSource = indexSource.slice(indexSource.indexOf("async function startBoardLoop"), indexSource.indexOf("export default function"));
check(startSource.indexOf("currentRevision(cwd)") < startSource.indexOf("loadConfig(cwd)"), "start path checks package revision before GitHub setup or mutation");
check(indexSource.includes("Revision: state=") && indexSource.includes("expected=${revision.expectedRevision") && indexSource.includes("disk=${revision.diskRevision"), "status output includes runtime state and expected, loaded, and disk revisions");
