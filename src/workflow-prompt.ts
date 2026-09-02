/**
 * Renders the JavaScript workflow source that pi-dynamic-workflows will
 * execute. Each invocation runs one builder in a persistent ticket worktree
 * prepared by the board loop and returns a JSON-shaped result for that card.
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
  planBranch: string;    // merged only after review + manual issue closure
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
 * `workflow` tool. The script returns a one-entry JSON array describing the
 * outcome: { taskKey, status: "success"|"failure", branch, error? }.
 */
export function renderWorkflowSource(input: {
  cfg: Config;
  planSlug: string;
  baseBranch: string;
  tasks: BuilderTask[];
  skillName: string;       // procedure label included in the self-contained mission
  context?: string;        // repo digest (see src/context.ts) — optional
}): string {
  if (input.tasks.length !== 1) {
    throw new Error("Persistent ticket worktrees require exactly one task per workflow");
  }

  const payload = JSON.stringify({
    tasks: input.tasks,
    cfg: {
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
  name: 'board-agent-build-${input.planSlug}',
  description: 'Build one ticket in its persistent worktree',
  phases: [{ title: 'Build' }],
};

const PAYLOAD = ${payload};
const t = PAYLOAD.tasks[0];

phase('Build');

const result = await agent(
  [
    'You are a board-agent builder running inside the persistent worktree for this ticket. If this is a resumed run, the executor has already verified this worktree is registered, on the expected branch, and clean.',
    '',
    'Plan slug: ' + PAYLOAD.planSlug,
    'Base branch: ' + PAYLOAD.cfg.base,
    'Plan branch (do not merge yet): ' + t.planBranch,
    'Task branch (already checked out): ' + t.taskBranch,
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
    '1. Follow the ' + PAYLOAD.skillName + ' procedure in this mission exactly.',
    '2. Verify \`git branch --show-current\` is \`' + t.taskBranch + '\`. Do not switch to the plan branch.',
    '3. If origin/' + t.taskBranch + ' exists, pull it with \`git pull --ff-only origin ' + t.taskBranch + '\`.',
    '4. Read the linked issue comments with \`gh issue view ' + (t.issueNumber ?? '<none>') + ' --comments\` and address any AI review findings. Then implement the task, add tests where applicable, and commit with a clear conventional-commit message.',
    '5. Push your task branch: \`git push -u origin ' + t.taskBranch + '\`.',
    '6. Do NOT merge into ' + t.planBranch + ' and do NOT close the ticket. The board loop waits for review and manual validation.',
    '7. Return a JSON object describing the outcome. ON SUCCESS:',
    '     { "taskKey": "' + t.taskKey + '", "itemId": "' + t.itemId + '", "status": "success", "branch": "' + t.taskBranch + '", "commits": <number>, "summary": "<one-line summary>" }',
    '   ON FAILURE (do NOT throw — return this object):',
    '     { "taskKey": "' + t.taskKey + '", "itemId": "' + t.itemId + '", "status": "failure", "error": "<reason>" }',
    '',
    'Constraints:',
    ' - This worktree is retained for human validation; do not create or remove worktrees.',
    ' - Never push to \`' + PAYLOAD.cfg.base + '\` or \`' + t.planBranch + '\`. Only push \`' + t.taskBranch + '\`.',
    ' - Never delete a branch.',
    ' - Never force-push.',
    ' - Stay inside this repo.',
    ' - Modify .pi/, .specify/, or .claude/ only when the ticket explicitly requires it.',
  ].join('\\n'),
  {
    tier: PAYLOAD.cfg.builder_tier,
    model: PAYLOAD.models.builder,
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
);

return [result];
`.trimStart();
}
