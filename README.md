# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

A durable **Task ticket executor** for GitHub Projects v2, running inside a
foreground [Pi](https://pi.dev/) session. One Issue owns one persistent task
branch/worktree and a recoverable WorkflowManager run.

> Git-only package: install a reviewed, full 40-character commit SHA. Not
> published to npm. Ticket **schema v5** is not a package version number.

## Workflow

```text
Ready → In Progress → mandatory AI Review → Done (Issue remains OPEN)
  → human validates the retained worktree and closes the Issue to request a PR
  → prepare and normally push task branch → create/recover managed PR
  → human manually merges PR (Squash and merge recommended) → verify merge proof
  → delete remote task ref → normal worktree removal → delete local task ref
  → confirm Project Backlog → delete the ticket record
```

Only target-repository **Issue + Type:Task** cards enter model execution.
Closed **Done Issues of any Type** may finalize without an AI-review marker,
then move to **Backlog**. PRs, Drafts and foreign-repository Issues are excluded.
Plan is optional grouping/context, never an admission gate. There is no Story
splitting, designer/Needs Design model, PR watchdog, comment listener or automatic
PR merge. Backlog is also a manual holding column. Tasks in Ready must be independently
implementable and testable against the available base; numbering and
`max_workers: 1` do not provide dependency scheduling.

AI review uses an isolated detached worktree at the exact pushed task SHA.
Done is not merged and does not close the Issue. Closing it requests a managed
PR; **human PR merge is the sole final integration approval**. Fresh local and/or
remote task sources, including safe ahead/divergent histories, are pinned and
their ancestry preserved. Preparation may publish a merge commit on task without
moving the user's worktree HEAD. Local/remote conflicts retain both sources for
manual resolution. No-ref history moves to Backlog without altering idle records
or leftovers only when no PR/integration/pending recovery evidence exists.
Builders commit and normally push only their task branch.

Waiting retains closed Done, worktree and refs, consumes no model slot and releases
the finalizer after bounded observation. CI failures do not trigger a rebuild.
Closing a PR **without merging** is not completion. Cleanup requires explicit
`merged=true`, the actual GitHub merge commit on fresh `origin/base`, and merged
PR-head ancestry covering prepared, saved and current work—not task ancestry in
base (which squash does not preserve), nor an unmerged test-merge SHA.

### Retries and decisions

**Project Status describes work; local `retry.stage` describes technical retries.**
Open Task build/review failures return to Ready. Pure integration/cleanup failures
keep the existing closed Done/Backlog status, update local retry diagnostics and
warn without claiming, commenting or reopening:

| Stage | Next attempt |
| --- | --- |
| `build` | Continue the original branch/worktree, including partial dirty work or MERGE_HEAD; then review |
| `review` | Retry review of the original pinned commit, not a successful build |
| `integrate` | Re-observe task/PR state before retrying preparation or PR creation; preserve closed submission |
| `cleanup` | Reconfirm saved merged/legacy-completed proof, finish cleanup/Backlog only |

Review code findings retry build. Setup/model errors, malformed output, failed
tests, timeouts and retry exhaustion are **not** product decisions. Failed
comment/status/reopen/release writes remain pending I/O; they do not relaunch a
model or pretend Ready was written. Old technical pending Ready writes are retired
without replaying Ready/comments; claim release still requires fresh guards.
Withdrawal cancels the obsolete write, not confirmed cleanup-only evidence.
Manual Needs Human/open Backlog holds remain unchanged. No same-ticket immediate
retry occurs in a tick; normal PR waiting is not a failure retry.

An initial deterministic, repairable base conflict comments, reopens and returns
to Ready. The builder merges base into the **original task branch**, resolves both
sides, tests and normally pushes; AI review and a **renewed human close** are required.
An accepted task push or PR creation with a lost response is observed/recovered
before retrying. Saved preparation alone proves neither publication nor merge.

Reopening the Issue or leaving the approval lane pauses integration/cleanup,
retaining the PR. **Open Ready** retires unmerged submission approval and permits
the original builder; review → Done → renewed close updates the same still-open
managed PR. Before pushing returned work, fetch and merge published `origin/task`
ancestry (finish any owned interrupted merge first). Do not rebase/force-rewrite
required source evidence. Confirmed merged/legacy-completed state remains
cleanup-only; uncovered later work needs a new submission/PR.

Strict required checks may need a human **merge-based Update branch** when base
advances. Appended commits and ancestry-preserving updates are supported; the bot
does not update waiting PRs, watch CI, auto-merge or bypass protection.

Only an explicit `needs_decision` with a concrete question, missing context,
viable options and recommendation moves a ticket to Needs Human. Work stays in
place; its slot is released only after safe drain and settlement. **Moving the
card to Ready is the resume signal**; no decision-reply check gates admission.
Needs Human stays paused, and a comment alone never resumes work. Trusted OWNER,
MEMBER or COLLABORATOR comments inform the resumed builder, including human replies
from the same account as the agent. Agent comments and their headings carry
`[Agent]`; these and legacy `<!-- board-agent-` comments are excluded from human
instructions, independently of the author account.

## Requirements and install

- Node.js `>=22.19.0`, Pi `>=0.80.8`, Git and authenticated `gh` with Project scope.
- Repository/Project permissions for Issue/Project writes, normal task-branch
  pushes, PR read/create APIs and exact-lease task-ref deletion.
- Windows: PowerShell FullLanguage with `Add-Type`/PInvoke allowed for process
  Job Objects and deadline enforcement.
- Project single-select Status: **Backlog, Ready, In Progress, Review, Done, Needs Human**.
- Configured single-select Type field (default `Type`) with **Task**.
- Plan field/value is optional. Existing Project options are not rebuilt.

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
not the repository allowed for Issue mutations. The bot needs no direct base-push
or PR-merge privilege. Keep PR requirements, required checks and base protections;
allow preparation merge commits on task and let humans merge the PR (squash is
recommended for linear base history). See the [runbook](docs/runbook.md#deployment-checklist).

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
warn and are ignored; `review.enabled: false` cannot disable AI review.
`task_merge_strategy: merge` or `squash` is validated, then warned and ignored;
remove it from both files. It is absent from runtime config, with no replacement
mode setting. Unknown keys/invalid values still fail.
See [config compatibility](docs/runbook.md#configuration-compatibility).

`max_workers` is the shared model budget: managed builders plus one foreground
review. Launching, pending, paused, missing/unreadable and unsettled associated
runs conservatively occupy slots. The widget distinguishes occupied slots from
running models; it never authorizes work. One separately tracked finalizer uses
no model slot and does not block other Ready/Review admissions on its remote
reads or cleanup. Candidates rotate by stable item ID. A board-wide read failure
still fails closed. Builder context is rendered from the
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
3. Upgrade **all writers together**, install the reviewed SHA, restart Pi, lint
   and run with one exclusive owner. Never mix the old direct executor with v5.
   Known v3/v4 records convert per ticket, preserving run identity and exact raw
   sources in `legacy-v3/` / `legacy-v4/` before atomic v5 publication.

Running/paused work resumes the same persisted run; launch-window recovery
adopts only a unique matching journal. Uncertainty stays occupied and is
re-observed, never replaced by a second builder. Old repair ledgers and cleanup
receipts stay read-only. Legacy results verified already on fresh base are
cleanup-only; pending results with valid source ancestry are reused as PR heads,
never pushed to base. Corrupt/missing proof or a cleanup result absent from base
blocks migration. Closed Done Issues, including non-Tasks, can complete; unrelated
Story/PR records and Issues are not closed or deleted.
Unsupported v1/v2, legacy inflight and corrupt data are not guessed or deleted.

New execution creates no repair ledger, full-tree cleanup snapshot or backup.
Cleanup protects managed paths, Git ownership, dirty/untracked program files,
locks, active runs and expected ref SHAs. **Ignored task-worktree files may be
discarded by `git clean -fdX` before normal `git worktree remove`**; save valuable ignored data elsewhere.
There is no force removal, broad prune/unlock or recursive-delete fallback.
Unknown unregistered leftovers remain for human inspection. Only existing,
validated legacy receipt evidence can authorize residual legacy removal. Each
attempt prepares evidence once, removes verified items non-recursively, and
verifies completion. Full backup verification occurs at most twice per attempt;
no cross-attempt cache or new snapshots/backups/archives are created by cleanup.

Cleanup uses exact remote leases, local compare-and-delete and renewed stepwise
authorization/source checks, **not a cross-system transaction**. If a remote task
ref is recreated during the final GitHub authorizer, new remote commits remain
protected but already-merged local worktree/record may still be removed. This is
the accepted [latest-observation boundary](docs/runbook.md#cleanup-observation-boundary).

`/run` and auto-start register tracked startup and return control to the UI.
Migration is still a model-admission barrier. Widget, status and schema-1
`runtime.json` show `starting`/`stopping` and maintenance activity separately from
model slots: ticket, phase, completed/total bytes or items, elapsed time,
`lastProgressAt`, and the last blocker. Progress publishes at most once per second
except phase changes/errors/end. Heartbeat is **not** progress. No progress for
`max(3 × tick_seconds, 300)` seconds is flagged, never used to unlock or restart.
Stop drains startup, tick, heartbeat, finalizer/file handles and manager leases
before releasing ownership; a failed drain retains the owner for another stop.

See [architecture](docs/architecture.md), [operations/recovery](docs/runbook.md),
and the [builder procedure](skills/board-agent/SKILL.md). Historical audit reports
are preserved baselines, not current policy.

### Update to the latest main commit (PowerShell)

Run `/board-agent stop` in every owning Pi session, wait for cleanup and managed
run leases to drain, and take a [stopped backup](docs/runbook.md#stopped-backup).
Exit those Pi sessions, then paste the following into PowerShell:

```powershell
$ref = git ls-remote --exit-code https://github.com/Hikoia/pi-board-agent.git refs/heads/main

if ($LASTEXITCODE -eq 0 -and $ref -match '^([0-9a-f]{40})\s') {
    $sha = $Matches[1]
    pi install "git:github.com/Hikoia/pi-board-agent@$sha"
} else {
    throw "Could not retrieve the latest SHA; update cancelled."
}
```

This resolves `main` once and installs that exact SHA. Latest does not mean
reviewed or tested; use the explicit reviewed-SHA install above if you have not
validated the current `main`. `pi update --extensions` does not advance an
existing SHA pin; rerun this snippet to select the latest `main` again.

After a successful install, restart Pi in the target repository and check:

```text
/board-agent lint
/board-agent status
```

Only after lint passes, use `/board-agent run` to resume with one exclusive
owner. Do not use `/reload` as a hot-update procedure.

## Commands

| Command | Purpose |
| --- | --- |
| `/board-agent init` | Write the packaged local template |
| `/board-agent lint` | Check pinned revision, state, config, auth and Task Project metadata |
| `/board-agent run` | Acquire ownership, convert/reconcile and admit Ready Tasks |
| `/board-agent status` | Display board/execution state and last checked revision |
| `/board-agent stop` | Close admission, cancel startup/review/finalizer, await Git/handles and builder drain, then release owner |
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
GitHub, deployment-policy or real-model certification. This manual-PR delivery
has not deployed or acted on real #121; live permissions, CI/protections and
GitHub behavior remain unverified. MAIN T07 completed all 91 offline test files
but **did not pass** (exit 1, Windows process-runner assertion). See the
[final acceptance report](docs/manual-pr-offline-acceptance.md); no deployment
or full-suite success is claimed.

MIT © Alessandro Mancini. See [LICENSE](LICENSE).
