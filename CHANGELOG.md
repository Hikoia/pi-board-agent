# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
