// Execute registered production handlers with real config loading, not source-string wiring checks.
import assert from "node:assert/strict";
import { until } from "./async-loop-fixture.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/owner/repo.git"], { stdio: "ignore" });
const project = join(cwd, ".pi", "board-agent.yml");
const global = join(homedir(), ".pi", "board-agent.yml");
for (const dir of [join(cwd, ".pi"), join(homedir(), ".pi")]) mkdirSync(dir, { recursive: true });
const config = "project:\n  number: 1\nbot_identity: bot\nsafety:\n  require_clean_worktree: false\nwatchdog:\n  enabled: false\n";
const globals = globalThis as any;
let starts = 0;
globals.__configStartup = {
  whoami: async () => "bot",
  getProjectMetadata: async () => ({
    projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT",
    statusOptions: Object.fromEntries(Object.values(_DEFAULTS.columns).map((name) => [name, name])),
    planFieldId: "PLAN", planFieldType: "TEXT", typeFieldId: "TYPE", typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK", Story: "STORY" },
  }),
  listCards: async () => [],
  initProject: async () => ({ created: [], view: "Board" }),
  createProductionTicketExecutor: () => {
    starts++;
    return {
      migrateLegacy: async () => ({ converted: [], failures: [] }),
      reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
      activeCount: () => 0,
      launch: async () => assert.fail("unexpected builder"),
      finalizeClosed: async () => assert.fail("unexpected finalization"),
      shutdown: async () => {},
    };
  },
  captureRuntimeIdentity: () => ({ loadedRevision: "a".repeat(40) }),
  checkRuntimeRevisionAsync: async () => ({ ok: true, expectedRevision: "a".repeat(40), loadedRevision: "a".repeat(40), diskRevision: "a".repeat(40), dirty: false }),
};
const entry = new URL("../src/index.ts", import.meta.url).href;
const shim = (file: string, names: string[]) => `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(new URL(file, entry).href)};
${names.map((name) => `export const ${name} = globalThis.__configStartup.${name};`).join("\n")}
`)}`;
const stubs: Record<string, string> = {
  "./gh.js": shim("gh.ts", ["whoami", "getProjectMetadata", "listCards"]),
  "./ticket-executor.js": shim("ticket-executor.ts", ["createProductionTicketExecutor"]),
  "./runtime.js": shim("runtime.ts", ["captureRuntimeIdentity", "checkRuntimeRevisionAsync"]),
  "./init-project.js": shim("init-project.ts", ["initProject"]),
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if ([entry, new URL("loop.ts", entry).href].includes(context.parentURL ?? "") && stubs[specifier])
    return { url: stubs[specifier], shortCircuit: true };
  return next(specifier, context);
} });
const events = new Map<string, Function>();
let command!: (args: string, ctx: any) => Promise<void>;
const messages: Array<{ message: string; level: string }> = [];
const ctx = { cwd, hasUI: false, ui: { notify: (message: string, level: string) => messages.push({ message, level }) }, sessionManager: { getSessionId: () => "offline-config" } };
const invoke = async (name: string) => {
  const path = join(cwd, ".pi", "board-agent", "runtime.json");
  const runtime = () => existsSync(path) ? readFileSync(path, "utf8") : "";
  const before = runtime();
  const messageStart = messages.length;
  await (name === "session_start" ? events.get(name)!({}, ctx) : command(name, ctx));
  if (["session_start", "run"].includes(name) && messages.slice(messageStart).some(({ message }) => message.includes("STARTING")))
    await until(() => !!runtime() && runtime() !== before && JSON.parse(runtime()).state !== "starting");
};
try {
  (await import(entry)).default({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (_name: string, options: any) => { command = options.handler; } });
  // A local false must override global true, even with durable recovery pending.
  const records = join(cwd, ".pi", "board-agent", "ticket-worktrees");
  const recordPath = join(records, "pvti_3.json");
  mkdirSync(records, { recursive: true });
  writeFileSync(global, "auto_start: true\n");
  writeFileSync(project, config + "auto_start: false\n");
  writeFileSync(recordPath, JSON.stringify({
    schemaVersion: 3, itemId: "PVTI_3", issueNumber: 3, taskKey: "T003", plan: "release",
    taskBranch: "task/issue-3", baseBranch: "main", path: join(cwd, ".pi", "worktrees", "pvti_3"),
    createdAt: 1, activeRunId: "run-3", activeRunStartedAt: 1,
  }));
  for (const recovery of [true, false]) {
    if (!recovery) rmSync(recordPath);
    messages.length = 0;
    await invoke("session_start");
    assert.equal(starts, 0, "auto_start=false must not start a loop, including recovery");
    assert.deepEqual(messages, [], "disabled auto-start must not announce startup");
    assert.equal(existsSync(join(cwd, ".pi", "board-agent", "owner.lock")), false);
    assert.equal(existsSync(join(cwd, ".pi", "board-agent", "runtime.json")), false);
  }
  await invoke("run");
  assert.equal(starts, 1, "manual run still starts with auto_start=false");
  await command("stop", ctx);
  console.log("PASS: auto_start=false overrides global true and prevents session startup with or without recovery; explicit run still works");

  // Explicit commands still load config when automatic startup is disabled.
  for (const [source, value] of [[global, true], [project, false], [undefined, undefined]] as const) {
    rmSync(global, { force: true });
    writeFileSync(project, source === project
      ? config.replace("  require_clean_worktree: false", `  require_clean_worktree: false\n  skip_closed_issues: ${value}`)
      : config);
    if (source === global) writeFileSync(global, `safety:\n  skip_closed_issues: ${value}\n`);
    for (const action of ["lint", "run", "status", "context", "init-project"]) {
      messages.length = 0;
      await invoke(action);
      assert.ok(!messages.some(({ level }) => level === "error"), JSON.stringify(messages));
      const warnings = messages.filter(({ message }) => /skip_closed_issues/.test(message));
      if (source) {
        assert.ok(warnings.length > 0, `${action}: production handler must deliver deprecation warning`);
        for (const warning of warnings) {
          assert.equal(warning.level, "warning");
          assert.ok(warning.message.includes(source));
          assert.match(warning.message, /deprecated.*Remove.*Closed Issues never/s);
        }
      } else assert.deepEqual(warnings, [], `${action}: defaults must not warn`);
      await command("stop", ctx);
    }
    console.log(`PASS: production run/lint/status/context/init-project ${source ? `warn for ${source === global ? "global true" : "project false"}` : "stay quiet for defaults"} through real loadConfig`);
  }
  writeFileSync(project, config + "auto_start: true\n");
  writeFileSync(global, "safety:\n  skip_closed_issues: false\n");
  messages.length = 0;
  const before = starts;
  await invoke("session_start");
  assert.equal(starts, before + 1, JSON.stringify(messages));
  assert.ok(messages.some(({ message, level }) => /skip_closed_issues.*deprecated/.test(message) && level === "warning"));
  console.log("PASS: automatic production startup reports the legacy warning while still starting a valid configuration");
} finally {
  await events.get("session_shutdown")?.({}, ctx);
  hooks.deregister();
  delete globals.__configStartup;
  rmSync(global, { force: true });
}
