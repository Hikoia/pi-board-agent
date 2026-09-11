# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

A durable GitHub Project (v2) executor for [Pi](https://pi.dev/). Move an
Issue to `Ready`; Board Agent builds it in a persistent per-Issue worktree,
optionally reviews the exact pushed commit, waits for human validation, and
integrates it only after the Issue is closed.

> **Git-only package:** install this repository at a reviewed, full 40-character
> commit SHA. It is not published to npm.

## Workflow

```text
Story Ready
  → refine once
  → create/reconcile marked child Issues exactly once
  → child Tasks Ready

Task Ready
  → assignee claim + fresh Project-item validation
  → persistent worktree on task/issue-<number>
  → one durable WorkflowManager builder
  → Review
  → optional detached AI review, or manual validation
  → Done (still unmerged; worktree retained)
  → human closes the Issue
  → no local task branch? already settled
  → otherwise merge/squash local task branch into branches.base (main by default)
  → push and verify origin/base
  → delete remote branch, worktree, then local task branch
```

`Plan` is required to claim/build a ticket, not to finish one. A closed `Done`
Task needs no execution record or review marker for finalization. If its local
`task/issue-<number>` branch is absent, Board Agent leaves it settled without
querying remote branches or deleting leftover files.

`Needs Design` accepts decisions only from repository `OWNER`, `MEMBER`, or
`COLLABORATOR` comments. `Needs Human` is terminal until a human fixes the
reported blocker and moves the card back to `Ready`.

Only open GitHub **Issues** from the repository configured by `origin` can
enter refinement, building, or review. Closed `Done` Task Issues are eligible
only for finalization. Pull requests, draft Project items, cross-repository
Issues, and cards without the exact configured `Type` (`Story` or `Task`) are
never mutated.

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.80.8`
- `git`
- On Windows: Windows PowerShell with `Add-Type`/PInvoke permitted (FullLanguage
  mode), for deadline-enforced process Job Objects
- authenticated `gh` CLI with Project scope:

  ```bash
  gh auth login
  gh auth refresh -s project
  ```

- GitHub Project fields:
  - `Status`: `Backlog`, `Ready`, `In Progress`, `Needs Design`,
    `Needs Human`, `Review`, `Done`
  - `Plan`: text or single-select
  - configured type field (default `Kind`): `Story`, `Task`

## Install

```bash
pi install git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>
# Restart Pi after changing the pin.
```

Then, in the target repository:

```text
/board-agent init
# edit .pi/board-agent.yml
/board-agent lint
/board-agent run
```

Use `/board-agent status` to inspect the loop and `/board-agent stop` for a
graceful stop that pauses managed runs before releasing ownership.

### Update

Stop Board Agent, install the new reviewed SHA, restart Pi, and run lint:

```powershell
$LATEST_SHA = gh api repos/Hikoia/pi-board-agent/commits/main --jq .sha
if ($LASTEXITCODE -ne 0 -or -not $LATEST_SHA) { throw "Failed to retrieve commit SHA" }
pi install "git:github.com/Hikoia/pi-board-agent@$LATEST_SHA"
```

A pinned package does not advance when `pi update --extensions` is run.
See [the rollout and recovery runbook](docs/runbook.md) before upgrading from
0.1.x or when persistent state exists.

## Configuration

```yaml
# .pi/board-agent.yml
project:
  owner: ""       # Project owner; empty falls back to the origin owner
  number: 12

status_field: "Status"
plan_field: "Plan"
type_field: "Kind"

columns:
  backlog: "Backlog"
  ready: "Ready"
  building: "In Progress"
  needs_design: "Needs Design"
  needs_human: "Needs Human"
  review: "Review"
  done: "Done"

branches:
  base: "main"
  task_prefix: "task/" # new branches are task/issue-<number>
task_merge_strategy: "squash" # or merge

max_workers: 2
tick_seconds: 90
builder_timeout_ms: 21600000
builder_retries: 1

models:
  builder: "deepseek-v4-flash-0731"
  refine: "deepseek-v4-flash-0731"
  review: "deepseek-v4-flash-0731"
  watch: "deepseek-v4-flash-0731"

watchdog:
  enabled: true
  respond_to_mentions: false # trusted maintainers only when enabled

safety:
  require_clean_worktree: true
  skip_closed_issues: true

auto_start: false
```

The Project owner and repository owner are separate identities. The Project
uses `project.owner`; Issue reads and mutations always use the repository
parsed from `git remote get-url origin`.

AI review is disabled by default. Validate the retained worktree, move the Task
to `Done`, then close its Issue to approve integration of its current local task
branch, including committed changes not yet pushed. Set `review.enabled: true`
for automated `Review` → `Done`. Finalization itself does not require an AI
review record; closing the Done Issue is the human approval.

The full annotated schema is in [`config-template.yml`](config-template.yml).
All counts and timers must be finite safe integers; durations must also fit a
JavaScript timer after unit conversion.

## Safety and recovery

- Every runtime Git/`gh` subprocess is non-interactive and has a fixed deadline.
  Supervisors terminate ordinary descendant trees on timeout; this is not a
  sandbox for malicious processes that deliberately escape a POSIX process group.
- One filesystem owner lock protects a checkout; the GitHub assignee plus a
  fresh post-claim read protects each Issue.
- Builder runs and their arguments are durable. Startup reconciles running,
  paused, launch-window, completed, missing, and malformed outcomes.
- AI review never runs in the main checkout. It uses a detached, disposable
  managed worktree pinned to the first fresh post-claim `origin/task` SHA.
- Review PASS persists that exact SHA before exposing `Done`.
- Finalization merges the local task branch into the fresh remote base without
  modifying the main checkout. It verifies the normal, non-force push before
  cleanup, and deletes the local branch last so failures remain retryable.
- Active builders, dirty/locked/unmanaged registered task worktrees, merge
  conflicts, failed pushes, and concurrent ref changes prevent unsafe cleanup.
  Remote-only commits are never discarded. The card stays `Done`.
- Story child markers, sub-Issue reconciliation, Project-content
  reconciliation, and atomic journals prevent duplicate children after a
  crash or ambiguous GitHub mutation result.

Persistent repository-local artifacts live under:

```text
.pi/board-agent/
├── owner.lock
├── runtime.json
├── refine-state.json
└── ticket-worktrees/<project-item-id>.json  # strict schema v3

.pi/worktrees/
├── ticket-*/   # persistent builder/human-validation worktrees
├── review-*/   # ephemeral; cleanup attempted after every review
└── watchdog-*/ # failed CI fixes retained for human recovery
```

Do not delete a dirty worktree or state record just to make automation run.
Follow the recovery matrix in [`docs/runbook.md`](docs/runbook.md).

## 0.1.x → 0.2.0 migration

There is **no automatic persistent-state migration**. Before installing 0.2.0:

1. Stop every Board Agent owner and back up `.pi/board-agent/`, all worktree
   contents (including dirty/untracked files), `git worktree list`, and task refs.
2. Finish or manually resolve old active work.
3. Remove or manually migrate legacy `.pi/board-agent/inflight/*.json` and v1/v2
   ticket records. `lint` and `run` report every unsupported path and perform no
   cleanup or GitHub mutation.
4. Remove these configuration keys: `pr`, `builder_tier`,
   `branches.plan_prefix`, and `watchdog.interval_seconds`.
5. Install dependencies normally; `pi-dynamic-workflows` is no longer bundled.
6. Replace any container deployment. Docker artifacts and daemon guidance were
   removed; Pi is a foreground process.

See [`docs/runbook.md`](docs/runbook.md) for backup commands and recovery steps.

## Commands

| Command | Description |
| --- | --- |
| `/board-agent init` | Write the packaged configuration template |
| `/board-agent lint` | Validate revision, state, config, auth, repository, Project fields, and statuses |
| `/board-agent run` | Reconcile existing state, acquire ownership, and admit new work |
| `/board-agent status` | Show revision/runtime identity, board progress, and active records |
| `/board-agent stop` | Stop admissions, settle the tick, pause runs, and release ownership |
| `/board-agent context` | Regenerate the repository context digest |
| `/board-agent init-project` | Create missing standard Project fields/options |

## Development

```bash
git clone https://github.com/Hikoia/pi-board-agent.git
cd pi-board-agent
npm ci
npm run check
npm pack --dry-run
```

CI uses exactly Node `22.19.0` on Linux and Windows and runs
`npm ci && npm run check`.

## License

MIT © Alessandro Mancini. See [LICENSE](LICENSE).
