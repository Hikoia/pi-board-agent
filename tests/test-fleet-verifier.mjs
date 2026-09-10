import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const check = (condition, label) =>
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);
const root = process.env.TMP_DIR;
const agentDir = join(root, "agent");
const packageRoot = join(
  agentDir,
  "git",
  "github.com",
  "Hikoia",
  "pi-board-agent",
);
const projects = [join(root, "project-a"), join(root, "project-b")];
const script = resolve("scripts/verify-board-agent-fleet.mjs");
mkdirSync(packageRoot, { recursive: true });
for (const project of projects)
  mkdirSync(join(project, ".pi", "board-agent"), { recursive: true });
const git = (...args) =>
  spawnSync("git", args, { cwd: packageRoot, encoding: "utf8" });
git("init", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
writeFileSync(join(packageRoot, "package.json"), "{}\n");
git("add", ".");
git("commit", "-m", "fixture");
const revision = git("rev-parse", "HEAD").stdout.trim();
const otherRevision = "f".repeat(40);
const globalSettingsPath = join(agentDir, "settings.json");
writeFileSync(
  globalSettingsPath,
  JSON.stringify({
    packages: [`git:github.com/Hikoia/pi-board-agent@${revision}`],
  }),
);

function writeRuntime(project, overrides = {}) {
  writeFileSync(
    join(project, ".pi", "board-agent", "runtime.json"),
    JSON.stringify({
      schemaVersion: 1,
      expectedRevision: revision,
      loadedRevision: revision,
      diskRevision: revision,
      dirty: false,
      pid: 1234,
      sessionId: "fixture",
      state: "running",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ...overrides,
    }),
  );
  writeFileSync(join(project, ".pi", "board-agent.yml"), "tick_seconds: 90\n");
}

function healthy() {
  rmSync(join(packageRoot, "dirty.txt"), { force: true });
  for (const project of projects) {
    rmSync(join(project, ".pi", "settings.json"), { force: true });
    writeRuntime(project);
  }
}

function verify(extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...projects], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
    encoding: "utf8",
  });
}

healthy();
const settingsBefore = readFileSync(globalSettingsPath, "utf8");
const runtimeBefore = readFileSync(
  join(projects[0], ".pi", "board-agent", "runtime.json"),
  "utf8",
);
let result = verify();
check(
  result.status === 0 &&
    result.stdout.split(/\r?\n/).filter((line) => line.startsWith("OK "))
      .length === 2,
  "fleet verifier accepts two healthy projects on one exact SHA",
);
check(
  readFileSync(globalSettingsPath, "utf8") === settingsBefore &&
    readFileSync(
      join(projects[0], ".pi", "board-agent", "runtime.json"),
      "utf8",
    ) === runtimeBefore,
  "fleet verifier is read-only",
);

healthy();
writeRuntime(projects[1], { heartbeatAt: new Date(0).toISOString() });
result = verify();
check(
  result.status === 1 &&
    result.stdout.includes("STALE") &&
    result.stdout.includes(projects[1]),
  "one stale project makes fleet verification fail",
);

healthy();
writeFileSync(
  join(projects[0], ".pi", "settings.json"),
  JSON.stringify({
    packages: [`git:github.com/Hikoia/pi-board-agent@${otherRevision}`],
  }),
);
result = verify();
check(
  result.status === 1 && result.stdout.includes("OVERRIDE"),
  "different project-local package override is reported",
);

healthy();
writeFileSync(join(packageRoot, "dirty.txt"), "dirty\n");
writeRuntime(projects[0], { diskRevision: otherRevision });
result = verify();
check(
  result.status === 1 &&
    result.stdout.includes("DIRTY") &&
    result.stdout.includes("MISMATCH"),
  "dirty package and runtime revision mismatch are reported",
);

healthy();
writeRuntime(projects[0], { state: "stopped" });
result = verify();
check(
  result.status === 1 && result.stdout.includes("STOPPED"),
  "stopped runtime is reported",
);

healthy();
writeRuntime(projects[0], { loadedRevision: otherRevision });
result = verify();
check(
  result.status === 1 && result.stdout.includes("MISMATCH"),
  "single-project SHA drift returns a non-zero exit code",
);

healthy();
for (const settings of [
  null,
  [],
  { packages: [42] },
  {
    packages: [
      {
        source: `git:github.com/Hikoia/pi-board-agent@${revision}`,
        autoload: "false",
      },
    ],
  },
]) {
  writeFileSync(globalSettingsPath, JSON.stringify(settings));
  result = verify();
  check(
    result.status === 1 && result.stdout.includes("MISMATCH"),
    "malformed settings cannot be filtered into a healthy fleet",
  );
}
for (const source of [
  `github.com/Hikoia/pi-board-agent@${revision}`,
  `git@github.com:Hikoia/pi-board-agent@${revision}`,
]) {
  writeFileSync(globalSettingsPath, JSON.stringify({ packages: [source] }));
  check(
    verify().status === 1,
    "undocumented bare Git shorthand cannot establish a fleet pin",
  );
}
writeFileSync(
  globalSettingsPath,
  JSON.stringify({
    packages: [`git://github.com/Hikoia/pi-board-agent@${revision}`],
  }),
);
check(
  verify().status === 0,
  "documented git protocol pin matches runtime validation",
);
writeFileSync(globalSettingsPath, settingsBefore);
const configPath = join(projects[0], ".pi", "board-agent.yml");
for (const tick of [0, -1, 1.5, 2147484, "90", 1e300]) {
  writeFileSync(configPath, JSON.stringify({ tick_seconds: tick }));
  result = verify();
  check(
    result.status === 1 && result.stdout.includes("invalid tick_seconds"),
    "invalid timer cannot disable stale-runtime detection",
  );
}
healthy();
writeRuntime(projects[0], {
  heartbeatAt: new Date(Date.now() - 400000).toISOString(),
});
writeFileSync(configPath, JSON.stringify({ tick_seconds: 200 }));
check(
  verify().status === 0,
  "JSON/YAML configuration uses the real tick interval for heartbeat age",
);
healthy();
const nestedPackage = join(packageRoot, "nested");
mkdirSync(nestedPackage);
result = verify({ PI_BOARD_AGENT_PACKAGE_ROOT: nestedPackage });
check(
  result.status === 1 && result.stdout.includes("MISMATCH"),
  "nested package directory cannot borrow its parent's checkout revision",
);
