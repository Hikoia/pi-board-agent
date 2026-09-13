# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `max_workers` is a total model budget, including conservative builder
  reservations and the single foreground design/refine/review/watchdog slot.
  Builders pre-fill before one primary model, back-fill before watchdog work.
- Runtime network Git and package-revision checks are asynchronous; UI snapshots
  are observational only. Closed-Done history uses a negative-only per-tick
  local-ref filter; actual finalization still revalidates approval and refs.
- New builder missions render navigation context from their prepared worktree;
  durable resumes keep their persisted mission. The packaged builder agent path
  is retained as a non-production pointer to the skill and actual mission.
- Startup/lint/recovery promotion validate enabled-lane Project metadata. Story
  Plan supports text or existing single-select options; no automatic schema
  changes. Restart the loop after manual metadata/config edits.
- Verified merge conflicts can automatically move the Task to Ready and reopen
  its Issue after fresh original-record/Plan, SHA, ownership and revision checks.
  An actual-author-verified comment (`requested` → `queued` → `consumed`) and
  retained `.pi/board-agent/repair/` ledger bind one repair run of the existing
  builder in the original task branch/worktree. Restarts reuse that run; failed
  or ambiguous writes stop rather than blind replay, and human lane/owner changes
  are protected. The Issue body is unchanged.
- Repair preserves original work and requirements, merges the specified base,
  runs existing integration tests on the committed result, and pushes the task
  normally. Host checks both ancestries, clean state with no unmerged entries,
  exact pushed SHA and actual persisted passing test execution. Success returns
  to Review; `review.enabled` is unchanged and humans must validate and **close
  the Issue again**. Repair/evidence failure or repair Review findings go to Needs Human
  when still authorized, not automatic Ready. Consumed requests are not reused
  automatically; a deliberate maintainer reopen/Ready uses ordinary retry flow.
  Ordinary Review is not proof of latest-main integrated tests; normal merges
  have no blanket integration test gate.

### Fixed

- Failed fresh reads no longer authorize mutation from stale board snapshots;
  failed assignee releases preserve unsettled execution evidence for retry.
- Story refinement rejects over-limit/invalid plans without dropping tasks or
  automatic schema repair, and requires base-independent implementation and
  verification. Truncated legacy journals block only the affected Story while
  preserving the original bytes and healthy updates in a same-format companion.
- Refine/design use private definitions plus the effective SDK
  `structured_output`-only allowlist, excluding coding/shared-store tools.
- Reentrant stop/shutdown drains foreground cleanup and managed leases before
  owner release; failed cleanup retains the loop/managers for retry. Model
  cancellation does not interrupt destructive Git or discard recovery work.
- Finalization publishes a late destructive cleanup receipt in
  `.pi/board-agent/cleanup/` only after confirmed remote integration and ready
  cleanup preconditions, not an early merge intent. Exact path/content/link/Git
  identity checks include ignored files. Normal registered Git removal or checked
  item-by-item leftovers must finish before local-ref, record and receipt deletion.
  Pending receipts retry even without a local ref; changed/unknown/locked paths
  block, with no forced cleanup or success while managed directories remain.
- Proven legacy integrated residuals require verified full content/layout backups
  in `.pi/board-agent/cleanup-backups/`. Confirmed old results are cleanup-only;
  missing results require narrow old persistence-order proof, exact-byte archive
  in `.pi/board-agent/repair-intent-backups/` and dedicated checked intent clear
  before conflict repair. Present unknown/unconfirmed results, rewritten base or
  other uncertainty block/preserve; ordinary pending-intent guards remain intact.
- Repeated per-ticket finalization/repair blockers warn once per loop lifetime
  while checks and safe retries still run every tick. Changed reasons/SHAs,
  recovery, different tickets and restart can warn again; dedup does not authorize
  replaying unconfirmed writes.

Backups, intent archives and consumed repair ledgers are not automatically
garbage-collected. Do not blindly downgrade while a cleanup receipt or repair is
pending; keep stopped backups including external workflow journals. There is no
new manual recovery command.

### Deprecated

- Explicit `safety.skip_closed_issues` in either config scope now warns for both
  boolean values. Remove it; closed Issues never start builders/design. Its
  boolean shape remains compatible, with unchanged strict validation. Templates
  omit it and absent/default-only values do not warn.

Current behavior/recovery constraints are in [architecture](docs/architecture.md)
and the [runbook](docs/runbook.md). Historical release notes below and audit
bodies retain their original baseline claims; they are not current specifications.

## [0.2.0] - 2026-09-10

### Added

- Strict schema-v3 per-ticket records with atomically persisted reviewed and
  finalization SHAs.
- Exact-SHA direct finalization for both squash and merge strategies using
  `merge-tree`/`commit-tree`, normal base pushes, remote verification, and
  preflighted cleanup.
- Read-only startup detection for legacy inflight files and malformed/v1/v2
  ticket records.
- Detached, disposable AI-review worktrees pinned to fresh `origin/task` HEADs,
  with main-checkout integrity verification.
- Durable Story creation journals, deterministic child markers, paginated
  sub-Issue/Project reconciliation, and crash-safe per-field progress.
- A shared non-interactive process runner with fixed Git/`gh` deadlines and
  process-tree termination; Telegram requests now have a 15-second deadline.
- Linux/Windows Node 22.19.0 CI, isolated auto-discovered regression suites,
  and canonical `typecheck`, `test`, and `check` package scripts.
- Failure-matrix tests for finalization, Story side effects, process timeouts,
  review isolation, card identity, unsupported state, and mention replay.

### Changed

- New task branches are named `task/issue-<issue-number>` and start from the
  configured base branch.
- AI Review PASS persists the first fresh post-claim task SHA before moving the
  card to `Done`. Human Issue closure remains the integration signal. With AI
  review disabled, manual validation plus `Done` and closure approves the fresh
  matching local/remote SHA; any prior AI approval remains binding.
- GitHub Project cards retain their content type and comment author association.
  Only target-repository Issues with exact `Story`/`Task` Type enter mutation
  lanes.
- Project ownership is separate from origin repository ownership.
- Mention replies are disabled by default and, when enabled, accept only
  `OWNER`, `MEMBER`, or `COLLABORATOR` mentions from non-bot authors. Cursors
  bootstrap without replay and advance only after successful handling.
- Story and Needs Design scheduling rotates fairly and skips waiting items;
  each lane performs at most one agent/side-effect action per tick.
- The clean-worktree gate ignores only Board Agent runtime paths, not source or
  user configuration changes.
- Closed Done Task finalization no longer claims the Issue or creates a missing
  worktree. Every blocked state leaves the card in `Done` and preserves
  recovery artifacts.

### Removed

- Legacy inflight runtime support and automatic v1/v2 ticket-record upgrades.
- Plan-branch creation/merge helpers and dead PR-open/find orchestration.
- Configuration keys `pr`, `builder_tier`, `branches.plan_prefix`, and
  `watchdog.interval_seconds`.
- Bundled-dependency metadata for `pi-dynamic-workflows`.
- Dockerfile, Compose, entrypoint, `.dockerignore`, and daemon/container
  documentation.

### Security

- Added post-claim and post-agent identity revalidation before builder, Task
  design, Story, review, and finalization mutations.
- Pull requests, DraftIssues, cross-repository Issues, and untyped/mistyped
  Project items now cause zero mutation.
- Review agents have no main-checkout fallback, and mention reply agents receive
  an empty tool allowlist.
- SHA drift, dirty/missing/unregistered/locked worktrees, merge conflicts, push
  rejection, and cleanup drift fail closed. Retry journals cannot be overwritten
  by a builder or substituted with a different result tree/parent history.
- Windows Job Objects and POSIX process groups enforce subprocess deadlines;
  Windows requires PowerShell `Add-Type`/PInvoke permission.
- Watchdog ticks are serialized and drained on stop. CI fixes use detached
  worktrees, recheck admissions before host-controlled pushes, and retain
  failures for manual recovery.

### Migration

0.2.0 does not mutate unsupported pre-0.2.0 state. Stop Board Agent, back up
`.pi/board-agent/`, worktrees, and refs, finish or preserve old active work,
then manually remove/migrate every path reported by startup or
`/board-agent lint`. Remove all deleted configuration keys before running.
See [`docs/runbook.md`](docs/runbook.md).

## [0.1.1] - 2026-06-22

### Added

- Initial GitHub Project polling loop and commands.
- Plan-grouped builder workflows, assignee claims, local inflight files, Task
  worktrees, plan pull requests, configuration, and offline tests.
