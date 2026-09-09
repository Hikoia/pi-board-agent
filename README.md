# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

> An autonomous GitHub Project (v2) board executor for [Pi](https://pi.dev/).
> Drag a card into the `Ready` column, walk away, come back to a PR.

Built on **pi-dynamic-workflows 3.10** for journaled, resumable builders in persistent per-ticket worktrees, with an owner lock, startup reconciliation, assignee-based claiming, AI review, human validation, and direct task merges into the base branch.

> **Git-only fork:** install this repository from a pinned Git commit. This fork is not published to npm; `@mancioshell/pi-board-agent` is the upstream package.

## Watch it run

```text
┌─ Board ─────────────────────────────────────────────────────┐
│ Columns                                      │                │
├──────────────────────────────────────────────┼────────────────┤
│ Backlog │ Ready │ In Progress │ Needs Design │ Needs Human │ Review │ Done │
│  …  …   │ T001  │ T003     │        │        │  ↙ T001 Ready  │
│         │ T002  │          │        │        │ ° picked       │
│         │ T007  │          │        │        │                │
├──────────────────────────────────────────────┼────────────────┤
│  T001 → build task/T001 → Review → Done → human closes issue │
│       → merge directly into main → clean ticket worktree      │
│  T002/T003 follow the same human-gated lifecycle              │
│                                                              │
│  Each closed Done task is integrated immediately              │
│  Reviewers: @reviewer1 @reviewer2                            │
│  Labels: board-agent                                         │
└──────────────────────────────────────────────────────────────┘
```

Review PASS moves a card to `Done` without merging or closing its issue. The
persistent ticket worktree stays available for manual validation. When the
human closes the issue, board-agent merges its task branch directly into
`main` (or `branches.base`) and removes the worktree.

## Quickstart

```bash
# 1. Install one reviewed, immutable revision (pi-dynamic-workflows is bundled)
pi install git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>
# Restart Pi so the loaded code and configured revision are identical.

# 2. Scaffold config
/board-agent init

# 3. Edit .pi/board-agent.yml — set your project number and plan field
# 4. Verify everything is wired up
/board-agent lint

# 5. Start the loop
/board-agent run

# 6. Check progress anytime
/board-agent status

# 7. Stop gracefully
/board-agent stop
```

### Quick update

The package is pinned to a full commit SHA, so `pi update --extensions` only
reconciles the existing pin; it does not advance to a newer commit.

1. In Pi, pause active builders with `/board-agent stop`.
2. From a shell, fetch the latest pushed `main` SHA and install it:

   **Bash / Git Bash**

   ```bash
   LATEST_SHA=$(gh api repos/Hikoia/pi-board-agent/commits/main --jq .sha)
   pi install "git:github.com/Hikoia/pi-board-agent@$LATEST_SHA"
   ```

   **PowerShell**

   ```powershell
   $LatestSha = gh api repos/Hikoia/pi-board-agent/commits/main --jq .sha
   pi install "git:github.com/Hikoia/pi-board-agent@$LatestSha"
   ```

   Both commands print or store the exact 40-character SHA before changing the
   package pin. Review that commit before restarting Pi.

3. Restart Pi and run `/board-agent lint`. If `auto_start` is disabled, run
   `/board-agent run`.

From a clean clone whose release commit has already been pushed, step 2 can be:

```bash
pi install "git:github.com/Hikoia/pi-board-agent@$(git rev-parse HEAD)"
```

## Prerequisites

- [Pi](https://pi.dev/) `>=0.80.8`
- Bundled [pi-dynamic-workflows](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) `^3.10.0`
- `gh` CLI authenticated with the `project` scope:

  ```bash
  gh auth login
  gh auth refresh -s project
  ```

- A **GitHub Project (v2)** with these `Status` options: `Backlog`, `Ready`, `In Progress`, `Needs Design`, `Needs Human`, `Review`, `Done`. Add `Needs Human` manually to an existing Project; `init-project` intentionally does not rewrite existing option lists.
- A `Plan` text or single-select field whose values match your feature slugs
  (e.g. `001-auth`, `002-dashboard`).

## Configuration

```yaml
# .pi/board-agent.yml
project:
  owner: ""        # auto-detected from git origin if empty
  number: 12       # the N in https://github.com/users/<owner>/projects/<N>

columns:
  ready: "Ready"
  building: "In Progress"
  needs_design: "Needs Design"
  needs_human: "Needs Human"
  review: "Review"
  done: "Done"
  backlog: "Backlog"
status_field: "Status"
plan_field: "Plan"

max_workers: 2     # shared cap: active builders + current reviewer
tick_seconds: 90   # 60-120 recommended (safe for GraphQL rate limit)
branches:
  base: "main"
  plan_prefix: "plan/"   # retained for legacy worktrees
  task_prefix: "task/"
task_merge_strategy: "squash"   # direct into branches.base; or "merge"

pr:                               # retained for config compatibility; unused
  reviewers: ["alice", "bob"]   # GitHub logins or "org/team-slug"
  labels: ["board-agent"]

builder_tier: "medium"          # pi-dynamic-workflows tier
builder_timeout_ms: 1800000     # 30 min, omit for no cap
builder_retries: 1

safety:
  require_clean_worktree: true
  skip_closed_issues: true

bot_identity: ""   # login for the assignee claim guard; empty = gh user
```

## How it works

| Component | Role |
| ----------- | ------ |
| `/board-agent run` | Starts one owner. Each tick reconciles and finalizes persisted work, reserves one shared slot for a pending reviewer, starts background builders in the remainder, then refills after review. Calling it again is a no-op unless it promotes a startup recovery-only loop. |
| `ticket-executor.ts` | Owns final card refetch, claim, worktree/run association, recovery, and idempotent outcome transitions. |
| `ticket-worktree.ts` | Atomically stores the v2 execution record and retains the worktree through review and human validation. |
| pi-dynamic-workflows `WorkflowManager` | Persists run status, args, journal, result, and lease; one manager/agent per ticket worktree. |
| `owner-lock.ts` | Native `fs.open(..., "wx")` lock prevents a second local board-agent owner. |
| `runtime.ts` | Fails closed unless the effective package pin, loaded module, and clean deployment checkout share one full Git SHA; atomically maintains `.pi/board-agent/runtime.json`. |
| `inflight.ts` | Compatibility only: quarantines and archives legacy inflight JSON; new runs do not write it. |
| `/board-agent stop` | Waits for the current tick, pauses managed runs durably, then releases the owner lock. |

### Recovery and safety

1. **Revision guard**: new work starts only when the effective package setting is a full Git SHA matching both the loaded module and a clean checkout. Revision drift leaves the process recovery-only until restart.
2. **Owner + claim guards**: one local owner lock, followed by an assignee mutation and a second full card refetch.
3. **Durable managed runs**: WorkflowManager persists the run before its agent starts. The ticket record associates that run with the retained worktree.
4. **Ticket-scoped worktree ownership**: a paused run resumes when its persisted args and ticket identity match. A fresh builder may also continue a dirty diff when the ticket record, managed path, registration, plan, and task branch match, regardless of the previous run ID. Usage-limit checkpoints stay paused; dirty completed results and unregistered, mismatched, missing, malformed, failed, or ambiguous state fail closed to `Needs Human` without blocking siblings.
5. **Idempotent terminal mutations**: run-lineage markers prevent duplicate comments while allowing a later run's incident to be reported, and the active record remains until GitHub status/comment updates succeed.

### Branch model

```text
main                  ← baseline and direct merge target
 ├─ task/t001         ← persistent worktree until issue #1 is closed
 ├─ task/t002         ← persistent worktree until issue #2 is closed
 └─ task/t003         ← persistent worktree until issue #3 is closed
```

AI review moves each task to Done but leaves it unmerged. Closing the linked
issue is the human approval signal; board-agent then merges that task directly
into `branches.base` and removes its worktree.

## Commands

| Command | Description |
| --------- | ------------- |
| `/board-agent init` | Write `.pi/board-agent.yml` template |
| `/board-agent lint` | Check: exact loaded revision, config, `gh` auth, project, fields, and statuses |
| `/board-agent status` | Revision identity/runtime state plus board snapshot, active runs, and legacy/orphan/Needs Human counts |
| `/board-agent run` | Start autonomous polling loop |
| `/board-agent stop` | Graceful stop — pause runs, settle persistence, release owner lock |

## FAQ

**Can I resume after a crash?**

Yes. On startup or `/reload`, active ticket records recreate their WorkflowManagers. A matching paused run resumes from its journal, while a fresh run may continue a partial diff in a structurally valid ticket worktree even without a previous active run ID. A usage-limit checkpoint remains paused for the scheduler. Completed results are applied only from a clean worktree; unmanaged, mismatched, or ambiguous state goes to `Needs Human` and keeps the worktree for inspection.

**What if a builder fails?**

Recoverable connection/empty-output failures use `builder_retries` inside the same managed run. A builder-reported failure, failed/aborted manager, or malformed/missing result moves the card to `Needs Human`; automation never loops it back to Ready.

**How do I resume a `Needs Human` ticket?**

Read the structured blocker comment, reply with the requested decision or manual fix, and leave the retained task worktree on its expected branch. It may remain dirty. Then manually move the Project card to `Ready`; the fresh builder reads trusted maintainer replies, preserves the existing diff, and continues from the retained task branch.

**How do the design and review lanes differ?**

- **`Needs Design` Story:** re-runs Story refinement after a fresh repository owner, member, or collaborator reply.
- **`Needs Design` Task:** posts a decision gate, waits for a fresh trusted reply after the latest gate or question, temporarily claims the issue, rewrites the contract, and returns it to `Ready`. Open questions create a new reply boundary.
- **`Review` Task:** independently reviews the task branch against the accepted contract; it does not refine that contract.

**What about merge conflicts?**

Builders never merge. If finalization conflicts after the human closes the
issue, board-agent leaves the ticket worktree and state intact and retries on a
later tick after a human resolves the conflict.

**Do I need to keep pi running the whole time?**

No agent can execute while Pi is off, but managed state survives normal shutdown and process restarts. The next Pi session automatically reconciles any active ticket record; `auto_start: true` also keeps admitting new Ready cards.

## Development

Never develop in Pi's package cache. Use a normal clone or isolated worktree:

```bash
git clone https://github.com/Hikoia/pi-board-agent.git
cd pi-board-agent
npm install
bash tests/run-offline.sh
```

For exact-SHA foreground deployment and fleet verification, follow [the local rollout runbook](docs/runbook.md).

## Credits

Heavily inspired by [super-board](https://github.com/EricTechPro/super-board) —
the autonomous GitHub Project board executor for Claude Code.

### Differences from super-board

| Area | super-board | pi-board-agent |
| --- | --- | --- |
| **Host agent** | Claude Code | [Pi](https://pi.dev/) |
| **Worker model** | Dynamic workflows (`workflows/super-board-wave.js`) or `claude -p` headless | [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) builders run in board-agent's persistent ticket worktrees; reviewers use ephemeral isolation |
| **Plan grouping** | No plan concept — cards are independent | Cards retain a `plan_field` for task and Story grouping |
| **Merge model** | One PR per card (opened by builder) | Builders push task branches; manual issue closure merges each accepted task directly into `branches.base` |
| **Review gate** | `super-review` skill runs automated review, with optional `human_approves_merge` | AI PASS moves the card to Done without closing or merging. The human validates the persistent worktree and closes the issue to approve the direct merge |
| **QA lane** | `super-qa` skill runs Playwright path specs on the worker's branch | Not built (v0.1). The `Review` column is the sole post-build gate. A future version will add a `super-qa` equivalent via pi-dynamic-workflows |
| **Mutex / claim** | Assignee claim on GitHub issue + `.claude/super-board/inflight/` lockfile | Owner lock + assignee claim/refetch + WorkflowManager run lease; legacy inflight files are quarantine-only |
| **Worktree** | Manual `git worktree` management in `super-board-wave.js` | One persistent worktree per ticket, retained through review and human validation, then removed after manual-close merge |
| **Execution persistence** | Wave scripts are process-local | Each ticket script, args, journal, and result are persisted by WorkflowManager and associated with its v2 ticket record |
| **Stop/resume** | `/super-board stop` posts comments + releases mutexes. `/super-board run <slug>` resumes from board state | `/board-agent stop` pauses managers and journals before releasing ownership; startup reconciles persisted runs/results |
| **Offline test** | `tests/test-wave-plan.sh` + `tests/test_status_parse.py` | `tests/run-offline.sh` — durable executor, fake-agent WorkflowManager persistence, worktree retention/finalization, and recovery checks |

## License

MIT © Alessandro Mancini. See [LICENSE](LICENSE).

## Docker (Raspberry Pi)

Run the board-agent in its own always-on container (independent pi instance):

```bash
cp .env.example .env      # GH_TOKEN + Telegram + provider key
docker compose up -d --build
```

The container runs pi headless with `auto_start: true` (config) — the loop's
setInterval keeps the process alive. Control via GitHub comments
(`@<bot-login> status|stop|refine <plan>`) or `docker compose exec`.
See `docs/docker.md` for the full setup.
