# Architecture: Task-only v4 continuation

Board Agent retains the polling loop, ticket executor, WorkflowManager and its
provider/backoff scheduler. It is a foreground Pi extension, not a daemon or a
new workflow framework. GitHub is the human-facing board; the existing atomic
per-ticket store and WorkflowManager journals hold local continuation state.

## Module map

```text
index.ts                 commands, startup/lint revision checks, lifecycle/UI
config.ts                strict config + finite legacy input normalization
owner-lock.ts            exclusive checkout owner with token-safe release
unsupported-state.ts     read-only unsupported/corrupt-state detection
loop.ts                  reconcile, integrate/cleanup, bounded build/review admission
  ticket-executor.ts     claim, launch, resume, drain, result settlement, finalize
    WorkflowManager      original durable script/args/worktree and provider backoff
  ticket-worktree.ts     v4 atomic store, owned worktrees, native Git finalization
  ticket-retry.ts        stage and pending comment/status/reopen/release settlement
  legacy-tickets.ts      sole v3 conversion/legacy evidence adapter
    cleanup-snapshot.ts  read-only old evidence verification and checked residual removal
  review.ts              detached exact-SHA isolated review
  dispatch.ts            fail-closed outcome/decision parsing
  workflow-prompt.ts     builder mission and trusted maintainer context
  plan.ts                optional read-only grouping
process-runner.ts         non-interactive, deadline-bound Git/gh process trees
context.ts / notify.ts   configured navigation digest and notifications
```

Story splitting/publication, design and PR watchdog execution do not exist.
Their old journals remain untouched. No production caller creates repair
ledgers, cleanup receipts, full-tree cleanup hashes or backups. The snapshot
module is reachable only for **existing legacy evidence**, not ordinary v4
build/review retry or native finalization.

## Identity and ownership

A mutation candidate must be an Issue in the repository resolved from `origin`,
with configured Type equal to Task. PR, Draft, foreign, Story and untyped cards
never mutate. Project ownership is separate from repository identity.

Fresh reads validate item/Issue/repository/Type, status, open/closed state,
contract and claim after awaited preparation and before writes. Plan is optional;
changing an existing Plan is still a contract change, not permission to use a
stale snapshot. Failed reads retain evidence rather than authorize from a cached
board. Claim release is also a mutation: an unidentifiable replacement card
cannot authorize it. Closed approval can be claimed specifically for finalization
failure writeback/reopening; builder admission still requires open Ready.

One filesystem owner protects the target checkout. PID/host/token checks reject
live local, foreign-host or corrupt ownership. Only a provably dead same-host
owner can be reclaimed, with a separate reclaim lock. An old release token cannot
remove a replacement lock. Global model capacity never substitutes for ownership.

## One ticket record

`.pi/board-agent/ticket-worktrees/<safe-item-id>.json` is atomically replaced:

```ts
interface TicketV4 {
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

`retry.reason` also carries unsettled writeback until comment, optional reopen,
status and release have been freshly confirmed. There is no second retry store
or requested/queued/consumed execution protocol. Integration is saved **before
push**; its presence is not evidence that origin accepted it. Strict readers,
compare-before-write and atomic publication preserve failures/corruption rather
than turn absence into successful cleanup.

## Scheduling and launch

Each tick:

1. Reject unsupported state read-only, then list cards.
2. Reconcile original run associations, uncertain launches and pending I/O.
3. Process approved closed Done (or integrate/cleanup Ready retry) Tasks.
4. Check admission and configured main-checkout cleanliness for new model work.
5. Reserve one slot for a pending review, pre-fill other slots with Ready builders.
6. Run at most one foreground review; recount/back-fill Ready builders.

A tick-local attempted set prevents same-ticket immediate retries. Only target
Tasks participate; no Plan gate or dependency scheduler exists. Local task refs
are a per-tick negative filter for historical closed Done cards, never positive
approval. Retained integration/retry/legacy cleanup evidence bypasses absence;
failed ref queries block that lane, not an empty successful inventory.

`max_workers` includes builders and foreground review. Active associations count
until safely drained and settled, including paused, terminal-but-unsettled,
missing/unreadable and launch-window state. Display observations cannot lend a
slot. Existing UsageLimitScheduler timers call fresh resume authorization after
cooperative drain; a final synchronous stop/admission veto guards actual resume.
No second scheduler or replacement builder is created for uncertain state.

Launch claims open Ready, re-reads the card and prepares the original managed
branch/worktree. Existing partial dirty work is preserved. After preparation,
stop withdrawal releases the still-matching claim without a failure comment or
manager creation. New execution saves the launch window before In Progress and
manager start, then associates the persisted run ID. Fresh checks bracket async
context/board operations. A crash adopts only a unique persisted run matching
ticket args/time/path; ambiguity or no match retains the window for observation.

Builders retain configured model, timeout/retry policy and worktree-specific
context. Durable resumes preserve original script/args/context/worktree, including
interrupted MERGE_HEAD. Builders push only their task branch. Review or humans
assess test adequacy; missing tool telemetry is not a product-decision signal.

## Results, decisions and review

Builder output is success/failure/needs_decision; review output is
pass/fail/needs_decision. Parsing is fail-closed. A decision requires a concrete
question, missing context, distinct viable options and a recommendation. No
classifier model is added. Technical exceptions, timeout, failed tests,
malformed output or exhausted retries are not Needs Human.

Success proceeds to mandatory AI Review. Review pins fresh `origin/task` in a
detached managed worktree; main-checkout integrity is checked before/after and
review cleanup is awaited. There is no main-checkout fallback. Exact review SHA
is persisted before Done; the Issue remains open and task worktree remains.

- Builder failure or review code findings: Ready/build, preserving original work.
- Review fetch/setup/model/cleanup exception: Ready/review of the pinned commit,
  never a replacement successful build.
- Decision: Needs Human after safe drain/writeback/release; only that ticket pauses.
- Pending GitHub I/O: replay settlement, not the model; authentic bot comment
  markers deduplicate an already-observed result.

Needs Human is resumed only after an OWNER/MEMBER/COLLABORATOR reply **and** a
manual move to Ready. There is no comment listener. Trusted comments become
builder context; untrusted text is not authorization. Fresh withdrawal preserves
the human's state. Failed release retains the association/pending write; a
second builder cannot use its occupied slot.

## Merge-only integration and cleanup

Fresh closed Done approval must match an idle owned v4 ticket and exact reviewed
local/remote task tip (or the narrowly archived original v3 approval described
below). New integrations use native `merge-tree` then `commit-tree` with base and
task parents. No checkout/reset/merge in main and no new squash. Push to base is
normal, never forced. There is no blanket integration-test run in the finalizer.

A real conflict produces no integration commit or push. It queues the ordinary
build retry, comments, reopens and moves Ready; branch/path ownership and fresh
card authority remain guarded throughout settlement. Resolution merges base
into the original task, tests, pushes, reviews and requires another human close.

A rejected nonconflicting base advance stays integrate-only. Fresh observation
must show the old base remains in history before the prepared result can be
atomically superseded by a new normal merge. An actual new conflict instead
clears unconfirmed progress under checked authority and requires reapproval.
Confirmed cleanup progress cannot be superseded. Push success with a lost
response is resolved by observing fresh origin/base, not by assuming success or
rerunning a builder.

Cleanup order is fixed and reentrant:

1. Prove the recorded result is an ancestor of **fresh** origin/base.
2. Delete the remote task ref with its expected SHA lease.
3. Use normal `git worktree remove` for the owned registered task worktree.
4. Delete the local task ref with expected-SHA compare-and-delete.
5. Write/confirm Project Done.
6. Delete the ticket record last.

Every operation tolerates an already-absent ref/path but not changed ownership.
Guards re-observe approval, record, Git identity/locks and refs across awaits.
Dirty/untracked program files, wrong branch/path, symlinked ownership,
locks, active runs or concurrent ref movement block deletion. **Ignored files
may be discarded by normal Git removal.** No full ignored-tree scan/snapshot is
created. No force remove, broad prune/unlock, recursive fallback or force base
push is allowed. Unknown unregistered leftovers are retained. Failed cleanup
returns Project Ready/cleanup while keeping the Issue closed and approved.

## Exclusive stopped v3 continuation

The old owner must stop and drain before installing/restarting; finishing every
Task is unnecessary. Startup acquires exclusive ownership before invoking the
single `LegacyTickets` adapter, and before creating managers. Per-ticket
conversion creates/verifies an exact raw v3 backup before atomic v4 publication.
A stop-generation/owner loss vetoes publication. Already-published v4 never
replays migration. A bad ticket is isolated; no source or Issue is deleted to
claim successful conversion.

Conversion retains original run ID, script/args/worktree, paused work and unique
launch bindings. Unlaunched old repair becomes an ordinary build retry with its
request/diagnostics retained. Bound old repair resumes its original run. Old
merge/squash results are adopted; fresh remote observation selects integrate or
cleanup, never a new squash. Original v3 closed Done may lack AI-review evidence;
only its archived unchanged execution can retain that approval, never a later
unreviewed v4 build. Unknown/rewritten pre-result bases, task drift and unsafe
ownership block conversion.

Old receipts/ledgers stay read-only and are not garbage-collected. Partly removed
unregistered legacy paths require their existing ownership/unchanged snapshots
and any recorded backup; only the adapter can verify/remove those residuals.
There are no new snapshots or inferred backups. Without existing evidence,
unknown remnants remain. Preserve Needs Human; old Task Needs Design maps to
Needs Human with original questions. Remaining Story/PR state is untouched.
Unsupported v1/v2/inflight/corrupt data is never guessed or deleted.

## Runtime and lifecycle

Installed package identity is immutable for the owner lifetime. Startup/lint
and deployment check pinned/configured/loaded/disk revisions and config. UI,
heartbeat, stop and ordinary admission use the last result/latch, never package
Git HEAD/status or settings scans. Runtime JSON is an observation, not fresh
deployment proof. Unsupported-state and owner-lock checks still guard writes;
fresh ticket identity/capacity/deadlines remain live. Hot update is unsupported.

`stop()` publishes one reentrant barrier, closes scheduling, aborts foreground
review, awaits tick/heartbeat work, then pauses/drains managers and leases before
owner release. Failed drain retains managers/owner for retry. Startup generation
checks prevent a late continuation after stop. Stop during preparation is not a
technical failure. Already-started Git runs to its bounded outcome; stop awaits
it, while subsequent destructive steps may be vetoed and left recoverable.

All runtime Git/gh calls use the shared deadline runner. POSIX process groups and
Windows Job Objects contain ordinary descendant processes, not malicious POSIX
session escapes. Telegram combines cancellation with its fixed deadline. No
live models, GitHub or deployment policy are certified by offline fixture tests.

Historical audit reports retain their original source baselines and are not
current policy. See [runbook](runbook.md) for stopped backups and recovery.
