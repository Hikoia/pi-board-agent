# Architecture

Board Agent is a foreground Pi extension. GitHub Project Status is the scheduler
UI; one atomic per-ticket store and existing WorkflowManager journals carry
recovery evidence. There is no second executor, queue, retry engine or persistent
state machine for the simplified workflow.

## Module map

```text
src/index.ts                 commands, startup/lint coherence, owner lifecycle
├── runtime.ts               immutable installation identity and runtime heartbeat
├── config.ts                strict config, narrow compatibility, origin identity
├── owner-lock.ts            exclusive local owner and token-safe release
├── unsupported-state.ts     safe paths and read-only unsupported-state inventory
└── loop.ts                  reconcile, closed-Done, bounded build/review admission
    ├── ticket-executor.ts   claim, launch, durable-run resume/settlement, finalize
    │   ├── ticket-worktree.ts  v4 atomic records and native Git integration/cleanup
    │   ├── legacy-adapter.ts   stopped-owner v3/receipt/ledger conversion
    │   │   └── cleanup-snapshot.ts  read-only legacy evidence/remnant checks
    │   └── WorkflowManager     existing journals, leases and provider backoff
    ├── dispatch.ts          outcomes, trusted decisions, resumable settlement I/O
    ├── review.ts            independent pinned-SHA detached review
    ├── workflow-prompt.ts   original-worktree builder mission
    └── plan.ts              optional read-only grouping summaries

process-runner.ts            deadline-bound, non-interactive Git/gh subprocesses
notify.ts                   configured notifications
```

Story/refine, Task-design, PR-watchdog and Project-schema-creation execution
paths are retired. Old state is not a request to restart those roles.

## Identity and configuration

Mutable cards must be GitHub **Issues**, have Type `Task`, and belong to the
repository parsed from configured `origin`. `project.owner` controls Project
access separately. PRs, drafts, cross-repository Issues, Stories and untyped
cards remain display data only. Task matching is case-insensitive; it is not
substring matching.

Status and Type must be single-select. Required options are the configured
Ready, In Progress, Review, Done, Needs Human and Task. Backlog is manual. Plan
is optional read-only grouping; its presence, field type or value is not an
admission prerequisite. An optional Plan change still participates in freshness
checks. Metadata validation never creates or edits fields/options.

Config is validated at startup/run/promotion and lint. Supported retired keys
are type/shape-checked before warning and normalization; unrelated unknown keys
still fail. Old refine/watchdog switches/models are ignored, review is always
on, and old `squash` input maps to `merge` for new work. The old Needs Design
lane name remains only migration provenance. Config files and Project schema
are not rewritten. A running loop retains its config/metadata snapshot: a
changed snapshot prevents promotion at preflight. Stop successfully, lint and
start a new loop to apply changes.

## Startup-only package coherence

Module load captures and freezes the package root, loaded SHA/dirty state and
effective package setting. Startup and explicit run/promotion/lint compare that
identity with the full-SHA pin and installed checkout. Project package overrides,
malformed/ambiguous settings, wrong checkout root, dirty-at-load state and changed
HEAD fail closed. Settings and the process mismatch latch are read after awaited
startup Git observation. A detected mismatch is latched for the Pi process;
restoring files does not make hot replacement safe.

`LoopDeps` contains no revision callback. Ticks, ordinary actual-start checks,
widget notifications, status and heartbeat writes do **not** inspect package
HEAD/status or reread package settings. They consume the last startup/lint
observation. `runtime.json` keeps its existing schema; `diskRevision` and `dirty`
are last-check provenance, while `heartbeatAt` is current liveness. The explicit
fleet verifier separately checks installed files/settings for deployment.

Package upgrades require a successful stop/drain for every owner sharing the
installation, backup, immutable install and **Pi process restart**, not `/reload`.
Startup mismatch can start recovery-only when ticket evidence exists, including
idle Done records. It prevents new builder/reviewer admissions, not settlement,
resume of already-owned runs or approved closed-Done integration/cleanup.

## Ticket state and legacy conversion

Each ticket uses `.pi/board-agent/ticket-worktrees/<safe-item-id>.json`:

```ts
interface TicketExecutionRecord {
  schemaVersion: 4;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  plan?: string;
  taskBranch: string;
  baseBranch: string;
  path: string;
  createdAt: number;
  launchingAt?: number;
  activeRunId?: string;
  activeRunStartedAt?: number;
  lastRunId?: string;
  reviewedTaskSha?: string;
  retry?: { stage: "build" | "review" | "integrate" | "cleanup"; reason: string };
  integration?: { baseSha: string; taskSha: string; resultSha: string };
}
```

`retry.reason` also carries identity-bound unfinished comment/status/reopen/
release settlement. `integration.resultSha` is prepared before push; its
presence is not success. General updates cannot discard pending integration.
The legacy `finalization` member is conversion input, not a new execution path.

Under the exclusive stopped-upgrade owner, `LegacyTicketAdapter` inventories
legacy tickets and isolates failures. Supported v3 records get a create-only
`<record>.json.v3.bak` of **exact original bytes**, verified/durable before atomic
v4 publication. Published v4 is not replayed from backup. Malformed/v1/v2 evidence
is retained, never guessed or deleted; lint reports unsupported paths read-only.
Unsafe state directories block traversal. Healthy tickets may continue while
unhealthy legacy tickets remain blocked.

- Active/paused runs keep the same run ID, script, args and worktree. Launch
  windows bind only a unique matching persisted run; ambiguity retains evidence
  and capacity, never starts a replacement builder.
- Old repair bindings resume their actual run. Proven not-launched queued work
  becomes an ordinary build retry with original requirements/diagnostics; no new
  requested/queued/consumed protocol or test-history telemetry is emitted.
- Recorded old merge/squash results and receipts become integration/cleanup
  evidence. A freshly confirmed result is cleanup-only, including old squash;
  no new squash commit is created. Present but unconfirmed results are retained.
- Pre-result legacy intent requires the old persistence-order and identity proof
  before conversion/clear. Absence alone is not proof that nothing was pushed.
- Receipts can recover half-finished cleanup without a local ref/record. Completed
  read-only receipts do not resurrect a fully cleaned closed-Done ticket.
- Old ledgers, receipts and backups remain read-only, without automatic GC.
  Snapshot checks are confined to legacy evidence conversion/residual cleanup;
  new integrations take no content snapshots or backups.
- Retired Story/watchdog files remain untouched; already-created Tasks continue.
  Existing Needs Human is retained; old Task Needs Design maps to Needs Human
  preserving its body/question/comments. A reply alone never resumes it.

## Scheduling and actual invocation

```text
safe state paths → fresh board read
  → reconcile owned runs / pending settlement
  → closed-Done integration or cleanup
  → new-admission flag / owner / stop / clean-host check
  → reserve one available review slot
  → pre-fill remaining slots with Ready Task builders
  → at most one foreground AI review
  → recount and back-fill Ready builders
```

`max_workers` covers builders plus the single transient foreground reviewer.
Launching, running, pending, paused, missing/unreadable and unsettled terminal
associations occupy slots until settlement/drain proves release. Recovery can
resume excess previously owned runs within their retained slots; new admissions
wait for capacity. Display observations are never capacity or mutation authority.
Per-ticket handled/attempted sets prevent retrying one ticket twice in a tick.

The live owner record/token and stop signal authorize continuing work. New
admission additionally uses the loop's synchronous admission flag. Builder
preparation/context and review fetch/worktree setup are awaited; fresh complete
card reads then revalidate identity, requirements, lane and sole bot claim.
Synchronous final admission/stop and exact execution-record checks remain after
those awaits, immediately before invocation. Removing package polling does not
turn an old card or UI observation into authority.

Reconcile gets recovery authority, not the new-admission flag; a later launch
cannot replace that authority for already-owned runs. UsageLimitScheduler keeps
its existing backoff/timers. Actual resume revalidates after cooperative drain
and has a synchronous final veto, preserving the original run on denial.

## Build, review and failure settlement

A new builder claims an open Ready Task, refetches it, and creates or reuses its
one managed worktree on `task/issue-<number>` (configured prefix). Existing partial
diffs and interrupted `MERGE_HEAD` are retained. It persists `launchingAt` and
known-unstarted settlement before changing Status, then starts WorkflowManager
and records the durable run ID. A persisted matching run closes the crash window
between manager start and ticket binding. Missing/ambiguous journals are
uncertainty, not permission to rebuild or clear the slot.

New missions use the digest rendered from the prepared ticket worktree, configured
models/timeouts/context and trusted maintainer decisions. Resumes keep their
persisted script. The [builder skill](../skills/board-agent/SKILL.md) supplies the
procedure; the packaged agent pointer is not a second permission policy.

Builder outcomes are `success`, `failure`, `needs_decision`; review verdicts are
`pass`, `fail`, `needs_decision`. Only a complete genuine missing decision goes
to Needs Human. Tool errors, timeout, failed tests, missing evidence, malformed
or incomplete decision output and exhausted retries are technical failures.
There is no host classification model.

- Builder technical failure or actionable review code findings → Ready/build.
- Review execution failure → Ready/review at the original successful build SHA.
- Integration failure → Ready/integrate, retaining closure unless it is a
  positively verified conflict requiring a new build/approval cycle.
- Cleanup failure → Ready/cleanup, Issue still closed and approval retained.

Results and partial settlement are saved before external I/O. Retry observes
already-written comments/status/reopen/release before replay and finishes that
I/O before models. Previous execution is drained before claim/slot release.
GitHub write failures log/notify a local failure, not a fictional Ready success.
Fresh human lane/identity/claim changes stop stale write-back and retain work.

AI review is unconditional. It checks the pushed original successful build SHA
in a detached managed worktree, verifies main checkout integrity, persists its
verdict before cleanup/board writes, then uses awaited native scratch cleanup.
A pass exposes Done with the Issue **open** and persistent task worktree available.
The user validates and manually closes. Outstanding build/review retry obligations
block manual Done/close bypass. Trusted OWNER/MEMBER/COLLABORATOR replies reach a
new mission only after manual Ready; comments alone do not resume Needs Human.

## Integration and native cleanup

The loop's once-per-tick local task-ref query is a negative filter for historical
closed-Done Tasks. No-ref/no-progress entries defer; integration/retry state can
continue without a ref. Query errors block the lane rather than imply absence.
Presence still requires fresh approval, ticket record, refs and owned worktree.
Unknown branches/remnants do not imply ownership.

`finalizeAccepted` fetches base and prepares a normal two-parent result via
`merge-tree`/`commit-tree`, without switching/editing main. Already-integrated
task history needs no extra commit. It atomically saves `{baseSha,taskSha,resultSha}`
before a normal, non-force base push. After any response, including loss/error,
it fetches again: only result ancestry on current `origin/base` proves integration.
A positively observed non-fast-forward rejection can prepare against advanced
base for a later tick; ambiguity cannot authorize a duplicate merge or cleanup.

A verified conflict creates no integration push/cleanup. Durable diagnostic,
reopen and Ready settlement returns the original branch/worktree to the ordinary
builder. It resolves base into task, preserves useful edits/requirements from
both parents and tests; independent Review and a **new manual close** follow.
There is no dedicated repair ledger or special passing-tool-history protocol for
new work. Normal finalization itself has no blanket post-merge test gate.

After remote integration is freshly proved, the record becomes cleanup-only.
Every destructive step rechecks ancestry, approval, exact execution/ref identity
and managed Git/path ownership:

1. For an owned registered worktree, native `git clean -fdX` removes only ignored
   files **while registration exists**. Remaining ignored links are checked and
   unlinked nonrecursively, never followed. This catches ignored Windows locked
   file failures before Git can unregister a failed removal.
2. Delete the remote task ref with an exact expected-SHA deletion lease.
3. Use ordinary `git worktree remove` for the managed task worktree.
4. Verify path/registration and remote ref absence; delete the local task ref with
   its expected SHA.
5. Observe Project Done, then recheck ancestry/absence and delete the ticket record.

Tracked/non-ignored dirty files, locked or active Git operations, nested Git,
external paths, changed refs and unknown remnants block. There is no force
worktree remove, prune, unlock or recursive fallback. Fresh unregistered remnants
are retained. Only existing legacy receipts with verified unchanged ownership/
backup evidence authorize narrow per-entry residual deletion. Missing refs/path
are retryable; the record remains through failed final Project writes.

## Lifecycle and process containment

`BoardLoop.stop()` publishes a shared promise before abort listeners can reenter,
closes admission/scheduling synchronously, waits for tick and liveness-heartbeat
work, then pauses/drains managers and leases before releasing the owner. Failed
drains retain unfinished managers, loop/store and ownership for retry. A tick
error still drains and may be reported as a warning after successful cleanup.
Startup continuations and promotion check stop generation across awaited work;
stop cannot be undone by a late preflight continuation.

Foreground review uses the existing deadline and AbortSignal. Stop drains its
model finally, scratch cleanup and claim release before releasing capacity/owner;
a failed UI observer cannot detach an early model rejection. Already-started Git
finalization keeps its deadline/verification sequence and is awaited, not aborted
mid-destructive operation.

Git/gh use shell-free, non-interactive bounded subprocesses. Network Git and
startup package checks yield through the async runner; necessary local probes
remain synchronous. POSIX process groups and Windows Job Objects contain ordinary
descendants, not malicious POSIX process-group escape. Telegram retains its
mandatory deadline and caller cancellation. The owner lock rejects live/foreign/
corrupt owners; only a proven-dead same-host owner is reclaimable, with a separate
reclaim lock and token-safe release.

Historical audits describe their original baselines, not current requirements.
Offline verification does not establish live GitHub/provider/deployment behavior
or normal base-push permission; see the [runbook](runbook.md).
