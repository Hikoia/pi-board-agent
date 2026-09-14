import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { _DEFAULTS } from "../src/config.js";
import * as gh from "../src/gh.js";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertSupportedState,
  findUnsupportedState,
} from "../src/unsupported-state.js";

const previousCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "board-agent-startup-"));
const project = join(root, "project");
const home = join(root, "home");
const agent = join(home, "agent");
for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_|PI_SESSION)|TOKEN|API_KEY|SECRET|PASSWORD/i.test(key))
    delete process.env[key];
}
process.env.HOME = process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.GIT_CONFIG_GLOBAL = join(root, "empty-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const check = (ok: boolean, label: string) => {
  assert.ok(ok, label);
  console.log(`PASS: ${label}`);
};
const state = join(project, ".pi", "board-agent");
const records = join(state, "ticket-worktrees");
const legacy = join(state, "inflight", "legacy.json");
const currentRecord = {
  schemaVersion: 3,
  itemId: "PVTI_3",
  issueNumber: 3,
  taskKey: "T003",
  plan: "release",
  taskBranch: "task/issue-3",
  baseBranch: "main",
  path: join(project, ".pi", "worktrees", "pvti_3"),
  createdAt: 1,
};
const putLegacy = () => {
  mkdirSync(join(state, "inflight"), { recursive: true });
  writeFileSync(legacy, "{}");
};
// Byte/mtime inventory detects writes, renames, migration, deletion AND new paths.
const inventory = (dir: string): unknown =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((name) => {
          const path = join(dir, name);
          const stat = lstatSync(path);
          return [
            name,
            stat.mtimeMs,
            stat.isDirectory() ? inventory(path) : readFileSync(path, "utf8"),
          ];
        })
    : undefined;
let hooks: ReturnType<typeof registerHooks> | undefined;
const globals = globalThis as any;

try {
  mkdirSync(records, { recursive: true });
  mkdirSync(agent, { recursive: true });
  git(project, "init", "-b", "main");
  git(
    project,
    "remote",
    "add",
    "origin",
    "https://github.com/repo-org/target-repo.git",
  );
  putLegacy();
  for (const [name, value] of [
    ["v1", { schemaVersion: 1 }],
    ["v2", { schemaVersion: 2 }],
    ["corrupt", "{bad"],
  ] as const) {
    writeFileSync(
      join(records, `${name}.json`),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  const before = inventory(state);
  assert.deepEqual(findUnsupportedState(project), [
    ".pi/board-agent/inflight/legacy.json",
    ".pi/board-agent/ticket-worktrees/corrupt.json",
    ".pi/board-agent/ticket-worktrees/v1.json",
    ".pi/board-agent/ticket-worktrees/v2.json",
  ]);
  assert.throws(
    () => assertSupportedState(project),
    /No files were moved or deleted/,
  );
  assert.deepEqual(inventory(state), before);
  const nested = join(project, "nested");
  mkdirSync(nested);
  assert.deepEqual(findUnsupportedState(nested), findUnsupportedState(project));
  check(
    true,
    "unsupported v1/v2/inflight/malformed records are reported read-only, including from a repo subdirectory",
  );
  rmSync(records, { recursive: true });
  rmSync(join(state, "inflight"), { recursive: true });
  mkdirSync(records);
  writeFileSync(join(records, "pvti_3.json"), JSON.stringify(currentRecord));
  check(
    findUnsupportedState(project).length === 0,
    "a current v3 record with only current fields passes detection",
  );
  const finalization = {
    targetBranch: "main",
    baseSha: "a".repeat(40),
    taskSha: "b".repeat(40),
  };
  for (const invalid of [
    { ...currentRecord, reviewPending: true },
    { ...currentRecord, issueNumber: Number.MAX_SAFE_INTEGER + 1 },
    { ...currentRecord, createdAt: -1 },
    { ...currentRecord, createdAt: 0.5 },
    { ...currentRecord, activeRunId: "", activeRunStartedAt: 1 },
    { ...currentRecord, activeRunId: "run" },
    { ...currentRecord, launchingAt: -1 },
    {
      ...currentRecord,
      activeRunId: "run",
      activeRunStartedAt: 1,
      finalization,
    },
    { ...currentRecord, launchingAt: 1, finalization },
    { ...currentRecord, finalization: { ...finalization, legacy: true } },
  ]) {
    writeFileSync(join(records, "pvti_3.json"), JSON.stringify(invalid));
    const untouched = inventory(state);
    assert.deepEqual(findUnsupportedState(project), [
      ".pi/board-agent/ticket-worktrees/pvti_3.json",
    ]);
    assert.throws(
      () => assertSupportedState(project),
      /No files were moved or deleted/,
    );
    assert.deepEqual(inventory(state), untouched);
  }
  check(
    true,
    "strict v3 rejects obsolete fields, unsafe identities/timestamps and mixed execution/finalization read-only",
  );
  rmSync(records, { recursive: true });
  const outside = join(root, "outside-state");
  mkdirSync(outside);
  writeFileSync(join(outside, "pvti_3.json"), JSON.stringify(currentRecord));
  symlinkSync(
    outside,
    records,
    process.platform === "win32" ? "junction" : "dir",
  );
  const outsideBefore = inventory(outside);
  assert.deepEqual(findUnsupportedState(project), [
    ".pi/board-agent/ticket-worktrees",
  ]);
  assert.throws(
    () => assertSupportedState(project),
    /Symlinked or unreadable state paths/,
  );
  assert.deepEqual(inventory(outside), outsideBefore);
  rmSync(records);
  const invalidDirectory = join(root, "invalid-directory");
  mkdirSync(invalidDirectory);
  git(invalidDirectory, "init", "-b", "main");
  writeFileSync(join(invalidDirectory, ".pi"), "not a directory");
  assert.deepEqual(findUnsupportedState(invalidDirectory), [".pi"]);
  putLegacy();
  writeFileSync(
    join(state, "inflight", "interrupted.tmp"),
    "unfinished legacy state",
  );
  assert.ok(
    findUnsupportedState(project).includes(
      ".pi/board-agent/inflight/interrupted.tmp",
    ),
  );
  rmSync(join(state, "inflight"), { recursive: true });
  check(
    true,
    "unsafe state directories and all legacy inflight artifacts fail closed without following or changing external paths",
  );

  // Load the REAL entry point from an immutable disposable package checkout.
  // Only Pi registration, board I/O and loop/executor lifetimes are adapters;
  // config, state scanning, revision gating and owner locks are the real modules.
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "src"), { recursive: true });
  for (const name of [
    "index.ts",
    "config.ts",
    "runtime.ts",
    "owner-lock.ts",
    "unsupported-state.ts",
    "ticket-worktree.ts",
    "cleanup-snapshot.ts",
    "repair.ts",
    "dispatch.ts",
    "process-runner.ts",
  ]) {
    cpSync(new URL(`../src/${name}`, import.meta.url), join(pkg, "src", name));
  }
  cpSync(
    new URL("../config-template.yml", import.meta.url),
    join(pkg, "config-template.yml"),
  );
  writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
  writeFileSync(join(pkg, ".gitignore"), "node_modules/\n");
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(pkg, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  git(pkg, "init", "-b", "main");
  git(pkg, "add", ".");
  git(
    pkg,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "disposable package fixture",
  );
  const sha = git(pkg, "rev-parse", "HEAD");
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      packages: [`git:github.com/Hikoia/pi-board-agent@${sha}`],
    }),
  );
  const configFile = join(project, ".pi", "board-agent.yml");
  const configText =
    "project:\n  owner: project-user\n  number: 17\nauto_start: false\n";
  writeFileSync(configFile, configText);

  const ghCalls: unknown[][] = [];
  const validMetadata: gh.ProjectMetadata = {
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
  let metadata = structuredClone(validMetadata);
  let executors = 0;
  const loops: any[] = [];
  let stopWait = Promise.resolve();
  let failStart = false;
  let metadataWait = Promise.resolve();
  class FakeLoop {
    running = false;
    promotions = 0;
    ticks = 0;
    stops = 0;
    constructor(
      public deps: any,
      public state: any,
      _executor: unknown,
      _worktrees: unknown,
      public lock: any,
      public admissions: boolean,
    ) {
      loops.push(this);
    }
    async start() {
      this.running = this.state.running = true;
      if (failStart) throw new Error("start fixture failure");
    }
    isRunning() {
      return this.running;
    }
    isStopping() {
      return this.stops > 0 && this.running;
    }
    isStopped() {
      return this.stops > 0 && !this.running;
    }
    isAdmittingNewWork() {
      return this.admissions;
    }
    enableAdmissions() {
      this.promotions++;
      this.admissions = true;
    }
    async tickNow() {
      this.ticks++;
    }
    async stop() {
      this.stops++;
      await stopWait;
      this.running = this.state.running = false;
      this.lock.release();
    }
  }
  globals.__boardStartupTest = {
    BoardLoop: FakeLoop,
    createLoopState: () => ({
      running: false,
      tickCount: 0,
      wavesLaunched: 0,
      reviewingTask: null,
      foreground: null,
    }),
    whoami: async () => {
      ghCalls.push(["whoami"]);
      return "bot";
    },
    getProjectMetadata: async (...args: unknown[]) => {
      ghCalls.push(["metadata", ...args]);
      await metadataWait;
      return structuredClone(metadata);
    },
    validateStatusOptions: gh.validateStatusOptions,
    validateProjectMetadata: gh.validateProjectMetadata,
    createProductionTicketExecutor: () => {
      executors++;
      return {};
    },
    inspectTicketExecutions: () => ({ active: [], orphans: 0, needsHuman: 0 }),
  };
  const data = (names: string[]) =>
    `data:text/javascript,${encodeURIComponent(names.map((name) => `export const ${name} = globalThis.__boardStartupTest.${name};`).join("\n"))}`;
  const stubs: Record<string, string> = {
    "@earendil-works/pi-coding-agent":
      'data:text/javascript,export const CONFIG_DIR_NAME = ".pi";',
    "./loop.js": data(["BoardLoop", "createLoopState"]),
    "./gh.js": data([
      "whoami",
      "getProjectMetadata",
      "validateStatusOptions",
      "validateProjectMetadata",
    ]),
    "./ticket-executor.js": data([
      "createProductionTicketExecutor",
      "inspectTicketExecutions",
    ]),
  };
  const entry = pathToFileURL(join(pkg, "src", "index.ts")).href;
  hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry && stubs[specifier])
        return { url: stubs[specifier], shortCircuit: true };
      return next(specifier, context);
    },
  });
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const messages: string[] = [];
  const ctx = {
    cwd: project,
    hasUI: false,
    ui: { notify: (message: string) => messages.push(message) },
    sessionManager: { getSessionId: () => "test-session" },
  };
  process.chdir(project);
  const extension = await import(entry);
  extension.default({
    on: (name: string, handler: Function) => events.set(name, handler),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
  });
  const command = (name: string, context = ctx) =>
    commands.get("board-agent").handler(name, context);
  const event = (name: string) => events.get(name)!({}, ctx);

  putLegacy();
  writeFileSync(
    join(state, "runtime.json"),
    '{"sentinel":"must not change"}\n',
  );
  for (const action of ["lint", "init-project"]) {
    const unchanged = inventory(state);
    const messageStart = messages.length;
    if (action === "session_start") await event(action);
    else await command(action);
    assert.ok(
      messages
        .slice(messageStart)
        .some(
          (message) =>
            message.includes("Unsupported pre-0.2.0") &&
            message.includes("inflight/legacy.json"),
        ),
      `${action} must report the offending state`,
    );
    assert.deepEqual(
      inventory(state),
      unchanged,
      `${action} must not write runtime, acquire locks or migrate state`,
    );
    assert.equal(ghCalls.length, 0, `${action} must fail before GitHub I/O`);
    assert.equal(loops.length, 0);
    check(
      true,
      `${action} rejects unsupported state with byte/mtime-identical state and zero GitHub calls`,
    );
  }
  const retiredBefore = inventory(join(state, "inflight"));
  await event("session_start"); // retired state alone does not restart a lane
  assert.equal(loops.length, 0);
  assert.equal(ghCalls.length, 0);
  await command("run");
  assert.equal(loops.length, 1);
  assert.ok(existsSync(loops[0].lock.path));
  assert.deepEqual(inventory(join(state, "inflight")), retiredBefore);
  await command("stop");
  loops.length = 0; executors = 0; ghCalls.length = 0;
  check(true, "startup isolates retired evidence instead of blocking healthy tickets; explicit run acquires its owner and leaves legacy bytes unchanged");
  rmSync(join(state, "inflight"), { recursive: true });
  for (const [label, patch, error] of [
    ["missing Plan", { planFieldId: undefined }, /Plan.*TEXT.*SINGLE_SELECT/],
    ["wrong Plan", { planFieldType: "NUMBER" }, /Plan.*TEXT.*SINGLE_SELECT/],
    [
      "unknown Plan type",
      { planFieldType: undefined },
      /Plan.*TEXT.*SINGLE_SELECT/,
    ],
    [
      "missing Plan options",
      { planFieldType: "SINGLE_SELECT", planOptions: undefined },
      /Plan.*option/,
    ],
    ["missing Type", { typeFieldId: undefined }, /Type.*SINGLE_SELECT/],
    ["wrong Type", { typeFieldType: "TEXT" }, /Type.*SINGLE_SELECT/],
    ["missing Task", { typeOptions: { Story: "STORY" } }, /Type.*Task/],
    ["missing Story", { typeOptions: { Task: "TASK" } }, /Type.*Story/],
    ["missing Status", { statusFieldId: "" }, /Status.*SINGLE_SELECT/],
    ["wrong Status", { statusFieldType: "TEXT" }, /Status.*SINGLE_SELECT/],
    [
      "missing Status option",
      { statusOptions: { Ready: "R" } },
      /Status option/,
    ],
  ] as Array<[string, Partial<gh.ProjectMetadata>, RegExp]>) {
    metadata = { ...validMetadata, ...patch };
    for (const action of ["lint", "run", "session_start"]) {
      writeFileSync(
        configFile,
        configText.replace(
          "auto_start: false",
          `auto_start: ${action === "session_start"}`,
        ),
      );
      const start = messages.length;
      const callsBefore = ghCalls.length;
      if (action === "session_start") await event(action);
      else await command(action);
      assert.ok(
        messages.slice(start).some((message) => error.test(message)),
        `${action}/${label}: ${messages.slice(start).join("\n")}`,
      );
      assert.equal(loops.length, 0, `${action}/${label}: no loop`);
      assert.equal(executors, 0, `${action}/${label}: no executor/models`);
      assert.equal(existsSync(join(state, "owner.lock")), false);
      assert.ok(
        ghCalls
          .slice(callsBefore)
          .every((call) => ["whoami", "metadata"].includes(String(call[0]))),
        "preflight is read-only; no schema repair",
      );
    }
  }
  console.log(
    "PASS: lint, explicit run, and auto-start fail closed on missing/wrong fields or required options, before owner/executor/model creation and without schema repair",
  );
  metadata = structuredClone(validMetadata);
  writeFileSync(configFile, configText);
  mkdirSync(records, { recursive: true });
  writeFileSync(
    join(records, "pvti_3.json"),
    JSON.stringify({
      ...currentRecord,
      activeRunId: "run-3",
      activeRunStartedAt: 1,
    }),
  );
  await event("session_start");
  assert.equal(loops.length, 1, messages.join("\n"));
  const recovery = loops[0];
  assert.equal(recovery.admissions, false);
  assert.equal(recovery.deps.repoOwner, "repo-org");
  assert.equal(recovery.deps.repoName, "target-repo");
  assert.ok(
    ghCalls.some(
      (call) =>
        call[0] === "metadata" && call[1] === "project-user" && call[2] === 17,
    ),
  );
  check(
    true,
    "startup resumes durable records in recovery-only mode with separate Project/origin identities",
  );

  putLegacy();
  const unchanged = inventory(state);
  const callCount = ghCalls.length;
  await command("run");
  assert.equal(recovery.promotions, 1);
  assert.equal(recovery.ticks, 1);
  assert.ok(ghCalls.length > callCount);
  assert.deepEqual(inventory(state), unchanged);
  check(true, "cached promotion leaves newly introduced retired state read-only instead of replaying it");
  recovery.admissions = false; recovery.promotions = 0; recovery.ticks = 0;
  rmSync(join(state, "inflight"), { recursive: true });
  writeFileSync(configFile, configText + "pr: null\n");
  await command("run");
  assert.equal(
    recovery.promotions,
    0,
    "cached promotion must still reject removed configuration",
  );
  writeFileSync(configFile, configText);
  metadata = { ...validMetadata, planFieldId: undefined };
  const promotionStart = messages.length;
  await command("run");
  assert.equal(
    recovery.promotions,
    0,
    "cached promotion cannot bypass metadata validation",
  );
  assert.equal(recovery.ticks, 0);
  assert.ok(
    messages.slice(promotionStart).some((message) => /Plan/.test(message)),
  );
  assert.ok(
    existsSync(recovery.lock.path),
    "failed admission preserves active recovery ownership",
  );
  console.log(
    "PASS: cached recovery promotion checks current metadata before admitting work and retains recovery on failure",
  );
  metadata = structuredClone(validMetadata);
  await command("run");
  check(
    recovery.promotions === 1 && recovery.ticks >= 1,
    "an explicit run promotes recovery only after all current preflights pass",
  );

  let finishStop!: () => void;
  stopWait = new Promise((resolve) => {
    finishStop = resolve;
  });
  let stopped = false;
  const stopping = command("stop").then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.ok(existsSync(recovery.lock.path));
  finishStop();
  await stopping;
  assert.equal(existsSync(recovery.lock.path), false);
  assert.equal(
    JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")).state,
    "stopped",
  );
  await event("session_shutdown");
  check(
    recovery.stops === 1,
    "stop awaits settlement before lock release; subsequent shutdown is idempotent",
  );

  stopWait = Promise.resolve();
  await event("session_start");
  const resumed = loops.at(-1);
  await event("session_shutdown");
  check(
    resumed.stops === 1 && !existsSync(resumed.lock.path),
    "Pi session shutdown actually stops the recovered loop and releases ownership",
  );

  failStart = true;
  await command("run");
  const failedStart = loops.at(-1);
  check(
    failedStart.stops === 1 &&
      !failedStart.running &&
      !existsSync(failedStart.lock.path),
    "failed startup stops its partially started loop before releasing ownership",
  );

  failStart = false;
  for (const stopAction of ["stop", "session_shutdown"]) {
    let finishMetadata!: () => void;
    metadataWait = new Promise((resolve) => {
      finishMetadata = resolve;
    });
    const loopCount = loops.length;
    const pendingStart = command("run");
    await new Promise((resolve) => setImmediate(resolve));
    if (stopAction === "stop") await command("stop");
    else await event(stopAction);
    finishMetadata();
    await pendingStart;
    check(
      loops.length === loopCount && !existsSync(join(state, "owner.lock")),
      `${stopAction} cancels startup still awaiting metadata instead of allowing a later unattended loop`,
    );
  }

  metadataWait = Promise.resolve();
  for (const refine of [true, false]) {
    for (const planFieldType of ["TEXT", "SINGLE_SELECT"]) {
      metadata = {
        ...validMetadata,
        planFieldType,
        planOptions:
          planFieldType === "SINGLE_SELECT"
            ? { Release: "RELEASE_ID" }
            : undefined,
        typeOptions: refine
          ? { Task: "TASK", Story: "STORY" }
          : { task: "TASK" },
        statusOptions: Object.fromEntries(
          Object.entries(validMetadata.statusOptions).filter(
            ([name]) => refine || !["Backlog", "Needs Design"].includes(name),
          ),
        ),
      };
      writeFileSync(
        configFile,
        `${configText}refine:\n  enabled: ${refine}\nreview:\n  enabled: true\nwatchdog:\n  enabled: false\n`,
      );
      const start = messages.length;
      await command("lint");
      assert.ok(
        messages.slice(start).includes("All checks passed."),
        messages.slice(start).join("\n"),
      );
      const count: number = loops.length;
      await command("run");
      assert.equal(loops.length, count + 1);
      await command("stop");
      console.log(
        `PASS: lint/run accept ${planFieldType} Plan with refine=${refine}; disabled design does not require Story/Needs Design/Backlog`,
      );
    }
  }
  metadata = structuredClone(validMetadata);
  writeFileSync(configFile, configText);

  const unconfigured = join(root, "unconfigured");
  mkdirSync(unconfigured);
  rmSync(join(pkg, "config-template.yml"));
  await assert.rejects(
    () => command("init", { ...ctx, cwd: unconfigured }),
    /Packaged config template is missing/,
  );
  check(
    !existsSync(join(unconfigured, ".pi")),
    "init fails before creating local config directories when its packaged template is missing",
  );
} finally {
  process.chdir(previousCwd);
  hooks?.deregister();
  delete globals.__boardStartupTest;
  rmSync(root, { recursive: true, force: true });
}
