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
    │   ├── ticket-worktree.ts  schema-v3 record + exact-SHA Git operations
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
  → process at most one Needs Design Task when a worker slot is free
  → process fair Story lane (at most one external Story action)
  → await the serialized watchdog tick
  → reserve one shared worker slot for Review when needed
  → launch Ready Task builders into remaining slots
  → run at most one foreground reviewer
  → recount active builders and refill Ready slots
```

Waiting Stories are skipped rather than returned from the whole lane. Candidate
order rotates by tick, so one persistent blocker cannot starve siblings. The
same principle applies to Needs Design Tasks.

`max_workers` covers active builders and foreground Story/Task refinement or
review. Watchdog maintenance is a separate serialized lane.
Builders remain background-managed; Story and review mutations complete before
their lane advances.

## Builder launch and recovery

1. Validate an open Ready Task Issue from the origin repository.
2. Add the bot assignee.
3. Re-read and require sole claim, unchanged Plan/identity/status.
4. Create or resume the registered persistent worktree from fresh
   `origin/<base>` on `task/issue-<number>`.
5. Refuse pending finalization; atomically record `launchingAt` and clear a
   prior reviewed SHA only for a new builder attempt.
6. Move the card to `In Progress`.
7. Start WorkflowManager; it persists the run before starting the agent.
8. Atomically associate `activeRunId`.

A crash between steps 7 and 8 is recovered by matching the persisted
`itemId`, `issueNumber`, and `taskKey`. Ambiguous or unprovable state goes to
`Needs Human`. Run-lineage comment markers make terminal GitHub writes
idempotent. The active association is cleared only after the terminal comment,
status, and assignee operations succeed.

Paused managed runs resume when record, args, path, branch, and card identity
match. Usage-limit pauses remain under the scheduler. Dirty partial work may be
continued only by the same structurally owned ticket; dirty completed work,
wrong branches, missing runs, malformed results, and identity drift fail
closed.

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
worktree is created during finalization.

## Local-branch finalization

For a fresh, closed Done Task in the origin repository:

1. Derive `task/issue-<number>` using the configured task prefix. If the local
   branch is absent, it is settled: no remote lookup, record requirement,
   warning, or leftover-file cleanup. Git errors are not treated as absence.
2. Refuse active builders and unsafe registered task worktrees. A branch does
   not need to be checked out, pushed, or accompanied by an execution record.
3. Fetch `origin/<base>` and use native `git merge-tree` / `git commit-tree`
   to merge or squash the local tip, leaving the main checkout untouched.
4. Push normally and fetch again to verify the result reached the remote base.
5. Recheck the local ref/worktrees, delete only an integrated remote task ref
   with an exact deletion lease, remove clean managed worktrees, then delete
   the local ref with its expected SHA. Clear a matching builder record if any.

The local branch is the retry/completion signal and is deleted last. There is
no new finalization journal. Merge ancestry or an unchanged squash result tree
avoids duplicate integration on retry; conflicting later edits after a squash
need manual resolution. Dirty/locked worktrees, conflicts, rejected pushes,
failed verification, and ref races preserve work rather than forcing cleanup.
`Plan` and `reviewedTaskSha` remain useful build/review metadata, not completion
gates. Story completion uses the same closed-Done/no-local-branch rule for its
children. Existing legacy journals remain protected against builder relaunch;
the finalizer does not depend on them.

## Story exactly-once state machine

`.pi/board-agent/refine-state.json` is atomically replaced. Before the first
child mutation it stores the complete refinement output and a creation plan for
every child: index, digest, deterministic marker, title, body, and task key.

On every attempt, `refine.ts` reconciles in this order:

1. paginate all current sub-Issues and match the marker;
2. create the child only when no target-repository match exists;
3. paginate Project contents and find/add the Issue;
4. re-read the Project item;
5. reconcile `Ready`, exact Plan, and `Task`, persisting after each step.

Attempt markers are persisted before non-idempotent create/add/comment calls.
Visible remote results can be adopted after an ambiguous failure; an attempted
operation whose result cannot be confirmed is never blindly repeated. Multiple
matching markers fail closed. Partial failure keeps the journal, posts
a marker-deduplicated blocker, and moves the Story to `Needs Human`. Returning it
to `Ready` resumes creation without rerunning refinement.

Needs Design comment cursors bootstrap without replay and advance only after
trusted input is handled successfully. A waiting Story does not block another
Story or Task in the same tick.

## Process and lifecycle boundaries

All runtime Git and `gh` calls use `process-runner.ts`: shell-free command argv,
credential prompts disabled, fixed deadlines, and independent supervisors.
POSIX process groups and Windows Job Objects terminate ordinary descendants,
including inherited pipes; deliberate POSIX `setsid()` escape or host SIGKILL
is outside this containment guarantee. Windows requires PowerShell
FullLanguage with `Add-Type`/PInvoke available. Telegram composes caller
cancellation with its mandatory 15-second deadline.

`owner.lock` records pid, hostname, bot identity, and a random token. A live
same-host owner and every different-host owner fail closed; only a provably dead
same-host lock can be reclaimed. A separate `owner.lock.reclaim` serializes
stale takeovers; an interrupted takeover fails closed until manually resolved.

`BoardLoop.stop()` stops admissions, waits for the current tick, pauses active
managers, waits for their leases, writes stopped runtime state, and releases the
owner lock. A failed tick still drains managers; failed draining retains the
lock. A revision mismatch allows settlement/reconciliation but never new
admissions.

Watchdog ticks are awaited and coalesced across instances. Admission is
rechecked before agents and mutations, including the host-controlled CI push.
CI fixes use detached `.pi/worktrees/watchdog-<pr>-*` worktrees and a normal
exact-commit push; failures retain the worktree and block a replacement fix
until a human resolves it. Mention replies use an effective empty tool policy,
not an ignored inline workflow option.
