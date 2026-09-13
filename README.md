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
  → no local task branch and no cleanup receipt? finalizer has no work
  → otherwise merge/squash into branches.base (main by default), or resume cleanup
  → push and verify origin/base before publishing a cleanup receipt
  → delete remote branch, worktree, local task branch, record, then receipt
```

`Plan` is required to claim/build a ticket, not for ordinary finalization. A
closed `Done` Task needs no execution record or review marker to integrate its
local branch. If both its local `task/issue-<number>` branch and cleanup receipt
are absent, the finalizer does not query remote branches or delete leftover
files. A pending receipt still retries cleanup without that branch; repair
handoff requires the matching original record and Plan.

`Needs Design` accepts decisions only from repository `OWNER`, `MEMBER`, or
`COLLABORATOR` comments. `Needs Human` is terminal until a human fixes the
reported blocker and moves the card back to `Ready`.

Only open GitHub **Issues** from the repository configured by `origin` can
enter refinement, building, or review. Closed `Done` Task Issues may finalize
or enter the guarded conflict handoff below; a closed Issue never launches a
builder. Pull requests, draft Project items, cross-repository Issues, and cards
without the exact configured `Type` (`Story` or `Task`) are never mutated.

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
  - `Plan`: text or single-select (pre-create the desired select options)
  - configured type field (default `Kind`): single-select `Story`, `Task`

Startup, lint and recovery-to-autonomous promotion validate the current config
and enabled-lane field types/options before admission. Story publication also
checks its own Plan option before claim/model/child creation; text uses a text
write, single-select uses the existing option ID. These checks never mutate
Project schema. After manual field/option or config edits, **stop successfully,
lint, then run a new loop**; promoting a cached recovery loop does not replace
its metadata/config snapshot. Restart Pi as well after changing the package pin.
See [enabled-lane requirements](docs/runbook.md#project-preflight).

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
graceful stop that cancels foreground models, drains cleanup and pauses managed
runs before releasing ownership. Concurrent stop/shutdown requests share the
same completion barrier. If cleanup fails, the loop and owner remain retained;
retry `/board-agent stop`. Cancellation is not permission to interrupt or
force-clean destructive Git operations.

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

auto_start: false
```

The Project owner and repository owner are separate identities. The Project
uses `project.owner`; Issue reads and mutations always use the repository
parsed from `git remote get-url origin`.

AI review is disabled by default. Validate the retained worktree, move the Task
to `Done`, then close its Issue to approve integration of its current local task
branch, including committed changes not yet pushed. Set `review.enabled: true`
for automated `Review` → `Done`. Finalization itself does not require an AI
review record; closing the Done Issue is the human approval. Ordinary Review
is not proof that the latest main/base has been integrated and passed integration
tests. Normal merges have no blanket integration test gate.

The full annotated schema is in [`config-template.yml`](config-template.yml).
All counts and timers must be finite safe integers; durations must also fit a
JavaScript timer after unit conversion.

`safety.skip_closed_issues` is deprecated: an explicit `true` **or** `false` in
`~/.pi/board-agent.yml` or the project file remains a valid boolean and produces
a file-specific warning through startup/config commands. Remove it from both
files; closed Issues never start builders or design. Defaults alone do not warn.
Unknown keys and non-boolean values still fail validation.

## Scheduling and design

`max_workers` is the **total model budget** for managed builders plus one
foreground invocation (Task design, Story refine, review, or watchdog). Occupied
slots are conservative: launching, pending, paused, missing and unreadable
associated runs reserve capacity even when not known to be running. The widget
separates **slots occupied** from **models running**; it is an observation, not
an admission or recovery authority.

Each tick reconciles builders and finalizes closed Done Tasks first. With
capacity, it reserves one primary foreground slot, pre-fills other slots with
Ready builders, then invokes at most one primary model in Task design → Story
refine → Review priority. Waiting/non-model actions can fall through. It
recounts/back-fills builders before awaited watchdog maintenance; watchdog
models never reserve ahead of Ready builders and defer at full capacity.
Live revision, stop, identity, ownership and capacity gates apply at actual
invocation, not just selection. Fresh identity/claim/revision checks still gate
write-back.

Every Ready child must be independently implementable **and verifiable from the
current base**. Merge tightly coupled scope into one Task, or keep dependent
work in Backlog until prerequisites are integrated. Task order and
`max_workers: 1` are not dependency scheduling. `refine.max_tasks` bounds the
prompt, schema and host validation: over-limit/invalid output is rejected
without slicing requirements or an automatic repair pass. Open questions block
child publication. Prompt/schema validation does not prove semantic independence.

Story refinement and Task design use private role definitions plus the SDK
allowlist **`["structured_output"]`**: no coding or shared-store tools. An empty
role `tools: []` or prompt prohibition alone is not that guarantee in installed
workflow 3.10.0. This restriction is specific to these two design agents.
Builders receive a navigation digest rendered from their actual prepared
worktree, not the host's cached HEAD; worktree code is authoritative. Durable
resumes retain the persisted mission, and digest generation does not dirty the
worktree. The [builder skill](skills/board-agent/SKILL.md) documents the procedure;
[`workflow-prompt.ts`](src/workflow-prompt.ts) supplies the production mission.
[`agents/board-agent-builder.md`](agents/board-agent-builder.md) is only a
non-production compatibility pointer.

## Conflict repair and renewed approval

A positively verified merge conflict pushes no integration result and performs
no cleanup. With the matching idle original record, Plan, clean worktree and
local/remote task SHA, Board Agent freshly checks identity, branch ownership,
human lane/claim and revision before automatically moving the card to `Ready`
and reopening the Issue. Other Git failures or unprovable ownership block and
preserve work; they do not authorize repair.

The same actual bot-authored, versioned comment advances `requested` → `queued`
→ `consumed`, backed by a local repair ledger. Only confirmed open `Ready` work
can enter the existing `max_workers` scheduler: one repair run of the existing
builder, in the original task branch/worktree. Restarts resume that unique run,
including its interrupted dirty merge, rather than launching another builder.
Failed or ambiguous writes stop until their exact result is confirmed, not blind
replay; later human lane or owner changes are not overwritten. The Issue body
is unchanged.

The repair preserves original work and requirements, merges the specified base
commit into the task, resolves both sides, runs existing integration tests on
the committed result, and commits/pushes normally. No blanket ours/theirs,
force-push, main mutation or self-close is allowed. The host checks original-task
and specified-base ancestry, no unresolved merge, a clean worktree, exact local/
remote result SHA and actual persisted passing test execution, not just a success
assertion.
Failure or missing/ambiguous evidence goes to `Needs Human` when fresh authority
still permits settlement. Success returns to `Review`; `review.enabled` remains
unchanged. Humans must validate the repaired result, reach `Done`, and **close
the Issue again**. Repair Review findings go to `Needs Human`, not automatic
`Ready`. A consumed request is not automatically reused; an explicit maintainer
reopen/Ready retry uses the ordinary builder flow.

## Safety and recovery

- Every runtime Git/`gh` subprocess is non-interactive and has a fixed deadline.
  Runtime network Git (worktree preparation/finalization/review/watchdog) and
  package-revision checks use the asynchronous runner without parallelizing Git
  writes. Small synchronous local probes/context scans remain; async is not a
  claim that Git itself is faster.
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
  cleanup. A late destructive cleanup receipt, not an early merge intent, keeps
  retries possible even after the local branch has been deleted.
- Active builders, dirty/locked/unmanaged registered task worktrees, failed
  pushes and concurrent ref changes prevent unsafe cleanup. Remote-only commits
  are never discarded. These blockers leave the card `Done`; a verified conflict
  may instead use the guarded repair/reapproval cycle above.
- Cleanup receipts bind the confirmed result and task SHAs, record/path and Git
  ownership, directory identities, and relative file types/sizes/hashes or link
  targets, including ignored files. Registered worktrees use normal Git removal;
  after registration is gone, only rechecked matching leftovers are removed
  item-by-item. Missing entries may already be removed; additions, changes,
  replacements, unknown ownership or locks block. No force-remove/prune/unlock
  fallback is used for ticket cleanup.
- Failed fresh reads never fall back to board snapshots for mutation authority.
  Failed assignee release is surfaced; unsettled execution associations and
  journals remain available for retry instead of being cleared as success.
- Closed-Done candidates use one per-tick local task-ref query as a **negative
  filter only**. Absent branches defer without per-card remote reads unless a
  cleanup receipt remains; present branches still undergo fresh approval/ref/
  worktree checks. Query failure warns and blocks that lane, never means “all
  absent.” Unsettled records and repair handoffs still reconcile independently;
  no general persistent completion cache is created.
- Identical per-ticket finalization/repair blockers warn once per loop lifetime;
  checks and safe retries still run every tick. Changed reasons/SHAs, recovery,
  a different ticket or restart can warn again. Notification deduplication is
  not permission to replay an unconfirmed write.
- Story child markers, sub-Issue reconciliation, Project-content
  reconciliation, and atomic journals prevent blind duplicate creation after a
  crash or ambiguous GitHub mutation result. Legacy truncated journals preserve
  the original file's exact bytes; only the affected Story is blocked. Healthy
  updates remain durable in a same-format companion journal. Back up both;
  there is no automatic repair, consolidation or migration. See
  [Story journal recovery](docs/runbook.md#truncated-story-journal-recovery).

Persistent repository-local artifacts live under:

```text
.pi/board-agent/
├── owner.lock
├── runtime.json
├── refine-state.json
├── refine-state-unblocked.json             # only when preserving truncated evidence
├── ticket-worktrees/<project-item-id>.json  # strict schema v3, unchanged
├── cleanup/<safe-item-id>.json             # late cleanup receipt
├── cleanup-backups/<unique-backup>/        # verified full legacy residual backup
├── repair/conflict-<hash>.json             # retained repair ledger/run binding
└── repair-intent-backups/<item>-<hash>.json # exact old intent record bytes

.pi/worktrees/
├── ticket-*/   # persistent builder/human-validation worktrees
├── review-*/   # ephemeral; cleanup attempted after every review
└── watchdog-*/ # failed CI fixes retained for human recovery
```

Legacy residual cleanup requires positive record/path/task and remote integration
proof plus a verified full content/layout backup in `cleanup-backups/`; a confirmed
old result is cleanup-only. For a conflict with no old `resultSha`, only the narrow
old persistence-order proof permits archiving exact bytes in
`repair-intent-backups/` and a checked intent clear before repair. A present but
unconfirmed result, rewritten base or other uncertainty blocks and preserves
state. See the [legacy criteria](docs/runbook.md#legacy-finalization-and-conflict-recovery).

Backups, intent archives and consumed repair ledgers are not automatically
garbage-collected. Do not delete a dirty worktree, state record, receipt or ledger
just to make automation run, or blindly downgrade while a cleanup receipt or
repair is pending.
Back up all local and external workflow evidence while stopped; older readers
may ignore it and replay work. Follow the recovery matrix in
[`docs/runbook.md`](docs/runbook.md).

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
| `/board-agent stop` | Stop admissions, cancel foreground models, drain/pause runs; release ownership only after successful cleanup |
| `/board-agent context` | Regenerate the host repository digest (builders render from their own worktrees) |
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
