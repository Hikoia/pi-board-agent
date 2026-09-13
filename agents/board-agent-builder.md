# board-agent-builder

**NON-production compatibility pointer.** This packaged path remains available
for older integrations; production does not select `agentType: "board-agent-builder"`.

For the reusable builder procedure, read
[`skills/board-agent/SKILL.md`](../skills/board-agent/SKILL.md).
For the actual per-ticket production mission and result schema, read
[`renderWorkflowSource` in `src/workflow-prompt.ts`](../src/workflow-prompt.ts).
The executor supplies that mission to the managed builder in its prepared
persistent worktree. This file defines neither a second rule body nor tool permissions.
