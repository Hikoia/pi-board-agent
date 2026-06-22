# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@mancioshell/pi-board-agent?color=cb3837&logo=npm)](https://www.npmjs.com/package/@mancioshell/pi-board-agent)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

> An autonomous GitHub Project (v2) board executor for [Pi](https://pi.dev/).
> Drag a card into the `Ready` column, walk away, come back to a PR.

Built on **pi-dynamic-workflows** for parallel git-worktree-isolated builders,
with assignee-based card claiming, plan-level PR batching, and a review gate
before PR handoff.

## Watch it run

```
┌─ Board ─────────────────────────────────────────────────────┐
│ Columns                                      │                │
├──────────────────────────────────────────────┼────────────────┤
│ Backlog │ Ready │ Building │ Review │ Done   │                │
│  …  …   │ T001  │ T003     │        │        │  ↙ T001 Ready  │
│         │ T002  │          │        │        │ ° picked       │
│         │ T007  │          │        │        │                │
├──────────────────────────────────────────────┼────────────────┤
│  T001 → plan/001-feature → task/T001 → build → merge → Done  │
│  T002 → plan/001-feature → task/T002 → build → merge → Done  │
│  T003 → plan/001-feature → task/T003 → build → merge → Done  │
│                                                              │
│  All 3 Done → gh pr create plan/001-feature → main           │
│  Reviewers: @reviewer1 @reviewer2                            │
│  Labels: board-agent                                         │
└──────────────────────────────────────────────────────────────┘
```

Every card for a plan, once done, lands together in one PR.
PR generation is per-plan: when all cards reach `Done`, a PR opens from
`plan/<slug>` into `main`.

## Quickstart

```bash
# 1. Install board-agent AND its peer dep
pi install npm:@quintinshaw/pi-dynamic-workflows
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

- [Pi](https://pi.dev/) (any recent version)
- [pi-dynamic-workflows](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) `>=2.0.0` (installed as peer)
- `gh` CLI authenticated with the `project` scope:
  ```bash
  gh auth login
  gh auth refresh -s project
  ```
- A **GitHub Project (v2)** with these column names on a `Status` single-select
  field: `Backlog`, `Ready`, `Building`, `Review`, `Done`.
- A `Plan` single-select field whose values match your spec-kit feature slugs
  (e.g. `001-auth`, `002-dashboard`).

## Configuration

```yaml
# .pi/board-agent.yml
project:
  owner: ""        # auto-detected from git origin if empty
  number: 12       # the N in https://github.com/users/<owner>/projects/<N>

columns:
  ready: "Ready"
  building: "Building"
  review: "Review"
  done: "Done"
status_field: "Status"
plan_field: "Plan"

max_workers: 2     # 1-16, parallel builder agents
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
  max_stuck_building: 3
  require_clean_worktree: true
  skip_closed_issues: true

bot_identity: ""   # login for the assignee mutex; empty = gh user
```

## How it works

| Component | Role |
|-----------|------|
| `/board-agent run` | Polling loop. Every `tick_seconds`: fetch all cards, pick `Ready` cards (max `max_workers`), claim via assignee, dispatch a pi-dynamic-workflows wave. |
| `skills/board-agent/SKILL.md` | Builder procedure: worktree → task branch → implement → commit → push → merge into plan branch → return JSON outcome. |
| pi-dynamic-workflows `workflow` tool | Fan-out `agent()` calls with `isolation: "worktree"`. Each builder runs in its own throwaway worktree. |
| `plan.ts` | Detects when all cards in a plan are `Done`, then opens `gh pr create plan/<slug> -> main`. |
| `inflight.ts` | Lockfile registry under `.pi/board-agent/inflight/` to survive crashes and avoid double-dispatch. |
| `/board-agent stop` | Stops the loop, posts comments on in-flight cards, releases assignee mutexes. |

### Three safety layers

1. **Assignee mutex**: before spawning a builder, board-agent claims the card
   as an assignee on GitHub. No two agents can claim the same card.
2. **Local lockfiles**: `.pi/board-agent/inflight/<itemId>.json` — the
   lockfile is written **before** the assignee claim, survives crashes.
3. **Orphan scan**: on startup, the loop detects existing lockfiles and
   reports stale cards without re-dispatching.

### Branch model

```
main
 └─ plan/001-auth   ← long-lived plan branch, re-used across waves
     ├─ task/T001   ← worktree subagent #1, merged with --squash/--no-ff
     ├─ task/T002   ← worktree subagent #2
     └─ task/T003   ← worktree subagent #3
```

When all 3 reach Done → **one PR**: `plan/001-auth` → `main`, with
reviewers from config.

## Commands

| Command | Description |
|---------|-------------|
| `/board-agent init` | Write `.pi/board-agent.yml` template |
| `/board-agent lint` | Check: config, `gh` auth, project exists, fields present |
| `/board-agent status` | Board snapshot: cards per column, plans, loop stats |
| `/board-agent run` | Start autonomous polling loop |
| `/board-agent stop` | Graceful stop — releases assignees, posts status comments |

## FAQ

**Can I resume after a crash?**

Yes. The board is the source of truth. Re-run `/board-agent run` and the
loop will pick up cards in the `Building` column as stale items and skip
them. Move them back to `Ready` manually to retry, or inspect the comments
on the linked issue.

**What if a builder fails?**

The card is moved back to `Ready`. The next wave will pick it up and retry
(up to `builder_retries` times). If it keeps failing, the error message is
posted as a comment on the linked issue.

**What about merge conflicts?**

The builder reports a `failure` outcome. The card goes back to `Ready`.
A comment is posted on the linked issue with the conflict details so a
human can resolve it.

**Do I need to keep pi running the whole time?**

For v0.1, yes — the loop runs in the foreground TUI session. At some point
you will need to manually switch Done cards to Done (the review gate).
A future version will support daemonized execution.

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
| **Worker model** | Dynamic workflows (`workflows/super-board-wave.js`) or `claude -p` headless | [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) fan-out with `parallel()` + `isolation: "worktree"` |
| **Plan grouping** | No plan concept — cards are independent | Cards are grouped by a `plan_field` on the project (e.g. `Plan: 001-auth`). When ALL cards of a plan reach `Done`, a single cumulative PR from `plan/<slug>` → `main` is opened |
| **PR model** | One PR per card (opened by builder) | **One PR per plan** — all cards of a plan share a long-lived `plan/<slug>` branch. Each builder merges its task into that branch; the PR is opened once by the orchestrator |
| **Review gate** | `super-review` skill runs automated review, with optional `human_approves_merge` | Cards land in `Review` after build; the orchestrator leaves them there (manual approval column). The PR reviewers from config are requested on the plan PR |
| **QA lane** | `super-qa` skill runs Playwright path specs on the worker's branch | Not built (v0.1). The `Review` column is the sole post-build gate. A future version will add a `super-qa` equivalent via pi-dynamic-workflows |
| **Mutex / claim** | Assignee claim on GitHub issue + `.claude/super-board/inflight/` lockfile | Same double-layer: assignee claim via `gh issue edit --add-assignee` + `.pi/board-agent/inflight/<itemId>.json` lockfile |
| **Worktree** | Manual `git worktree` management in `super-board-wave.js` | Delegated to pi-dynamic-workflows' built-in `isolation: "worktree"` — one throwaway worktree per agent, cleaned up automatically |
| **Saved workflows** | None — scripts are generated inline | The workflow script generated by `workflow-prompt.ts` can be saved as a `/board-agent-wave-<slug>` command via `/workflows save` |
| **Stop/resume** | `/super-board stop` posts comments + releases mutexes. `/super-board run <slug>` resumes from board state | Same pattern: `/board-agent stop` releases assignees + clears inflight lockfiles. `/board-agent run` always resumes from the board as source of truth |
| **Offline test** | `tests/test-wave-plan.sh` + `tests/test_status_parse.py` | `tests/run-offline.sh` — 30 assertions covering config parsing, inflight lifecycle, plan-summary computation, workflow-source generation, and loop tick orchestration |

## License

MIT © Alessandro Mancini. See [LICENSE](LICENSE).