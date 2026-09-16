/**
 * /board-agent init-project — initialize a GitHub Project (v2) with the
 * Task board: Status single-select (5 required columns), Type
 * single-select (Task), and a Board view grouped
 * by Status.
 */
import type { Config } from "./config.js";
import { ensureStandardFields, getProjectMetadata, validateProjectMetadata, type ProjectMetadata } from "./gh.js";

export interface InitResult {
  created: string[];
  existing: string[];
  view: string;
}

export function buildStandardSpecs(cfg: Config) {
  return [
    {
      name: cfg.status_field,
      kind: "single" as const,
      options: [
        cfg.columns.ready,
        cfg.columns.building,
        cfg.columns.needs_human,
        cfg.columns.review,
        cfg.columns.done,
      ],
      colors: ["BLUE", "YELLOW", "RED", "PURPLE", "GREEN"],
    },
    {
      name: cfg.type_field,
      kind: "single" as const,
      options: ["Task"],
      colors: ["PURPLE"],
    },
  ];
}

export async function initProject(owner: string, number: number, cfg: Config): Promise<InitResult> {
  const meta = await getProjectMetadata(owner, number, cfg.status_field, cfg.type_field);
  const specs = buildStandardSpecs(cfg);
  const { created, existing } = await ensureStandardFields(meta, specs, "Board");
  const refreshed = await getProjectMetadata(owner, number, cfg.status_field, cfg.type_field);
  try {
    validateProjectMetadata(refreshed, cfg);
  } catch (error: any) {
    throw new Error(`${error.message}. Add missing required options manually; init-project never rewrites an existing option list.`);
  }
  return { created, existing, view: "Board" };
}

export type { ProjectMetadata };