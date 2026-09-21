/** Load and validate `.pi/board-agent.yml`. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { processFailure, runProcessSync } from "./process-runner.js";

export interface Config {
  project: { owner: string; number: number };
  columns: {
    ready: string;
    building: string;
    review: string;
    done: string;
    needs_human: string;
    backlog: string;
  };
  status_field: string;
  plan_field: string;
  type_field: string;
  max_workers: number;
  tick_seconds: number;
  branches: { base: string; task_prefix: string };
  builder_timeout_ms?: number;
  builder_retries: number;
  models: { builder: string; review: string };
  context: { enabled: boolean; max_chars: number; exclude: string[] };
  review: { timeout_ms: number };
  telegram: {
    enabled: boolean;
    bot_token_env: string;
    chat_id_env: string;
    on: string[];
  };
  auto_start: boolean;
  safety: { require_clean_worktree: boolean; skip_closed_issues: boolean };
  bot_identity: string;
}

const DEFAULTS: Config = {
  project: { owner: "", number: 0 },
  columns: {
    ready: "Ready",
    building: "In Progress",
    review: "Review",
    done: "Done",
    needs_human: "Needs Human",
    backlog: "Backlog",
  },
  status_field: "Status",
  plan_field: "Plan",
  type_field: "Type",
  max_workers: 2,
  tick_seconds: 90,
  branches: { base: "main", task_prefix: "task/" },
  builder_retries: 1,
  models: {
    builder: "deepseek-v4-flash-0731",
    review: "deepseek-v4-flash-0731",
  },
  context: { enabled: true, max_chars: 20_000, exclude: [] },
  review: { timeout_ms: 600_000 },
  telegram: {
    enabled: true,
    bot_token_env: "TELEGRAM_BOT_TOKEN",
    chat_id_env: "TELEGRAM_CHAT_ID",
    on: ["needs_human"],
  },
  auto_start: false,
  safety: { require_clean_worktree: true, skip_closed_issues: true },
  bot_identity: "",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function deepMerge<T>(base: T, overlay: Partial<T>): T {
  if (overlay == null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base))
    return (overlay as T) ?? base;
  const out: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(
    overlay as Record<string, unknown>,
  )) {
    if (value === undefined || value === null) continue;
    out[key] =
      typeof value === "object" && !Array.isArray(value)
        ? deepMerge(
            (base as Record<string, unknown>)[key],
            value as Record<string, unknown>,
          )
        : value;
  }
  return out as T;
}

function configObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
    if (parsed == null) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed))
      throw new ConfigError(`${path} must contain a YAML mapping.`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `Cannot read YAML config ${path}: ${(error as Error).message}`,
    );
  }
}

/** Validate input before merging: nulls, typos and string booleans are not defaults. */
function validateShape(
  value: unknown,
  reference: unknown,
  name: string,
  partial = false,
): void {
  if (Array.isArray(reference)) {
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string" || !entry.trim())
    )
      throw new ConfigError(`${name} must be an array of non-empty strings.`);
  } else if (reference && typeof reference === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ConfigError(`${name} must be a mapping.`);
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (!Object.hasOwn(reference, key))
        throw new ConfigError(`Unknown config key: ${name}.${key}.`);
    }
    for (const [key, example] of Object.entries(reference)) {
      if (
        !Object.hasOwn(object, key) &&
        (partial || key === "builder_timeout_ms")
      )
        continue;
      if (key === "builder_timeout_ms" && object[key] === undefined) continue;
      validateShape(object[key], example, `${name}.${key}`, partial);
    }
  } else if (typeof value !== typeof reference) {
    throw new ConfigError(`${name} must be a ${typeof reference}.`);
  }
}

function removedKeys(value: Record<string, unknown>): string[] {
  const found: string[] = [];
  if (Object.hasOwn(value, "pr")) found.push("pr");
  if (Object.hasOwn(value, "builder_tier")) found.push("builder_tier");
  const branches = "branches" in value ? value.branches : undefined;
  if (
    branches &&
    typeof branches === "object" &&
    Object.hasOwn(branches, "plan_prefix")
  )
    found.push("branches.plan_prefix");
  const watchdog = "watchdog" in value ? value.watchdog : undefined;
  if (
    watchdog &&
    typeof watchdog === "object" &&
    Object.hasOwn(watchdog, "interval_seconds")
  )
    found.push("watchdog.interval_seconds");
  return found;
}

function rejectRemovedKeys(
  value: Record<string, unknown>,
  source = "config",
): void {
  const keys = removedKeys(value);
  if (keys.length)
    throw new ConfigError(
      `${source} uses key(s) removed in 0.2.0: ${keys.join(", ")}. Migration: back up the file and remove those keys. Use models.builder instead of builder_tier, branches.base/task_prefix for task PRs instead of plan/PR settings, and tick_seconds for polling.`,
    );
}

// Finite input-only compatibility. Do not spread arbitrary old keys into Config.
const LEGACY_INPUT = {
  ...DEFAULTS,
  task_merge_strategy: "merge",
  builder_timeout_ms: 0,
  columns: { ...DEFAULTS.columns, needs_design: "Needs Design" },
  models: { ...DEFAULTS.models, refine: "", watch: "" },
  refine: { enabled: true, timeout_ms: 240_000, max_tasks: 12 },
  watchdog: { enabled: true, fix_rounds_max: 5, fix_cooldown_minutes: 5,
    respond_to_mentions: false, pr_label: "board-agent", needs_human_label: "needs-human" },
  review: { ...DEFAULTS.review, enabled: true },
};
// Only the migration adapter needs the old column label. It is never a lane.
const legacyDesignColumns = new WeakMap<Config, string>();
export function legacyNeedsDesignColumn(cfg: Config): string {
  return legacyDesignColumns.get(cfg) ?? "Needs Design";
}

function normalizeLegacy(value: Record<string, unknown>, source: string, warn?: (message: string) => void): string | undefined {
  const retired = (key: string) => warn?.(`${source}: ${key} is retired and ignored; Task-only execution never runs Story refinement, designers or legacy PR watchdogs. Remove this key manually.`);
  const columns = value.columns as Record<string, unknown> | undefined;
  const design = columns?.needs_design as string | undefined;
  for (const [section, keys] of [
    ["columns", ["needs_design"]], ["models", ["refine", "watch"]],
    ["watchdog", ["pr_label", "needs_human_label"]],
  ] as const) {
    const object = value[section] as Record<string, unknown> | undefined;
    for (const key of keys) if (object && Object.hasOwn(object, key)) {
      const text = object[key] as string;
      if (!text || text !== text.trim() || /[\x00-\x1f\x7f]/.test(text))
        throw new ConfigError(`${source}.${section}.${key} must be a non-empty, trimmed single-line string.`);
      if (section === "columns") {
        warn?.(`${source}: columns.needs_design is retired as an execution lane; its label is used only to migrate old Task cards to Needs Human. Remove it manually after migration.`);
        delete object[key];
      } else if (section === "models") {
        retired(`${section}.${key}`);
        delete object[key];
      }
    }
  }
  for (const [section, key, min, max] of [
    ["refine", "timeout_ms", 1, MAX_TIMER_MS], ["refine", "max_tasks", 1, 12],
    ["watchdog", "fix_rounds_max", 0, 10], ["watchdog", "fix_cooldown_minutes", 0, Math.floor(MAX_TIMER_MS / 60_000)],
  ] as const) {
    const object = value[section] as Record<string, unknown> | undefined;
    if (object && Object.hasOwn(object, key)) {
      try { integer(`${section}.${key}`, object[key] as number, min, max); }
      catch (error) { throw new ConfigError(`${source}: ${(error as Error).message}`); }
    }
  }
  for (const key of ["refine", "watchdog"]) if (Object.hasOwn(value, key)) {
    retired(key); delete value[key];
  }
  const review = value.review as Record<string, unknown> | undefined;
  if (review && Object.hasOwn(review, "enabled")) {
    warn?.(`${source}: review.enabled=${review.enabled} is retired; AI review is always enabled. Remove this key manually.`);
    delete review.enabled;
  }
  if (Object.hasOwn(value, "task_merge_strategy")) {
    if (value.task_merge_strategy !== "merge" && value.task_merge_strategy !== "squash")
      throw new ConfigError(`${source}.task_merge_strategy must be 'merge' or 'squash' (retired input only).`);
    warn?.(`${source}: task_merge_strategy=${value.task_merge_strategy} is retired and ignored; closed Done Issues request a PR for human manual merge. Remove this key manually.`);
    delete value.task_merge_strategy;
  }
  return design;
}

/** Warn only for explicit deprecated keys, not merged defaults. */
export function loadConfig(cwd: string, warn?: (message: string) => void): Config {
  const projectPath = resolve(cwd, ".pi", "board-agent.yml");
  const globalPath = resolve(homedir(), ".pi", "board-agent.yml");
  let cfg = structuredClone(DEFAULTS);
  let designColumn = "Needs Design";
  for (const path of [globalPath, projectPath]) {
    if (!existsSync(path)) continue;
    const overlay = configObject(path);
    rejectRemovedKeys(overlay, path);
    validateShape(overlay, LEGACY_INPUT, path, true);
    designColumn = normalizeLegacy(overlay, path, warn) ?? designColumn;
    if (overlay.safety && Object.hasOwn(overlay.safety, "skip_closed_issues"))
      warn?.(
        `${path}: safety.skip_closed_issues is deprecated and has no effect (true or false). Remove this key from the file. Closed Issues never start builders or review; closed Done Issues request managed PR integration, with cleanup only after verified completion.`,
      );
    cfg = deepMerge(cfg, overlay as Partial<Config>);
  }
  legacyDesignColumns.set(cfg, designColumn);
  return cfg;
}

const MAX_TIMER_MS = 2_147_483_647;

function integer(name: string, value: number, min: number, max: number): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new ConfigError(
      `config.${name} must be an integer between ${min} and ${max}.`,
    );
}

function timerMilliseconds(name: string, value: number): void {
  integer(name, value, 1, MAX_TIMER_MS);
}

function timerSeconds(name: string, value: number): void {
  integer(name, value, 1, Math.floor(MAX_TIMER_MS / 1000));
}

export function validateConfig(cfg: Config): void {
  rejectRemovedKeys({ ...cfg });
  validateShape(cfg, { ...DEFAULTS, builder_timeout_ms: 0 }, "config");
  // ProjectV2(number:) is a GraphQL Int, not an arbitrary JS safe integer.
  integer("project.number", cfg.project.number, 1, 2_147_483_647);
  integer("max_workers", cfg.max_workers, 1, 16);
  timerSeconds("tick_seconds", cfg.tick_seconds);
  if (cfg.builder_timeout_ms !== undefined)
    timerMilliseconds("builder_timeout_ms", cfg.builder_timeout_ms);
  integer("builder_retries", cfg.builder_retries, 0, 10);
  timerMilliseconds("review.timeout_ms", cfg.review.timeout_ms);
  integer("context.max_chars", cfg.context.max_chars, 1, MAX_TIMER_MS);

  for (const [name, value] of Object.entries({
    status_field: cfg.status_field,
    plan_field: cfg.plan_field,
    type_field: cfg.type_field,
    ...Object.fromEntries(
      Object.entries(cfg.columns).map(([key, value]) => [
        `columns.${key}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(cfg.branches).map(([key, value]) => [
        `branches.${key}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(cfg.models).map(([key, value]) => [
        `models.${key}`,
        value,
      ]),
    ),
  })) {
    if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value))
      throw new ConfigError(
        `config.${name} must be a non-empty, trimmed single-line string.`,
      );
  }
  for (const [name, value] of [
    ["project.owner", cfg.project.owner],
    ["bot_identity", cfg.bot_identity],
  ]) {
    if (value !== value.trim() || /[\s\x00-\x1f\x7f]/.test(value))
      throw new ConfigError(`config.${name} must be empty or a single login.`);
  }
  for (const name of ["bot_token_env", "chat_id_env"] as const) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.telegram[name]))
      throw new ConfigError(
        `config.telegram.${name} must be an environment variable name.`,
      );
  }

  const statuses = [
    cfg.columns.backlog,
    cfg.columns.ready,
    cfg.columns.building,
    cfg.columns.needs_human,
    cfg.columns.review,
    cfg.columns.done,
  ];
  if (statuses.some((status) => typeof status !== "string" || !status.trim()))
    throw new ConfigError(
      "config.columns must define the five execution statuses and manual Backlog label.",
    );
  if (
    new Set(statuses.map((status) => status.toLowerCase())).size !==
    statuses.length
  )
    throw new ConfigError("config.columns status names must be distinct.");
  if (!cfg.branches.base || !cfg.branches.task_prefix)
    throw new ConfigError("config.branches.base and task_prefix are required.");
  if (!cfg.models.builder)
    throw new ConfigError("config.models.builder is required in 0.2.0.");
}

/** Resolve the Project owner separately from the repository identity. */
export function resolveOwner(
  cfg: Config,
  cwd: string,
): { projectOwner: string; repoOwner: string; repoName: string } {
  const args = ["remote", "get-url", "origin"];
  const remote = runProcessSync("git", args, { cwd });
  if (!remote.ok)
    throw new ConfigError(processFailure("git", args, remote).message);
  const url = remote.stdout.trim();
  const match = url.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+?)(?:\.git)?$/i,
  );
  if (!match || match[2] === "." || match[2] === "..")
    // Do not echo an untrusted URL: it may contain embedded credentials.
    throw new ConfigError(
      "origin must be a GitHub remote using HTTPS or SSH and exactly owner/repository.",
    );
  const repoOwner = match[1];
  return {
    projectOwner: cfg.project.owner || repoOwner,
    repoOwner,
    repoName: match[2],
  };
}

export function planSlug(planName: string): string {
  return planName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function taskBranch(prefix: string, issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
    throw new Error(
      "A positive linked issue number is required for a task branch.",
    );
  return `${prefix}issue-${issueNumber}`;
}

export { DEFAULTS as _DEFAULTS };

/** Read the template shipped with this package; a missing package file is fatal. */
export function readConfigTemplate(): string {
  const path = fileURLToPath(
    new URL("../config-template.yml", import.meta.url),
  );
  if (!existsSync(path))
    throw new ConfigError(`Packaged config template is missing: ${path}`);
  return readFileSync(path, "utf8");
}
