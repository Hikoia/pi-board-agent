# Architecture

`pi-board-agent` is a foreground Pi extension with a durable, per-Issue
execution model. The GitHub Project is the scheduler UI; local atomic records
and pi-dynamic-workflows journals are the recovery source of truth.

## Module map

```text
src/index.ts                 commands, lifecycle, revision/state gates
├── config.ts                strict 0.2.0 schema and origin identity
├── owner-lock.ts            one local owner via atomic file creation
├── unsupported-state.ts     read-only legacy/v1/v2 detector
└── loop.ts                  fair selection and bounded admissions
    ├── ticket-executor.ts   claim, launch, reconcile, finalize
    │   ├── ticket-worktree.ts  schema-v3 record + exact-SHA Git/cleanup operations
    │   │   └── cleanup-snapshot.ts  non-following receipts/backup/removal checks
    │   ├── conflict-recovery.ts  actual-author handoff + local repair ledger
    │   ├── repair.ts           repair args + persisted test-execution evidence
    │   └── WorkflowManager     durable one-agent builder journal
    ├── refine.ts            Story/Task design and Story creation journal
    ├── review.ts            detached fresh-SHA review worktree
    ├── watchdog.ts          CI monitoring and trusted mention replies
    └── plan.ts              read-only board summaries

process-runner.ts            shared non-interactive, deadline-bound Git/gh calls
```

`dispatch.ts` only validates persisted builder results. `plan.ts` never creates
branches or pull requests.

## Identity boundary

A mutable candidate must satisfy all of these conditions:

1. Project content `__typename` is `Issue`.
2. Its repository owner/name equals the repository parsed from `origin`.
3. Its configured `Type` is exactly `Story` or `Task` for the selected lane.
4. Lane-specific status, open/closed state, Plan, and claim conditions match.

The Project owner is independent: Project GraphQL operations use
`project.owner`; Issue operations use the origin repository. Pull requests,
drafts, cross-repository Issues, and untyped items remain visible for summary
purposes but cannot enter a mutation lane.

Every claim is followed by a complete fresh Project-item read. Task design and
review perform another read after their agent finishes and before any write.
A failed/missing fresh read cannot be replaced by a tick snapshot to authorize
mutation. Missing cards follow orphan recovery; unreadable evidence stays
unsettled. `gh.release()` propagates failures: terminal comment/status writes
may already have succeeded, but the execution association is cleared only after
release succeeds. Retry settles the existing lineage rather than rebuilding.
Closed Issues never enter builder/design/review admission, regardless of the
deprecated boolean `safety.skip_closed_issues`. `loadConfig(cwd, warn?)` warns
per explicit source file (global then project, even when shadowed); defaults do
not warn. `index.ts` forwards warnings to Pi notifications at every config-load
entry point. Boolean shape validation and unknown-key rejection are unchanged.

## Project preflight

Startup (explicit, automatic, recovery), lint and cached-loop promotion validate
current config plus metadata for enabled lanes before admission. Status and Type
must be single-select; Plan must be text or single-select. Task is always needed;
Story and Needs Design are needed when refinement is enabled. Backlog is not an
automatic lane requirement. An unrefined/partial Story checks its own select Plan
option before claim/model/publication, and creation rechecks independently.
Plan text uses `setTextField`; select Plan resolves the existing option ID with
`setSingleSelect`. Plan/Type are verified before child Ready publication.

Preflight is read-only: no automatic schema mutation. A missing option blocks
that Story without consuming another healthy Story's turn. Running loops keep
their config/metadata snapshot; after manual edits, stop successfully, lint,
then run a new loop. Successful cached recovery promotion validates current metadata but does
not refresh its stored snapshot. Package changes additionally require Pi restart.

## Durable ticket record

Each ticket has one atomically replaced JSON file at
`.pi/board-agent/ticket-worktrees/<safe-item-id>.json`:

```ts
interface TicketExecutionRecord {
  schemaVersion: 3;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  plan: string;
  taskBranch: string; // task/issue-<issueNumber>
  baseBranch: string;
  path: string;
  createdAt: number;
  launchingAt?: number;
  activeRunId?: string;
  activeRunStartedAt?: number;
  lastRunId?: string;
  reviewedTaskSha?: string;
  finalization?: {
    targetBranch: string;
    baseSha: string;
    taskSha: string;
    resultSha?: string;
  };
}
```

Only schema v3 is accepted. Legacy inflight files, malformed files, and v1/v2
records are reported read-only by startup, `lint`, and `run`; 0.2.0 never moves,
archives, upgrades, or deletes them.

WorkflowManager stores each run outside the repository in Pi's workflow
storage. One manager with one agent owns each persistent ticket worktree.

## Tick order

```text
reject unsupported state read-only
  → list/hydrate all Project items
  → reconcile persisted ticket runs and launch windows
  → finalize eligible closed Done Tasks (also in recovery-only mode)
  → check pinned revision, admissions, and main-checkout cleanliness
  → reserve one slot if primary foreground work is pending and capacity exists
  → pre-fill remaining capacity with Ready Task builders
  → at most one primary model: Needs Design Task → Story refine → Review
  → recount occupied builder slots and back-fill Ready Tasks
  → await serialized watchdog maintenance; models use only spare capacity
```

Waiting Stories are skipped rather than returned from the whole lane. Candidate
order rotates by tick, so one persistent blocker cannot starve siblings. The
same principle applies to Needs Design Tasks.

`max_workers` is the total model budget: builders plus **one** transient
foreground invocation shared by Task design, Story refine, review and watchdog.
`activeCount()` is conservative occupied capacity, not a count of only running
models: launch windows, pending/paused runs and missing/unreadable associated
runs count too. Automatic resume cannot appear as uncounted capacity while a
foreground await is in progress. Settled terminal associations can remain visible
without consuming a running slot.

Task/Story waiting and non-model actions do not consume the primary model turn;
one lane may publish a gate or reconcile children and still fall through to a
lower-priority model. Candidates rotate within design/Story lanes. Ready launch
attempts are not retried twice in the same tick. A stale or unclaimed foreground
candidate returns its reservation to builder back-fill. Builders stay managed in
the background; there is no detached foreground promise, second scheduler or
queue. Watchdog can make serial model calls at the tail, each rechecked against
capacity; it never reserves ahead of builders or exceeds the shared ceiling.

Capacity/revision/stop checks run at invocation, including after asynchronous
builder preparation/context and inside each watchdog model admission. Fresh
card/claim/record checks still gate write-back. Widget/runtime snapshots are
non-authoritative observations: notifications consume the executor observation,
not new stores/Git scans. Root/store reuse lasts only with the retained loop
owner; unsupported-state, ownership and revision gates remain live.

## Builder launch and recovery

1. Validate an open Ready Task Issue from the origin repository.
2. Add the bot assignee.
3. Re-read and require sole claim, unchanged Plan/identity/status.
4. Create a new persistent worktree from fresh `origin/<base>` on
   `task/issue-<number>`, or resume its registered same-branch worktree without
   resetting partial work to a newer base.
5. Refuse pending finalization/cleanup; require any repair to bind its unique
   queued request. Atomically record `launchingAt` and clear a prior reviewed
   SHA only for a new builder attempt.
6. Move the card to `In Progress`.
7. Start WorkflowManager; it persists the run before starting the agent.
8. Atomically associate `activeRunId`.

A crash between steps 7 and 8 is recovered by matching the persisted
`itemId`, `issueNumber`, and `taskKey`. Ambiguous or unprovable state goes to
`Needs Human`. Run-lineage comment markers make terminal GitHub writes
idempotent. The active association is cleared only after the terminal comment,
status, and assignee operations succeed.

The production factory renders a new builder's context using `record.path`
after worktree preparation, not `generateContext` in the host checkout. The
optional digest is returned in memory and respects exclusions/size limits; it
is navigation, while worktree code is authoritative. It creates no dirty cache
files in the ticket worktree. A resumed durable run keeps its persisted script
and context; the host context command/design/watchdog cache is unchanged.
[`workflow-prompt.ts`](../src/workflow-prompt.ts) supplies the self-contained
production mission; the [skill](../skills/board-agent/SKILL.md) is the reusable
procedure. The packaged [agent path](../agents/board-agent-builder.md) is a
non-production compatibility pointer, not another rule body or permission policy.

Paused managed runs resume when record, args, path, branch, and card identity
match. Usage-limit pauses remain under the scheduler. Dirty partial work may be
continued only by the same structurally owned ticket; dirty completed work,
wrong branches, missing runs, malformed results, and identity drift fail
closed.

## Automatic conflict repair

Only the positively verified `MergeConflictError` path can originate a handoff:
merge-tree exit 1 with a real tree object and conflict diagnostic, not a fetch,
permission, timeout, malformed-output or unrelated-history failure. A conflict
creates no integration commit, base push or cleanup. Production uses an
author-aware board adapter; an adapter without that capability only reports the
conflict, with no live API fallback.

`ConflictRecovery` requires the matching idle original v3 record, Plan, clean
original task worktree and exact local/remote task SHA. Before writes it freshly
rechecks ticket/body/title identity, configured branches, base/task SHAs, sole
ownership, absence of another builder or cleanup receipt, revision and stop
admission. Final synchronous ownership/SHA checks follow awaited validation.
A later human lane, identity or claim change stops unsafe handoff/settlement;
an observed contrary state invalidates an unfinished handoff even if moved back.
These are fresh observable checks, not an atomic cross-resource GitHub lock.

A key derived from item/base/task SHAs binds a strict v1 local ledger at
`.pi/board-agent/repair/conflict-<hash>.json` and one versioned Issue comment.
The host verifies its **actual author** is the bot and reads back exact canonical
data, identity and version; a response ID, claimed author text, ordinary/fake
comment, duplicate marker or missing ledger is not authorization. The Issue body
is never rewritten. Comment phases are `requested` → `queued` → `consumed`:

1. Persist attempted-create evidence, create/confirm `requested`.
2. Persist the Ready attempt, move to Ready, confirm **closed Ready**.
3. Persist the reopen attempt, reopen, confirm **open Ready**.
4. Edit/confirm the same marker as `queued`.
5. The existing Ready/max_workers scheduler obtains the repair input, consumes
   and confirms the marker before launch, and binds one unique durable run.

Failed/ambiguous writes stop until reads confirm the exact intended result; the
host does not blindly replay them, even after a crash between attempt persistence
and the API call. Closed Ready or not-yet-queued open Ready never falls through
to ordinary builder admission. Repair terminal notices also retain attempt and
actual-author evidence; settlement status/release retries require fresh authority.
Consumed request/run bindings remain retained and cannot automatically relaunch
on another Done closure. An explicit maintainer reopen/Ready retry after
consumption uses the ordinary builder flow, not replay of that repair request.

Repair is optional `{ requestKey, baseSha, taskSha }` input persisted in existing
`run.args`, not new v3 fields, a new builder role or another scheduler. The
existing builder keeps original work/requirements, merges the specified base
commit into the original task branch, resolves both sides, commits normally and
runs existing relevant integration tests on that final committed result before
a normal task push. No blanket ours/theirs, force-push, main mutation or self-close
is permitted. The original-SHA/clean check gates first launch; the same persisted
run/script/args may resume advanced HEAD or a dirty interrupted merge. Restarts
reuse its exact run binding. Capacity observations cannot authorize cold repair
resume. Every repair resume from the existing usage-limit scheduler rechecks fresh
authority and revision after cooperative drain, with a final local/stop veto;
already-armed timers cannot bypass it. Denied/unknown authorization retains the
paused run and occupied slot, so confirmed recovery resumes that same run.

Before repair success enters Review, the host verifies both original task and
specified base ancestry, no unmerged index/unfinished merge, a clean owned
worktree, and freshly fetched remote task equal to the local result. It checks
real persisted bash tool call/result evidence at that exact committed SHA,
including clean HEAD/status checks around test execution. Missing, failed,
truncated or ambiguous telemetry fails closed, even with a success assertion.
There is no host test-command discovery/execution or semantic proof of test
adequacy; existing Review/humans assess test relevance and both branches'
requirements. Failure goes to Needs Human when fresh authority still permits
settlement, otherwise evidence stays blocked without overwriting human state.
Success goes to Review; `review.enabled` remains authoritative and unchanged.
Humans must validate the repaired result, reach Done, and **close the Issue again**.
Repair Review findings go to Needs Human, not an automatic Ready retry. A retained
consumed run binding identifies repair even when its run file, exact repair args
or test evidence is unavailable: this blocks ordinary Review/Ready and goes to
Needs Human only with fresh authority. A later explicit maintainer retry has a
new run ID and retains ordinary builder/Review behavior.

## Review and human approval

Review is opt-in (`review.enabled: false` by default). Without it, humans
validate the retained worktree, move the Task to `Done`, and close the Issue.
Closing a Done Issue approves the current local task branch, including unpushed
commits. Finalization does not require a persisted review SHA or Plan.

When enabled, a Review Task is claimed and re-read. `review.ts` then:

1. snapshots branch, HEAD, and status of the main checkout;
2. fetches `origin/<base>` and `origin/<task>` with a fixed deadline;
3. creates a detached worktree under `.pi/worktrees/review-*` at the fresh
   `origin/<task>` SHA;
4. verifies detached HEAD and a clean review worktree;
5. runs the reviewer there without nested workflow isolation;
6. force-removes/prunes the review worktree; and
7. verifies the main checkout snapshot is unchanged.

A fetch, setup, agent, cleanup, or checkout-integrity failure leaves the card in
`Review`. After a PASS, the loop re-reads the card again, atomically persists
the returned `reviewedTaskSha`, and only then moves the card to `Done`.

The Issue remains open and the persistent task worktree remains available for
human validation. Closing a Done Issue is the approval signal; no claim or new
worktree is created during ordinary finalization. Ordinary Review is not proof
that the latest main/base has been integrated and passed integration tests.
Repair evidence covers its specified base and result, not later base advances;
normal merges have no blanket integration test gate.

## Local-branch finalization

Before per-card finalization, the loop queries local task refs once per tick
with closed-Done target Task candidates. Exact full local branch names are a
**negative-only filter**: absence defers a candidate only if no cleanup receipt
remains; presence never approves integration. A newly created branch can wait
until the next tick; a vanished branch or changed approval is caught by fresh
checks. A failed refs query warns/blocks this lane, not an empty-success result.
Unsettled records and repair handoffs reconcile independently without a branch;
no general persistent completed-ticket table is added.

For a fresh, closed Done Task in the origin repository:

1. A pending cleanup receipt takes precedence: reconfirm its result on remote
   base and perform only checked cleanup. Otherwise derive `task/issue-<number>`
   using the configured prefix. An absent local branch means no finalizer work:
   no remote lookup or leftover-file deletion; Git errors are not absence.
2. Refuse active builders and unsafe registered task worktrees. Ordinary
   integration needs no Plan, review marker, checked-out/pushed branch or record;
   any managed directory being removed does require matching recorded ownership.
3. Fetch `origin/<base>` and use native `git merge-tree` / `git commit-tree`
   to merge or squash the local tip, leaving the main checkout untouched.
   A verified conflict can enter the separately guarded repair handoff above.
4. Push normally and fetch again to verify remote integration. Only once
   destructive preconditions are ready, publish a late cleanup receipt.
5. Delete only an integrated remote task ref with an exact deletion lease, then
   remove managed directories and related Git metadata under receipt checks.
   Reconfirm remote base integration and remote-task absence; delete the local
   ref with its expected SHA, then the exact record, then the receipt last.

A receipt survives failures, including after local-ref/record deletion, and
bypasses the no-ref filter on retry. Without one, existing merge ancestry or
unchanged squash result tree can prove prior integration; uncertainty preserves
work rather than forcing cleanup. `Plan` and `reviewedTaskSha` remain build/review
metadata, not ordinary completion gates. Story completion still checks its
children are closed Done with no local task branch; it is not a cleanup-receipt
or integration-test audit.

### Late destructive cleanup receipts

Strict v1 receipts in `.pi/board-agent/cleanup/<safe-item-id>.json` are separate
from unchanged v3 records, **not an early merge intent**. They bind ticket,
branches, original task/result SHAs, exact record bytes/hash, managed path and
Git common-directory identities, directory ancestors and relative entry
snapshots. Asynchronous non-following traversal includes ignored files and
empty directories; entries record type, identity, size/content hash or symlink
target and creation kind. Link targets are not traversed, copied or deleted.
Atomic create-only publication refuses overwriting an existing receipt.

Registered ticket worktrees use normal `git worktree remove`, never a force
fallback. Once registration is gone, only exact receipted leftovers are removed
with checked individual unlink/rmdir operations and rechecks before deletion.
Missing entries may already be removed; additions, changed files/link targets,
identical-content replacements, root/ancestor links, special files, nested or
foreign Git ownership, locks and corrupt evidence block. No recursive deletion,
prune or unlock is used for ticket cleanup; finalization fetch disables implicit
auto-maintenance pruning. No cleanup success is returned while managed
directories remain. Portable checks are not atomic against a hostile path swap
at the exact filesystem syscall boundary.

Legacy integrated residuals additionally need a complete content/layout backup
and original record in `.pi/board-agent/cleanup-backups/`. Source/copy equality
and unchanged source are verified before receipt/cleanup, including non-following
link reproduction; retries reverify backups. Unknown/unrecorded directories,
lost tracked-file identity, altered tracked bytes, backup failure or uncertain
ownership/integration block. These backups cover specified bytes/layout, not
external link contents or all filesystem metadata such as ACLs.

### Legacy finalization classification

A valid old v3 `finalization` with a present `resultSha` currently confirmed on
remote base is **cleanup-only** after matching record/path/task and recorded
parents/tree proof. It uses the verified backup and receipt, not a new merge
against later conflicting base edits or a repair builder.

For conflict recovery with **missing `resultSha`**, only the narrow old persistence
order is proof: initial intent preceded merge-tree, but result SHA was persisted
**before any push**. Matching original local/remote task SHA, reviewed SHA when
present, clean owned worktree, verified Git operations, old base still in current
base history and fresh card/claim/revision checks are required. Exact original
bytes are durably archived and verified in `.pi/board-agent/repair-intent-backups/`
before a dedicated checked atomic intent clear and new repair request. Ordinary
`update()` still forbids removing/replacing pending intent; archive/source changes
block clearing. No-result/no-journal integrated residuals may use the existing
ancestry/squash-tree proof only with the same strict ownership/backup checks.

A present result absent from today's remote is **not proof of never-pushed**:
unknown/unconfirmed results, rewritten base history, unknown old bases,
task/review/identity mismatch or other ambiguity block and preserve evidence.
There is no manual recovery command. Backups, intent archives and consumed repair
ledgers are not automatically garbage-collected. Do not blindly downgrade while
a cleanup receipt or repair is pending; older readers may ignore it and replay
work. Preserve stopped backups including external workflow journals and require
compatibility with current remote/Git state before any reader change.

### Blocking notification deduplication

The loop keeps only the last blocking fingerprint per ticket in a private
loop-lifetime Map: category, relevant known base/task SHAs and root reason.
Reconcile, closed-Done and Ready handoff results combine into one per-ticket
warning. Identical blockers warn once; checks and safe retries still run every
tick. Changed/returning reasons or SHAs, recovery, different tickets and restart
can warn again; successful finalization/handoff/launch clears blockers and
irrelevant entries are pruned. This is notification-only, with no persistent
notification state, timer or replay authority for failed/ambiguous writes.

## Story exactly-once state machine

`.pi/board-agent/refine-state.json` normally uses atomic replacement. Before the
first child mutation it stores the complete refinement output and a creation
plan for every child: index, digest, deterministic marker, title, body, task key.

Each Ready Task must be independently implementable **and verifiable from the
current base**. The prompt asks for tightly coupled work plus its verification
in one Task; real dependencies belong in manually held Backlog until integrated.
Ordering tasks or reducing worker count does not make a prerequisite available.
`refine.max_tasks` reaches the prompt, schema and host parser/intent validator.
Malformed/over-limit output is rejected before intents or child mutation: no
slice, no automatic repair/re-prompt pass (`maxSchemaRetries: 0` for refinement).
Normal later polling of an unjournaled Ready Story is unchanged. Questions can
carry tentative/empty tasks but produce zero publication intents until resolved.
Count/digest validation does not prove semantic independence or completeness.

Refine/design roles use a private registry, immune to local/user Markdown
shadowing, **and SDK `session.tools: ["structured_output"]`**. That is the actual
allowlist: coding and shared-store tools are absent, schema output remains.
Installed workflow 3.10.0's empty named `tools: []` alone does not enforce this;
inline DSL `toolNames` is not a permission boundary. This guarantee concerns
refine/design, not every Board Agent model.

On every attempt, `refine.ts` reconciles in this order:

1. paginate all current sub-Issues and match the marker;
2. create the child only when no target-repository match exists;
3. paginate Project contents and find/add the Issue;
4. re-read the Project item;
5. reconcile exact Plan and `Task`, freshly verify both, then publish `Ready`,
   persisting after each step.

Attempt markers are persisted before non-idempotent create/add/comment calls.
Visible remote results can be adopted after an ambiguous failure; an attempted
operation whose result cannot be confirmed is never blindly repeated. Multiple
matching markers fail closed. Partial failure keeps the journal, posts
a marker-deduplicated blocker, and moves the Story to `Needs Human`. Returning it
to `Ready` resumes creation without rerunning refinement.

Needs Design comment cursors bootstrap without replay and advance only after
trusted input is handled successfully. A waiting Story does not block another
Story or Task in the same tick.

### Legacy truncated evidence

A recognizable historical shortened intent prefix (including zero intents) is
readable as evidence but cannot publish or complete its Story, even if already
marked refined. Strict identity/shape/digest/progress checks still apply; arbitrary
malformation is not treated as this recoverable prefix case. The affected Story
is warned/skipped before claim/model/write; existing children are not reset.

When such evidence exists, `refine-state.json` stays **byte-for-byte at its
original path**, including whitespace/line endings. Healthy Story updates go to
`refine-state-unblocked.json`, atomically, in the **same journal format**. Reads
combine the original with those updates; unchanged original entries are not
migrated. The companion cannot mask a truncated entry; missing original,
malformed companion or symlinked paths fail closed. No-op saves preserve bytes.

There is no automatic consolidation, repair or migration. Back up both files
with worktrees/refs and workflow journals; older readers ignore the companion,
so downgrading can lose durable progress or replay ambiguous operations. Follow
[manual Story recovery](runbook.md#truncated-story-journal-recovery).

## Process and lifecycle boundaries

All runtime Git and `gh` calls use `process-runner.ts`: shell-free command argv,
credential prompts disabled, fixed deadlines, and independent supervisors.
POSIX process groups and Windows Job Objects terminate ordinary descendants,
including inherited pipes; deliberate POSIX `setsid()` escape or host SIGKILL
is outside this containment guarantee. Windows requires PowerShell
FullLanguage with `Add-Type`/PInvoke available. Runtime network Git and package
HEAD/status revision checks use the asynchronous runner, with dependent writes
still awaited in order. Local synchronous root/clean/context probes remain;
async keeps the event loop available during those subprocess waits, not Git
faster. UI snapshots do not authorize work or replace live admission checks.
Telegram composes caller cancellation with its mandatory 15-second deadline.

`owner.lock` records pid, hostname, bot identity, and a random token. A live
same-host owner and every different-host owner fail closed; only a provably dead
same-host lock can be reclaimed. A separate `owner.lock.reclaim` serializes
stale takeovers; an interrupted takeover fails closed until manually resolved.

`BoardLoop.stop()` publishes a shared completion promise before aborting the
loop-owned foreground model signal, stops new scheduling and waits for tick and
heartbeat cleanup. It then pauses/drains managers and their leases before owner
release. The entry point retains the loop/store until cleanup succeeds and only
then reports stopped. Concurrent stop/stop/session-shutdown calls join that
barrier; failed drains retain managers and ownership for a later stop retry.
Startup continuations cannot acquire ownership after a stop-generation change.
A tick failure still drains and can be reported as a warning after successful
cleanup; it is not itself an incomplete drain.

Cancellation targets model invocations, not destructive Git finalization.
Already-started Git keeps its bounded runner/verification/cleanup sequence;
stopping waits rather than unlocking underneath it. Cancelled model output is
not written back. Revision mismatch latches recovery-only: it permits settlement
but never new admissions merely because a later observation looks healthy.

Watchdog ticks are awaited and coalesced across instances. Admission is
rechecked before agents and mutations, including the host-controlled CI push.
CI fixes use detached `.pi/worktrees/watchdog-<pr>-*` worktrees and a normal
exact-commit push; failures retain the worktree and block a replacement fix
until a human resolves it. Mention replies use a private named registry with
`tools: []`; unlike refine/design, that wrapper has no SDK `structured_output`-only
allowlist. An empty definition is not proof of an effective no-tools surface in
workflow 3.10.0. Mentions remain opt-in and restricted to trusted maintainers.

The repository's audit documents record historical baselines, not current
implementation requirements. Their source notes/findings are preserved; this
document and the runbook describe current behavior.
