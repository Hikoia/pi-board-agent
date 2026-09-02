import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const BOARD_AGENT_SOURCE = "git:github.com/Hikoia/pi-board-agent";
export const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

export type RuntimeState = "running" | "recovery-only" | "version-mismatch" | "stopped";

export interface LoadedRuntimeIdentity {
  packageRoot: string;
  loadedRevision: string | null;
  loadedDirty: boolean;
  expectedRevisionAtLoad: string | null;
  expectedSourceAtLoad: string | null;
  expectedErrorAtLoad?: string;
}

export interface RevisionCheck {
  ok: boolean;
  expectedRevision: string | null;
  loadedRevision: string | null;
  diskRevision: string | null;
  dirty: boolean;
  reason?: string;
  repairCommand: string;
}

export interface RuntimeStatus {
  schemaVersion: 1;
  expectedRevision: string | null;
  loadedRevision: string | null;
  diskRevision: string | null;
  dirty: boolean;
  pid: number;
  sessionId?: string;
  state: RuntimeState;
  startedAt: string;
  heartbeatAt: string;
}

interface PackageSetting {
  source: string;
  autoload?: boolean;
}

interface ExpectedRevision {
  revision: string | null;
  source: string | null;
  error?: string;
}

function packageSetting(value: unknown): PackageSetting | undefined {
  if (typeof value === "string") return { source: value };
  if (!value || typeof value !== "object") return undefined;
  const setting = value as { source?: unknown; autoload?: unknown };
  if (typeof setting.source !== "string") return undefined;
  return { source: setting.source, autoload: setting.autoload === false ? false : undefined };
}

/** Return the configured ref for this package, or undefined for another package. */
export function boardAgentRef(source: string): string | undefined {
  let spec = source.trim();
  if (spec.startsWith("git:")) spec = spec.slice(4);
  const prefixes = [
    "github.com/",
    "https://github.com/",
    "http://github.com/",
    "ssh://git@github.com/",
    "git@github.com:",
  ];
  const prefix = prefixes.find((candidate) => spec.toLowerCase().startsWith(candidate.toLowerCase()));
  if (!prefix) return undefined;
  const match = spec.slice(prefix.length).match(/^Hikoia\/pi-board-agent(?:\.git)?(?:@([^@]+))?$/i);
  return match ? (match[1] ?? "") : undefined;
}

function readPackageSettings(path: string): { entries: PackageSetting[]; error?: string } {
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown };
    if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) {
      return { entries: [], error: `packages is not an array in ${path}` };
    }
    return { entries: (parsed.packages ?? []).map(packageSetting).filter((entry): entry is PackageSetting => !!entry) };
  } catch (error) {
    return { entries: [], error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function resolveExpectedRevision(projectRoot: string, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): ExpectedRevision {
  const global = readPackageSettings(join(resolve(agentDir), "settings.json"));
  const project = readPackageSettings(join(resolve(projectRoot), ".pi", "settings.json"));
  if (global.error || project.error) return { revision: null, source: null, error: project.error ?? global.error };

  const localMatches = project.entries.filter((entry) => boardAgentRef(entry.source) !== undefined && entry.autoload !== false);
  const globalMatches = global.entries.filter((entry) => boardAgentRef(entry.source) !== undefined && entry.autoload !== false);
  const selected = localMatches.length > 0 ? localMatches : globalMatches;
  const scope = localMatches.length > 0 ? "project" : "global";
  if (selected.length !== 1) {
    return {
      revision: null,
      source: null,
      error: selected.length === 0 ? "Board Agent package entry is missing" : `multiple ${scope} Board Agent package entries found`,
    };
  }
  return {
    revision: boardAgentRef(selected[0].source) || null,
    source: selected[0].source,
  };
}

export function inspectPackageCheckout(packageRoot: string): { revision: string | null; dirty: boolean; error?: string } {
  const run = (args: string[]) => spawnSync("git", args, { cwd: packageRoot, encoding: "utf8" });
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain", "--untracked-files=normal"]);
  const error = head.status !== 0 || status.status !== 0
    ? ((head.stderr || status.stderr || head.error?.message || status.error?.message || "git inspection failed").trim())
    : undefined;
  return {
    revision: head.status === 0 && FULL_GIT_SHA.test(head.stdout.trim()) ? head.stdout.trim().toLowerCase() : null,
    dirty: status.status !== 0 || status.stdout.trim().length > 0,
    error,
  };
}

/** Capture immutable module identity before any board work can start. */
export function captureRuntimeIdentity(packageRoot: string, projectRoot: string, agentDir?: string): LoadedRuntimeIdentity {
  const loaded = inspectPackageCheckout(packageRoot);
  const expected = resolveExpectedRevision(projectRoot, agentDir);
  return {
    packageRoot: resolve(packageRoot),
    loadedRevision: loaded.revision,
    loadedDirty: loaded.dirty || !!loaded.error,
    expectedRevisionAtLoad: expected.revision,
    expectedSourceAtLoad: expected.source,
    expectedErrorAtLoad: expected.error,
  };
}

export function checkRuntimeRevision(
  projectRoot: string,
  loaded: LoadedRuntimeIdentity,
  agentDir?: string,
  mismatchLatched = false,
): RevisionCheck {
  const expected = resolveExpectedRevision(projectRoot, agentDir);
  const disk = inspectPackageCheckout(loaded.packageRoot);
  const reasons: string[] = [];
  if (mismatchLatched) reasons.push("a package revision mismatch already occurred in this process; restart is required");
  if (expected.error) reasons.push(expected.error);
  if (!expected.revision || !FULL_GIT_SHA.test(expected.revision)) reasons.push("effective package ref must be a full 40-character Git SHA");
  if (expected.revision !== loaded.expectedRevisionAtLoad || expected.source !== loaded.expectedSourceAtLoad || expected.error !== loaded.expectedErrorAtLoad) {
    reasons.push("effective package setting changed after extension load");
  }
  if (!loaded.loadedRevision || !FULL_GIT_SHA.test(loaded.loadedRevision)) reasons.push("loaded package revision is unavailable");
  if (loaded.loadedDirty) reasons.push("package checkout was dirty when the extension loaded");
  if (disk.error) reasons.push(disk.error);
  if (disk.dirty) reasons.push("package checkout is dirty");
  if (expected.revision && loaded.loadedRevision !== expected.revision.toLowerCase()) reasons.push("loaded revision does not match expected revision");
  if (disk.revision !== loaded.loadedRevision) reasons.push("package revision on disk changed after extension load");
  if (expected.revision && disk.revision !== expected.revision.toLowerCase()) reasons.push("disk revision does not match expected revision");

  const revision = expected.revision?.toLowerCase() ?? null;
  return {
    ok: reasons.length === 0,
    expectedRevision: revision,
    loadedRevision: loaded.loadedRevision,
    diskRevision: disk.revision,
    dirty: loaded.loadedDirty || disk.dirty,
    reason: reasons.length > 0 ? [...new Set(reasons)].join("; ") : undefined,
    repairCommand: `pi install ${BOARD_AGENT_SOURCE}@${revision && FULL_GIT_SHA.test(revision) ? revision : "<FULL_GIT_SHA>"}`,
  };
}

export function formatRevisionFailure(check: RevisionCheck): string {
  return `Board Agent revision check failed (expected=${check.expectedRevision ?? "missing"}, loaded=${check.loadedRevision ?? "unknown"}, disk=${check.diskRevision ?? "unknown"}, dirty=${check.dirty ? "yes" : "no"}): ${check.reason ?? "unknown mismatch"}. Repair with \`${check.repairCommand}\`, then restart this Pi process.`;
}

export function runtimePath(projectRoot: string): string {
  return join(resolve(projectRoot), ".pi", "board-agent", "runtime.json");
}

export function writeRuntimeStatus(projectRoot: string, status: Omit<RuntimeStatus, "schemaVersion" | "heartbeatAt">): RuntimeStatus {
  const path = runtimePath(projectRoot);
  const dir = join(resolve(projectRoot), ".pi", "board-agent");
  const temporary = join(dir, `.runtime-${process.pid}-${randomUUID()}.tmp`);
  const record: RuntimeStatus = { schemaVersion: 1, ...status, heartbeatAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return record;
}

export function readRuntimeStatus(projectRoot: string): RuntimeStatus | undefined {
  try {
    return JSON.parse(readFileSync(runtimePath(projectRoot), "utf8")) as RuntimeStatus;
  } catch {
    return undefined;
  }
}
