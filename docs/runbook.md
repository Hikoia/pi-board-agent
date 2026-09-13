# 0.2.0 rollout and recovery runbook

Board Agent runs inside a foreground Pi process. It is installed from one
reviewed, full Git SHA; there is no Docker/daemon deployment in 0.2.0.

## Invariants

- The effective Pi package entry is pinned to a 40-character SHA.
- The loaded module SHA, package checkout HEAD, and configured SHA are equal.
- The package checkout is clean and is never used for development.
- Exactly one owner process controls a target checkout.
- Windows requires PowerShell FullLanguage with `Add-Type`/PInvoke allowed;
  constrained hosts fail closed rather than losing subprocess containment.
- Issue mutations target only the repository from `origin`; `project.owner`
  controls Project GraphQL access only.
- Never delete dirty worktrees, branches, journals, records, receipts or repair
  ledgers merely to clear a warning.
- Do not blindly downgrade while a cleanup receipt or repair is pending. Older
  readers may ignore recovery evidence and replay work. Use a compatible reader;
  any downgrade needs a separately verified stopped backup consistent with the
  current Git/GitHub state, not just restored old files.

## Capacity and admission

`max_workers` is the total model budget for builders plus one foreground
invocation shared by Task design, Story refine, review and watchdog. Occupied
slots include launching, pending, paused, missing/unreadable associated runs,
not just running models. A widget showing more occupied than running is
conservative by design; investigate recovery evidence rather than raising the
limit or deleting a record to bypass it.

Tick order is recovery/finalization → reserve one primary slot → pre-fill
builders → at most one primary model (Task design → Story refine → Review) →
recount/back-fill builders → awaited watchdog maintenance. Waiting/non-model
work may fall through to another primary lane. Watchdog models take spare
capacity only and can be deferred while builders fill the budget. This is not a
throughput guarantee or a fair queue across model roles.

Runtime/widget summaries are non-authoritative observations. Live
identity/contract/sole-claim, stop, capacity and revision checks gate the actual
start after preparation; fresh identity/claim/revision checks gate write-back.
Failed reads do not fall back to old board snapshots; failed builder assignee
releases retain unsettled execution evidence for retry. Foreground best-effort
releases warn on failure. A green-looking UI is not permission to clear evidence.

Runtime network Git and package-revision checks use the async deadline runner;
Git writes remain ordered and small synchronous local/context probes remain.
No speed/cost claim follows from this. Closed-Done history uses one local-ref
query per eligible tick as a negative filter only; presence still needs fresh
approval/ref/worktree checks. Failure warns/blocks finalization, not “all absent.”
A branch created after the snapshot may wait one tick; unsettled records and
repair handoffs still reconcile independently. Pending cleanup receipts bypass
the no-local-ref filter, including after record/ref deletion has already succeeded.
Identical per-ticket finalization/repair blockers warn once per loop lifetime,
not once per attempt: checks and safe retries still run every tick. A changed
reason/SHA, recovery, different ticket or restart can warn again. Silence does
not mean success and never authorizes replay of an unconfirmed write.

## Project preflight

Startup, lint and promotion from recovery to autonomous mode check current
config and enabled-lane metadata before admitting work:

- Status and Type must be single-select; Plan must be text or single-select.
- Ready, In Progress, Review, Done, Needs Human and Type `Task` are required.
- With refinement enabled, Needs Design and Type `Story` are required too.
  Backlog is recommended for manual holds but is not an automatic lane gate.
- Each unrefined/partial Story needs its Plan option to exist before claim,
  model or child work. Text Plan writes text; select Plan uses its existing
  option ID. Child creation independently checks metadata and publishes Ready
  only after Plan/Type are set and freshly verified.

Missing/wrong fields or select options fail closed. Preflight never creates or
repairs schema. `/board-agent init-project` is a separate **explicit** operator
schema action, not a startup fallback. After manual schema/config edits, stop
successfully, lint, then run a **new** loop to refresh its metadata/config.
Promoting a cached recovery loop validates today's metadata but keeps its old
snapshot. Restart Pi too after a package-pin change.

Remove deprecated `safety.skip_closed_issues` from both
`~/.pi/board-agent.yml` and `.pi/board-agent.yml`. Explicit `true` and `false`
remain boolean-compatible but both emit a file-specific warning through
startup/config commands, including shadowed global values. Absence/defaults
stay quiet; invalid booleans and unknown keys still fail. Closed Issues never
start builders/design regardless of this key. A closed Done Task may finalize
or enter conflict handoff; it must be confirmed reopened before builder admission.

## Story scope and builder context

Ready tasks must be independently implementable **and verifiable from the
current base**. Combine an unavailable API and its consumer/verification into
one Task; otherwise hold dependent work in Backlog until the prerequisite is
integrated. Ordering task numbers or using one worker does not serialize merges.
`refine.max_tasks` is an output rejection limit, not permission to truncate
requirements. Invalid/over-limit output creates no intents/children and gets no
automatic repair pass; normal later polling of unjournaled Ready Stories remains.
Unresolved questions wait in Needs Design without publishing tentative children.
Human review still checks semantic independence; schema validation cannot.

Refine and Task-design agents use private roles plus SDK
`session.tools: ["structured_output"]`: the actual surface excludes coding and
shared-store tools. A prompt ban or empty role allowlist alone is insufficient
in workflow 3.10.0; do not extend this guarantee to other roles. Builders use
[`workflow-prompt.ts`](../src/workflow-prompt.ts)'s production mission and the
[builder skill](../skills/board-agent/SKILL.md); the packaged
[compatibility agent path](../agents/board-agent-builder.md) supplies no second
rule body or permissions. Their new-launch digest comes from the prepared
worktree, not the host cache; read relevant code as authority. Durable resumes
retain their mission. Digest generation creates no worktree cache files.

## Stop and retry

`/board-agent stop` and session shutdown close admissions and abort foreground
models, then await tick/heartbeat cleanup and manager pause/lease drains before
releasing the owner. Concurrent calls share one completion barrier. During a
failed/incomplete drain the loop, managers and owner remain retained; run and
auto-start cannot replace them. Retry stop after resolving the reported cleanup
failure. `recovery-only`/“stopping” is not a completed stop; only successful
cleanup permits takeover. A tick error can remain a warning after cleanup has
actually completed.

Cancellation does **not** abort destructive Git or authorize force-cleanup.
Already-started Git keeps its deadline and recovery/verification sequence; stop
waits. Foreground finally blocks and claim-release attempts finish before ownership
release. Preserve failed CI-fix worktrees; disposable review cleanup is awaited.

## Back up before any upgrade or manual state repair

Stop every owner first:

```text
/board-agent status
/board-agent stop
```

From the target repository, record and copy all recovery evidence:

```bash
git status --porcelain=v1 --untracked-files=all
git worktree list --porcelain
git branch -avv
mkdir -p ../board-agent-backup
cp -a .pi/board-agent ../board-agent-backup/state
cp -a .pi/worktrees ../board-agent-backup/worktrees
git bundle create ../board-agent-backup/refs.bundle --all
```

On PowerShell:

```powershell
git status --porcelain=v1 --untracked-files=all
git worktree list --porcelain
git branch -avv
New-Item -ItemType Directory -Force ..\board-agent-backup | Out-Null
Copy-Item -Recurse -Force .pi\board-agent ..\board-agent-backup\state
Copy-Item -Recurse -Force .pi\worktrees ..\board-agent-backup\worktrees
git bundle create ..\board-agent-backup\refs.bundle --all
```

Use a new backup directory each time; skip only paths that do not exist. The
bundle saves committed refs, not dirty or untracked files: retain the worktree
copy as well. Copy any worktrees located outside `.pi/worktrees` separately.

Also save the Project item status, Issue number, assignees, Plan, Type, task
branch, worktree path, and HEAD for every active ticket.

### Unsupported state policy

0.2.0 deliberately has no automatic migration for:

- `.pi/board-agent/inflight/*.json`;
- malformed ticket records; or
- ticket records with schema version 1 or 2.

Startup, `/board-agent lint`, and `/board-agent run` list every unsupported path
and stop before GitHub mutation. They do not archive, rename, overwrite, or
delete anything.

After backing up, finish or manually preserve the old task work. Only then
remove/migrate the listed files. A valid 0.2.0 ticket record must be schema v3;
do not change the version number without reconstructing and verifying every
field and Git ref.

Remove these obsolete keys from `.pi/board-agent.yml`:

```text
pr
builder_tier
branches.plan_prefix
watchdog.interval_seconds
```

Use `models.builder`, `branches.base`, `branches.task_prefix`, and the main
`tick_seconds` scheduler instead. `pi-dynamic-workflows` is installed as a
normal dependency, not bundled.

## Release checklist

In a clean development clone or isolated worktree:

```bash
npm ci
npm run check
npm pack --dry-run
```

Confirm:

- package and lockfile versions are `0.2.0`;
- Node engine is `>=22.19.0`;
- the tarball contains `src/`, `skills/`, `agents/`, and
  `config-template.yml`, but no Docker files or bundled dependency metadata;
- Linux and Windows CI use exact Node `22.19.0` and run
  `npm ci && npm run check`;
- `git status --short` contains only intended release changes.

Commit and push the complete release. Record the immutable commit:

```bash
RELEASE_SHA=$(git rev-parse HEAD)
test "${#RELEASE_SHA}" -eq 40
```

## Rollout

1. Stop active owners and wait for `/board-agent stop` to settle managers.
2. Take the backup above.
3. Install the reviewed SHA:

   ```bash
   pi install "git:github.com/Hikoia/pi-board-agent@$RELEASE_SHA"
   ```

4. Restart Pi. Verify the deployment artifact:

   ```bash
   pi list
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent rev-parse HEAD
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent status --porcelain
   ```

   HEAD must equal `RELEASE_SHA`; status must be empty.

5. In each target repository:

   ```text
   /board-agent lint
   /board-agent status
   /board-agent run
   ```

6. Let startup reconciliation finish before moving new cards to `Ready`.
7. If managing several projects, run:

   ```bash
   node scripts/verify-board-agent-fleet.mjs <project-path> [more-paths...]
   ```

   `STALE`, `OVERRIDE`, `DIRTY`, `MISMATCH`, or `STOPPED` requires correction
   and a Pi restart before new work is admitted.

## State locations

```text
.pi/board-agent/owner.lock
.pi/board-agent/owner.lock.reclaim  # present only during stale-owner takeover
.pi/board-agent/runtime.json
.pi/board-agent/context.md
.pi/board-agent/refine-state.json
.pi/board-agent/refine-state-unblocked.json  # same-format healthy updates beside frozen evidence
.pi/board-agent/watchdog-state.json
.pi/board-agent/ticket-worktrees/<safe-project-item-id>.json  # unchanged v3
.pi/board-agent/cleanup/<safe-project-item-id>.json          # late cleanup receipt
.pi/board-agent/cleanup-backups/<unique-backup>/            # verified legacy residuals + record
.pi/board-agent/repair/conflict-<hash>.json                  # retained handoff/run binding
.pi/board-agent/repair-intent-backups/<item>-<hash>.json     # exact old record bytes
.pi/worktrees/ticket-*/
.pi/worktrees/review-*/
.pi/worktrees/watchdog-*/
```

WorkflowManager journals are in Pi's workflow project storage, keyed by the
persistent ticket worktree path. Use `/board-agent status` and the record's
`activeRunId` to locate them. Include those journals in the stopped backup too;
copying only `.pi/board-agent/` does not capture external run/lease evidence.
Cleanup backups, intent archives and consumed repair ledgers are not automatically
garbage-collected. Keep them in backups; neither restarting nor successful repair
is permission to discard this evidence.

## Recovery matrix

| Message / state | Automation behavior | Required human action |
| --- | --- | --- |
| `Unsupported pre-0.2.0 Board Agent state detected` | Startup/lint/run stop read-only | Stop Pi, back up the listed paths and refs, finish/preserve old work, then remove or deliberately migrate each listed artifact. |
| Closed `Done`, neither local task branch nor cleanup receipt | Finalizer has no work; no remote queries or leftover-file deletion | Do not delete unknown residuals just to match the UI. Unsettled records/repair ledgers reconcile independently; a remote-only branch does not trigger finalization. |
| Closed `Done`, local task branch exists | Ordinary merge into fresh `origin/<base>`, push/verify, receipt, then checked cleanup; no Plan, execution record or AI-review marker required for integration | Validate current local commits before closure. Local-only branches are supported; automatic conflict handoff separately requires the original record, Plan and matching pushed task SHA. |
| Pending cleanup receipt, even without local ref/record | Reconfirms remote integration and retries only receipted cleanup | Preserve receipt and any backup. Do not recreate a branch/worktree or relaunch a builder to make cleanup retry. |
| `In Progress` without a valid v3 record | That card moves to `Needs Human`; siblings continue | Inspect Issue history and branches. Restore a verified record/worktree from backup or restart intentionally from `Ready`. |
| Missing WorkflowManager run or mismatched persisted args | Stops/quarantines only that ticket | Preserve the worktree, inspect the run journal and record, then move to `Ready` only when ownership and intended diff are known. |
| Dirty completed worktree / wrong branch / unmanaged path | Fails closed to `Needs Human` | Do not reset automatically. Inspect and commit/push valid ticket work, or discard it explicitly; restore the expected registered branch/path before retry. |
| Usage-limit pause | Remains paused for the scheduler | Wait or repair provider access. Do not create a second run. |
| `AI review failed ... Leaving status unchanged` | No stale write-back; an unchanged card stays `Review` | Fix fetch/auth/agent/cleanup failure. Retry uses a new detached worktree only if still eligible. |
| Main checkout changed during isolated review | Review fails and ephemeral cleanup is attempted | Inspect the main checkout immediately; preserve unexpected changes and restore its prior branch/HEAD/status before retry. |
| Missing or older AI-reviewed SHA on a closed Done Task | Not a finalization gate; closure approves the current local branch | Reopen the Issue if the current commits are not approved. AI review still governs automated `Review` → `Done`. |
| Dirty, missing, locked or unmanaged registered task worktree | No unsafe removal; card remains closed and `Done` | Stop Board Agent and preserve/resolve the worktree. For a lock, confirm no process uses it before `git worktree unlock <path>`. A branch without a registered worktree needs no recreation. |
| Verified merge conflict with provable original ownership | No integration push/cleanup; guarded `requested` → Ready → reopen → `queued` handoff | Let the unique original-worktree builder repair and return to Review. Validate and close the Issue again; see below. |
| Conflict without handoff proof / unrelated history / malformed Git output | Blocks and preserves work; not authority to launch repair | Inspect the blocker while stopped and backed up. Do not fabricate a marker/record or clear pending evidence. |
| Unconfirmed handoff/terminal write, closed Ready, or open Ready not confirmed queued | Reads reconcile exact attempted results; no blind replay or ordinary builder fallback | Preserve the ledger and actual bot comment. Investigate permissions and remote state; uncertainty remains blocked, not permission to repeat a write. |
| Human changes owner, lane or ticket identity during repair | Fresh authority checks stop unsafe handoff/settlement; an observed contrary state invalidates unfinished handoff | Keep the human decision and recovery evidence. Moving back to an old lane does not resurrect an invalidated request. |
| Repair failure / bad test evidence / repair Review findings | Needs Human when still authorized; no automatic Ready retry | Inspect preserved work and evidence. A consumed request is not reused; an explicit maintainer reopen/Ready retry follows ordinary builder flow. |
| Push rejected / verification failed | Local branch and worktrees remain | Repair credentials, connectivity or branch protection. Ordinary finalization before a receipt retries against fresh remote base with a normal, non-force push; pending legacy results need the proof below. |
| Cleanup drift/failure after base integration | Late receipt retains retry authority; local ref is deleted only after directory/Git cleanup, then record and receipt last | Resolve the reported lock or ref race without deleting evidence. Added/changed/replaced files, unknown ownership, corrupt receipts/backups and unmerged remote-only commits block. No duplicate integration or cleanup success while managed directories remain. |
| `Story creation needs human input` | Creation journal and completed children remain; Story moves to `Needs Human` | Fix auth, Project fields, duplicate marker ambiguity, or incorrect item identity. Move the Story to `Ready`; it resumes without rerunning refinement or duplicating children. |
| Story/Task in `Needs Design` | Waits without consuming untrusted comments | Reply as repository OWNER/MEMBER/COLLABORATOR after the latest authentic question/gate. |
| Story create/add/comment attempted but result unconfirmed | Keeps attempt markers and refuses blind repetition | Inspect paginated sub-Issues, Project items, and bot comments. Restore/adopt the intended remote result where possible. Clear an attempt marker only while stopped, after backup and positive confirmation that the operation did not take effect. |
| CI fix stopped / unresolved prior CI fix worktree | Retains `.pi/worktrees/watchdog-<pr>-*`; does not start a replacement | Inspect and preserve dirty files/commits, compare the PR remote SHA, then explicitly remove only the resolved watchdog worktree. Do not force-delete unresolved work. |
| Git/`gh` timeout | Process tree is terminated; durable state remains at the last completed boundary | Repair network/credentials and let fresh reads reconcile side effects. An unconfirmed attempted repair write is not blindly replayed. |
| Owner lock held | A second owner refuses to start | Use the existing process. Reclaim only a provably dead same-host pid; a different-host lock requires coordination. |
| `owner.lock.reclaim` remains after interruption | Stale takeover fails closed | Stop/coordinate every owner and contender, back up both lock files, verify no takeover is active, then remove only the stale reclaim file. Never clear a live or foreign-host owner by guessing. |
| Could not pause workflow runs / cleanup incomplete during stop | Loop, managers and owner lock remain held; restart/admission blocked | Inspect the named managers/leases, then retry `/board-agent stop`. Coordinate deliberate process termination only if cleanup cannot be recovered; a stopped heartbeat is not proof of successful shutdown. |
| Fresh read fails or item disappears | No snapshot-authorized mutation; missing items use orphan recovery | Preserve record/worktree/journal evidence and investigate remote identity/access. Retry fresh observation; do not substitute an old card dump. |
| Assignee release fails after terminal comment/status | Execution association stays unsettled; settlement retries without a new builder | Repair access/ownership and let reconciliation finish. Do not delete the association because the card already looks terminal. |
| Closed-Done local refs query fails | Warns and skips this finalization lane, retaining work | Resolve the Git failure and retry; do not treat it as confirmation that all tasks are settled. |
| Truncated Story creation journal | Affected Story cannot publish or complete; healthy updates continue durably | Follow the exact-byte journal recovery procedure below; keep both files. |

## Truncated Story journal recovery

Older code could store more refinement tasks than publication intents. A
recognizable shortened prefix (even zero intents, or an entry already marked
refined) is evidence, **not** an actionable plan. The affected Story is warned
and blocked before claim/model/write; its already-published children are not
reset. This exception does not make arbitrary malformed journals acceptable.

The current reader keeps `.pi/board-agent/refine-state.json` **exactly byte-for-byte
at its original path**, including formatting/line endings. It writes only
healthy Story changes atomically to `.pi/board-agent/refine-state-unblocked.json`
in the **same existing journal format/schema**, so siblings' publication,
comment cursors and completion remain durable across restart. Reads combine
both files. A companion cannot override truncated evidence, and a missing
original or malformed/symlinked companion fails closed.

Recovery is manual, with no automatic consolidation, migration or repair:

1. Finish a successful stop for every owner. Take a new backup of **both**
   journal files, all worktrees (dirty/untracked included), refs, ticket records
   and external WorkflowManager journals. Keep the original bytes in backup.
2. Compare the entire `creation.refine.tasks` list against `creation.tasks`,
   deterministic markers, paginated remote sub-Issues/Project items, assignees,
   comments and integrated refs. Record which requirements are still missing
   and which attempted operations actually took effect. Uncertainty remains
   blocked; it is not permission to repeat a create/add/comment.
3. Have a maintainer explicitly reconcile the complete intended scope and
   remote results while stopped. There is no supported “change the count,”
   “delete the blocked entry,” or “mark refined” shortcut. If manually
   reconstructing state, preserve verified identities, digests and attempt
   evidence in **both** files; validate in a disposable copy before resuming.
4. Restart only with a reader that understands both files. Do not discard the
   companion to clear an error or blindly downgrade: older readers ignore its
   healthy progress and may replay work. A downgrade needs a separately
   verified, coherent stopped backup compatible with that reader **and** the
   current remote/Git state; restoring old files does not undo GitHub effects.

## Manual verification before retry

Before retrying a local task branch, inspect its commits and worktrees:

```bash
git -C <repo> worktree list --porcelain
git -C <worktree> status --porcelain=v1
git -C <worktree> branch --show-current
git -C <worktree> rev-parse HEAD
git -C <repo> ls-remote origin refs/heads/<task-branch> refs/heads/<base>
```

Done + closed approves committed work on the current local task branch.
The remote task branch may be absent or behind it. Registered task worktrees
must be clean; remote-only commits and concurrent ref changes prevent deletion.
Stop the owner before manually resolving completed-ticket branches. Never
force-push the base as a recovery shortcut.

## Conflict repair and reapproval

Only a positively verified merge-tree conflict can initiate automatic repair.
The original idle v3 record, Plan, task branch/worktree, exact local/remote task
SHA, fresh base SHA, identity, ownership, revision and stop gates must still
match; another builder or a cleanup receipt blocks handoff. A failed fetch,
permission error, timeout or unrelated history is not a conflict request.

Board Agent records an attempt locally, creates an actual bot-authored versioned
`requested` comment, moves the card to `Ready` while closed, reopens the Issue,
and confirms open Ready before marking the same comment `queued`. The Issue
body is not changed. The marker is `consumed` before launch; the existing
`max_workers` scheduler admits one repair run in the original task worktree,
not a new role or queue. Actual author and exact marker data are read back;
ordinary/fake comments cannot authorize repair. Failed or ambiguous writes stop
until their exact results can be confirmed, rather than being blindly repeated.
Fresh human lane/claim checks apply through settlement, not only at selection.

The builder retains original work and requirements, merges the specified base
commit into the task, resolves both sides without blanket ours/theirs, and runs
existing relevant integration tests on the final committed result. It commits
and pushes only the task branch normally: no force-push, main mutation or
self-close. The host verifies original-task/base ancestry, no unfinished merge,
a clean worktree, exact local/remote result SHA and actual persisted passing test
execution. Missing, failed, truncated or ambiguous evidence is failure, even
with a reported success. Only the same durable run may resume a dirty partial
repair; a new launch must pass the original-SHA/clean admission checks.

Success returns to `Review`; `review.enabled` stays authoritative and unchanged.
Review/humans assess whether the tests and resolution cover both branches'
requirements. Humans must validate the repair, reach `Done`, and **close the
Issue again**. Builder/evidence failure or repair Review findings go to
`Needs Human` when settlement is authorized, never automatically back to Ready.
Consumed requests stay retained, not automatically reused; deliberate maintainer
reopen/Ready after consumption takes the ordinary retry path.

Ordinary Review is not proof that the latest main/base was integrated and passed
integration tests. The repair gate concerns its specified base and tested result,
not every future base advance. Normal finalization has no blanket integration
test gate and still requires human approval of the current task commits.

## Cleanup receipts and retained backups

A late destructive receipt in `.pi/board-agent/cleanup/` is written only after
remote base integration is confirmed and destructive preconditions are ready;
it is **not an early merge intent**. Its strict versioned data binds ticket,
branches, task/result SHAs, exact record, managed paths/Git ownership, directory
identities and relative entries (type, size, content hash or symlink target),
including ignored files. Symlink targets are recorded, not traversed or deleted.

Registered ticket worktrees use normal `git worktree remove`. After registration
is gone, only matching receipted leftovers are removed item-by-item, rechecked
before deletion. Missing entries may already have been removed; additions,
changed contents/link targets, replacements, locks, foreign/nested Git identities,
special files or corrupt evidence block and preserve remaining work. There is
no force-remove, prune, unlock or recursive-delete fallback for ticket cleanup.
Remote integration is rechecked; only after all managed directories and related
Git cleanup succeed is the local ref deleted, then the record, then the receipt.
A remaining receipt retries even if the ref/record is gone. No success is reported
while the managed directory remains.

Proven legacy residuals require a full content/layout backup plus original record
in `.pi/board-agent/cleanup-backups/`, with verified source/copy equality and
unchanged source before receipt publication/cleanup. Retries reverify the backup;
failed backups also remain. This is not a promise to copy external link targets,
ACLs or other unspecified filesystem metadata. Backups do not authorize guessing
at ownership or integration; unknown/unrecorded directories remain blocked.

## Legacy finalization and conflict recovery

Older valid v3 records may contain `finalization`; ordinary updates still cannot
remove or replace pending intent. There is no new manual recovery command and
no supported “delete the member and retry” shortcut. With owners stopped, back
up records, receipts, ledgers, worktrees, refs and external workflow journals
before investigating:

- **Present `resultSha`, confirmed on fresh remote base:** after validating the
  recorded tree/parents and original record/path/task, recovery is cleanup-only,
  with the verified legacy backup and late receipt. No repair builder or new
  integration is triggered, even if the base later changed.
- **Missing `resultSha`, verified conflict:** absence alone is not enough. The
  old persistence order saved the initial intent before merge-tree, then saved
  `resultSha` **before any push**. Only that narrow proof, with matching original
  task/local/remote SHA, review SHA when present, clean owned worktree, valid old
  base still in current base history and fresh identity/claim/revision checks,
  permits automatic recovery. Exact original record bytes are durably archived
  and verified in `.pi/board-agent/repair-intent-backups/` before a dedicated,
  checked atomic intent clear and new repair request. Archive/source mutation
  or failed Git checks block the clear; the general update guard is not relaxed.
- **Present but unconfirmed/unknown result, rewritten base history, unknown old
  base, task/review/identity drift or any other uncertainty:** block and preserve
  everything. A result absent from today's remote may have been pushed and later
  rewritten away; that is never proof of never-pushed.
- **Old integrated residual without a receipt/result journal:** only existing
  ancestry or squash-tree equality plus original record/path/task and surviving
  tracked-file identity proof can authorize backup/cleanup. Unknown directories,
  altered residuals or ambiguous integration remain untouched. Missing metadata
  is not authority to recreate or discard work.

## Historical reports

The repository-only `architecture-flow-audit.md`, `overengineering-audit.md`
and `review-builder-concurrency-analysis.md` retain their original source
baselines and findings for traceability. They are not current run instructions
or proof of present performance; use this runbook and
[architecture](architecture.md) for current behavior.

## Clean-clone smoke test

After the release commit is pushed:

```bash
tmp=$(mktemp -d)
git clone https://github.com/Hikoia/pi-board-agent.git "$tmp/pi-board-agent"
git -C "$tmp/pi-board-agent" checkout "$RELEASE_SHA"
cd "$tmp/pi-board-agent"
npm ci
npm run check
npm pack --dry-run
export PI_CODING_AGENT_DIR="$tmp/pi-agent" # isolate settings and package clones
pi install "git:github.com/Hikoia/pi-board-agent@$RELEASE_SHA"
```

Start the smoke Pi session with that same environment, run `/board-agent init`
in a disposable repository, and confirm the generated file equals the packaged
template. `/board-agent lint` should reject the template's unset
`project.number`; configure a disposable Project only for deliberate live
validation. Do not use production settings, credentials, or Projects.
