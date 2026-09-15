# Rollout and recovery runbook

Board Agent runs inside foreground Pi, installed at one reviewed full Git SHA.
These are operator procedures, **not a claim that live GitHub, deployment or base
push permissions have been tested**. Historical audits are not current run
instructions; use this document and [architecture](architecture.md).

## Before deployment

Confirm:

- Node `>=22.19.0`, Pi `>=0.80.8`, Git and authenticated `gh` with Project scope.
- Windows PowerShell permits FullLanguage `Add-Type`/PInvoke for process containment.
- The target `origin` is the intended repository; `project.owner` may differ.
- The configured base permits ordinary merge commits and normal bot pushes.
  Task-branch push and expected-SHA remote deletion must also be allowed.
  PR-only or linear-history requirements can block this workflow. Resolve the
  intended deployment policy with maintainers; Board Agent does not alter branch
  protections, create a PR fallback or force-push base.
- The installed package is a clean checkout pinned to a reviewed **40-character
  SHA**, not a branch/tag/short SHA or a development checkout.
- Every previous owner has successfully stopped and drained before package update.

## Normal operation

```text
Task Ready → In Progress → AI Review (configured Review lane)
           → Done, Issue OPEN, persistent worktree retained
           → user validates and manually closes
           → ordinary two-parent merge and normal push to base
           → verify remote integration → safe cleanup → Project Done
```

Task Issue in the configured origin repository is the unit of work. Plan is
optional read-only grouping; no Plan field/value is needed. There is no
Story/refine/design/PR watchdog or `init-project` command. PRs, drafts, Stories,
non-Task cards and cross-repository Issues are protected from mutation.

AI review is always enabled. Validate the retained task worktree before closing
Done. Outstanding build/review obligations cannot be bypassed by manually moving
the card to Done and closing. Normal integration does not run a blanket
post-merge test suite; review and human validation do not prove compatibility
with every later base change. Keep dependent Tasks in Backlog until their
prerequisites are integrated; task order or one worker is not dependency scheduling.

```text
/board-agent init
# Configure .pi/board-agent.yml.
/board-agent lint
/board-agent run
/board-agent status
/board-agent stop
```

`init` creates a config file only if absent. `lint` checks state, revision,
configuration, auth and metadata read-only. `status` shows observations, including
last startup/lint provenance, without package inspection. `context` generates a
host digest; new builders render their digest from the actual prepared worktree.

## Configuration and Project preflight

Use [`config-template.yml`](../config-template.yml). Project config overrides
`~/.pi/board-agent.yml`. Required Project fields/options:

- Single-select Status: configured Ready, In Progress, Review, Done, Needs Human.
- Single-select type field (default `Kind`): Task.
- Backlog is a manual hold, not a required lane. Plan, Story and Needs Design
  are not schema requirements. Optional Plan is never written by Board Agent.

Startup/run/promotion and lint validate current config/metadata, without schema
creation or repair. A running loop retains its snapshot. After changing YAML,
origin or Project fields/options: **stop successfully, lint, run a new loop**.
A cached recovery loop cannot be promoted with a different config/metadata snapshot.

Supported obsolete settings warn per source file, including shadowed global
values, and normalize only in memory:

| Old key | Current handling |
| --- | --- |
| `refine`, `watchdog`, `models.refine`, `models.watch` | Validate supported old shape/types, warn and ignore |
| `columns.needs_design` | Migration provenance only; no execution lane |
| `review.enabled` | Validate boolean, warn and ignore; AI review always runs |
| `task_merge_strategy: squash` | Warn, use merge for new work; do not rewrite recorded old results |
| `safety.skip_closed_issues` | Either boolean warns; closed Issues never start builders/review |

Remove these keys from both files after reviewing warnings. Invalid types,
unrelated unknown keys, and previously rejected pre-0.2 keys (`pr`,
`builder_tier`, `branches.plan_prefix`, `watchdog.interval_seconds`) remain errors.
Configured models, worker budget, timeouts, retries, context, notifications and
provider backoff otherwise remain unchanged.

## Runtime coherence and liveness

Revision/config coherence is a startup/run/promotion, lint and deployment check,
**not** heartbeat/UI/tick/ordinary builder/reviewer package polling. Runtime
`expectedRevision`, `loadedRevision`, `diskRevision` and `dirty` reflect the last
startup/lint check; a recent heartbeat only proves liveness, not a fresh disk scan.
Use explicit lint or the fleet verifier for deployment inspection.

A detected package mismatch closes new admissions and latches for that Pi
process. Restoring package files does not clear it. Stop/drain, repair the exact
pin/checkout and restart Pi. Do not install/update under an active owner; `/reload`
is not a package-upgrade procedure. Existing owned runs, pending settlement and
approved closed-Done recovery can continue with new admissions disabled.

`max_workers` counts launching, pending, paused, missing/unreadable and unsettled
associated runs as occupied, not just models currently running. Review shares
that budget. A display snapshot cannot lend capacity or override fresh ticket,
sole-claim, exact execution, owner or stop checks. Do not delete evidence or raise
workers just to make an occupied slot disappear.

Ticks reconcile owned work and finalization first, then reserve an available
review slot, pre-fill other slots with builders, review, and back-fill. Necessary
Git/ticket checks remain live. Historical closed-Done cards use one local task-ref
query as a negative filter; query failure is not proof of absence. Progress
records can recover after refs/path have already been removed. Warning deduplication
is display-only: quiet retries are not success or permission to replay unknown I/O.

## Stop, drain and retry

`/board-agent stop` and session shutdown synchronously close admission and
scheduling, cancel foreground models, then await tick/heartbeat cleanup and
manager pause/lease drains. Reentrant/concurrent calls share a barrier. Failed
drains retain the loop, unfinished managers and owner; run/auto-start cannot
replace them. Resolve the failure and retry stop.

“Stopping” or recovery-only is not a completed stop. A tick error may be a warning
after cleanup actually succeeds. Already-started destructive Git keeps its
bounded operation/verification sequence: cancellation does not authorize force
cleanup or early unlock. Foreground review cleanup/claim release is awaited too.

## Back up before upgrades or manual repair

Stop every owner, including processes sharing a global package installation.
Verify that no manager is still draining. Use a **new** backup destination each
time. Example from the target checkout, with a destination that does not exist:

```bash
backup=../board-agent-backup-YYYYMMDD-HHMMSS
mkdir "$backup" || exit 1
git status --porcelain=v1 --untracked-files=all > "$backup/status.txt"
git worktree list --porcelain > "$backup/worktrees.txt"
git branch -avv > "$backup/branches.txt"
cp -a .pi/board-agent "$backup/state"
cp -a .pi/worktrees "$backup/worktrees"
git bundle create "$backup/refs.bundle" --all
```

On PowerShell, create the destination with `New-Item -ItemType Directory
-ErrorAction Stop`, then copy existing state/worktree paths with `Copy-Item
-Recurse -ErrorAction Stop`. Check every command's result. Skip only paths that
are genuinely absent; do not treat copy errors as an empty backup.

The bundle saves committed refs, not dirty/untracked/ignored bytes. Retain the
worktree copies and verify the backup. Handle symlinks/junctions without copying
or removing unrelated external targets. Separately back up external worktrees
and **WorkflowManager journals/lease evidence**, keyed by each ticket worktree
path in Pi workflow storage. Copying `.pi/board-agent/` alone is insufficient.
Record Project item/Issue identity, status, assignees, optional Plan, Type,
branch, path and HEAD for each unfinished ticket.

## Install / upgrade

1. Complete stop/drain and backup above.
2. Choose a reviewed release SHA. In a clean development clone, run the required
   typecheck/offline suites and review the complete diff/package contents.
3. Install the immutable artifact (global example):

   ```bash
   pi install "git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>"
   ```

4. Restart the Pi process. Check the effective global/project package settings,
   `pi list`, installed checkout HEAD and clean status. A pinned update never
   means “follow newest main”; installing a new SHA is explicit.
5. Run lint/status. Let recovery observe existing work before admitting new Tasks.
6. Run a new loop after resolving preflight errors. Optionally inspect a fleet:

   ```bash
   node scripts/verify-board-agent-fleet.mjs <project-path> [more-paths...]
   ```

   The verifier reads current installed HEAD/status and compares runtime
   provenance/liveness. STALE/OVERRIDE/DIRTY/MISMATCH need investigation; STOPPED
   can simply mean an intentionally stopped/recovery-only loop. Do not start or
   update blindly to make a deployment report green.

The repository configures exact Node `22.19.0` Linux/Windows CI. Full-suite,
cross-platform, live GitHub/provider and deployment verification remain separate
release checks; offline local-bare tests do not establish those outcomes.

## State and migration

```text
.pi/board-agent/
  owner.lock / owner.lock.reclaim
  runtime.json                         # existing liveness/provenance schema
  context.md                           # optional host digest
  ticket-worktrees/<safe-id>.json       # current atomic v4
  ticket-worktrees/<safe-id>.json.v3.bak # create-only exact v3 provenance
  cleanup/                             # read-only old receipts
  repair/                              # read-only old ledgers
  cleanup-backups/                      # retained old residual backups
  repair-intent-backups/                # retained old intent archives
  refine-state*.json / watchdog-state.json # retired, untouched evidence
.pi/worktrees/ticket-*/                 # persistent builder/validation work
.pi/worktrees/review-*/                 # detached managed review scratch
```

After exclusive stopped-owner acquisition, supported v3 records convert to v4
with exact-byte create-only backup **before** publication. Reentrant conversion
never overwrites a backup or replays v4. Active/paused/launch-window runs keep
original run/script/args/path. Only a unique journal match binds an interrupted
launch. Queued not-launched old repair work becomes an ordinary build retry;
old bound runs resume rather than spawn duplicates.

Supported old merge/squash results are adopted after verification, not remerged
or newly squashed. A proved integrated result is cleanup-only. Old receipts can
supply partial-cleanup evidence after local ref/record deletion; successful
completion is not re-adopted on every restart. Legacy unregistered leftovers
need existing unchanged ownership/receipt/backup proof. No new hot-path snapshot,
repair ledger or cleanup receipt is created.

Malformed records, v1/v2 and old inflight evidence are retained, never guessed or
automatically destroyed. Lint inventories unsupported paths read-only; production
recovery isolates affected tickets so healthy Tasks can continue where state paths
are safe. Do not change a version number or fabricate a record to bypass evidence.
Retired Story/watchdog state remains read-only. Already-created Task Issues can
continue. Legacy Task Needs Design maps to Needs Human with original questions;
existing Needs Human stays held.

Backups, receipts and ledgers have no automatic garbage collection. Do not
blindly downgrade: an older reader may ignore v4 progress and replay work. A
reader change needs a verified stopped backup compatible with **current** Git
and GitHub state; restoring old files does not undo remote effects.

## Recovery matrix

| Situation | Behavior / operator action |
| --- | --- |
| Builder tool/timeout/test/result failure | Ready/build; continue the original branch, partial diff and MERGE_HEAD. Repair the technical cause; never reset just to retry. |
| Review actionable code findings | Ready/build in the original worktree, then review again. |
| Review execution/tool/timeout/cleanup failure | Ready/review; retry original build SHA or pending cleanup/write I/O, not a new builder. |
| Genuine complete `needs_decision` | Needs Human; preserve work, drain/release stopped slot. Trusted OWNER/MEMBER/COLLABORATOR reply is mission input only after **manual Ready**. |
| Incomplete decision / missing journal / ambiguous launch match | Technical retry/observation, not Needs Human. Retain run binding, uncertainty and slot; do not invent a new run. |
| Partial comment/status/reopen/release failure | Retain settlement; observe/retry I/O before models. A card looking Ready is not settlement/drain proof. Failed writes are reported locally. |
| Fresh identity/claim/lane/requirements change | Preserve human state; no stale snapshot writes. Investigate original claim/evidence if the target is no longer verifiable. |
| Owned paused run / usage limit | Same run resumes after fresh authority and cooperative drain, using existing backoff. Disabled new admissions do not discard recovery. |
| Open Done | Wait for user validation and manual close; keep worktree. |
| Closed Done, no branch and no progress | Nothing to integrate; unknown residuals are not deletion permission. |
| Unknown local branch/worktree without matching record | Preserve; branch naming is not ownership proof. Restore verified evidence while stopped. |
| Verified merge conflict after close | Diagnostic + reopen + Ready/build. Resolve base into original task, test, Review, open Done, then **validate and close again**. |
| Fetch/permission/timeout/malformed merge output | Not a conflict decision; retry integrate/observation, preserve work. |
| Push rejected or response lost | Observe fresh remote result first. Normally retry integrate against valid evidence; once integrated, cleanup only. Never force-push base. |
| Cleanup failure or final Project write failure | Issue remains CLOSED; Project retries Ready/cleanup. Keep record/result; do not rebuild/remerge or recreate deleted refs just to restart. |
| Dirty/locked/nested/external/unknown data | No unsafe cleanup. Stop, back up, coordinate actual ownership and resolve the blocker. Never force worktree remove, prune, unlock or recursively delete as a fallback. |
| Pre-result legacy intent | Only original persistence-order/ref/identity proof permits conversion/clear; missing result alone proves nothing. |
| Old result absent from current remote | Retain evidence and investigate history; absence is not proof it was never pushed. |
| Old unregistered residual | Existing unchanged receipt/ownership/backup evidence only; otherwise preserve for manual investigation. |
| Live/foreign/corrupt owner lock | Do not steal it. Coordinate owners; only a proven-dead same-host PID is reclaimable. |
| Interrupted `owner.lock.reclaim` | Coordinate all contenders, back up both files and verify no takeover remains before deliberate manual recovery. |
| Failed stop/drain | Owner/managers remain retained; retry stop. Do not remove lock to start a second process. |

## Safe cleanup details

Before destructive cleanup, freshly fetched base must contain the persisted
result. The sequence is ignored-only preclean while registered → expected-SHA
remote deletion → normal worktree removal → expected-SHA local deletion →
observed Project Done → ticket record deletion.

Native `git clean -fdX` may discard **ignored** task-worktree files only after
ownership, dirty/lock/nested-Git checks. This runs before remote deletion while
Git registration exists, so Windows ignored-file locks can fail without losing
ownership evidence. Remaining ignored links are removed nonrecursively; external
target data/Git remains untouched. Tracked or non-ignored dirty data is protected.

A remaining path/registration is not cleanup success. New unknown unregistered
remnants have no force/prune/unlock/recursive fallback. Narrow legacy per-entry
cleanup uses existing unchanged evidence only. Missing refs/path are resumable
steps; the integration record survives until final Project/absence verification.

Before a deliberate manual repair, inspect while stopped:

```bash
git -C <repo> worktree list --porcelain
git -C <worktree> status --porcelain=v1 --untracked-files=all
git -C <worktree> branch --show-current
git -C <worktree> rev-parse HEAD
git -C <repo> ls-remote origin refs/heads/<task-branch> refs/heads/<base>
```

These reads are investigation, not permission to delete records, reset partial
work, rewrite history or bypass renewed human approval.
