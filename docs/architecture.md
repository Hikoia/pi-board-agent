# Architecture

This document describes how the modules of `pi-board-agent` fit together.

## Module map

```
src/index.ts          ← Extension entrypoint (pi.registerCommand × 5, lifecycle hooks)
│
├── src/config.ts     ← Load .pi/board-agent.yml, validate, resolve owner from git origin
├── src/gh.ts         ← gh CLI wrapper: GraphQL ProjectsV2 queries, card lifecycle mutations
├── src/git-helpers.ts← Low-level git checks: isClean, ensurePlanBranch
├── src/inflight.ts   ← Lockfile registry under .pi/board-agent/inflight/ for crash recovery
│
├── src/loop.ts       ← Polling loop orchestrator
│   ├── Reads cards via gh.ts (listCards)
│   ├── Groups into plans via plan.ts (summarizePlans)
│   ├── Claims cards via gh.ts (tryClaim) + inflight.ts lockfiles
│   ├── Generates workflow scripts via workflow-prompt.ts
│   └── Hands them to pi-dynamic-workflows (dxRun)
│
├── src/workflow-prompt.ts ← Renders a JS module for pi-dynamic-workflows' workflow tool
│   └── Embeds per-card payloads + builder instructions referencing skills/board-agent
│
└── src/plan.ts       ← Plan-level operations: detect completion, open cumulative PR
    ├── summarizePlans(): group cards by plan_field, count per-status
    ├── isPlanComplete(): all cards in done_status?
    └── openPlanPr(): gh pr create plan/<slug> → base, idempotent via findPr

skills/board-agent/SKILL.md   ← Builder agent procedure (loaded by pi-dynamic-workflows agent)
agents/board-agent-builder.md ← AgentType definition (optional, for agentType: "board-agent-builder")
```

## Data flow (one tick)

```
[Timer fires every tick_seconds]
         │
         ▼
loop.ts: tick()
  ├─ ① listCards(projectId) → Card[]
  │
  ├─ ② summarizePlans(cfg, cards) → Map<slug, PlanSummary>
  │     └─ For each plan where ALL cards are Done:
  │         openPlanPr() → gh pr create plan/<slug> → main
  │
  ├─ ③ Filter: cards where status == ready AND plan != null AND not already inflight
  │     per plan: pick up to max_workers cards
  │
  ├─ ④ For each card in the batch:
  │     ├─ tryClaim(card, botLogin)  — atomic assignee mutex on GitHub
  │     ├─ inflight.write(record)    — local lockfile (crash recovery)
  │     └─ setStatus(itemId, building) — advance column
  │
  ├─ ⑤ buildTasksForWave(cfg, planSlug, claimedCards) → BuilderTask[]
  │     renderWorkflowSource({ tasks, ... }) → JS string
  │     dxRun(script) → runId
  │
  └─ ⑥ dxResult(runId) → outcome[]
        └─ per card:
            success → setStatus(itemId, review) + release assignee
            failure → setStatus(itemId, ready)  + release assignee
```

## Branch model

```
main                            ← never touched by board-agent
 │
 └─ plan/001-auth               ← long-lived, created once by ensurePlanBranch()
      │
      ├─ task/T001              ← worktree subagent (git checkout -b, implement, push)
      │     └─ merge --squash → plan/001-auth
      │
      ├─ task/T002              ← parallel worktree subagent
      │     └─ merge --squash → plan/001-auth
      │
      └─ task/T003
            └─ merge --squash → plan/001-auth
                                  │
                          All 3 Done → gh pr create plan/001-auth → main
```

Each per-task branch is created and pushed by a builder agent running in an
isolated git worktree (provided by pi-dynamic-workflows `isolation: "worktree"`).
The worktree is cleaned up automatically by the workflow runtime after the agent
finishes.

## Safety layers

1. **Assignee mutex** — before spawning a builder, the loop calls
   `gh issue edit --add-assignee <botLogin>`. If another instance already holds
   the assignee, the claim fails and the card is skipped. This is the primary
   concurrency guard.

2. **Local lockfiles** — written to `.pi/board-agent/inflight/<itemId>.json`
   BEFORE the assignee claim. On crash recovery, the next loop tick scans
   these files and reports stuck cards without re-dispatching.

3. **Orphan scan** — `inflight.list()` returns all lockfile records. The loop
   skips cards that have an active lockfile (same itemId).

4. **Dirty worktree guard** — `config.safety.require_clean_worktree` (default:
   `true`) prevents the loop from running when the working tree has uncommitted
   changes.

5. **Stuck-building guard** — `config.safety.max_stuck_building` (default: 3)
   pauses the loop when too many cards are stuck in the `Building` column,
   indicating a possible crash or zombie worker.

6. **Skip closed issues** — `config.safety.skip_closed_issues` (default:
   `true`) ignores cards whose linked GitHub issue/PR has already been closed.

## Extending

### Adding a QA lane (like super-board's super-qa)

1. Create `skills/board-agent-qa/SKILL.md` with the QA procedure.
2. Add a `qa` phase to the workflow in `workflow-prompt.ts` that runs
   `agent(..., {..., phase: 'QA'})` for cards in the `Review` column.
3. The orchestrator loop (`loop.ts`) would pick cards from `Review` instead
   of stopping at `Review`.

### Adding a saved workflow for reuse

After a run, the generated workflow script is visible in pi-dynamic-workflows'
`/workflows` TUI. Use `/workflows save board-agent-wave-<slug>` to persist it
as a reusable command.

### Using a different backend

The `LoopDeps` interface (`loop.ts`) accepts `dxRun` and `dxResult` as
injectable functions. To replace pi-dynamic-workflows with a custom backend,
provide your own implementation of these two functions.