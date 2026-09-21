import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, legacyNeedsDesignColumn, loadConfig, validateConfig } from "../src/config.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh (isolated HOME required)");
const cwd = join(root, "config"), global = join(homedir(), ".pi", "board-agent.yml"), project = join(cwd, ".pi", "board-agent.yml");
mkdirSync(join(homedir(), ".pi"), { recursive: true }); mkdirSync(join(cwd, ".pi"), { recursive: true });
const inherited = `project: {owner: team, number: 5}
max_workers: 4
builder_timeout_ms: 123456
builder_retries: 3
models: {builder: custom-builder, review: custom-review, refine: old-refiner, watch: old-watcher}
review: {enabled: false, timeout_ms: 654321}
refine: {enabled: true, timeout_ms: 4000, max_tasks: 7}
watchdog: {enabled: true, fix_rounds_max: 2, fix_cooldown_minutes: 4, respond_to_mentions: true, pr_label: old-pr, needs_human_label: old-human}
columns: {needs_design: Legacy Design}
task_merge_strategy: squash
context: {enabled: true, max_chars: 3210, exclude: [vendor]}
telegram: {enabled: true, bot_token_env: CUSTOM_TOKEN, chat_id_env: CUSTOM_CHAT, on: [needs_human, ci_fixed, refine_done]}
`;
writeFileSync(global, inherited); writeFileSync(project, "models: {review: project-review}\nmax_workers: 6\ncolumns: {needs_design: Project Design}\nreview: {enabled: false}\n");
const warnings: string[] = [], cfg = loadConfig(cwd, (s) => warnings.push(s));
validateConfig(cfg);
assert.equal(cfg.max_workers, 6); assert.deepEqual(cfg.models, { builder: "custom-builder", review: "project-review" });
assert.equal(cfg.builder_timeout_ms, 123456); assert.equal(cfg.builder_retries, 3); assert.equal(cfg.review.timeout_ms, 654321);
assert.deepEqual(cfg.context, { enabled: true, max_chars: 3210, exclude: ["vendor"] });
assert.deepEqual(cfg.telegram, { enabled: true, bot_token_env: "CUSTOM_TOKEN", chat_id_env: "CUSTOM_CHAT", on: ["needs_human", "ci_fixed", "refine_done"] });
assert.ok(!Object.hasOwn(cfg, "task_merge_strategy")); assert.deepEqual(cfg.review, { timeout_ms: 654321 });
for (const key of ["refine", "watchdog"]) assert.ok(!Object.hasOwn(cfg, key));
assert.ok(!Object.hasOwn(cfg.columns, "needs_design")); assert.equal(legacyNeedsDesignColumn(cfg), "Project Design");
for (const key of ["models.refine", "models.watch", "refine", "watchdog", "columns.needs_design", "review.enabled=false", "task_merge_strategy=squash"])
  assert.ok(warnings.some((s) => s.includes(global) && s.includes(key)), `global warning for ${key}`);
for (const key of ["columns.needs_design", "review.enabled=false"])
  assert.ok(warnings.some((s) => s.includes(project) && s.includes(key)), `project warning for ${key}`);
assert.equal(readFileSync(global, "utf8"), inherited); assert.ok(readFileSync(project, "utf8").includes("enabled: false"));
console.log("PASS: finite legacy lane config warns per file/key without rewrite, omits retired merge strategy, requires AI review and preserves models/budget/timeouts/context/notification configuration and custom migration label");
rmSync(global); rmSync(project);

for (const strategy of ["merge", "squash"]) {
  for (const file of [global, project]) {
    const raw = `project: {number: 1}\ntask_merge_strategy: ${strategy}\n`;
    writeFileSync(file, raw);
    warnings.length = 0;
    const loaded = loadConfig(cwd, (s) => warnings.push(s));
    validateConfig(loaded);
    assert.ok(!Object.hasOwn(loaded, "task_merge_strategy"));
    assert.ok(!Object.hasOwn(loadConfig(cwd), "task_merge_strategy"), "warning callback stays optional");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(file));
    assert.ok(warnings[0].includes(`task_merge_strategy=${strategy}`));
    assert.match(warnings[0], /retired and ignored.*PR.*human manual merge.*Remove/);
    assert.equal(readFileSync(file, "utf8"), raw);
    rmSync(file);
  }
  writeFileSync(global, `task_merge_strategy: ${strategy}\n`);
  writeFileSync(project, `task_merge_strategy: ${strategy === "merge" ? "squash" : "merge"}\n`);
  warnings.length = 0;
  assert.ok(!Object.hasOwn(loadConfig(cwd, (s) => warnings.push(s)), "task_merge_strategy"));
  assert.equal(warnings.length, 2, "both explicit sources warn, even when project shadows global");
  assert.ok(warnings[0].includes(global) && warnings[1].includes(project));
  rmSync(global); rmSync(project);
}
warnings.length = 0;
assert.ok(!Object.hasOwn(loadConfig(cwd, (s) => warnings.push(s)), "task_merge_strategy"));
assert.equal(warnings.length, 0, "defaults stay quiet");
console.log("PASS: merge/squash are input-only compatibility in both scopes, warn actionably without rewriting and never enter runtime Config");

for (const value of ["rebase", "manual", "' merge '", "''", "null", "true", "0", "[]", "{}"])
  for (const file of [global, project]) {
    const raw = `task_merge_strategy: ${value}\n`;
    writeFileSync(file, raw);
    // An invalid global input must fail even if a valid project value shadows it.
    if (file === global) writeFileSync(project, "task_merge_strategy: merge\n");
    warnings.length = 0;
    assert.throws(() => loadConfig(cwd, (s) => warnings.push(s)),
      (e) => e instanceof ConfigError && e.message.includes(file) && e.message.includes("task_merge_strategy"));
    assert.equal(warnings.length, 0, "validate before warning/ignoring");
    assert.equal(readFileSync(file, "utf8"), raw);
    rmSync(file);
    if (file === global) rmSync(project);
  }
console.log("PASS: retired merge strategy rejects invalid values before warning, including shadowed global inputs; no manual-mode setting is accepted");
for (const yaml of [
  "refine: null", "refine: {enabled: 'false'}", "refine: {timeout_ms: -1}", "refine: {max_tasks: 13}", "refine: {unknown: true}",
  "watchdog: []", "watchdog: {enabled: 'true'}", "watchdog: {fix_rounds_max: 11}", "watchdog: {fix_cooldown_minutes: -1}",
  "watchdog: {respond_to_mentions: 1}", "watchdog: {pr_label: ''}", "watchdog: {needs_human_label: 1}", "watchdog: {interval_seconds: 2}",
  "columns: {needs_design: null}", "columns: {needs_design: ''}", "models: {watch: false}", "models: {refine: ''}", "models: {designer: x}",
  "review: {enabled: null}", "review: {enabled: 'false'}", "review: {unknown: true}", "task_merge_strategy: rebase", "task_merge_strategy: false",
  "random: false", "pr: {}", "builder_tier: medium", "branches: {plan_prefix: x}",
]) for (const file of [global, project]) {
  writeFileSync(file, yaml);
  assert.throws(() => loadConfig(cwd), (e) => e instanceof ConfigError && e.message.includes(file), `${file}: ${yaml}`);
  assert.equal(readFileSync(file, "utf8"), yaml); rmSync(file);
}
console.log("PASS: wrong legacy types/ranges, unrelated/unknown keys and previously unsupported settings reject in both config scopes without writes");
