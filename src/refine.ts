/**
 * Phase C — story refinement + task breakdown.
 *
 * A story card (Type=Story) entering Ready is refined in ONE cheap-model pass
 * (no SpecKit): the agent receives the story body + the repo context digest
 * and returns a schema-constrained RefineOutput. If openQuestions is
 * non-empty the story goes to Needs Design and waits for human answers on the
 * linked issue (comment polling); otherwise sub-issue tasks are created on the
 * board (Status=Ready, Plan=<slug>, Type=Task) with acceptance criteria.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runWorkflow } from "@quintinshaw/pi-dynamic-workflows";
import type { Config } from "./config.js";
import type { Card, ProjectMetadata } from "./gh.js";
import {
  createIssue,
  addIssueToProject,
  createComment,
  setSingleSelect,
  setTextField,
  resolveIssueId,
} from "./gh.js";

export interface RefineTask {
  title: string;
  acceptanceCriteria: string[];
}

export interface RefineOutput {
  goal: string;
  impactedAreas: string[];
  decisions: string[];
  risks: string[];
  openQuestions: string[];
  tasks: RefineTask[];
}

export interface RefineRunInput {
  cwd: string;
  storyTitle: string;
  storyBody: string;
  extraContext: string; // human answers from Needs Design re-runs
  contextDigest: string;
  model: string;
  timeoutMs: number;
}

/** Render a single-agent workflow that returns a schema-constrained RefineOutput. */
export function renderRefineWorkflowSource(input: RefineRunInput): string {
  const payload = JSON.stringify({
    storyTitle: input.storyTitle,
    storyBody: input.storyBody,
    extraContext: input.extraContext,
    contextDigest: input.contextDigest,
  });
  return `
export const meta = {
  name: 'board-agent-refine',
  description: 'Refine a story: goal, impacted areas, decisions, risks, open questions, task breakdown',
  phases: [{ title: 'Refine' }],
};

const PAYLOAD = ${payload};

phase('Refine');

const result = await agent(
  [
    'You are a senior product+technical designer refining a story for implementation.',
    'Return the RefineOutput JSON ONLY (schema-enforced). Be concise; no prose.',
    'MINIMALISM: Current acceptance criteria set the scope. Reuse existing modules and standard-library/native capabilities before proposing new code or dependencies. Produce the fewest dependency-ordered tasks that can be implemented and verified safely; defer hypothetical flexibility and infrastructure.',
    '',
    'STORY TITLE: ' + PAYLOAD.storyTitle,
    '',
    'STORY BODY:',
    '----8<----',
    PAYLOAD.storyBody,
    '----8<----',
    '',
    ...(PAYLOAD.extraContext ? ['HUMAN ANSWERS TO PREVIOUS QUESTIONS:', '----8<----', PAYLOAD.extraContext, '----8<----', ''] : []),
    'REPO CONTEXT (existing code — use it to ground the design):',
    '----8<----',
    PAYLOAD.contextDigest,
    '----8<----',
    '',
    'RULES:',
    ' - openQuestions: only real blockers/ambiguities that need a human decision. Empty if the story is clear.',
    ' - tasks: a minimal, dependency-ordered breakdown (1-12 tasks). Each task needs a short title and 1-5 acceptance criteria.',
    ' - impactedAreas: paths/domains in the repo (from REPO CONTEXT) that will change.',
    ' - decisions: design decisions you made, grounded in the existing code.',
    ' - risks: technical risks and how to mitigate.',
  ].join('\\n'),
  {
    model: ${JSON.stringify(input.model)},
    timeoutMs: ${input.timeoutMs},
    label: 'refine',
    schema: {
      type: 'object',
      required: ['goal', 'impactedAreas', 'decisions', 'risks', 'openQuestions', 'tasks'],
      properties: {
        goal: { type: 'string' },
        impactedAreas: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'acceptanceCriteria'],
            properties: {
              title: { type: 'string' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
);

return result;
`.trimStart();
}

/** Validate/normalize a raw refine result into RefineOutput. */
export function parseRefineOutput(raw: unknown): RefineOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.goal !== "string") return null;
  const tasks = Array.isArray(r.tasks)
    ? r.tasks
        .filter(
          (t): t is RefineTask =>
            !!t &&
            typeof t === "object" &&
            typeof (t as RefineTask).title === "string" &&
            Array.isArray((t as RefineTask).acceptanceCriteria),
        )
        .slice(0, 12)
    : [];
  return {
    goal: r.goal,
    impactedAreas: asStrings(r.impactedAreas),
    decisions: asStrings(r.decisions),
    risks: asStrings(r.risks),
    openQuestions: asStrings(r.openQuestions),
    tasks,
  };
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Run the refine pass via pi-dynamic-workflows (single agent, cheap model). */
export async function runRefine(input: RefineRunInput): Promise<RefineOutput> {
  const script = renderRefineWorkflowSource(input);
  const res = await runWorkflow(script, {
    cwd: input.cwd,
    persistLogs: true,
  });
  const parsed = parseRefineOutput(res.result);
  if (!parsed) throw new Error(`Refine returned an invalid result: ${JSON.stringify(res.result).slice(0, 300)}`);
  return parsed;
}

// ── Task creation ───────────────────────────────────────────────────────────

export interface CreateTasksInput {
  cfg: Config;
  meta: ProjectMetadata;
  repoOwner: string;
  repoName: string;
  storyCard: Card; // the story issue (must have number + repo)
  planSlug: string;
  refine: RefineOutput;
  existingTaskCount: number; // tasks already in this plan (for T-numbering)
  projectId: string;
}

export interface CreatedTask {
  number: number;
  url: string;
  itemId?: string;
  taskKey: string;
}

/** Create sub-issue tasks under the story, add them to the project and set fields. */
export async function createTasksFromRefine(input: CreateTasksInput): Promise<CreatedTask[]> {
  const { cfg, meta, repoOwner, repoName, storyCard, planSlug, refine, existingTaskCount, projectId } = input;
  if (!storyCard.number) throw new Error("Story card has no issue number — cannot create sub-issues.");
  const parentIssueId = await resolveIssueId(repoOwner, repoName, storyCard.number);

  const created: CreatedTask[] = [];
  const cap = Math.min(cfg.refine.max_tasks, refine.tasks.length);
  for (let i = 0; i < cap; i++) {
    const t = refine.tasks[i];
    const seq = existingTaskCount + i + 1;
    const taskKey = `T${String(seq).padStart(3, "0")}`;
    const title = `${taskKey}: ${t.title}`;
    const body = [
      `## Task · plan \`${planSlug}\``,
      "",
      `_Part of story #${storyCard.number} (refined automatically by pi-board-agent)._`,
      "",
      "### Acceptance criteria",
      "",
      ...t.acceptanceCriteria.map((c) => `- [ ] ${c}`),
      "",
    ].join("\n");

    const issue = await createIssue({ repoOwner, repoName, title, body, parentIssueId });
    let itemId: string | undefined;
    try {
      itemId = await addIssueToProject(projectId, issue.id);
    } catch {
      // project link failed — issue still exists; fields can't be set.
    }
    if (itemId) {
      const set: Promise<void>[] = [];
      if (meta.statusFieldId) {
        set.push(setSingleSelect(meta, itemId, meta.statusFieldId, cfg.columns.ready, meta.statusOptions).catch(() => undefined));
      }
      if (meta.planFieldId) {
        set.push(setTextField(meta, itemId, meta.planFieldId, planSlug).catch(() => undefined));
      }
      if (meta.typeFieldId && meta.typeOptions) {
        set.push(setSingleSelect(meta, itemId, meta.typeFieldId, "Task", meta.typeOptions).catch(() => undefined));
      }
      await Promise.all(set);
    }
    created.push({ number: issue.number, url: issue.url, itemId, taskKey });
  }
  return created;
}

// ── Refine state (Needs Design comment polling) ─────────────────────────────

export interface RefineState {
  [issueNumber: number]: {
    lastSeenCommentId?: string;
    refined: boolean; // tasks already created
  };
}

export class RefineStateStore {
  private file: string;
  constructor(cwd: string) {
    this.file = resolve(cwd, ".pi", "board-agent", "refine-state.json");
    mkdirSync(resolve(cwd, ".pi", "board-agent"), { recursive: true });
  }
  load(): RefineState {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as RefineState;
    } catch {
      return {};
    }
  }
  save(state: RefineState): void {
    writeFileSync(this.file, JSON.stringify(state, null, 2), "utf8");
  }
  get(issueNumber: number): RefineState[number] | undefined {
    return this.load()[issueNumber];
  }
  update(issueNumber: number, patch: Partial<RefineState[number]>): void {
    const state = this.load();
    state[issueNumber] = { ...(state[issueNumber] ?? { refined: false }), ...patch };
    this.save(state);
  }
}

/** Markdown summary posted on the story after refinement. */
export function renderRefineComment(planSlug: string, refine: RefineOutput, created: CreatedTask[]): string {
  const lines = [
    `## ✅ Refined — plan \`${planSlug}\``,
    "",
    `**Goal:** ${refine.goal}`,
    "",
  ];
  if (refine.impactedAreas.length) {
    lines.push("**Areas:** " + refine.impactedAreas.join(", "));
  }
  if (refine.decisions.length) {
    lines.push("", "**Design decisions:**", "", ...refine.decisions.map((d) => `- ${d}`));
  }
  if (refine.risks.length) {
    lines.push("", "**Risks:**", "", ...refine.risks.map((r) => `- ${r}`));
  }
  if (created.length) {
    lines.push("", `**Tasks created (${created.length}):**`, "", ...created.map((c) => `- [#${c.number}](${c.url}) ${c.taskKey}`));
  }
  return lines.join("\n");
}

/** Markdown comment listing the open questions (Needs Design). */
export function renderQuestionsComment(planSlug: string, refine: RefineOutput): string {
  return [
    `## ❓ Domande di design — plan \`${planSlug}\``,
    "",
    "La storia è in **Needs Design**: rispondi a queste domande nei commenti qui sotto e il refine ripartirà da solo.",
    "",
    ...refine.openQuestions.map((q, i) => `${i + 1}. ${q}`),
    "",
  ].join("\n");
}

export { createComment as _createComment };
