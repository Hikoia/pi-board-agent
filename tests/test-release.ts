import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = new URL("..", import.meta.url);
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) process.exitCode = 1;
};
const json = <T>(path: string) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;
const pkg = json<{
  version: string;
  engines: { node: string };
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
  bundledDependencies?: unknown;
}>("package.json");
const lock = json<{
  version: string;
  packages: Record<
    string,
    {
      version?: string;
      engines?: { node?: string };
      devDependencies?: Record<string, string>;
      inBundle?: boolean;
    }
  >;
}>("package-lock.json");

check(
  pkg.version === "0.2.0" &&
    lock.version === "0.2.0" &&
    lock.packages[""].version === "0.2.0",
  "package and lockfile release versions are aligned",
);
check(
  pkg.engines.node === ">=22.19.0" &&
    lock.packages[""].engines?.node === ">=22.19.0",
  "package and lockfile require Node 22.19.0",
);
check(
  pkg.devDependencies["@types/node"] === "22.19.19" &&
    lock.packages[""].devDependencies?.["@types/node"] === "22.19.19" &&
    lock.packages["node_modules/@types/node"].version === "22.19.19",
  "typecheck uses locked Node 22 declarations rather than admitting Node 26-only APIs",
);
check(
  pkg.scripts.typecheck === "tsc --noEmit" &&
    pkg.scripts.test === "bash tests/run-offline.sh" &&
    pkg.scripts.check === "npm run typecheck && npm test",
  "canonical typecheck, test, and check scripts are present",
);
check(
  pkg.bundledDependencies === undefined &&
    Object.values(lock.packages).every((entry) => !entry.inBundle),
  "release metadata contains no bundled dependencies",
);
check(
  pkg.files.includes("config-template.yml") &&
    pkg.files.includes("docs/architecture.md") &&
    pkg.files.includes("docs/runbook.md") &&
    !pkg.files.includes("docs"),
  "tarball allowlist includes required docs/template without unrelated docs",
);

const ci = parseYaml(
  readFileSync(new URL(".github/workflows/check.yml", root), "utf8"),
);
const steps = ci.jobs.check.steps as Array<{
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}>;
check(
  steps.some(
    (step) =>
      step.uses?.startsWith("actions/setup-node@") &&
      step.with?.["node-version"] === "22.19.0",
  ) &&
    steps.some((step) => step.run === "npm ci") &&
    steps.some((step) => step.run === "npm run check"),
  "CI pins exact Node 22.19.0 and runs the canonical install/check commands",
);
check(
  ci.jobs.check.strategy.matrix.os.includes("ubuntu-latest") &&
    ci.jobs.check.strategy.matrix.os.includes("windows-latest") &&
    ci.jobs.check.defaults.run.shell === "bash",
  "CI exercises Linux and Windows Git Bash",
);
check(
  ci.permissions.contents === "read" &&
    steps.some(
      (step) =>
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.["persist-credentials"] === false,
    ),
  "CI uses read-only permissions and does not persist checkout credentials",
);
const tsconfig = json<{ include: string[] }>("tsconfig.json");
check(
  tsconfig.include.includes("src/**/*.ts") &&
    tsconfig.include.includes("tests/test-*.ts"),
  "typecheck includes runtime and every runnable TypeScript regression",
);

check(
  [
    "Dockerfile",
    "docker-compose.yml",
    "entrypoint.sh",
    ".dockerignore",
    "docs/docker.md",
  ].every((path) => !existsSync(new URL(path, root))),
  "Docker and daemon artifacts are absent",
);

const sourceFiles = readdirSync(new URL("src", root)).filter((file) =>
  file.endsWith(".ts"),
);
const childProcessUsers = sourceFiles.filter((file) =>
  readFileSync(new URL(`src/${file}`, root), "utf8").includes(
    "node:child_process",
  ),
);
check(
  childProcessUsers.length === 1 &&
    childProcessUsers[0] === "process-runner.ts",
  "all runtime subprocesses route through the shared process runner",
);
check(
  !existsSync(new URL("src/inflight.ts", root)) &&
    !existsSync(new URL("docs/implementation-plan.md", root)),
  "legacy runtime and superseded implementation plan are removed",
);

// Exercise the real harness in a disposable miniature repo, including its exit
// contract and cleanup. No edits to this checkout or the caller's global state.
const tmp = process.env.TMP_DIR!;
assert.ok(tmp, "Run via bash tests/run-offline.sh with an isolated TMP_DIR");
const fixture = join(tmp, "harness fixture with spaces");
const tests = join(fixture, "tests");
const temporary = join(fixture, "temporary");
const outsideHome = join(fixture, "caller-home");
mkdirSync(tests, { recursive: true });
mkdirSync(temporary, { recursive: true });
mkdirSync(outsideHome, { recursive: true });
const sentinel = join(temporary, "pi-board-agent-test-unrelated");
writeFileSync(sentinel, "not owned by this harness\n");
const settings = join(outsideHome, "settings.json");
writeFileSync(settings, '{"doNotChange":true}\n');
const harness = join(tests, "run-offline.sh");
copyFileSync(new URL("tests/run-offline.sh", root), harness);
const sample = join(tests, "test-fixture.mjs");
const runHarness = () => {
  const result = spawnSync("bash", [harness.replace(/\\/g, "/")], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      TMPDIR: temporary.replace(/\\/g, "/"),
      HOME: outsideHome,
      USERPROFILE: outsideHome,
      PI_CODING_AGENT_DIR: outsideHome,
      PI_SESSION_FILE: "active-session-must-not-leak",
      CUSTOM_LLM_TOKEN: "must-not-leak",
      GH_TOKEN: "must-not-leak",
      NODE_OPTIONS: "--invalid-preload-must-not-leak",
    },
  });
  assert.ifError(result.error);
  assert.equal(readFileSync(settings, "utf8"), '{"doNotChange":true}\n');
  assert.deepEqual(
    readdirSync(temporary),
    ["pi-board-agent-test-unrelated"],
    "cleanup must remove only this invocation's temp directories",
  );
  assert.equal(readFileSync(sentinel, "utf8"), "not owned by this harness\n");
  return result;
};
writeFileSync(
  sample,
  `
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
const root = process.env.TMP_DIR;
assert.ok(root);
for (const key of ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'GH_CONFIG_DIR', 'npm_config_cache'])
  assert.ok(process.env[key] && resolve(process.env[key]).startsWith(resolve(root) + sep), key + ' escaped test state');
assert.equal(resolve(homedir()), resolve(process.env.HOME));
for (const key of ['CUSTOM_LLM_TOKEN', 'GH_TOKEN', 'PI_SESSION_FILE', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined);
mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true });
writeFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), '{}');
console.log('PASS: isolated discovered fixture');
`,
);
let result = runHarness();
if (result.status !== 0) console.error(result.stdout, result.stderr);
check(
  result.status === 0 && result.stdout.includes("isolated discovered fixture"),
  "harness discovers mjs checks and isolates both platform homes, Pi paths, configs, and arbitrary credentials",
);
writeFileSync(
  sample,
  "console.log('PASS: before failure'); console.log('FAIL: deliberate failure');\n",
);
result = runHarness();
check(
  result.status === 1 && result.stdout.includes("1 FAILED, 1 passed"),
  "harness fails on a FAIL line even when Node exits zero",
);
writeFileSync(
  sample,
  "console.log('PASS: before crash'); throw new Error('deliberate crash');\n",
);
result = runHarness();
check(
  result.status === 1 &&
    result.stdout.includes("deliberate crash") &&
    result.stdout.includes("exited 1"),
  "harness preserves crash diagnostics and fails even after PASS output",
);
writeFileSync(sample, "// Intentionally empty: no regression was executed.\n");
result = runHarness();
check(
  result.status === 1 && result.stdout.includes("produced no PASS/FAIL checks"),
  "harness rejects a silently empty test file",
);
console.log(
  "PASS: every harness probe cleaned only its own temp dirs and preserved caller settings and unrelated files",
);
assert.equal(process.exitCode ?? 0, 0, "release regressions failed");
