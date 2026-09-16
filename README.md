# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

A durable **Task ticket executor** for GitHub Projects v2, running inside a
foreground [Pi](https://pi.dev/) session. One Issue owns one persistent task
branch/worktree and a recoverable WorkflowManager run.

> Git-only package: install a reviewed, full 40-character commit SHA. Not
> published to npm. Ticket **schema v4** is not a package version number.

## Workflow

```text
Ready → In Progress → mandatory AI Review → Done (Issue remains OPEN)
  → human validates the retained worktree and manually closes the Issue
  → native merge into fresh origin/base → normal push → verify integration
  → delete remote task ref → normal worktree removal → delete local task ref
  → confirm Project Done → delete the ticket record
```

Only target-repository **Issue + Type:Task** cards may mutate. PRs, Drafts,
foreign-repository Issues, Stories and missing/wrong Type are excluded. Plan is
optional grouping/context, never an admission gate. There is no Story splitting,
designer/Needs Design model, PR watchdog, comment listener or PR merge workflow.
Backlog is a manual holding column. Tasks in Ready must be independently
implementable and testable against the available base; numbering and
`max_workers: 1` do not provide dependency scheduling.

AI review uses an isolated detached worktree at the exact pushed task SHA.
Done is not merged and does not close the Issue. New integration requires that
reviewed SHA still match the original local and remote task branch. Builders
must commit and push their task branch, never close/merge their own Issue.

### Retries and decisions

Technical failures return the Project card to Ready with a persisted stage:

| Stage | Next attempt |
| --- | --- |
| `build` | Continue the original branch/worktree, including partial dirty work or MERGE_HEAD; then review |
| `review` | Retry review of the original pinned commit, not a successful build |
| `integrate` | Re-observe the remote and retry Git only; preserve closed approval |
| `cleanup` | Reconfirm remote integration, finish cleanup/Done only; preserve closed approval |

Review code findings retry build. Setup/model errors, malformed output, failed
tests, timeouts and retry exhaustion are **not** product decisions. Failed
comment/status/reopen/release writes remain pending I/O; they do not relaunch a
model or pretend Ready was written. No same-ticket immediate retry in a tick.

A real merge conflict comments, reopens and returns to Ready. The builder merges
base into the **original task branch**, resolves both sides, tests and pushes;
AI review and a **renewed human close** are required. A nonconflicting base
advance that rejects a push is integration-only: no rebuild, review or reopen.
An accepted push with a lost response is observed before attempting anything
else. A locally saved result SHA is never proof that the push succeeded.

Only an explicit `needs_decision` with a concrete question, missing context,
viable options and recommendation moves a ticket to Needs Human. Work stays in
place; its slot is released only after safe drain and settlement. A repository
OWNER, MEMBER or COLLABORATOR must **reply AND manually move it to Ready**.
A reply alone never resumes work; trusted replies inform the resumed builder.

## Requirements and install

- Node.js `>=22.19.0`, Pi `>=0.80.8`, Git and authenticated `gh` with Project scope.
- Windows: PowerShell FullLanguage with `Add-Type`/PInvoke allowed for process
  Job Objects and deadline enforcement.
- Project single-select Status: **Ready, In Progress, Review, Done, Needs Human**.
- Configured single-select Type field (default `Type`) with **Task**.
- Plan field/value and Backlog are optional. Existing Project options are not rebuilt.

```bash
gh auth login
gh auth refresh -s project
pi install "git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>"
# Restart Pi in the target repository.
```

```text
/board-agent init
# Edit .pi/board-agent.yml, especially project.number.
/board-agent lint
/board-agent run
```

The repository is resolved from `origin`; `project.owner` selects the Project,
not the repository allowed for Issue mutations. Deployment must permit **normal
merge commits and normal pushes to the configured base**. Do not bypass branch
protection, force-push or silently substitute squash/PR merging to deploy this
executor. See the [runbook](docs/runbook.md#deployment-checklist).

## Configuration

```yaml
project:
  owner: ""       # empty: origin repository owner
  number: 12
status_field: "Status"
type_field: "Type"
plan_field: "Plan" # optional
branches:
  base: "main"
  task_prefix: "task/"
task_merge_strategy: "merge"
max_workers: 2
tick_seconds: 90
builder_timeout_ms: 21600000
builder_retries: 1
models:
  builder: "deepseek-v4-flash-0731"
  review: "deepseek-v4-flash-0731"
review:
  timeout_ms: 600000
context:
  enabled: true
  max_chars: 20000
  exclude: []
safety:
  require_clean_worktree: true
auto_start: false
```

[The annotated template](config-template.yml) includes custom columns, bot
identity and Telegram notifications. Project config overrides
`~/.pi/board-agent.yml`. Both files are validated before compatibility
normalization; neither is rewritten automatically. Finite retired lane settings
warn and are ignored; `review.enabled: false` cannot disable AI review and
legacy `squash` normalizes to `merge`. Unknown keys/invalid values still fail.
See [config compatibility](docs/runbook.md#configuration-compatibility).

`max_workers` is the shared model budget: managed builders plus one foreground
review. Launching, pending, paused, missing/unreadable and unsettled associated
runs conservatively occupy slots. The widget distinguishes occupied slots from
running models; it never authorizes work. Builder context is rendered from the
prepared worktree; durable resumes retain their original script/args/context.

## Stop, upgrade and recovery

**No hot update.** Package/config consistency checks run at startup, explicit
lint and deployment—not on heartbeat, UI refresh or ordinary admission.
Runtime revision fields show the last such observation. Keep the installed
checkout and settings immutable while an owner is running.

1. Stop every old owner and wait for foreground cleanup and all managed run
   leases to drain. Incomplete stop retains ownership; retry stop, never remove
   a live lock to force takeover.
2. Back up records, dirty/untracked worktrees, refs and external WorkflowManager
   journals. You do **not** have to finish every Task before upgrading.
3. Install the reviewed SHA, restart Pi, lint and run with one exclusive owner.
   Current v3 Task records convert per ticket, preserving run identity and exact
   raw sources in `legacy-v3/` before atomic v4 publication.

Running/paused work resumes the same persisted run; launch-window recovery
adopts only a unique matching journal. Uncertainty stays occupied and is
re-observed, never replaced by a second builder. Old repair ledgers and cleanup
receipts stay read-only; old merge/squash results can finish without creating a
new squash. Remaining Story/PR records and Issues are not closed or deleted.
Unsupported v1/v2, legacy inflight and corrupt data are not guessed or deleted.

New execution creates no repair ledger, full-tree cleanup snapshot or backup.
Cleanup protects managed paths, Git ownership, dirty/untracked program files,
locks, active runs and expected ref SHAs. **Ignored task-worktree files may be
discarded by normal `git worktree remove`**; save valuable ignored data elsewhere.
There is no force removal, broad prune/unlock or recursive-delete fallback.
Unknown unregistered leftovers remain for human inspection. Only existing,
validated legacy receipt evidence can authorize residual legacy removal.

See [architecture](docs/architecture.md), [operations/recovery](docs/runbook.md),
and the [builder procedure](skills/board-agent/SKILL.md). Historical audit reports
are preserved baselines, not current policy.

## Commands

| Command | Purpose |
| --- | --- |
| `/board-agent init` | Write the packaged local template |
| `/board-agent lint` | Check pinned revision, state, config, auth and Task Project metadata |
| `/board-agent run` | Acquire ownership, convert/reconcile and admit Ready Tasks |
| `/board-agent status` | Display board/execution state and last checked revision |
| `/board-agent stop` | Close admission, cancel review, drain/pause builders, then release owner |
| `/board-agent context` | Generate host navigation digest; builders use their own worktree |
| `/board-agent init-project` | Explicitly create missing Task fields/options; never rebuild existing lists |

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

CI uses Node **22.19.0** on Linux and Windows. `tests/run-offline.sh` discovers
all `test-*.ts`/`test-*.mjs` files and isolates each test's home/state/credentials.
Local bare remotes and fake board/model adapters are offline evidence, not live
GitHub, deployment-policy or real-model certification.

MIT © Alessandro Mancini. See [LICENSE](LICENSE).
