import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { BoardLoop, LoopDeps } from "../src/loop.js";
import { acquireOwnerLock, ownerLockHeldByOther } from "../src/owner-lock.js";
import {
  BOARD_AGENT_SOURCE,
  boardAgentRef,
  captureRuntimeIdentity,
  checkRuntimeRevision,
  formatRevisionFailure,
  readRuntimeStatus,
  writeRuntimeStatus,
} from "../src/runtime.js";
import type {
  ReconcileSummary,
  TicketExecutor,
} from "../src/ticket-executor.js";

const check = (condition: boolean, label: string) => {
  assert.ok(condition, label);
  console.log(`PASS: ${label}`);
};
const previousCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "board-agent-revision-"));
const packageRoot = join(root, "package");
const projectRoot = join(root, "project");
const agentDir = join(root, "agent");
for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_|PI_SESSION)|TOKEN|API_KEY|SECRET|PASSWORD/i.test(key))
    delete process.env[key];
}
process.env.HOME = process.env.USERPROFILE = join(root, "home");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.GIT_CONFIG_GLOBAL = join(root, "empty-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const children: ChildProcessWithoutNullStreams[] = [];
const loops: BoardLoop[] = [];

try {
  for (const dir of [packageRoot, projectRoot, agentDir, process.env.HOME])
    mkdirSync(dir, { recursive: true });
  git("init", "-b", "main");
  execFileSync("git", ["init", "-b", "main"], {
    cwd: projectRoot,
    stdio: "ignore",
  });
  process.chdir(projectRoot);
  const { BoardLoop, createLoopState } = await import("../src/loop.js");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(packageRoot, "package.json"), "{}\n");
  git("add", ".");
  git("commit", "-m", "initial fixture");
  const revisionA = git("rev-parse", "HEAD");
  const revisionB = "b".repeat(40);
  const globalSettings = (ref?: string) =>
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ref ? [`${BOARD_AGENT_SOURCE}@${ref}`] : [] }),
    );
  const projectSettingsPath = join(projectRoot, ".pi", "settings.json");
  const projectSettings = (value?: unknown) => {
    mkdirSync(join(projectRoot, ".pi"), { recursive: true });
    if (value === undefined) rmSync(projectSettingsPath, { force: true });
    else
      writeFileSync(projectSettingsPath, JSON.stringify({ packages: [value] }));
  };

  globalSettings(revisionA);
  const loaded = captureRuntimeIdentity(packageRoot, projectRoot, agentDir);
  const valid = checkRuntimeRevision(projectRoot, loaded, agentDir);
  check(
    valid.ok &&
      valid.expectedRevision === revisionA &&
      valid.loadedRevision === revisionA &&
      valid.diskRevision === revisionA,
    "exact SHA and clean package checkout pass the revision gate",
  );
  check(
    Object.isFrozen(loaded),
    "captured extension identity is immutable in memory",
  );
  for (const ref of ["main", "v1.2.3", revisionA.slice(0, 8)]) {
    globalSettings(ref);
    assert.equal(
      checkRuntimeRevision(projectRoot, loaded, agentDir).ok,
      false,
      ref,
    );
  }
  globalSettings();
  assert.equal(checkRuntimeRevision(projectRoot, loaded, agentDir).ok, false);
  check(
    true,
    "branches, tags, short SHAs and a missing package pin cannot admit work",
  );
  globalSettings(revisionA);
  projectSettings(`${BOARD_AGENT_SOURCE}@${revisionB}`);
  const overridden = checkRuntimeRevision(projectRoot, loaded, agentDir);
  check(
    !overridden.ok && overridden.expectedRevision === revisionB,
    "project-local override wins and rejects a different immutable SHA",
  );
  projectSettings({
    source: `${BOARD_AGENT_SOURCE}@${revisionB}`,
    autoload: false,
  });
  check(
    checkRuntimeRevision(projectRoot, loaded, agentDir).ok,
    "autoload=false project delta preserves the effective global pin",
  );
  projectSettings();
  for (const source of [
    `git:git@github.com:Hikoia/pi-board-agent.git@${revisionA}`,
    `https://github.com/Hikoia/pi-board-agent@${revisionA}`,
    `ssh://git@github.com/Hikoia/pi-board-agent@${revisionA}`,
    `git://github.com/Hikoia/pi-board-agent@${revisionA}`,
    `git:git://github.com/Hikoia/pi-board-agent@${revisionA}`,
  ]) {
    assert.equal(boardAgentRef(source), revisionA);
  }
  for (const source of [
    `github.com/Hikoia/pi-board-agent@${revisionA}`,
    `git@github.com:Hikoia/pi-board-agent@${revisionA}`,
    `https://evilgithub.com/Hikoia/pi-board-agent@${revisionA}`,
    `https://example.test/github.com/Hikoia/pi-board-agent@${revisionA}`,
  ]) {
    assert.equal(boardAgentRef(source), undefined, source);
  }
  check(
    true,
    "package pin parsing accepts Pi Git syntaxes but not lookalike hosts or unsupported bare shorthands",
  );

  for (const value of [
    null,
    [],
    { packages: "wrong" },
    { packages: [null] },
    { packages: [{ source: 42 }] },
    {
      packages: [
        { source: `${BOARD_AGENT_SOURCE}@${revisionA}`, autoload: "false" },
      ],
    },
    {
      packages: [
        `${BOARD_AGENT_SOURCE}@${revisionA}`,
        `${BOARD_AGENT_SOURCE}@${revisionA}`,
      ],
    },
  ]) {
    writeFileSync(projectSettingsPath, JSON.stringify(value));
    assert.equal(
      checkRuntimeRevision(projectRoot, loaded, agentDir).ok,
      false,
      JSON.stringify(value),
    );
  }
  writeFileSync(projectSettingsPath, "{broken");
  assert.equal(checkRuntimeRevision(projectRoot, loaded, agentDir).ok, false);
  projectSettings();
  check(
    true,
    "malformed settings and ambiguous package entries fail closed instead of falling back to a global pin",
  );

  writeFileSync(join(packageRoot, "untracked.txt"), "dirty\n");
  assert.equal(checkRuntimeRevision(projectRoot, loaded, agentDir).ok, false);
  const loadedDirty = captureRuntimeIdentity(
    packageRoot,
    projectRoot,
    agentDir,
  );
  rmSync(join(packageRoot, "untracked.txt"));
  check(
    !checkRuntimeRevision(projectRoot, loadedDirty, agentDir).ok,
    "dirty-at-load remains rejected even after checkout cleanup",
  );
  const nested = join(packageRoot, "nested-package");
  mkdirSync(nested);
  const nestedLoaded = captureRuntimeIdentity(nested, projectRoot, agentDir);
  check(
    !checkRuntimeRevision(projectRoot, nestedLoaded, agentDir).ok,
    "a nested non-checkout package cannot borrow its parent Git revision",
  );
  rmSync(nested, { recursive: true });

  writeFileSync(join(packageRoot, "package.json"), '{"changed":true}\n');
  git("add", ".");
  git("commit", "-m", "changed fixture");
  const changedOnDisk = checkRuntimeRevision(projectRoot, loaded, agentDir);
  check(
    !changedOnDisk.ok && changedOnDisk.diskRevision !== revisionA,
    "moving disk HEAD blocks work loaded from the old SHA",
  );
  git("reset", "--hard", revisionA);
  const restored = checkRuntimeRevision(projectRoot, loaded, agentDir, true);
  check(
    !restored.ok && restored.reason?.includes("restart is required") === true,
    "restoring disk HEAD cannot clear a process mismatch latch",
  );
  const message = formatRevisionFailure(changedOnDisk);
  check(
    message.includes("expected=") &&
      message.includes("loaded=") &&
      message.includes("disk=") &&
      message.includes("pi install"),
    "mismatch guidance includes exact identities and an immutable repair command",
  );

  const status = {
    expectedRevision: revisionA,
    loadedRevision: revisionA,
    diskRevision: revisionA,
    dirty: false,
    pid: process.pid,
    sessionId: "session-test",
    startedAt: new Date(0).toISOString(),
  };
  writeRuntimeStatus(projectRoot, { ...status, state: "running" });
  writeRuntimeStatus(projectRoot, { ...status, state: "stopped" });
  const runtime = readRuntimeStatus(projectRoot);
  const runtimeDir = join(projectRoot, ".pi", "board-agent");
  check(
    runtime?.schemaVersion === 1 &&
      runtime.state === "stopped" &&
      runtime.sessionId === "session-test" &&
      readdirSync(runtimeDir).every((name) => !name.endsWith(".tmp")),
    "atomic runtime updates reach stopped and leave no temporary files",
  );

  const cfg: Config = {
    ...structuredClone(_DEFAULTS),
    project: { owner: "test", number: 1 },
    refine: { ..._DEFAULTS.refine, enabled: false },
    watchdog: { ..._DEFAULTS.watchdog, enabled: false },
    review: { ..._DEFAULTS.review, enabled: false },
    safety: { ..._DEFAULTS.safety, require_clean_worktree: false },
  };
  const ready: Card = {
    itemId: "PVTI_ready",
    contentType: "Issue",
    number: 1,
    repoOwner: "test",
    repoName: "repo",
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
  const settledSummary = {
    active: [],
    resumed: 0,
    adopted: 0,
    needsHuman: 0,
    orphans: 0,
    errors: 0,
  } as ReconcileSummary;
  const executor: TicketExecutor = {
    reconcile: async () => {
      reconciles++;
      return settledSummary;
    },
    launch: async () => {
      launches++;
      return { status: "launched", runId: "fixture", worktree: projectRoot };
    },
    finalizeClosed: async () => {
      throw new Error("Unexpected finalization of an open Ready fixture");
    },
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
    revisionCheck: () => ({ ok: false, reason: "fixture mismatch" }),
  };
  const boardLoop = new BoardLoop(deps, createLoopState(), executor);
  loops.push(boardLoop);
  await boardLoop.tickNow();
  check(
    reconciles === 1 && launches === 0 && !boardLoop.isAdmittingNewWork(),
    "revision mismatch permits settlement but blocks a real target-Issue Ready candidate",
  );
  const positive = new BoardLoop(
    { ...deps, revisionCheck: () => ({ ok: true }) },
    createLoopState(),
    executor,
  );
  loops.push(positive);
  await positive.tickNow();
  check(
    launches === 1,
    "positive control proves the same Ready candidate can actually launch",
  );
  let allowed = true;
  const recovery = new BoardLoop(
    { ...deps, revisionCheck: () => ({ ok: allowed }) },
    createLoopState(),
    executor,
    undefined,
    undefined,
    false,
  );
  loops.push(recovery);
  await recovery.tickNow();
  assert.equal(launches, 1);
  recovery.enableAdmissions();
  await recovery.tickNow();
  assert.equal(launches, 2);
  allowed = false;
  recovery.enableAdmissions();
  await recovery.tickNow();
  check(
    launches === 2 && !recovery.isAdmittingNewWork(),
    "recovery requires explicit promotion, which still cannot bypass the revision gate",
  );

  let releaseReconcile!: (summary: ReconcileSummary) => void;
  let heartbeatChecks = 0;
  let reachedHeartbeat!: () => void;
  const heartbeat = new Promise<void>((resolve) => {
    reachedHeartbeat = resolve;
  });
  const heartbeatLoop = new BoardLoop(
    {
      ...deps,
      cfg: { ...cfg, tick_seconds: 1 },
      listCards: async () => [],
      revisionCheck: () => {
        if (++heartbeatChecks >= 2) reachedHeartbeat();
        return { ok: true };
      },
    },
    createLoopState(),
    {
      ...executor,
      reconcile: () =>
        new Promise((resolve) => {
          releaseReconcile = resolve;
        }),
    },
  );
  loops.push(heartbeatLoop);
  const starting = heartbeatLoop.start();
  const deadline = setTimeout(reachedHeartbeat, 10_000);
  try {
    await heartbeat;
    check(
      heartbeatChecks >= 2,
      "long-running ticks continue revision/heartbeat checks at a valid integer polling interval",
    );
  } finally {
    clearTimeout(deadline);
    releaseReconcile(settledSummary);
    await starting;
    await heartbeatLoop.stop();
  }

  // Real lock files: live/foreign/corrupt locks are never silently stolen.
  const lock = acquireOwnerLock(projectRoot, "bot");
  assert.throws(
    () => acquireOwnerLock(projectRoot, "bot"),
    /already running locally/,
  );
  check(
    !ownerLockHeldByOther(projectRoot),
    "same-process heartbeat recognizes its live owner lock",
  );
  lock.release();
  const replacement = acquireOwnerLock(projectRoot, "bot");
  lock.release();
  check(
    existsSync(replacement.path),
    "an old release token cannot remove a replacement owner's lock",
  );
  replacement.release();
  const deadPid = Number(
    execFileSync(process.execPath, ["-e", "console.log(process.pid)"], {
      encoding: "utf8",
    }).trim(),
  );
  const stale = {
    pid: deadPid,
    hostname: hostname(),
    token: "stale-fixture",
    botLogin: "bot",
    startedAt: new Date(0).toISOString(),
  };
  writeFileSync(lock.path, JSON.stringify(stale));
  assert.equal(ownerLockHeldByOther(projectRoot), false);
  const reclaimed = acquireOwnerLock(projectRoot, "bot");
  reclaimed.release();
  check(true, "a confirmed-dead same-host owner is safely reclaimed");
  for (const record of [
    { ...stale, hostname: "other-host" },
    { ...stale, pid: 0 },
    { ...stale, pid: "123" },
    { ...stale, token: null },
    {},
  ]) {
    writeFileSync(lock.path, JSON.stringify(record));
    const bytes = readFileSync(lock.path, "utf8");
    assert.equal(ownerLockHeldByOther(projectRoot), true);
    assert.throws(() => acquireOwnerLock(projectRoot, "bot"));
    assert.equal(readFileSync(lock.path, "utf8"), bytes);
    rmSync(lock.path);
  }
  check(
    true,
    "foreign, corrupt and invalid-PID lock records block takeover and heartbeat overwrite",
  );
  writeFileSync(lock.path, JSON.stringify(stale));
  writeFileSync(`${lock.path}.reclaim`, JSON.stringify(stale));
  assert.throws(
    () => acquireOwnerLock(projectRoot, "bot"),
    /recovery is busy or interrupted/,
  );
  assert.deepEqual(JSON.parse(readFileSync(lock.path, "utf8")), stale);
  rmSync(`${lock.path}.reclaim`);
  check(
    true,
    "an interrupted stale-lock reclaim fails closed with manual recovery guidance",
  );

  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/TOKEN|API_KEY|SECRET|PASSWORD|PI_SESSION/i.test(key),
    ),
  );
  const moduleUrl = new URL("../src/owner-lock.ts", import.meta.url).href;
  const contenders = Array.from({ length: 4 }, () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
import { acquireOwnerLock } from ${JSON.stringify(moduleUrl)};
try {
  const lock = acquireOwnerLock(process.cwd(), "contender");
  console.log("owned");
  process.stdin.once("data", () => { lock.release(); process.exit(0); });
} catch (error) {
  if (!/already running locally|recovery is busy or interrupted/.test(error.message)) { console.error(error); process.exit(2); }
  console.log("rejected");
}
`,
      ],
      { cwd: projectRoot, env: childEnv, stdio: "pipe" },
    );
    children.push(child);
    const exit = new Promise<number | null>((resolve) =>
      child.on("exit", resolve),
    );
    const verdict = new Promise<string>((resolve, reject) => {
      let text = "",
        stderr = "";
      const timeout = setTimeout(
        () => reject(new Error(`lock contender timed out: ${stderr}`)),
        30_000,
      );
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) {
          clearTimeout(timeout);
          resolve(text.trim());
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", () => {
        clearTimeout(timeout);
        if (!text.trim())
          reject(
            new Error(`lock contender exited without a verdict: ${stderr}`),
          );
      });
    });
    return { child, exit, verdict };
  });
  const verdicts = await Promise.all(
    contenders.map((contender) => contender.verdict),
  );
  assert.equal(
    verdicts.filter((value) => value === "owned").length,
    1,
    verdicts.join(", "),
  );
  await Promise.all(
    contenders.map((contender, index) => {
      if (verdicts[index] !== "owned") {
        contender.child.stdin.destroy();
        return;
      }
      return new Promise<void>((resolve, reject) => {
        contender.child.stdin.once("error", reject);
        contender.child.stdin.end("release\n", resolve);
      });
    }),
  );
  assert.ok(
    (await Promise.all(contenders.map((contender) => contender.exit))).every(
      (code) => code === 0,
    ),
  );
  check(
    !existsSync(lock.path),
    "four real processes contending for a stale lock have exactly one simultaneous owner and clean token-safe release",
  );
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const loop of loops) await loop.stop();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
}
