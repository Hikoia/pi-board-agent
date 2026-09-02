# Architecture

`pi-board-agent` polls a GitHub Project, but ticket execution is durable and per-ticket. The board loop selects work; `TicketExecutor` owns claims, persistent worktrees, WorkflowManager runs, recovery, and terminal transitions.

## Module map

```text
src/index.ts
├── lifecycle hooks, commands, project metadata validation
├── owner-lock.ts             one local repo owner (`fs.open(..., "wx")`)
└── loop.ts                   reconcile first, then fill global worker slots
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
run story/review/watchdog/finalization lanes
  ↓
slots = max_workers - activeCount()
  ↓
launch Ready task cards globally (no plan-level inflight guard)
```

Builders run in the background. A tick never waits for a builder to finish; later ticks read persisted run state.

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
|---|---|
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

`BoardLoop.stop()` is asynchronous: it stops admissions and new ticks, waits for the current short tick, pauses managed runs and waits for their leases to settle, then releases the owner lock. `session_shutdown` awaits it. On startup or reload, an existing active/launching record (or legacy inflight file) starts a recovery-only loop even when `auto_start` is false; it reconciles existing tickets but does not admit Ready work. `/board-agent run` promotes that loop to autonomous mode.

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
