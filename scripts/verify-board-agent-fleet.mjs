#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const projects = process.argv.slice(2).map((project) => resolve(project));
if (projects.length === 0) {
  console.error("Usage: node scripts/verify-board-agent-fleet.mjs <project-root>...");
  process.exit(2);
}

const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const packageRoot = resolve(process.env.PI_BOARD_AGENT_PACKAGE_ROOT || join(agentDir, "git", "github.com", "Hikoia", "pi-board-agent"));

function packageEntry(value) {
  if (typeof value === "string") return { source: value };
  if (!value || typeof value !== "object" || typeof value.source !== "string") return undefined;
  return { source: value.source, autoload: value.autoload === false ? false : undefined };
}

function boardAgentRef(source) {
  let spec = source.trim();
  if (spec.startsWith("git:")) spec = spec.slice(4);
  const prefixes = ["github.com/", "https://github.com/", "http://github.com/", "ssh://git@github.com/", "git@github.com:"];
  const prefix = prefixes.find((candidate) => spec.toLowerCase().startsWith(candidate.toLowerCase()));
  if (!prefix) return undefined;
  const match = spec.slice(prefix.length).match(/^Hikoia\/pi-board-agent(?:\.git)?(?:@([^@]+))?$/i);
  return match ? (match[1] ?? "") : undefined;
}

function settings(path) {
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) throw new Error("packages is not an array");
    return { entries: (parsed.packages ?? []).map(packageEntry).filter(Boolean) };
  } catch (error) {
    return { entries: [], error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function git(args) {
  const result = spawnSync("git", args, { cwd: packageRoot, encoding: "utf8" });
  return { ok: result.status === 0, value: result.stdout?.trim() || "", error: result.stderr?.trim() || result.error?.message };
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
  for (const path of [join(homedir(), ".pi", "board-agent.yml"), join(project, ".pi", "board-agent.yml")]) {
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^\s*tick_seconds\s*:\s*["']?(\d+)["']?\s*(?:#.*)?$/m);
    if (match && Number(match[1]) > 0) value = Number(match[1]);
  }
  return value;
}

const globalSettings = settings(join(agentDir, "settings.json"));
const globalEntries = globalSettings.entries.filter((entry) => boardAgentRef(entry.source) !== undefined && entry.autoload !== false);
const globalRef = globalEntries.length === 1 ? boardAgentRef(globalEntries[0].source) : undefined;
const globalPin = globalRef && FULL_SHA.test(globalRef) ? globalRef.toLowerCase() : undefined;
const head = git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain", "--untracked-files=normal"]);
const packageHead = head.ok && FULL_SHA.test(head.value) ? head.value.toLowerCase() : undefined;
const packageDirty = !status.ok || status.value.length > 0;
let failed = false;

for (const project of projects) {
  const codes = new Set();
  const details = [];
  const localSettings = settings(join(project, ".pi", "settings.json"));
  const overrides = localSettings.entries.filter((entry) => boardAgentRef(entry.source) !== undefined && entry.autoload !== false);
  const runtime = json(join(project, ".pi", "board-agent", "runtime.json"));

  if (globalSettings.error || globalEntries.length !== 1 || !globalPin) {
    codes.add("MISMATCH");
    details.push(globalSettings.error || "global package must be exactly one full-SHA Board Agent entry");
  }
  if (localSettings.error || overrides.length > 1 || (overrides.length === 1 && boardAgentRef(overrides[0].source)?.toLowerCase() !== globalPin)) {
    codes.add("OVERRIDE");
    details.push(localSettings.error || "project-local Board Agent override differs from the global pin");
  }
  if (packageDirty || runtime?.dirty !== false) {
    codes.add("DIRTY");
    details.push(!status.ok ? (status.error || "package git status failed") : "package checkout/runtime reports dirty");
  }
  if (!head.ok || packageHead !== globalPin) {
    codes.add("MISMATCH");
    details.push(head.ok ? "package HEAD differs from global pin" : (head.error || "package HEAD unavailable"));
  }
  if (!runtime || runtime.schemaVersion !== 1 || !globalPin || [runtime.expectedRevision, runtime.loadedRevision, runtime.diskRevision].some((revision) => typeof revision !== "string" || revision.toLowerCase() !== globalPin)) {
    codes.add("MISMATCH");
    details.push(runtime ? "runtime revisions do not all equal the global pin" : "runtime.json is missing or invalid");
  }
  if (runtime?.state !== "running") {
    codes.add("STOPPED");
    details.push(`runtime state is ${runtime?.state ?? "missing"}`);
  }
  const heartbeat = Date.parse(runtime?.heartbeatAt ?? "");
  const maxAgeMs = Math.max(3 * tickSeconds(project), 300) * 1000;
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > maxAgeMs) {
    codes.add("STALE");
    details.push("runtime heartbeat is stale or missing");
  }

  if (codes.size === 0) {
    console.log(`OK ${project} revision=${globalPin} state=running pid=${runtime.pid} heartbeat=${runtime.heartbeatAt}`);
  } else {
    failed = true;
    console.log(`FAIL [${[...codes].join(",")}] ${project} expected=${runtime?.expectedRevision ?? globalPin ?? "missing"} loaded=${runtime?.loadedRevision ?? "missing"} disk=${runtime?.diskRevision ?? packageHead ?? "missing"} state=${runtime?.state ?? "missing"} pid=${runtime?.pid ?? "missing"} — ${[...new Set(details)].join("; ")}`);
  }
}

process.exitCode = failed ? 1 : 0;
