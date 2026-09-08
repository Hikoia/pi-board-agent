# Architecture

`pi-board-agent` polls a GitHub Project, but ticket execution is durable and per-ticket. The board loop selects work; `TicketExecutor` owns claims, persistent worktrees, WorkflowManager runs, recovery, and terminal transitions.

## Module map

```text
src/index.ts
├── lifecycle hooks, commands, project metadata validation
├── owner-lock.ts             one local repo owner (`fs.open(..., "wx")`)
└── loop.ts                   reconcile/finalize, then share worker slots
    ├── ticket-executor.ts    claim → worktree → managed run → recovery/outcome
    │   ├── ticket-worktree.ts  v2 ticket execution record + retained worktree
    │   ├── inflight.ts         legacy lock detection/archive only
    │   └── pi-dynamic-workflows WorkflowManager + UsageLimitScheduler
    ├── refine.ts / review.ts / watchdog.ts
    └── plan.ts               final task merge and cumulative plan PR
```

`dispatch.ts` only normalizes persisted builder results. It no longer starts workflows or stores in-memory promises.

## Durable state

Each ticket has one atomic JSON record under `.pi/board-agent/ticket-worktrees/`:

```ts
interface TicketExecutionRecord {
  schemaVersion: 2;
  itemId: string;
  issueNumber: number;
  taskKey: string;
  plan: string;
  taskBranch: string;
  planBranch: string;
  path: string;
  createdAt: number;
  launchingAt?: number;
  activeRunId?: string;
  activeRunStartedAt?: number;
  lastRunId?: string;
}
```

The record associates a card, retained worktree, and managed run. WorkflowManager's persisted run is the execution truth for status, journal, result, and lease. Legacy v1 worktree records remain readable and are upgraded when reused.

WorkflowManager stores runs outside the repository under Pi's workflow project storage. One manager is created lazily per ticket worktree with `concurrency=1` and `maxAgents=1`. Its usage-limit scheduler remains enabled.

## Tick flow

```text
listCards()
  ↓
TicketExecutor.reconcile(cards)
  ├─ adopt a run persisted during the launch write window
  ├─ resume a clean interrupted run
  ├─ apply a completed result once
  ├─ quarantine dirty/missing/malformed/failed runs in Needs Human
  └─ quarantine legacy inflight and record-less In Progress cards individually
  ↓
if activeCount() < max_workers: run the Needs Design Task gate/refinement lane
  ↓
run Story refinement, watchdog, finalization lanes, and plan PR checks
  ↓
build Review and Ready candidate lists
  ↓
available = max(0, max_workers - active builders)
  ├─ reserve one slot when Review work is pending
  └─ give every other available slot to builders
  ↓
launch Ready task builders in the background
  ↓
await at most one claimed Review card
  ↓
recount active builders and immediately refill Ready slots
```

`max_workers` is shared by task design, active builders, and the current reviewer.
Task design remains a foreground workflow and starts only when a worker slot is
available. Builders run in the background, so the reviewer overlaps their work.
The tick awaits the single reviewer lane but never waits for a builder; later
ticks reconcile persisted builder state.

## Task design gate

An open non-Story Task entering `Needs Design` first receives one requirements-gate marker under a temporary assignee claim. The bot then waits without claiming until an `OWNER`, `MEMBER`, or `COLLABORATOR` replies after the latest gate or task-design-question marker. A completed marker closes that request; moving the Task back to `Needs Design` starts a new gate.

After claiming and before running the designer, the loop re-reads the Project item and every issue comment. Before any post-design write, it re-reads both again and requires the issue to remain open and in `Needs Design`, the body to be unchanged, no competing assignee, and the same latest trusted decision source ID. A status change prevents every write; a changed body or decision is left for the next tick. Open questions create a fresh request boundary. A resolved contract updates the body, moves the Task to `Ready`, posts its audit marker, and releases the claim.

Candidates start at `tickCount % candidates.length`, so one failing Task cannot starve its siblings. Each tick invokes at most one Task designer.

## Launch ordering

1. Re-read the Project item and verify it is open, Ready, on the expected Plan, unclaimed, and has no active run.
2. Add the bot assignee, then re-read again. A competing assignee or changed card releases the bot and cancels launch.
3. Create/reuse the retained ticket worktree and atomically set `launchingAt`.
4. Move the card to In Progress.
5. Call `WorkflowManager.startInBackground()`. The manager persists the run before starting its agent.
6. Atomically write `activeRunId` and clear `launchingAt`.

If the process dies between steps 5 and 6, persisted args (`itemId`, `issueNumber`, `taskKey`) identify the unique run for adoption. If no run exists, the card returns to Ready only when the worktree is clean and the task branch has no delta. Unknown side effects go to Needs Human.

## Recovery policy

| Persisted state | Action |
| --- | --- |
| running with a live lease | Keep In Progress |
| paused, expected branch, clean worktree | Resume (usage-limit pauses wait for the built-in scheduler) |
| completed with one valid success result | Comment once, move to Review, release assignee, clear active association |
| builder failure, failed/aborted run, malformed/missing run | Needs Human |
| paused/completed worktree dirty or branch/path mismatch | Needs Human; retain worktree |
| card manually moved out of In Progress | Stop stale run and preserve the manual status; Ready is accepted only when clean |
| In Progress without an execution record | Needs Human for that card only |
| Project item removed while active | Stop its run, clear the active association, retain the worktree |

Outcome comments use `<!-- board-agent-run:<runId>:<outcome> -->`, so a retry after a GitHub mutation failure does not duplicate comments. The active record is cleared only after all terminal mutations succeed.

## Process lifecycle

`owner.lock` contains pid, hostname, bot identity, and a random token. A live local owner or any different-host owner fails closed; a dead same-host pid can be reclaimed.

`BoardLoop.stop()` is asynchronous: it stops admissions and new ticks, waits for the current tick (including its reviewer), pauses managed runs and waits for their leases to settle, then releases the owner lock. `session_shutdown` awaits it. On startup or reload, an existing active/launching record (or legacy inflight file) starts a recovery-only loop even when `auto_start` is false; it reconciles existing tickets but does not admit Ready work. `/board-agent run` promotes that loop to autonomous mode.

## Branch and human gate

```text
main
 └─ plan/001-auth
     ├─ task/t001 + retained worktree → Review → Done → human closes issue
     ├─ task/t002 + retained worktree → Review → Done → human closes issue
     └─ task/t003 + retained worktree → Review → Done → human closes issue
```

Closing a Done issue is the approval signal to merge its task branch into the plan branch and remove its worktree. The cumulative plan PR opens only after every task is closed and finalized.

## Safety boundaries

- GitHub assignee plus post-mutation refetch handles claim races.
- WorkflowManager supplies durable journals and per-run cross-process leases.
- The owner lock limits one board-agent process per checkout.
- Dirty interrupted worktrees are never handed back to a builder automatically.
- `Needs Human` is terminal for automation until a human moves the card to Ready.
- Legacy `.pi/board-agent/inflight/*.json` files are quarantined and archived; they are not part of new execution.
- No database, queue, heartbeat, custom lease, or board retry counter is maintained.
