/**
 * /board-agent init-project — initialize a GitHub Project (v2) with the
 * project's standard board: Status single-select (6 columns), Type
 * single-select (Story | Task), Plan text field, and a Board view grouped
 * by Status.
 */
import type { Config } from "./config.js";
import { ensureStandardFields, getProjectMetadata, type ProjectMetadata } from "./gh.js";

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
        cfg.columns.backlog,
        cfg.columns.ready,
        cfg.columns.building,
        cfg.columns.needs_design,
        cfg.columns.review,
        cfg.columns.done,
      ],
      colors: ["GRAY", "BLUE", "YELLOW", "ORANGE", "PURPLE", "GREEN"],
    },
    {
      name: cfg.type_field,
      kind: "single" as const,
      options: ["Story", "Task"],
      colors: ["BLUE", "PURPLE"],
    },
    {
      name: cfg.plan_field,
      kind: "text" as const,
    },
  ];
}

export async function initProject(owner: string, number: number, cfg: Config): Promise<InitResult> {
  const meta = await getProjectMetadata(owner, number, cfg.status_field, cfg.plan_field, cfg.type_field);
  const specs = buildStandardSpecs(cfg);
  const { created, existing } = await ensureStandardFields(meta, specs, "Board");
  return { created, existing, view: "Board" };
}

export type { ProjectMetadata };