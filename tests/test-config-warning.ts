// Public config loading: explicit legacy values warn without changing the schema.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, validateConfig } from "../src/config.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const project = join(cwd, ".pi", "board-agent.yml");
const global = join(homedir(), ".pi", "board-agent.yml");
for (const dir of [join(cwd, ".pi"), join(homedir(), ".pi")])
  mkdirSync(dir, { recursive: true });
const warnings: string[] = [];
const load = () => loadConfig(cwd, (message) => warnings.push(message));
const clear = () => {
  warnings.length = 0;
  for (const path of [project, global]) rmSync(path, { force: true });
};
try {
  assert.equal(load().safety.skip_closed_issues, true);
  writeFileSync(project, "safety:\n  require_clean_worktree: false\n");
  assert.equal(load().safety.require_clean_worktree, false);
  assert.equal(warnings.length, 0, "defaults and an unrelated safety key stay quiet");
  console.log("PASS: absent/default-only skip_closed_issues emits no deprecation warning");

  for (const path of [global, project]) {
    for (const value of [true, false]) {
      clear();
      writeFileSync(path, `project:\n  number: 1\nsafety:\n  skip_closed_issues: ${value}\n`);
      const cfg = load();
      validateConfig(cfg);
      assert.equal(cfg.safety.skip_closed_issues, value);
      assert.equal(loadConfig(cwd).safety.skip_closed_issues, value, "callback remains optional");
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(path), "warning identifies the file to edit");
      assert.match(warnings[0], /safety\.skip_closed_issues/);
      assert.match(warnings[0], /deprecated/i);
      assert.match(warnings[0], /remove/i);
      assert.match(warnings[0], /closed issues.*never.*(?:build|design)/i);
      console.log(`PASS: explicit ${value} in ${path === global ? "global" : "project"} config stays boolean-compatible and warns actionably`);
    }
  }
  for (const globalValue of [true, false]) {
    clear();
    writeFileSync(global, `safety:\n  require_clean_worktree: false\n  skip_closed_issues: ${globalValue}\n`);
    writeFileSync(project, `safety:\n  skip_closed_issues: ${!globalValue}\n`);
    const cfg = load();
    assert.equal(cfg.safety.skip_closed_issues, !globalValue);
    assert.equal(cfg.safety.require_clean_worktree, false);
    assert.equal(warnings.length, 2, "warn for both explicit files, even a shadowed global value");
    assert.ok(warnings[0].includes(global) && warnings[1].includes(project));
  }
  console.log("PASS: nested merge preserves booleans and reports both explicit config sources, including shadowed values");

  for (const path of [global, project]) {
    for (const value of ["'false'", "'true'", "null", "0", "[]", "{}"] ) {
      clear();
      writeFileSync(path, `safety:\n  skip_closed_issues: ${value}\n`);
      assert.throws(load, (error: unknown) => error instanceof ConfigError && /skip_closed_issues.*boolean/.test(error.message));
      assert.equal(warnings.length, 0, "invalid input is rejected, not deprecated/coerced");
    }
    clear();
    writeFileSync(path, "safety:\n  skip_closed_issue: false\n");
    assert.throws(load, /Unknown config key: .*safety.skip_closed_issue/);
  }
  clear();
  const cfg = load();
  cfg.project.number = 1;
  for (const value of [undefined, null, "false", 0]) {
    assert.throws(() => validateConfig({ ...cfg, safety: { ...cfg.safety, skip_closed_issues: value } } as any), ConfigError);
  }
  console.log("PASS: legacy boolean shape, malformed-value validation and unknown-key rejection remain strict");
} finally {
  clear();
}
