# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@mancioshell/pi-board-agent?color=cb3837&logo=npm)](https://www.npmjs.com/package/@mancioshell/pi-board-agent)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

> An autonomous GitHub Project (v2) board executor for [Pi](https://pi.dev/).
> Drag a card into the `Ready` column, walk away, come back to a PR.

Built on **pi-dynamic-workflows 3.10** for journaled, resumable builders in persistent per-ticket worktrees, with an owner lock, startup reconciliation, assignee-based claiming, AI review, human validation, and plan-level PR batching.

## Watch it run

```
┌─ Board ─────────────────────────────────────────────────────┐
│ Columns                                      │                │
├──────────────────────────────────────────────┼────────────────┤
│ Backlog │ Ready │ In Progress │ Needs Design │ Needs Human │ Review │ Done │
│  …  …   │ T001  │ T003     │        │        │  ↙ T001 Ready  │
│         │ T002  │          │        │        │ ° picked       │
│         │ T007  │          │        │        │                │
├──────────────────────────────────────────────┼────────────────┤
│  T001 → build task/T001 → Review → Done → human closes issue │
│       → merge into plan/001-feature → clean ticket worktree   │
│  T002/T003 follow the same human-gated lifecycle              │
│                                                              │
│  All tasks closed + merged → plan/001-feature PR → main       │
│  Reviewers: @reviewer1 @reviewer2                            │
│  Labels: board-agent                                         │
└──────────────────────────────────────────────────────────────┘
```

Review PASS moves a card to `Done` without merging or closing its issue. The
persistent ticket worktree stays available for manual validation. When the
human closes the issue, board-agent merges its task branch into `plan/<slug>`
and removes the worktree. The plan PR opens only after every task is Done,
manually closed, merged, and cleaned.

## Quickstart

```bash
# 1. Install board-agent (pi-dynamic-workflows is bundled)
pi install npm:@mancioshell/pi-board-agent
/reload

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

max_workers: 2     # global cap across running/paused/resuming builders
tick_seconds: 90   # 60-120 recommended (safe for GraphQL rate limit)
branches:
  base: "main"
  plan_prefix: "plan/"
  task_prefix: "task/"
task_merge_strategy: "squash"   # or "merge"

pr:
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
|-----------|------|
| `/board-agent run` | Starts one owner. Every tick reconciles persisted runs, then fills `max_workers - activeCount()` globally. Calling it again is a no-op unless it promotes a startup recovery-only loop. |
| `ticket-executor.ts` | Owns final card refetch, claim, worktree/run association, recovery, and idempotent outcome transitions. |
| `ticket-worktree.ts` | Atomically stores the v2 execution record and retains the worktree through review and human validation. |
| pi-dynamic-workflows `WorkflowManager` | Persists run status, args, journal, result, and lease; one manager/agent per ticket worktree. |
| `owner-lock.ts` | Native `fs.open(..., "wx")` lock prevents a second local board-agent owner. |
| `inflight.ts` | Compatibility only: quarantines and archives legacy inflight JSON; new runs do not write it. |
| `/board-agent stop` | Waits for the current tick, pauses managed runs durably, then releases the owner lock. |

### Recovery and safety

1. **Owner + claim guards**: one local owner lock, followed by an assignee mutation and a second full card refetch.
2. **Durable managed runs**: WorkflowManager persists the run before its agent starts. The ticket record associates that run with the retained worktree.
3. **Fail-closed reconciliation**: only a clean, matching paused worktree resumes. Dirty, missing, malformed, failed, or ambiguous state moves that ticket to `Needs Human` without blocking siblings.
4. **Idempotent terminal mutations**: run markers prevent duplicate comments, and the active record remains until GitHub status/comment updates succeed.

### Branch model

```
main
 └─ plan/001-auth   ← long-lived plan branch
     ├─ task/t001   ← persistent worktree until issue #1 is closed
     ├─ task/t002   ← persistent worktree until issue #2 is closed
     └─ task/t003   ← persistent worktree until issue #3 is closed
```

AI review moves each task to Done but leaves it unmerged. Closing the linked
issue is the human approval signal. Once all tasks are closed, merged, and
cleaned, board-agent opens **one PR**: `plan/001-auth` → `main`.

## Commands

| Command | Description |
|---------|-------------|
| `/board-agent init` | Write `.pi/board-agent.yml` template |
| `/board-agent lint` | Check: config, `gh` auth, project exists, fields present |
| `/board-agent status` | Board snapshot plus each active run ID/status/worktree and legacy/orphan/Needs Human counts |
| `/board-agent run` | Start autonomous polling loop |
| `/board-agent stop` | Graceful stop — pause runs, settle persistence, release owner lock |

## FAQ

**Can I resume after a crash?**

Yes. On startup or `/reload`, active ticket records recreate their WorkflowManagers. A clean paused worktree resumes from its journal; a completed persisted result is applied once. Unsafe or ambiguous state goes to `Needs Human` and keeps the worktree for inspection.

**What if a builder fails?**

Recoverable connection/empty-output failures use `builder_retries` inside the same managed run. A builder-reported failure, failed/aborted manager, or malformed/missing result moves the card to `Needs Human`; automation never loops it back to Ready.

**How do I resume a `Needs Human` ticket?**

Read the structured blocker comment, reply with the requested decision or manual fix, and leave the retained task worktree on its expected branch with a clean status. Then manually move the Project card to `Ready`. The fresh builder run reads trusted maintainer replies after the latest blocker comment and continues from the retained task branch.

**What about merge conflicts?**

Builders never merge. If finalization conflicts after the human closes the
issue, board-agent leaves the ticket worktree and state intact, skips the plan
PR, and retries on a later tick after a human resolves the conflict.

**Do I need to keep pi running the whole time?**

No agent can execute while Pi is off, but managed state survives normal shutdown and process restarts. The next Pi session automatically reconciles any active ticket record; `auto_start: true` also keeps admitting new Ready cards.

## Development

```bash
git clone https://github.com/mancioshell/pi-board-agent.git
cd pi-board-agent
npm install
bash tests/run-offline.sh
```

## Credits

Heavily inspired by [super-board](https://github.com/EricTechPro/super-board) —
the autonomous GitHub Project board executor for Claude Code.

### Differences from super-board

| Area | super-board | pi-board-agent |
|---|---|---|
| **Host agent** | Claude Code | [Pi](https://pi.dev/) |
| **Worker model** | Dynamic workflows (`workflows/super-board-wave.js`) or `claude -p` headless | [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) builders run in board-agent's persistent ticket worktrees; reviewers use ephemeral isolation |
| **Plan grouping** | No plan concept — cards are independent | Cards are grouped by a `plan_field` on the project (e.g. `Plan: 001-auth`). When ALL cards of a plan reach `Done`, a single cumulative PR from `plan/<slug>` → `main` is opened |
| **PR model** | One PR per card (opened by builder) | **One PR per plan** — builders push task branches; manual issue closure triggers task→plan merge; the orchestrator opens the cumulative plan PR |
| **Review gate** | `super-review` skill runs automated review, with optional `human_approves_merge` | AI PASS moves the card to Done without closing or merging. The human validates the persistent worktree and closes the issue to approve merge |
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
