# Architecture: Task-only v5 managed PR continuation

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
  ticket-worktree.ts     v5 atomic store, PR preparation/proof, guarded Git cleanup
  ticket-retry.ts        stage and pending comment/status/reopen/release settlement
  legacy-tickets.ts      sole v3/v4 conversion/legacy evidence adapter
    cleanup-snapshot.ts  read-only old evidence verification and checked residual removal
  review.ts              detached exact-SHA isolated review
  dispatch.ts            fail-closed outcome/decision parsing
  workflow-prompt.ts     builder mission and trusted maintainer context
  plan.ts                optional read-only grouping
gh.ts                    strict findPullRequests/createPullRequest/getPullRequest
process-runner.ts         non-interactive, deadline-bound Git/gh process trees
context.ts / notify.ts   configured navigation digest and notifications
```

Story splitting/publication, design and PR watchdog execution do not exist.
Their old journals remain untouched. No production caller creates repair
ledgers, cleanup receipts, full-tree cleanup hashes or backups. The snapshot
module is reachable only for **existing legacy evidence**, not ordinary v5
build/review retry or PR cleanup.

## Identity and ownership

Model execution requires an Issue in the repository resolved from `origin`,
with configured Type equal to Task. Closed Done Issues of any Type may finalize
and move to Backlog without an AI-review marker. PR, Draft and foreign cards
never mutate. Project ownership is separate from repository identity.

Fresh reads validate item/Issue/repository/Type, status, open/closed state,
contract and claim after awaited preparation and before writes. Plan is optional;
changing an existing Plan is still a contract change, not permission to use a
stale snapshot. Failed reads retain evidence rather than authorize from a cached
board. Claim release is also a mutation: an unidentifiable replacement card
cannot authorize it. Only an actual build retry/conflict claims closed approval
for reopening/Ready writeback; pure technical finalization failures update local
retry state and warnings without changing the Project lane. Builder admission
still requires open Ready.

One filesystem owner protects the target checkout. PID/host/token checks reject
live local, foreign-host or corrupt ownership. Only a provably dead same-host
owner can be reclaimed, with a separate reclaim lock. An old release token cannot
remove a replacement lock. Global model capacity never substitutes for ownership.

## One ticket record

`.pi/board-agent/ticket-worktrees/<safe-item-id>.json` is atomically replaced:

```ts
interface TicketExecutionRecordV5 {
  schemaVersion: 5;
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
  integration?: TicketPullRequestIntegration | TicketLegacyCompletedIntegration;
}
```

The exact types/validators live in `src/ticket-worktree.ts`. Both variants pin
`scope: {owner, repo, base, head}`, `baseSha`, `taskSha` and nullable
`remoteTaskSha` (v5 never uses omission to mean a source):

- `kind: "pr"`: `preparedHeadSha`, stable `initialPreparedHeadSha`, and phase
  `prepared | open | suspended | merged`. `prNumber`/`prUrl` are required for open
  and merged; prepared/suspended may retain them. Merged additionally requires
  `mergedHeadSha` and the actual `mergeCommitSha`.
- `kind: "legacy-completed"`: `resultSha` attested by owner-held migration on
  fresh base. Cleanup-only forever, not a new PR preparation.

`recordPullRequestPreparation()` permits new/renewed suspended approval;
`progressPullRequest()` advances PR evidence. Ordinary `updateV5()` cannot replace
sources, PR references or evidence. Merged evidence is never downgraded/erased.
The stable initial SHA identifies recovery across repairs, not an equality
constraint on later PR heads. Strict readers and compare-before-write atomic
publication preserve uncertainty/corruption rather than treating it as absence.

`retry.reason` also carries unsettled writeback until comment, optional reopen,
status and release have been freshly confirmed. Existing `integrate | cleanup`
stages handle technical failures; normal PR waiting is not a failure. There is
no second retry store. Preparation is saved **before task push/PR creation**;
its presence proves neither publication nor merge.

## Scheduling and launch

Each tick:

1. Reject unsupported state read-only, then list cards.
2. Reconcile original run associations, uncertain launches and model-result I/O.
   Pure finalization records do not repeat per-ticket remote checks here.
3. If idle, start one tracked finalizer for closed Done, retained PR observation,
   pending Backlog cleanup or retirement of an old technical writeback. Do not
   await it before model admission. Rotate stable item IDs using an in-memory
   cursor; exclude its ticket until the Promise and settlement have completed.
4. Check admission and configured main-checkout cleanliness for new model work.
5. Reserve one slot for a pending review, pre-fill other slots with Ready builders.
6. Run at most one foreground review; recount/back-fill Ready builders.

A tick-local attempted set prevents same-ticket immediate retries. Only target
Tasks enter model lanes; no Plan gate or dependency scheduler exists. Finalization
checks local and remote refs: local absence cannot exclude remote-only work.
Confirmed no-ref history without PR/integration/pending evidence moves to
Backlog, preserving idle records and leftovers; corrupt or pending recovery is
never absence. Retained PR evidence takes precedence even if GitHub deleted head.
Idle closed Backlog history without pending evidence stops per-ticket polling.

`max_workers` includes builders and foreground review. Active associations count
until safely drained and settled, including paused, terminal-but-unsettled,
missing/unreadable and launch-window state. Display observations cannot lend a
slot. The one finalizer has its own Promise/AbortController and no model slot,
queue, journal or dispatch timer. `waiting` returns the PR number/URL/reason after
bounded observation and releases the finalizer; it never holds a worker or
launches a CI-triggered rebuild. A failed board list still prevents admissions;
background maintenance does not authorize work from stale board data.
Existing UsageLimitScheduler timers call fresh resume authorization after
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
interrupted MERGE_HEAD. On returned work, builders finish owned interrupted merges,
then fetch/merge published `origin/task` ancestry before a normal task push; no
force/rebase rewrite of required evidence. Review or humans assess test adequacy;
missing tool telemetry is not a product-decision signal.

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

## Managed PR submission, observation and cleanup

Fresh closed Done requests a PR from either or both task refs without an AI-review
marker. Existing record identity/ownership remains binding; a safe recordless
branch gets a v5 record. Remote-only restoration is compare-and-create and never
starts a builder or creates a worktree. `preparePullRequest()` pins both sources,
supporting local-only, remote-only, ahead and divergent histories. Source conflicts
retain both tips for manual resolution, never an automatic repair builder.
Native `merge-tree`/`commit-tree` prepares a head preserving both ancestries and
base, saves it atomically, then **normally pushes task only**. Neither main nor
the user's task-worktree HEAD is moved. A prepared retry observes publication
first; open PRs are observation-only, not automatically updated for CI/base drift.

Only an initial deterministic, repairable base conflict uses the existing build
retry: comment, reopen, Ready; resolve base into the original branch, test, push,
review, Done and renewed close. CI failure or pending review never initiates this
handoff. Humans handle strict required checks with merge-based Update branch or
appended commits. Human PR merge (squash recommended) remains the sole final
integration approval. There is no base push, merge/Auto-merge API or protection
bypass, and no blanket integration-test run.

### PR API and identity

`src/gh.ts` uses the existing deadline-bound `gh` GraphQL/JSON boundary:

- `PullRequestScope { owner, repo, base, head }` requires the same repository at
  both ends. `PullRequestInfo` carries scope, number, URL, body, open/closed state,
  explicit merged boolean, head SHA and nullable `mergeCommitSha` (an unmerged
  value can be a test-merge SHA, not completion).
- `findPullRequests(scope)` paginates all OPEN/CLOSED/MERGED candidates;
  `getPullRequest(scope, number)` never falls back to discovery on unknown data.
- `createPullRequest(scope, title, body, authorize?)` renews caller authorization
  after repository lookup, before the mutation. Production injects these through
  `TicketExecutorDeps.pullRequests`; tests inject fakes, never a live fallback.

One PR belongs to `itemId + createdAt`. Body uses `Refs #N` and a machine marker
with that identity plus `initialPreparedHeadSha`. Saved number/URL wins; marker
recovery also requires exact scope and source ancestry. Multiple/wrong candidates,
missing JSON, permission errors and timeouts block instead of implying absence.
Response loss recovers before another create; human PR bodies are not overwritten.
PR closed-not-merged returns waiting with retained work, not cleanup or a new PR.

### Withdrawal and renewal

Issue reopen or leaving the approval lane suspends unmerged submission, retaining
the PR. Open Ready permits the original builder in its original worktree; review,
Done and renewed close may prepare/update the same still-open PR while retaining
initial marker identity. No automatic PR reopen/close occurs. A merge observed
while withdrawn/active is persisted irreversibly (draining the original run), not
permission to delete. Confirmed merged/legacy-completed state is cleanup-only;
uncovered later work requires a new submission/PR, never reuse of old merge proof.

### Merge proof and cleanup

`cleanupMergedPullRequest()` requires exact saved PR identity, explicit
`merged=true`, and the actual GitHub `mergeCommitSha` on **fresh** `origin/base`.
An unmerged test-merge SHA or task ancestry in base is not proof of squash merge.
The merged PR head object (fetched via `refs/pull/<number>/head` when needed) must
cover prepared head, saved sources and current local/remote tips. Appended commits
and merge-based Update branch preserve this evidence; rebase/force rewrites losing
ancestry block without patch-equivalence guesses. Merged evidence is persisted
before cleanup, including when GitHub has already deleted the task branch.

After proof, reject nested Git and clean ignored files/unlink ignored junctions
without following targets while refs/registration remain. Cleanup order is fixed:

1. Delete remote task ref with its exact SHA lease.
2. Normal `git worktree remove` of the owned registered task worktree.
3. Delete local task ref with expected-SHA compare-and-delete.
4. Write/confirm Project Backlog.
5. `completeFinalization()` deletes the ticket record last.

Guards renew owner/stop, ticket/PR authorization, record, source tips, fresh base
proof and worktree/Git identity across awaits, then pin local preconditions after
the last awaited authorizer. Unknown/dirty/untracked work, extra commits, unsafe
paths, symlinks, nested Git, Windows/Git locks and active runs detected by those
guards retain artifacts. **Ignored files may be discarded by `git clean -fdX` and
normal removal.** No force removal, broad prune/unlock or recursive fallback is
allowed. Unknown unregistered leftovers stay; cleanup creates no snapshots.

These are **latest-observation guards, not cross-system atomicity**. GitHub and
remote Git cannot be read atomically. If a task ref is recreated during the final
GitHub authorizer, exact leases protect new remote commits, but the already-merged
local worktree/ref/record may still be removed. The post-observation race is an
accepted limitation, not an absolute prevention claim or reason to add distributed
locks/watchdogs. See the [operating boundary](runbook.md#cleanup-observation-boundary).

Failed cleanup retains proof, updates local cleanup diagnostics and retries only
unfinished steps. Historical integrate/cleanup pending Ready writes retire without
status/comment/reopen replay; identity/claim/record guards still govern release.
Withdrawal never erases confirmed cleanup evidence.

## Exclusive stopped v3/v4 continuation

Stop/drain the old owner and back up raw records, worktree bytes, refs and external
journals before installing/restarting; finishing every Task is unnecessary.
Upgrade all writers together, never mix the old direct executor with v5. Startup
acquires exclusive ownership before `LegacyTickets.migrateV5()` and manager
creation. Per-ticket conversion verifies exact-byte backups in `legacy-v3/` or
`legacy-v4/` before atomic v5 publication. Stop/owner loss vetoes publication.
Already-published v5 never replays migration. A bad ticket is isolated; no source
or Issue is deleted to claim successful conversion.

Conversion retains original run ID, script/args/worktree, paused work and unique
launch bindings. Unlaunched old repair becomes an ordinary build retry with its
request/diagnostics retained. Bound old repair resumes its original run. Old
merge/squash results already verified on fresh base become immutable
`legacy-completed` cleanup-only evidence. Pending valid results that retain exact
source ancestry become prepared PR heads for normal task push, never base push.
Missing/corrupt evidence, changed sources, rewritten base or a cleanup result
absent from base blocks migration; a pending squash losing ancestry cannot be
reused. Human-closed Done submission needs no AI-review marker in either schema.
Valid v1/v2 cleanup receipts with null records can finish or convert safely;
completed receipts do not resurrect execution records.

Old receipts/ledgers stay read-only and are not garbage-collected. Partly removed
unregistered legacy paths require their existing ownership/unchanged snapshots
and any recorded backup; only the adapter can verify/remove those residuals.
Each attempt uses prepare → remove → finish: strict original/archive parsing,
one full backup/source validation, expected-entry Maps and a surviving-item
removal list; per-entry source/parent/backup checks; then final full backup and
raw evidence validation. Removed entries are not rescanned. Files hash in 1 MiB
chunks, cancellation is checked between chunks/items, and traversal yields after
about 50 ms accumulated work. Handles always close in `finally`.

Full backups are verified at most twice per cleanup attempt. Receipt/manifest
identity, size, mtime and ctime are pinned between full reads; changed evidence
is rejected, not adopted. No verification context survives an attempt or owner.
A remote authorization window permits at most **32 deletions or 1 second** after
observation, whichever comes first. Check expiry before each delete; long hashes
refresh expired authority then recheck file/ancestor stamps. Stop, owner, record
and local Git guards are not cached. Ref deletion and Backlog/record completion
have independent fresh checks and expected-SHA protection. This window is not a
network deadline or a promise to detect remote withdrawal within one second.
Unknown/recreated entries, symlink/junction replacement, nested Git and locks
still block; partial progress resumes without rollback. A failed normal v5 Git
removal never falls back to this legacy path.

There are no new snapshots or inferred backups. Without existing evidence,
unknown remnants remain. Preserve Needs Human; old Task Needs Design maps to
Needs Human with original questions. Closed Done non-Task Issues may complete;
remaining Story/PR state is untouched.
Unsupported v1/v2/inflight/corrupt data is never guessed or deleted.

## Runtime and lifecycle

Installed package identity is immutable for the owner lifetime. Startup/lint
and deployment check pinned/configured/loaded/disk revisions and config. UI,
heartbeat, stop and ordinary admission use the last result/latch, never package
Git HEAD/status or settings scans. Runtime JSON is an observation, not fresh
deployment proof. Unsupported-state and owner-lock checks still guard writes;
fresh ticket identity/capacity/deadlines remain live. Hot update is unsupported.

`/run` and auto-start register a startup Promise/AbortController before yielding,
without holding the UI behind migration. Repeated run cannot acquire a second
owner. Migration finishes (isolating failed tickets) before model admission.
`BoardLoop.start()` installs its timer and tracked first tick and returns.

`stop()` publishes one reentrant barrier, closes scheduling/automatic resume,
aborts startup, foreground review and finalization, awaits their real settlement
(including tick/heartbeat and file handles), then drains managers/leases before
owner release. Failed drain retains managers/owner for retry. Startup generation
checks prevent a late continuation after stop. Stop during preparation is not a
technical failure. Already-started Git runs to its bounded outcome; stop awaits
it, while subsequent destructive steps may be vetoed and left recoverable.

Widget, status and schema-1 runtime carry optional observational activity:
ticket, phase, completed/total/unit, startedAt, lastProgressAt and lastBlocker.
Old runtime files without activity remain readable. Progress publication is
throttled to 1 Hz except phase changes, errors and completion; it performs no
Git/GitHub/revision/capacity probes. Active activity clears at settlement; a
blocker remains until the next attempt. Heartbeat and progress are independent.
A no-progress interval over `max(3 × tick_seconds, 300)` seconds is displayed,
never treated as takeover/restart authority. `starting`/`stopping` are observable
states, not healthy running; STOPPING never hides a retained owner as stopped.

All runtime Git/gh calls use the shared deadline runner. POSIX process groups and
Windows Job Objects contain ordinary descendant processes, not malicious POSIX
session escapes. Telegram combines cancellation with its fixed deadline. No
live models, GitHub or deployment policy are certified by offline fixture tests.
This delivery makes no deployment or real #121 changes. Live PR permissions,
CI/protections and manual merge acceptance remain unverified. MAIN T07 completed
all 91 offline test files with exit 1; full-suite acceptance **did not pass**.
See the [final acceptance report](manual-pr-offline-acceptance.md).

Historical audit reports retain their original source baselines and are not
current policy. See [runbook](runbook.md) for stopped backups and recovery.
