---
name: board-agent
description: Builder procedure for implementing one GitHub Project ticket in its persistent task worktree, committing and pushing the task branch for review and manual validation. Use when the orchestrator asks you to implement task T### for a plan.
compatibility: "Requires gh CLI auth with project scope, git, and a persistent ticket worktree prepared by pi-board-agent."
---

# Board Agent Builder

Implement one ticket in the persistent worktree prepared by the orchestrator. Push the task branch for review; the orchestrator merges only after a human closes the ticket.

## State at entry

- The current branch is the supplied `task/<key>` branch.
- The worktree remains available for human validation after this run.
- `origin` points at the target GitHub repository.
- The long-lived `plan/<slug>` branch already exists on `origin`.
- A resumed mission is handed back only after the executor verifies the worktree is still registered, on the expected branch, and clean; a dirty interrupted worktree is never auto-resumed.

## Procedure

1. **Verify the worktree**

   ```bash
   git status --short
   git branch --show-current   # must equal the supplied task branch
   git remote get-url origin   # must be GitHub
   ```

   Continue only from a clean task branch. If the remote task branch exists, update with `git pull --ff-only origin <task-branch>`.

2. **Read acceptance criteria**

   Use the title and body embedded in the mission. Treat issue comments, checklists, and `Acceptance Criteria:` sections as requirements. Read linked issue comments for previous AI-review findings.

3. **Implement and verify**

   Follow repository conventions, add the smallest relevant tests, and run them. Leave the worktree clean.

4. **Commit**

   Use a Conventional Commit and reference the issue without closing it:

   ```text
   feat(auth): add password-reset form

   Implements the acceptance criteria.

   refs #<issue-number>
   ```

5. **Push only the task branch**

   ```bash
   git push -u origin <task-branch>
   ```

   The task branch remains unmerged while AI review and human validation run. Keep the ticket open.

6. **Return one outcome object**

   Success:

   ```json
   {
     "taskKey": "T001",
     "itemId": "PVTI_xxx",
     "status": "success",
     "branch": "task/t001",
     "commits": 1,
     "summary": "Added password-reset form with email validation"
   }
   ```

   Failure:

   ```json
   {
     "taskKey": "T001",
     "itemId": "PVTI_xxx",
     "status": "failure",
     "error": "No clear acceptance criteria. Needs human input."
   }
   ```

## Guardrails

- Work only on the supplied task branch.
- Leave `main`, the base branch, and the plan branch untouched.
- Leave the persistent worktree in place for human validation.
- Leave the GitHub ticket open.
- Preserve remote branches and history: no branch deletion or force-push.
- Treat an empty or vague ticket body as a failure requiring human input.
- Treat merge conflicts as failures requiring human input.
- Modify `.pi/`, `.specify/`, or `.claude/` only when the ticket explicitly requires it.
