/**
 * Loads `.pi/board-agent.yml` (project-local, overrides ~/.pi/board-agent.yml)
 * and exposes a strongly typed `Config` object plus a resolver for the
 * owner (auto-derive from origin remote when empty).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

export interface Config {
  project: { owner: string; number: number };
  columns: { ready: string; building: string; review: string; done: string };
  status_field: string;
  plan_field: string;
  max_workers: number;
  tick_seconds: number;
  branches: { base: string; plan_prefix: string; task_prefix: string };
  task_merge_strategy: "squash" | "merge";
  pr: {
    reviewers: string[];
    body_template: string;
    labels: string[];
  };
  builder_tier: "small" | "medium" | "big";
  builder_timeout_ms?: number;
  builder_retries: number;
  safety: {
    max_stuck_building: number;
    require_clean_worktree: boolean;
    skip_closed_issues: boolean;
  };
  bot_identity: string;
}

const DEFAULTS: Config = {
  project: { owner: "", number: 0 },
  columns: { ready: "Ready", building: "Building", review: "Review", done: "Done" },
  status_field: "Status",
  plan_field: "Plan",
  max_workers: 2,
  tick_seconds: 90,
  branches: { base: "main", plan_prefix: "plan/", task_prefix: "task/" },
  task_merge_strategy: "squash",
  pr: { reviewers: [], body_template: ".github/PULL_REQUEST_TEMPLATE.md", labels: ["board-agent"] },
  builder_tier: "medium",
  builder_retries: 1,
  safety: { max_stuck_building: 3, require_clean_worktree: true, skip_closed_issues: true },
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
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return (overlay as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(cwd: string): Config {
  const projectPath = resolve(cwd, ".pi", "board-agent.yml");
  const globalPath = resolve(homedir(), ".pi", "board-agent.yml");
  let cfg: Config = DEFAULTS;
  if (existsSync(globalPath)) cfg = deepMerge(cfg, parseYaml(readFileSync(globalPath, "utf-8")) ?? {});
  if (existsSync(projectPath)) cfg = deepMerge(cfg, parseYaml(readFileSync(projectPath, "utf-8")) ?? {});
  return cfg;
}

export function validateConfig(cfg: Config): void {
  if (!cfg.project.number || cfg.project.number <= 0) {
    throw new ConfigError("config.project.number is required and must be > 0. Edit .pi/board-agent.yml");
  }
  if (cfg.max_workers < 1 || cfg.max_workers > 16) {
    throw new ConfigError("config.max_workers must be between 1 and 16 (pi-dynamic-workflows hard cap).");
  }
  if (!cfg.columns.ready || !cfg.columns.building || !cfg.columns.review || !cfg.columns.done) {
    throw new ConfigError("config.columns.{ready,building,review,done} must all be set.");
  }
  if (cfg.task_merge_strategy !== "squash" && cfg.task_merge_strategy !== "merge") {
    throw new ConfigError("config.task_merge_strategy must be 'squash' or 'merge'.");
  }
}

/** Derive the owner from `origin` when config.project.owner is empty. */
export function resolveOwner(cfg: Config, cwd: string): { owner: string; repoName: string } {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8" });
  if (remote.status !== 0) throw new ConfigError(`No git origin in ${cwd}: ${remote.stderr}`);
  const url = remote.stdout.trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) throw new ConfigError(`origin is not a GitHub remote: ${url}`);
  const ownerFromOrigin = m[1];
  const repoName = m[2];
  return { owner: cfg.project.owner || ownerFromOrigin, repoName };
}

/** Slug for a plan/<slug> branch — sanitize the plan-field value. */
export function planSlug(planName: string): string {
  return planName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Branch for a single task. Task ids look like "T001" or just an issue number. */
export function taskBranch(prefix: string, taskKey: string | number): string {
  const key = String(taskKey).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `${prefix}${key}`;
}

export function planBranch(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

export { DEFAULTS as _DEFAULTS };

/** Read a config-template overlay from the package itself (for `init` command). */
export function readConfigTemplate(): string {
  const candidates = [
    resolve(__dirname, "..", "config-template.yml"),
    resolve(__dirname, "..", "..", "config-template.yml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf-8");
  }
  // Fallback: emit a serialized version of DEFAULTS.
  return [
    "# pi-board-agent config (auto-generated fallback)",
    `project:`,
    `  owner: ""`,
    `  number: 0`,
    `columns:`,
    `  ready: "Ready"`,
    `  building: "Building"`,
    `  review: "Review"`,
    `  done: "Done"`,
    `status_field: "Status"`,
    `plan_field: "Plan"`,
    `max_workers: 2`,
    `tick_seconds: 90`,
    `branches:`,
    `  base: "main"`,
    `  plan_prefix: "plan/"`,
    `  task_prefix: "task/"`,
    `task_merge_strategy: "squash"`,
    `pr:`,
    `  reviewers: []`,
    `  labels: ["board-agent"]`,
    `builder_tier: "medium"`,
    `builder_retries: 1`,
    `safety:`,
    `  max_stuck_building: 3`,
    `  require_clean_worktree: true`,
    `  skip_closed_issues: true`,
    `bot_identity: ""`,
    "",
  ].join("\n");
}
