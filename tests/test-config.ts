import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ConfigError,
  _DEFAULTS,
  type Config,
  loadConfig,
  readConfigTemplate,
  resolveOwner,
  taskBranch,
  validateConfig,
} from "../src/config.js";

const root = mkdtempSync(join(tmpdir(), "board-agent-config-"));
const home = join(root, "home");
const cwd = join(root, "project");
for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_|PI_SESSION)|TOKEN|API_KEY|SECRET|PASSWORD/i.test(key))
    delete process.env[key];
}
process.env.HOME = process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
process.env.GIT_CONFIG_GLOBAL = join(root, "empty-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
const check = (ok: boolean, label: string) => {
  assert.ok(ok, label);
  console.log(`PASS: ${label}`);
};
const validConfig = (): Config => ({
  ...structuredClone(_DEFAULTS),
  project: { owner: "", number: 1 },
});
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore" });

try {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi"), { recursive: true });
  const file = join(cwd, ".pi", "board-agent.yml");
  const globalFile = join(home, ".pi", "board-agent.yml");
  const cfg = loadConfig(cwd);
  check(
    cfg.max_workers === 2 &&
      !("watchdog" in cfg) && !("refine" in cfg) && !("enabled" in cfg.review) &&
      !("pr" in cfg) &&
      !("builder_tier" in cfg) &&
      !("plan_prefix" in cfg.branches) &&
      cfg.task_merge_strategy === "merge",
    "defaults omit retired lanes, always review, and merge new work",
  );

  const template = readConfigTemplate();
  const parsedTemplate = parseYaml(template);
  assert.equal(Object.hasOwn(parsedTemplate.safety, "skip_closed_issues"), false, "recommended template omits the deprecated no-op key");
  writeFileSync(file, template.replace("number: 0", "number: 1"));
  const templateWarnings: string[] = [];
  validateConfig(loadConfig(cwd, (message) => templateWarnings.push(message)));
  assert.deepEqual(templateWarnings, []);
  rmSync(file);
  check(
    !/\bpr:|builder_tier|plan_prefix|interval_seconds/.test(template) &&
      !parsedTemplate.watchdog && !parsedTemplate.refine && !parsedTemplate.columns.needs_design && !("enabled" in parsedTemplate.review),
    "the actual packaged YAML validates as 0.2.0 config",
  );

  for (const [name, yaml] of [
    ["pr", "pr: null\n"],
    ["builder_tier", "builder_tier: medium\n"],
    ["branches.plan_prefix", "branches:\n  plan_prefix: null\n"],
    ["watchdog.interval_seconds", "watchdog:\n  interval_seconds: 30\n"],
  ]) {
    for (const target of [file, globalFile]) {
      writeFileSync(target, yaml);
      assert.throws(
        () => loadConfig(cwd),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes(name) &&
          error.message.includes(target) &&
          error.message.includes("removed in 0.2.0") &&
          error.message.includes("Migration:"),
      );
      rmSync(target);
    }
    check(
      true,
      `${name}, including null values, fails explicitly in both config scopes`,
    );
  }

  const legacyYaml = `project:
  number: 1
models:
  builder: configured-builder
  review: configured-review
  refine: retired-refine
  watch: retired-watch
refine:
  enabled: true
  timeout_ms: 1234
  max_tasks: 3
watchdog:
  enabled: true
  fix_rounds_max: 2
  fix_cooldown_minutes: 4
  respond_to_mentions: true
  pr_label: old-pr
  needs_human_label: old-human
columns:
  needs_design: Old Questions
review:
  enabled: false
  timeout_ms: 4321
task_merge_strategy: squash
max_workers: 4
builder_timeout_ms: 1000
builder_retries: 2
context:
  enabled: true
  max_chars: 1234
  exclude: [vendor]
telegram:
  enabled: false
  on: [needs_human, ci_fixed]
`;
  for (const target of [globalFile, file]) {
    writeFileSync(target, legacyYaml);
    const warnings: string[] = [];
    const normalized = loadConfig(cwd, message => warnings.push(message));
    validateConfig(normalized);
    assert.equal(readFileSync(target, "utf8"), legacyYaml, "compatibility never rewrites the user file");
    for (const key of ["models.refine", "models.watch", "refine", "watchdog", "columns.needs_design", "review.enabled", "task_merge_strategy=squash"])
      assert.ok(warnings.some(message => message.includes(target) && message.includes(key) && message.includes("retired")), key);
    assert.equal(warnings.length, 7);
    assert.deepEqual(normalized.models, { builder: "configured-builder", review: "configured-review" });
    assert.deepEqual(normalized.review, { timeout_ms: 4321 });
    assert.equal(normalized.task_merge_strategy, "merge");
    assert.equal(normalized.columns.needs_design, "Old Questions");
    assert.ok(!("refine" in normalized) && !("watchdog" in normalized));
    assert.equal(normalized.max_workers, 4); assert.equal(normalized.builder_timeout_ms, 1000); assert.equal(normalized.builder_retries, 2);
    assert.deepEqual(normalized.context, { enabled: true, max_chars: 1234, exclude: ["vendor"] });
    assert.deepEqual(normalized.telegram.on, ["needs_human", "ci_fixed"], "notification subscriptions are not rewritten");
    rmSync(target);
  }
  check(true, "both config scopes warn for each retired surface while preserving configured live controls and exact file bytes");
  writeFileSync(globalFile, `review:
  enabled: false
models:
  builder: global-builder
  review: global-review
`);
  writeFileSync(file, `project:
  number: 1
review:
  enabled: true
models:
  builder: project-builder
`);
  const warnings: string[] = [];
  const layered = loadConfig(cwd, m => warnings.push(m)); validateConfig(layered);
  assert.deepEqual(layered.models, { builder: "project-builder", review: "global-review" });
  assert.ok(warnings.some(m => m.includes(globalFile)) && warnings.some(m => m.includes(file)));
  assert.ok(!("enabled" in layered.review));
  rmSync(file); rmSync(globalFile);
  check(true, "review.enabled true and false are ignored per-file before layering without changing model precedence");
  for (const yaml of [
    "refine: false", "refine: null", "refine: {enabled: 'true'}", "refine: {timeout_ms: '1'}", "refine: {max_tasks: 13}",
    "watchdog: []", "watchdog: {enabled: 1}", "watchdog: {fix_rounds_max: -1}", "watchdog: {fix_cooldown_minutes: '1'}",
    "watchdog: {respond_to_mentions: 'false'}", "watchdog: {pr_label: false}", "watchdog: {needs_human_label: ''}",
    "models: {refine: 42}", "models: {watch: ''}", "columns: {needs_design: false}", "review: {enabled: 'false'}",
    "task_merge_strategy: false", "refine: {unknown: 1}", "watchdog: {typo: true}", "models: {design: x}", "columns: {story: x}",
  ]) {
    for (const target of [globalFile, file]) {
      writeFileSync(target, yaml);
      assert.throws(() => loadConfig(cwd), (error: unknown) => error instanceof ConfigError && error.message.includes(target), yaml);
      assert.equal(readFileSync(target, "utf8"), yaml);
      rmSync(target);
    }
  }
  check(true, "retired input types/bounds and unrelated nested unknown keys still fail closed in either scope");

  writeFileSync(
    globalFile,
    "max_workers: 3\ncolumns:\n  ready: Global Ready\n",
  );
  writeFileSync(file, "max_workers: 4\ncolumns:\n  done: Project Done\n");
  const merged = loadConfig(cwd);
  check(
    merged.max_workers === 4 &&
      merged.columns.ready === "Global Ready" &&
      merged.columns.done === "Project Done",
    "project overrides global without losing nested defaults",
  );
  rmSync(globalFile);
  rmSync(file);
  const firstLoad = loadConfig(cwd);
  firstLoad.columns.ready = "mutated";
  firstLoad.telegram.on.push("mutated");
  check(
    loadConfig(cwd).columns.ready === "Ready" &&
      !loadConfig(cwd).telegram.on.includes("mutated"),
    "config loads cannot mutate defaults or each other",
  );

  for (const yaml of [
    "[]",
    "true",
    "branches: []",
    "project: false",
    "columns: null",
    "max_workers: null",
    "max_workers: '2'",
    "auto_start: 'false'",
    "safety:\n  require_clean_worktree: 'false'",
    "models: []",
    "context:\n  exclude: [42]",
    "telegram:\n  on: ci_fixed",
    "builder_tier_typo: medium",
    "branches:\n  unknown: main",
    "__proto__:\n  polluted: true",
    "max_workers: 2\nmax_workers: 3",
    "project: [",
  ]) {
    writeFileSync(file, yaml);
    assert.throws(() => loadConfig(cwd), ConfigError, yaml);
  }
  rmSync(file);
  check(
    true,
    "malformed YAML, nulls, wrong types, unknown keys and duplicate keys fail as ConfigError",
  );

  const integerCases: Array<[string, number, number]> = [
    ["project.number", 1, 2_147_483_647],
    ["max_workers", 1, 16],
    ["tick_seconds", 1, Math.floor(2_147_483_647 / 1000)],
    ["builder_timeout_ms", 1, 2_147_483_647],
    ["builder_retries", 0, 10],
    ["review.timeout_ms", 1, 2_147_483_647],
    ["context.max_chars", 1, 2_147_483_647],
  ];
  const set = (cfg: Config, path: string, value: unknown) => {
    const parts = path.split(".");
    const key = parts.pop()!;
    let obj: any = cfg;
    for (const part of parts) obj = obj[part];
    obj[key] = value;
  };
  for (const [name, min, max] of integerCases) {
    for (const value of [
      min - 1,
      max + 1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      null,
    ]) {
      const cfg = validConfig();
      set(cfg, name, value);
      assert.throws(
        () => validateConfig(cfg),
        (error: unknown) =>
          error instanceof ConfigError && error.message.includes(name),
        `${name}=${value}`,
      );
    }
    for (const value of [min, max]) {
      const cfg = validConfig();
      set(cfg, name, value);
      validateConfig(cfg);
    }
    check(
      true,
      `${name} rejects invalid/overflow values and accepts both exact boundaries`,
    );
  }
  for (const [name, value] of [
    ["project", null],
    ["project.owner", " "],
    ["columns.review", "Done"],
    ["columns.review", " Done "],
    ["status_field", ""],
    ["models.builder", " "],
    ["models.review", 42],
    ["task_merge_strategy", "rebase"],
    ["branches.base", ""],
    ["branches.task_prefix", "\n"],
    ["telegram.bot_token_env", "BAD-NAME"],
  ] as Array<[string, unknown]>) {
    const cfg = validConfig();
    set(cfg, name, value);
    assert.throws(() => validateConfig(cfg), ConfigError, name);
  }
  validateConfig(validConfig());
  check(
    true,
    "required strings, distinct statuses, booleans and environment names fail closed",
  );
  for (const number of [0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => taskBranch("task/", number));
  }
  check(
    taskBranch("task/", 42) === "task/issue-42",
    "task branch identity requires a positive safe integer issue number",
  );

  git("init", "-b", "main");
  git("remote", "add", "origin", "https://github.com/repo-org/target-repo.git");
  for (const url of [
    "https://github.com/repo-org/target-repo.git",
    "git@github.com:repo-org/target-repo.git",
    "ssh://git@github.com/repo-org/target-repo",
  ]) {
    git("remote", "set-url", "origin", url);
    assert.deepEqual(
      resolveOwner(
        { ...validConfig(), project: { owner: "project-user", number: 1 } },
        cwd,
      ),
      {
        projectOwner: "project-user",
        repoOwner: "repo-org",
        repoName: "target-repo",
      },
    );
    check(
      resolveOwner(validConfig(), cwd).projectOwner === "repo-org",
      `independent Project/origin identities for ${url.split(":")[0]}`,
    );
  }
  for (const url of [
    "https://evilgithub.com/repo-org/target-repo",
    "https://example.test/github.com/repo-org/target-repo",
    "https://github.com.evil.test/repo-org/target-repo",
    "https://github.com/repo-org/target-repo?x=1",
    "https://github.com/repo-org/target-repo/extra",
    "https://token-secret@evilgithub.com/repo-org/target-repo",
  ]) {
    git("remote", "set-url", "origin", url);
    assert.throws(
      () => resolveOwner(validConfig(), cwd),
      (error: unknown) =>
        error instanceof ConfigError && !error.message.includes("token-secret"),
      url,
    );
  }
  check(
    true,
    "origin parsing rejects lookalike hosts, extra paths and queries without exposing credentials",
  );

  // Execute the actual shell setup with a shell-function gh fixture. No credentials
  // or installed gh command are reachable through this stub.
  git("remote", "set-url", "origin", "git@github.com:repo-org/target-repo.git");
  const bashEnv = join(root, "stub-gh.sh");
  const ghLog = join(root, "gh-calls.log");
  writeFileSync(
    bashEnv,
    `gh() {
  printf '%s\\n' "$*" >> "$GH_TEST_LOG"
  case "$1 $2" in
    'auth status') printf 'authenticated; scopes: project\\n' ;;
    'project field-list') printf '{"fields":[{"name":"Status","options":[{"name":"Ready"}]}]}\\n' ;;
    *) printf 'Unexpected gh invocation\\n' >&2; return 91 ;;
  esac
}\n`,
  );
  const shellEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/TOKEN|API_KEY|SECRET|PASSWORD|PI_SESSION/i.test(key),
    ),
  );
  Object.assign(shellEnv, {
    BASH_ENV: bashEnv.replaceAll("\\", "/"),
    GH_TEST_LOG: ghLog.replaceAll("\\", "/"),
    GH_CONFIG_DIR: join(root, "gh-config"),
    PROJECT_OWNER: "project-user",
    PROJECT_NUMBER: "17",
    STATUS_FIELD: 'Status "QA" \\ suffix',
    PLAN_FIELD: "on: #not-a-comment",
    TYPE_FIELD: "true",
    READY_COL: "Ready: QA",
    DONE_COL: "Done 'approved'",
  });
  const setup = (env = shellEnv) =>
    execFileSync(
      "bash",
      [
        fileURLToPath(
          new URL("../scripts/setup.sh", import.meta.url),
        ).replaceAll("\\", "/"),
        "--non-interactive",
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const setupOutput = setup();
  const setupConfig = loadConfig(cwd);
  validateConfig(setupConfig);
  assert.equal(setupConfig.status_field, shellEnv.STATUS_FIELD);
  assert.equal(setupConfig.plan_field, shellEnv.PLAN_FIELD);
  assert.equal(setupConfig.type_field, shellEnv.TYPE_FIELD);
  assert.equal(setupConfig.project.owner, "project-user");
  assert.equal(setupConfig.project.number, 17);
  assert.match(
    readFileSync(ghLog, "utf8"),
    /project field-list 17 --owner project-user --format json/,
  );
  check(
    setupOutput.includes(
      'pi install "git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>"',
    ) && setupOutput.includes("--print exits"),
    "shell setup emits valid safely-escaped YAML and current immutable install/lifecycle guidance",
  );
  const saved = readFileSync(file, "utf8");
  setup();
  assert.equal(readFileSync(file, "utf8"), saved);
  rmSync(ghLog);
  assert.throws(() => setup({ ...shellEnv, PROJECT_NUMBER: "2147483648" }));
  assert.throws(() => readFileSync(ghLog));
  assert.equal(readFileSync(file, "utf8"), saved);
  check(
    true,
    "unattended setup preserves existing config and rejects numeric overflow before any gh command",
  );

  // Run the real template reader from a deliberately incomplete disposable package.
  const incomplete = join(root, "incomplete-package");
  mkdirSync(join(incomplete, "src"), { recursive: true });
  writeFileSync(join(incomplete, "package.json"), '{"type":"module"}');
  for (const name of ["config.ts", "process-runner.ts"])
    cpSync(
      new URL(`../src/${name}`, import.meta.url),
      join(incomplete, "src", name),
    );
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(incomplete, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const missing = await import(
    pathToFileURL(join(incomplete, "src", "config.ts")).href
  );
  assert.throws(
    () => missing.readConfigTemplate(),
    /Packaged config template is missing/,
  );
  check(
    true,
    "a missing packaged template throws instead of returning a fallback",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
