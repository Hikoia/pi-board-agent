#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const projects = process.argv.slice(2).map((project) => resolve(project));
if (projects.length === 0) {
  console.error(
    "Usage: node scripts/verify-board-agent-fleet.mjs <project-root>...",
  );
  process.exit(2);
}

const agentDir = resolve(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
);
const packageRoot = resolve(
  process.env.PI_BOARD_AGENT_PACKAGE_ROOT ||
    join(agentDir, "git", "github.com", "Hikoia", "pi-board-agent"),
);

function packageEntry(value) {
  if (typeof value === "string")
    return value.trim() ? { source: value } : undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.source !== "string" ||
    !value.source.trim() ||
    (value.autoload !== undefined && typeof value.autoload !== "boolean")
  )
    return undefined;
  return {
    source: value.source,
    autoload: value.autoload === false ? false : undefined,
  };
}

function boardAgentRef(source) {
  let spec = source.trim();
  const explicitGit = spec.startsWith("git:") && !spec.startsWith("git://");
  if (explicitGit) spec = spec.slice(4);
  if (!explicitGit && !/^(?:https?|ssh|git):\/\//i.test(spec)) return undefined;
  const prefixes = [
    "github.com/",
    "https://github.com/",
    "http://github.com/",
    "git://github.com/",
    "ssh://git@github.com/",
    "git@github.com:",
  ];
  const prefix = prefixes.find((candidate) =>
    spec.toLowerCase().startsWith(candidate.toLowerCase()),
  );
  if (!prefix) return undefined;
  const match = spec
    .slice(prefix.length)
    .match(/^Hikoia\/pi-board-agent(?:\.git)?(?:@([^@]+))?$/i);
  return match ? (match[1] ?? "") : undefined;
}

function settings(path) {
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("settings must be an object");
    if (parsed.packages !== undefined && !Array.isArray(parsed.packages))
      throw new Error("packages is not an array");
    const entries = (parsed.packages ?? []).map(packageEntry);
    if (entries.some((entry) => !entry))
      throw new Error("invalid package entry");
    return { entries };
  } catch (error) {
    return {
      entries: [],
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function git(args) {
  const result = spawnSync(
    "git",
    ["--no-pager", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    },
  );
  return {
    ok: !result.error && result.status === 0,
    value: result.stdout?.trim() || "",
    error: result.stderr?.trim() || result.error?.message,
  };
}

function json(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function tickSeconds(project) {
  let value = 90;
  for (const path of [
    join(homedir(), ".pi", "board-agent.yml"),
    join(project, ".pi", "board-agent.yml"),
  ]) {
    if (!existsSync(path)) continue;
    const config = parse(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error(`invalid config: ${path}`);
    if (config.tick_seconds === undefined) continue;
    if (
      !Number.isSafeInteger(config.tick_seconds) ||
      config.tick_seconds < 1 ||
      config.tick_seconds > 2147483
    )
      throw new Error(`invalid tick_seconds in ${path}`);
    value = config.tick_seconds;
  }
  return value;
}

const globalSettings = settings(join(agentDir, "settings.json"));
const globalEntries = globalSettings.entries.filter(
  (entry) =>
    boardAgentRef(entry.source) !== undefined && entry.autoload !== false,
);
const globalRef =
  globalEntries.length === 1
    ? boardAgentRef(globalEntries[0].source)
    : undefined;
const globalPin =
  globalRef && FULL_SHA.test(globalRef) ? globalRef.toLowerCase() : undefined;
const head = git(["rev-parse", "--show-toplevel", "HEAD"]);
const [packageTop, headSha] = head.value.split(/\r?\n/);
let rootMatches = false;
try {
  const canonical = (path) =>
    process.platform === "win32"
      ? realpathSync(path).toLowerCase()
      : realpathSync(path);
  rootMatches = canonical(packageTop) === canonical(packageRoot);
} catch {
  /* Not a readable checkout root. */
}
const status = git(["status", "--porcelain", "--untracked-files=normal"]);
const packageHead =
  head.ok && rootMatches && FULL_SHA.test(headSha ?? "")
    ? headSha.toLowerCase()
    : undefined;
const packageDirty = !status.ok || status.value.length > 0;
let failed = false;

for (const project of projects) {
  const codes = new Set();
  const details = [];
  const localSettings = settings(join(project, ".pi", "settings.json"));
  const overrides = localSettings.entries.filter(
    (entry) =>
      boardAgentRef(entry.source) !== undefined && entry.autoload !== false,
  );
  const runtime = json(join(project, ".pi", "board-agent", "runtime.json"));

  if (globalSettings.error || globalEntries.length !== 1 || !globalPin) {
    codes.add("MISMATCH");
    details.push(
      globalSettings.error ||
        "global package must be exactly one full-SHA Board Agent entry",
    );
  }
  if (
    localSettings.error ||
    overrides.length > 1 ||
    (overrides.length === 1 &&
      boardAgentRef(overrides[0].source)?.toLowerCase() !== globalPin)
  ) {
    codes.add("OVERRIDE");
    details.push(
      localSettings.error ||
        "project-local Board Agent override differs from the global pin",
    );
  }
  if (packageDirty || runtime?.dirty !== false) {
    codes.add("DIRTY");
    details.push(
      !status.ok
        ? status.error || "package git status failed"
        : "package checkout/runtime reports dirty",
    );
  }
  if (!head.ok || packageHead !== globalPin) {
    codes.add("MISMATCH");
    details.push(
      head.ok
        ? "package HEAD differs from global pin"
        : head.error || "package HEAD unavailable",
    );
  }
  if (
    !runtime ||
    runtime.schemaVersion !== 1 ||
    !globalPin ||
    [
      runtime.expectedRevision,
      runtime.loadedRevision,
      runtime.diskRevision,
    ].some(
      (revision) =>
        typeof revision !== "string" || revision.toLowerCase() !== globalPin,
    )
  ) {
    codes.add("MISMATCH");
    details.push(
      runtime
        ? "runtime revisions do not all equal the global pin"
        : "runtime.json is missing or invalid",
    );
  }
  if (runtime?.state !== "running") {
    codes.add("STOPPED");
    details.push(`runtime state is ${runtime?.state ?? "missing"}`);
  }
  const heartbeat = Date.parse(runtime?.heartbeatAt ?? "");
  let maxAgeMs = 300000;
  try {
    maxAgeMs = Math.max(3 * tickSeconds(project), 300) * 1000;
  } catch (error) {
    codes.add("MISMATCH");
    details.push(error instanceof Error ? error.message : String(error));
  }
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > maxAgeMs) {
    codes.add("STALE");
    details.push("runtime heartbeat is stale or missing");
  }

  if (codes.size === 0) {
    console.log(
      `OK ${project} revision=${globalPin} state=running pid=${runtime.pid} heartbeat=${runtime.heartbeatAt}`,
    );
  } else {
    failed = true;
    console.log(
      `FAIL [${[...codes].join(",")}] ${project} expected=${runtime?.expectedRevision ?? globalPin ?? "missing"} loaded=${runtime?.loadedRevision ?? "missing"} disk=${runtime?.diskRevision ?? packageHead ?? "missing"} state=${runtime?.state ?? "missing"} pid=${runtime?.pid ?? "missing"} — ${[...new Set(details)].join("; ")}`,
    );
  }
}

process.exitCode = failed ? 1 : 0;
