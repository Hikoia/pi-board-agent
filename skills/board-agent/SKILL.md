---
name: board-agent
description: Builder agent for the pi-board-agent workflow. When a card is picked from a GitHub Project (v2) Ready column, this skill tells the builder agent how to implement the task, commit it, merge it into the plan branch, and return a structured outcome. Use this skill when the orchestrator asks you to "implement task T### for plan <slug>".
compatibility: "Requires gh CLI auth with project scope, git, and a clean worktree (provided by pi-dynamic-workflows isolation: worktree)."
---

# Board Agent Builder

You are running inside an **isolated git worktree** created by
pi-dynamic-workflows. Your job is to implement ONE task from a GitHub Project
card, commit it to a task branch, merge it into the plan branch, and report
back.

## State at entry

- You are at the root of a throwaway git worktree based on the **plan branch**
  (`plan/<slug>`).
- `origin` points at the target repo.
- The plan branch already exists on `origin` and was pulled fresh.
- A task branch **does not yet exist** — you create it.

## Procedure (strict)

1. **Verify you're in a worktree**
   ```bash
   git status  # should show a clean plan/<slug> branch
   git remote get-url origin | grep -q github.com  # safety: must be GitHub
   ```

2. **Read the card's acceptance criteria**
   The orchestrator passing you the task already embedded `title` and `body`
   in your prompt. If `body` contains `<!-- acceptance criteria -->` or
   similar structured markdown, parse it. Look for checklists (`- [ ]`)
   or explicit `Acceptance Criteria:` sections.

3. **Create the task branch**
   ```bash
   git checkout -b <task-branch>  # name given by orchestrator in the prompt
   ```

4. **Implement the task**
   - Add / modify / delete files as needed.
   - Write tests for the changed code (unit or integration).
   - Follow existing patterns in the repo: import style, naming conventions,
     logging, error handling.
   - If you need to read other files in the monorepo, do so — you have a full
     copy.

5. **Commit**
   Use [Conventional Commits](https://www.conventionalcommits.org/).
   The commit message footer MUST reference the linked GitHub issue:
   ```
   feat(auth): add password-reset form

   Implements the reset-password flow per acceptance criteria.

   closes #<issue-number>
   ```

6. **Push**
   ```bash
   git push -u origin <task-branch>
   ```

7. **Merge into the plan branch**
   The orchestrator specifies `task_merge_strategy`: `"squash"` or `"merge"`.

   Squash (recommended: 1 commit per task on the plan branch):
   ```bash
   git checkout <plan-branch>           # plan/<slug>
   git pull --ff-only origin <plan-branch>
   git merge --squash <task-branch>
   git commit -m "<conventional-commit closing #<issue-number>>"
   ```
   Merge (preserve history):
   ```bash
   git checkout <plan-branch>
   git pull --ff-only origin <plan-branch>
   git merge --no-ff <task-branch>
   ```

8. **Push the plan branch**
   ```bash
   git push origin <plan-branch>
   ```

9. **Return outcome**
   Report a JSON object. On success:
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
   On failure (do NOT throw — return this object so the orchestrator can
   retry later):
   ```json
   {
     "taskKey": "T001",
     "itemId": "PVTI_xxx",
     "status": "failure",
     "error": "Merge conflict in src/auth/reset.ts — may need manual resolution"
   }
   ```

## Constraints (NEVER violate)

- ❌ Never push to `main` (or the `base` branch — only `<task-branch>` and `<plan-branch>` are allowed).
- ❌ Never delete a remote branch.
- ❌ Never force-push.
- ❌ Never modify `.pi/`, `.specify/`, `.claude/` directories unless the
  task's body explicitly instructs you to.
- ❌ Never run `npm install` with untrusted flags.
- ✅ If a merge conflict arises, report it as a `failure` outcome immediately
  — do not attempt to resolve it blindly.
- ✅ If the task body is empty or vague, report it as a `failure` outcome
  (`error: "No clear acceptance criteria. Needs human input."`).

## Tips

- Use `git stash` if you need to context-switch during implementation (rare).
- Use `rg` (ripgrep) to search the codebase quickly.
- The worktree is ephemeral — the orchestrator will clean it up after you
  finish. Don't worry about leaving it dirty.
- If `gh` CLI auth fails during push, report a `failure` outcome with the
  exact error message.