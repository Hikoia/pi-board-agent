/**
 * Renders the JavaScript workflow source that pi-dynamic-workflows will
 * execute. The workflow:
 *  - fans out one `agent()` call per card, all running in parallel with
 *    `isolation: "worktree"` (each worker gets a throwaway git worktree)
 *  - returns a JSON-shaped result per card so the loop can update the board
 *
 * The workflow is generated dynamically because pi-dynamic-workflows runs
 * scripts in a sandboxed VM (no `require`/`import`/`fs`/network), so we
 * must embed the per-card payload as literal data.
 */

import type { Card } from "./gh.js";
import type { Config } from "./config.js";
import { planBranch as makePlanBranch, taskBranch as makeTaskBranch } from "./config.js";

export interface BuilderTask {
  itemId: string;
  taskKey: string;       // T001, T002, ... or issue number when no Tnnn
  issueNumber?: number;
  title: string;
  body: string;
  taskBranch: string;    // branch the builder should push to
  planBranch: string;    // branch that the task branch should merge into
}

export function buildTasksForWave(cfg: Config, planSlug: string, cards: Card[]): BuilderTask[] {
  const planB = makePlanBranch(cfg.branches.plan_prefix, planSlug);
  return cards.map((c) => {
    const taskKey = extractTaskKey(c) ?? (c.number ? `issue-${c.number}` : `item-${c.itemId.slice(-6)}`);
    return {
      itemId: c.itemId,
      taskKey,
      issueNumber: c.number,
      title: c.title,
      body: c.body,
      taskBranch: makeTaskBranch(cfg.branches.task_prefix, taskKey),
      planBranch: planB,
    };
  });
}

const TASK_KEY_RE = /\bT(\d{1,4})\b/;

export function extractTaskKey(card: Card): string | undefined {
  const m = TASK_KEY_RE.exec(card.title) ?? TASK_KEY_RE.exec(card.body);
  if (m) return `T${m[1].padStart(3, "0")}`;
  return undefined;
}

/**
 * Returns a JavaScript module string compatible with the pi-dynamic-workflows
 * `workflow` tool. The script returns a JSON array (one entry per card)
 * describing the outcome: { taskKey, status: "success"|"failure", branch, error? }.
 */
export function renderWorkflowSource(input: {
  cfg: Config;
  planSlug: string;
  baseBranch: string;
  tasks: BuilderTask[];
  skillName: string;       // "board-agent" — pi will load skills/board-agent/SKILL.md
  context?: string;        // repo digest (see src/context.ts) — optional
}): string {
  const payload = JSON.stringify({
    tasks: input.tasks,
    cfg: {
      task_merge_strategy: input.cfg.task_merge_strategy,
      base: input.baseBranch,
      builder_tier: input.cfg.builder_tier,
      builder_timeout_ms: input.cfg.builder_timeout_ms,
      builder_retries: input.cfg.builder_retries,
    },
    models: {
      builder: input.cfg.models.builder,
    },
    context: input.context ?? null,
    skillName: input.skillName,
    planSlug: input.planSlug,
  });

  // The body of an agent() prompt is plain text. We embed taskKey/title/body
  // verbatim, plus the repo context digest (when enabled), then instruct the
  // subagent to load the board-agent skill and follow it step by step.
  return `
export const meta = {
  name: 'board-agent-wave-${input.planSlug}',
  description: 'Wave of ${input.tasks.length} builder agent(s) for plan ${input.planSlug}',
  phases: [{ title: 'Build' }],
};

const PAYLOAD = ${payload};

phase('Build');

const results = await parallel(
  PAYLOAD.tasks.map((t) => () => agent(
    [
      'You are a board-agent builder running inside a fresh git worktree.',
      '',
      'Plan slug: ' + PAYLOAD.planSlug,
      'Base branch: ' + PAYLOAD.cfg.base,
      'Plan branch (long-lived, already exists on origin): ' + t.planBranch,
      'Your task branch (you will create + push): ' + t.taskBranch,
      'Task merge strategy: ' + PAYLOAD.cfg.task_merge_strategy,
      '',
      'Card title: ' + t.title,
      '',
      'Card body (acceptance criteria):',
      '----8<----',
      t.body,
      '----8<----',
      '',
      ...(PAYLOAD.context ? ['', 'REPO CONTEXT (use this instead of exploring the whole repo):', '----8<----', PAYLOAD.context, '----8<----', ''] : []),
      'Procedure (follow EXACTLY):',
      '',
      '1. Read the board-agent skill (skills/board-agent/SKILL.md) for full details.',
      '2. Checkout the plan branch: \`git checkout ' + t.planBranch + ' && git pull --ff-only\`.',
      '3. Create your task branch off the plan branch: \`git checkout -b ' + t.taskBranch + '\`.',
      '4. Read the linked issue comments with \`gh issue view ' + (t.issueNumber ?? '<none>') + ' --comments\` and address any AI review findings. Then implement the task, add tests where applicable, and commit with a clear conventional-commit message that ends with: closes #' + (t.issueNumber ?? '<none>') + '.',
      '5. Push your task branch: \`git push -u origin ' + t.taskBranch + '\`.',
      '6. Merge your task branch into the plan branch. If task_merge_strategy is "squash", run:',
      '     git checkout ' + t.planBranch + ' && git pull --ff-only && git merge --squash ' + t.taskBranch + ' && git commit -m "<conventional commit closing #' + (t.issueNumber ?? '<none>') + '>"',
      '   If "merge":',
      '     git checkout ' + t.planBranch + ' && git pull --ff-only && git merge --no-ff ' + t.taskBranch,
      '7. Push the updated plan branch: \`git push origin ' + t.planBranch + '\`.',
      '8. Return a JSON object describing the outcome. ON SUCCESS:',
      '     { "taskKey": "' + t.taskKey + '", "itemId": "' + t.itemId + '", "status": "success", "branch": "' + t.taskBranch + '", "commits": <number>, "summary": "<one-line summary>" }',
      '   ON FAILURE (do NOT throw — return this object):',
      '     { "taskKey": "' + t.taskKey + '", "itemId": "' + t.itemId + '", "status": "failure", "error": "<reason>" }',
      '',
      'Constraints:',
      ' - You are inside an isolated worktree: \`git worktree\` is set up for you, do not create another one.',
      ' - Never push to \`' + PAYLOAD.cfg.base + '\`. Only \`' + t.taskBranch + '\` and \`' + t.planBranch + '\`.',
      ' - Never delete a remote branch.',
      ' - Never force-push.',
      ' - Stay inside this repo.',
    ].join('\\n'),
    {
      tier: PAYLOAD.cfg.builder_tier,
      model: PAYLOAD.models.builder,
      isolation: 'worktree',
      label: 'build ' + t.taskKey,
      retries: PAYLOAD.cfg.builder_retries,
      ...(PAYLOAD.cfg.builder_timeout_ms ? { timeoutMs: PAYLOAD.cfg.builder_timeout_ms } : {}),
      schema: {
        type: 'object',
        required: ['taskKey', 'itemId', 'status'],
        properties: {
          taskKey: { type: 'string' },
          itemId: { type: 'string' },
          status: { type: 'string', enum: ['success', 'failure'] },
          branch: { type: 'string' },
          commits: { type: 'number' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  )),
);

return results;
`.trimStart();
}
