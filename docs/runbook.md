# Manual-PR v5 rollout and recovery

Board Agent runs inside one foreground Pi process. Install a reviewed full Git
SHA, not a moving branch. **v5 is the ticket record schema**, not a new package
major-version promise. There is no hot update or Docker/daemon deployment.

## Non-negotiable operating rules

- Exactly one owner controls a target checkout. Coordinate all hosts before an
  upgrade; do not delete a live/foreign/corrupt lock to start another owner.
- Keep the installed package checkout, pin and runtime config immutable while
  the owner runs. Package/config consistency checks occur at startup, lint and
  deployment, not heartbeat/UI/ordinary admission. Runtime revision fields are
  the **last checked** observation, not a continuously scanned disk identity.
- Only target-repository Task Issues enter model execution. Closed Done Issues
  of any Type may finalize without an AI-review marker and move to Backlog.
  PR, Draft and foreign cards remain untouched. Plan is optional.
- AI review is mandatory. Done stays OPEN until human validation and Issue close
  requests a managed PR. Human PR merge is the sole final integration approval;
  closing a PR without merge is not completion. The bot normally pushes task
  only, never base, PR merge, Auto-merge or a protection bypass.
- Never delete dirty worktrees, refs, records, journals, receipts or ledgers just
  to clear a warning. Never force-push base or force-clean ticket worktrees.
- Ignored files in a task worktree may be discarded by **`git clean -fdX` and
  normal Git worktree removal**. Preserve valuable ignored data outside that worktree before close.

## Project preflight

Startup, lint and explicit run/promotion validate current config/metadata:

- Status: single-select with Backlog, Ready, In Progress, Review, Done, Needs Human.
- Configured Type field (default `Type`): single-select with Task.
- Plan field/value is not required. Backlog is also available as a manual hold.

No preflight rewrites user config or Project schema. `/board-agent init-project`
is an explicit setup action that creates missing Task fields, not a fallback
that rebuilds existing option lists. Stop successfully, lint and start a **new**
loop after editing config/metadata. A cached recovery loop retains its snapshot.
Restart Pi after changing the package pin or installed source.

## Configuration compatibility

Project `.pi/board-agent.yml` overrides `~/.pi/board-agent.yml`. Both source files
are validated before normalization; warnings identify the source file even if a
project value shadows a global value. No automatic rewrite occurs.

These finite retired inputs are accepted with warnings:

| Input | Current meaning |
| --- | --- |
| `refine.enabled`, `refine.timeout_ms`, `refine.max_tasks` | Ignored; no Story/designer execution |
| `watchdog.enabled`, `fix_rounds_max`, `fix_cooldown_minutes`, `respond_to_mentions`, `pr_label`, `needs_human_label` under `watchdog` | Ignored; no PR maintenance or mention listener |
| `models.refine`, `models.watch` | Ignored; builder/review models are retained |
| `columns.needs_design` | Migration label only; old Task questions map to Needs Human |
| `review.enabled` | Ignored; false cannot disable review |
| `task_merge_strategy: merge` or `squash` | Validated, then warned and ignored; absent from runtime config. Remove the key; there is no replacement mode setting |
| `safety.skip_closed_issues` | Deprecated boolean; closed Issues never launch builders |

Unknown keys, malformed objects, wrong types and invalid ranges remain errors.
Previously unsupported `pr`, `builder_tier`, `branches.plan_prefix` and
`watchdog.interval_seconds` are not guessed. Remove them after deliberate config
review. Models, `max_workers`, timeouts, builder retries, context, custom column
labels and notifications remain configurable; use [config-template.yml](../config-template.yml).

## Stop before upgrading—not finish every Task

```text
/board-agent status
/board-agent stop
```

Stop closes new admission, disables automatic resume scheduling and cancels
startup, foreground review and the one maintenance finalizer. It waits for
startup/migration, the current tick/heartbeat, file handles, review cleanup and
managed pause/lease drain before releasing ownership. Reentrant stop/shutdown
calls share that barrier. If draining fails, the loop/managers/owner remain:
resolve the reported failure and retry stop. A stopping/recovery-only display or
paused status alone is **not** proof that old agents finished their finally blocks.

Stop during worktree preparation must not launch a manager or post a builder
failure comment. Existing work stays. Already-started Git runs to a bounded
outcome; stop waits instead of terminating it or releasing ownership underneath
it. Later destructive steps can be vetoed and resumed from retained progress.
Startup continuations are canceled if stop arrives while initialization waits.

You may upgrade with unfinished or paused Tasks. After the old process has
**stopped and drained**, a new exclusive owner converts supported v3/v4 records
and continues their original worktree and journal. Upgrade all writers together;
never mix v5 with the old direct executor. Do not run old and new versions side by
side against the same state or use `/reload` as a hot-update procedure.

## Stopped backup

Before installation or manual recovery, use a **new** backup directory. Capture
all applicable paths; skip only those that do not exist:

```bash
git status --porcelain=v1 --untracked-files=all
git worktree list --porcelain
git branch -avv
mkdir ../board-agent-backup-<unique-name>
cp -a .pi/board-agent ../board-agent-backup-<unique-name>/state
cp -a .pi/worktrees ../board-agent-backup-<unique-name>/worktrees
git bundle create ../board-agent-backup-<unique-name>/refs.bundle --all
```

PowerShell equivalents for copies/bundle:

```powershell
New-Item -ItemType Directory ..\board-agent-backup-<unique-name>
Copy-Item -Recurse .pi\board-agent ..\board-agent-backup-<unique-name>\state
Copy-Item -Recurse .pi\worktrees ..\board-agent-backup-<unique-name>\worktrees
git bundle create ..\board-agent-backup-<unique-name>\refs.bundle --all
```

A bundle saves committed refs, **not dirty/untracked/ignored work**. Preserve
those bytes/layout too, including worktrees outside `.pi/worktrees`. Record each
Project item/Issue, status, Type, optional Plan, assignees, path, branch and HEAD.
WorkflowManager journals/leases are in Pi's external workflow project storage,
keyed by the persistent worktree path: include those, not only repository-local
`.pi`. Preserve old repair/cleanup/Story/watchdog sources and retained backups.

## Deployment checklist

In the reviewed release checkout:

```bash
npm ci
npm run check
npm pack --dry-run
git status --short
git rev-parse HEAD
```

Verify package/lockfile consistency, Node `>=22.19.0`, and Linux/Windows checks
on exact Node **22.19.0**. The package contains runtime, builder skill, template,
architecture and runbook, not dependencies bundled into source or audit reports.

Before enabling the owner in a target repository:

1. Verify the bot can read/write the required Issue/Project fields, normally
   push task refs, read/create PRs via GitHub APIs and delete task refs with exact
   leases. Direct base-push or PR-merge privilege is not required. Keep required
   PRs, checks/reviews and base protections. Preparation merge commits are allowed
   on task; human **Squash and merge** is recommended for linear base history.
   With strict checks, humans may need merge-based **Update branch**. Do not
   relax protection or use an admin bypass to make deployment/tests pass.
2. Stop/drain every old owner and take the backup above. Tasks need not be done.
3. Install the reviewed full SHA, then restart Pi:

   ```bash
   pi install "git:github.com/Hikoia/pi-board-agent@<REVIEWED_FULL_40_CHARACTER_SHA>"
   pi list
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent rev-parse HEAD
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent status --porcelain
   ```

   The installed checkout must be clean at that exact SHA. Use the actual
   `PI_CODING_AGENT_DIR` package path if customized. A pinned install does not
   advance automatically with `pi update --extensions`.
4. In the target repository run lint, inspect status, then run. Startup acquires
   the exclusive owner before conversion or manager creation. Review isolated
   conversion failures before moving additional Tasks to Ready.
5. For explicit fleet verification:

   ```bash
   node scripts/verify-board-agent-fleet.mjs <project-path> [more-paths...]
   ```

   This deployment tool deliberately inspects current package HEAD/status.
   STALE, OVERRIDE, DIRTY, MISMATCH, STOPPED, STARTING or STOPPING needs investigation. It is not an
   ordinary heartbeat hook, and STOPPED is expected during a stopped rollout.

Windows additionally needs PowerShell FullLanguage with `Add-Type`/PInvoke for
Job Objects. Git/gh run non-interactively with deadlines and ordinary descendant
termination. No timeout or permission failure is authority to discard work.

## v3/v4 continuation and unsupported state

The single legacy adapter supports known v3/v4 records, WorkflowManager journals,
repair ledgers and cleanup receipts. Conversion is per ticket, exact-byte,
create-only backup first (`legacy-v3/` or `legacy-v4/`), atomic v5 publication
second. Reentry skips published v5, even after an interrupted response.
Source/backup mutation, owner loss or stop before publication blocks conversion.

- Active/paused work resumes the original run/script/args/path.
- A launch window adopts only a unique persisted match; ambiguous/missing
  evidence stays occupied for re-observation, never launches another builder.
- Unlaunched old repair becomes an ordinary build retry retaining diagnostics.
- Old merge/squash results verified already on fresh `origin/base` become
  `legacy-completed`: immutable cleanup-only evidence; no PR is created.
- Pending `integrate` results are reused as prepared PR heads only after exact
  source/result validation and preserved source ancestry; normally push to task,
  never base. A pending historical squash without that ancestry blocks safely.
- Missing/corrupt evidence, changed sources, rewritten base, or a `cleanup` result
  absent from fresh base blocks conversion. Preserve bytes/worktrees/refs; do not
  erase a result, rewrite schema numbers or manufacture a new ticket to proceed.
- Fresh human-closed Done approval needs no AI-review marker, in either schema.
- Existing receipts/ledgers remain read-only; they are not garbage-collected.
  Unregistered residuals require existing validated ownership/unchanged evidence
  and any recorded backup. Unknown leftovers stay untouched; no new snapshots
  or automatic backup-and-delete path is created.
- Needs Human remains. Old Task Needs Design becomes Needs Human with its
  original questions. Closed Done non-Task Issues may complete; unrelated
  Story/PR records and existing Issues are not closed/deleted. Story/watchdog journals are retired read-only artifacts.

Unsupported inflight, v1/v2 and corrupt data is reported, not renamed, deleted
or upgraded by changing a schema number. Stop and preserve it; manually assess
it with a compatible old reader in an isolated copy. Do not infer ownership or
restore only old JSON against newer remote effects. A downgrade requires a
separately verified coherent stopped backup and remote-state reconciliation.

## PR approval and returned work

Closing Done submits one managed PR per `itemId + createdAt` execution. Preparation
pins local/remote task tips, supports either ref or ahead/divergent histories and
may add a task merge commit without moving the user's worktree HEAD. Saved PR
number wins on recovery; otherwise all-state lookup validates scope, marker and
source ancestry. Conflicting/multiple candidates block; the bot does not overwrite
human PR bodies, auto-close/reopen PRs or create replacements on uncertainty.

Waiting keeps closed Done, worktree and refs. Each bounded observation returns,
freeing the single finalizer and using no worker slot. Pending/failed CI or required
reviews remain GitHub/human concerns; they never launch a builder automatically.
Humans may append commits or merge-update base into task for strict required
checks. Rebase/force rewriting that loses required ancestry blocks cleanup;
patch-equivalence is not inferred.

Reopen the Issue or leave the approval lane to pause integration/cleanup. To return
unmerged work, set **open Ready**: submission approval is suspended, the same PR
identity remains, and the original builder can repair its original worktree.
Finish any owned `MERGE_HEAD` and commit intended work; **fetch and merge published
`origin/<task-branch>` before normal push**, preserving prepared-source ancestry.
Then tests → AI Review → Done → renewed human close prepares/updates the same
still-open PR. Human PR merge is still required. Confirmed merged or
`legacy-completed` evidence never becomes buildable again. If a PR is merged
while withdrawn/active, work is retained; renew closed Done for cleanup only when
all current work is covered. Uncovered later work needs a new submission/PR.

## Retry and human decision matrix

| State / failure | Automation and operator response |
| --- | --- |
| Ready/build | Continue original branch/worktree, including dirty partial work and MERGE_HEAD; tests, push, then mandatory review |
| Ready/review | Retry the original pinned review commit; fix provider/fetch/setup failure, not rebuild successful code |
| Needs Human | Real requirement/product/cost/authorization decision only: trusted maintainer reply **and manual Ready**; reply alone does nothing |
| Review code findings | Ready/build, not Needs Human; preserve original work |
| Malformed output, tests, timeout, exhausted retries | Technical retry, not a decision; repair the underlying problem |
| Pending comment/status/reopen/release | Retry I/O after fresh observation and safe drain; no replacement builder or false Ready claim |
| Done OPEN | Await human validation/close; no integration or task cleanup |
| Closed Done Issue of any Type | No review marker required. Prepare/push task, create/recover managed PR; wait for human merge before cleanup/Backlog |
| Initial deterministic repairable base conflict | Comment, reopen, Ready/build; resolve original branch, tests → review → Done → **renewed human close** |
| Local/remote source conflict | Preserve both sources for manual resolution; no automatic conflict builder |
| Waiting PR needs CI/review or base update | Retain work and PR link; human handles checks or merge-based Update branch, no automatic rebuild/update |
| PR closed without merge | Retain everything; human resolution required, no automatic reopen/replacement |
| Task push or PR-create response lost | Observe refs and recover by saved PR number/all-state lookup before retry; saved preparation is not completion |
| Unknown API/403/timeout/incomplete JSON | Technical diagnostics and retained evidence; never interpret unknown as absent/merged |
| Merged cleanup/Backlog write failure | Keep Done/Backlog and cleanup proof; retry unfinished cleanup/Backlog only, no build/review/publication replay |
| Old closed Ready + integrate/cleanup | Preserve technical evidence; retire obsolete pending Ready writes. Closed Ready is not fresh PR submission approval; use closed Done to renew |
| Old technical pending Ready writeback | Do not replay Ready/comment/reopen; freshly verify identity/claim/record, release safely and honor withdrawal without erasing the technical stage |
| Remote base rewritten or confirmed result absent | Preserve integration record/refs/work; investigate, never supersede cleanup with a new result |
| Dirty/untracked programs, changed refs, wrong path/branch, Git lock | Cleanup blocks. Stop and investigate the actual owner; never force-remove/prune/unlock to get green |
| Unknown unregistered leftover | Retain it. No recursive fallback or new snapshot to manufacture removal authority |
| Missing/mismatched journal or unknown launch | Retain association and conservative capacity; investigate original journals, never start a competing run |
| Manual lane/claim/identity withdrawal | Do not overwrite it or treat it as a technical failure; release only a freshly verified original bot claim after drain |
| No local task ref | Check remote; restore remote-only ref using compare-and-create, never create a builder/worktree |
| Confirmed no local or remote task refs | Move closed Done to Backlog only; preserve idle records/leftovers and never bypass pending or corrupt recovery |
| Stop during pending writeback | Do not send a late status/comment/reopen; retain the pending reset/result for guarded settlement by the next owner. Safe release-only cleanup may finish |
| Failed owner drain / owner.lock.reclaim remains | Coordinate all owners, preserve evidence, retry or investigate; never steal ownership from an uncertain process |

`max_workers` counts launching, paused, missing and unsettled associated runs as
occupied. An optimistic widget cannot authorize more capacity. Normal provider
backoff is retained. Review gets at most one foreground slot; builders use the
remaining budget. One maintenance finalizer uses no model slot and does not
hold Ready/Review admissions behind cleanup or repeated remote reads. Candidates
rotate; the same ticket is excluded until settlement. Board-wide GitHub failure
still fails closed. There is no second retry queue or same-ticket immediate retry.

Inspect before manual recovery:

```bash
git -C <repo> worktree list --porcelain
git -C <worktree> status --porcelain=v1 --untracked-files=all
git -C <worktree> branch --show-current
git -C <worktree> rev-parse HEAD
git -C <repo> ls-remote origin refs/heads/<task-branch> refs/heads/<base>
```

These observations do not authorize deletion by themselves. PR cleanup requires
the exact saved PR identity, explicit `merged=true`, actual `mergeCommitSha` on
fresh `origin/base`, and merged PR head covering prepared/saved/current task work.
Task ancestry in base is not squash proof; an unmerged test-merge SHA is never
completion. A GitHub-deleted head branch does not bypass the saved PR checks.

Cleanup order: remote task ref with exact lease → normal worktree removal → local
ref with compare-and-delete → confirm Project Backlog → delete record last.
Missing steps resume; unknown/dirty/new work or changed ownership detected by the
guards blocks deletion. Retain evidence, never force-delete to make cleanup pass.

### Cleanup observation boundary

Guards renew owner, stop, ticket/PR authorization, source coverage and base proof
stepwise, with synchronous local checks after the final awaited authorizer.
Remote deletion uses an exact lease and local ref deletion compare-and-delete.
**This is a latest-observation boundary, not cross-system atomicity:** GitHub and
remote Git cannot be read atomically. If the remote task ref is recreated during
the final GitHub authorizer, its new remote commits remain protected, but the
already-merged local worktree/ref/record can still be removed. That post-observation
race is accepted; repeated checks are not a distributed lock or an absolute
prevention guarantee. Coordinate returned/new work through withdrawal/open Ready
rather than relying on racing cleanup.

## Maintenance observation

`/board-agent run` and auto-start return after registering startup; `starting`
means preflight/migration has not yet opened model admission. `stopping` means
cancellation/drain is pending, not that the owner can be replaced. Fleet checks
report STARTING/STOPPING as non-healthy and grant no takeover authority.

Widget, `/board-agent status` and schema-1 `runtime.json` show maintenance apart
from model slots: ticket, phase, completed/total MiB or items, elapsed time,
`lastProgressAt`, and the last blocking reason. Missing activity in an older
runtime is valid. Progress updates are limited to once per second except phase
changes/errors/end, without extra Git/GitHub/revision probes. Active activity
clears on completion; the blocker persists until the next attempt.

Heartbeat only means the owner is responding. After no progress for
`max(3 × tick_seconds, 300)` seconds, inspect the displayed duration/blocker;
**do not automatically unlock or restart**. Slow Git completes at its existing
deadline, and stop waits for it rather than abandoning its Promise.

Legacy cleanup verifies its full backup at preparation and finish (at most twice
per attempt), then checks each surviving source/parent/backup before non-recursive
unlink/rmdir. Large files hash in 1 MiB chunks with cooperative cancellation.
Receipt/manifest metadata is pinned between complete reads. Remote authorization
is refreshed after at most 32 deletes or 1 second; long-file validation that
exhausts the window refreshes before deletion. Local owner/record/Git checks and
stop are never cached. Ref deletion/completion have separate fresh guards. The
window is **not** a network timeout or a one-second remote-change detection SLA.
Partial removal resumes safely; no new cleanup snapshots/backups/archives or
force-delete fallback are introduced. There is no fixed cleanup-time promise.

## State locations and evidence

```text
.pi/board-agent/owner.lock[.reclaim]
.pi/board-agent/runtime.json                     # last-check identity, heartbeat, optional maintenance activity
.pi/board-agent/context.md
.pi/board-agent/ticket-worktrees/<item>.json      # v5 continuation (PR or legacy-completed evidence)
.pi/board-agent/legacy-v3/*                      # exact raw v3/receipt migration sources
.pi/board-agent/legacy-v4/*                      # exact raw v4 migration sources
.pi/board-agent/repair/*                         # old, read-only
.pi/board-agent/cleanup/*                        # old, read-only
.pi/board-agent/cleanup-backups/*                # old, retained if present
.pi/board-agent/repair-intent-backups/*           # old, retained if present
.pi/board-agent/refine-state{,-unblocked}.json    # retired, untouched
.pi/board-agent/watchdog-state.json              # retired, untouched
.pi/worktrees/ticket-*                          # persistent Task work
.pi/worktrees/review-*                          # isolated ephemeral review
```

Old watchdog worktrees also remain for manual preservation; no new watchdog
runs. Include external WorkflowManager storage in backups. There is no automatic
archive GC or production repair/snapshot maintenance path.

## Validation boundaries

`npm run check` uses isolated, auto-discovered offline fixtures, local bare Git
remotes and fake board/model boundaries. It is not live GitHub/Project or real
model certification. This delivery is local/offline only: no deployment or action
on real #121. MAIN accepted G4 after typecheck and 222 focused checks including
authorization-race fixes; **final full-suite offline acceptance remains pending
MAIN T07**. Live GitHub permissions, PR behavior, CI and branch protections have
not been verified here. Before rollout, separately validate task-push/PR API
permissions and manual squash merge/cleanup in a protected test repository;
never change protection as a test shortcut. The earlier v4 test-port mapping is
historical: [test-v4-mapping.md](test-v4-mapping.md).

Historical `architecture-flow-audit.md`, `overengineering-audit.md` and
`review-builder-concurrency-analysis.md` retain their original baselines. They
are not current policy; use this runbook and [architecture](architecture.md).
