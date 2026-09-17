# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Task-only model execution: optional Plan and isolated exact-SHA AI review.
  Human-closed Done Issues of any Type finalize without review-marker prerequisites
  and move to Backlog. Local-only, remote-only and divergent task refs are supported;
  no-ref history preserves idle records and leftovers.
- One v4 ticket record retains build/review/integrate/cleanup retry stages and
  pre-push integration progress. Dirty partial work and interrupted MERGE_HEAD
  continue on the original task branch/worktree. I/O failures retry I/O, not models.
- Only complete product/requirement/cost/authorization decisions enter Needs Human.
  Trusted maintainer reply **and manual Ready** are required; no comment listener.
- Real conflicts reopen Ready for original-branch resolution, tests, review and
  renewed human close. Nonconflicting base-advance push rejection stays
  integration-only; ambiguous push responses require fresh remote observation.
- Ordered cleanup verifies integration, expected remote deletion, normal worktree
  removal, expected local deletion, Project Backlog and record deletion last.
  Ignored task-worktree files are cleaned before ref/registration removal; nested
  repositories and external junction targets remain protected.
- Exclusive stopped/drained owner upgrade converts supported v3 Tasks without
  finishing all tasks first. Exact raw backup precedes atomic v4 publication;
  active/paused/uncertain original runs and existing old merge/squash results
  continue conservatively. Old ledgers and v1/v2 cleanup receipts, including
  recordless receipts, remain read-only without GC.
- Finite removed lane config warns without rewriting files or Project schema.
  Legacy squash normalizes to merge and review cannot be disabled. Unknown keys,
  invalid input and unsupported v1/v2/corrupt data still fail closed.
- Package/config consistency checks are startup/lint/deployment-only. Heartbeat,
  UI, stop and ordinary admission reuse the checked identity/latch without package
  HEAD/status/settings scans. Hot update is unsupported; restart after upgrade.

### Fixed

- Stop during asynchronous worktree preparation no longer creates a manager or
  posts a false builder-failure comment. Reentrant stop, foreground/lease drain,
  owner retention after failure and startup-stop generation barriers remain.
- Conflict writeback rechecks duplicate branch/path ownership after board awaits.
  Production conflict recovery can claim an approved closed Issue for reopening
  without permitting closed builder admission.
- Legacy pre-result conversion rejects unknown/rewritten base history, changed
  task identity and unsafe original worktrees instead of guessing authority.
- Retained lifecycle, dirty/path/lock/ownership/recovery/retry/ref-safety tests are
  ported to v4; only the retired repair-evidence protocol tests are removed.

### Removed

- Story refinement/child publication, designer/Needs Design model and PR watchdog.
- New-path repair requested/queued/consumed ledgers, test-telemetry gates and
  full-tree cleanup snapshot/backup protocols. Existing legacy evidence remains
  readable only through the legacy adapter; unknown leftovers are not deleted.

Worker limits, configured builder/review models, timeouts, context, notifications,
WorkflowManager and provider backoff are retained. No force task cleanup, broad
prune/unlock, recursive-delete fallback or force base push is introduced.

Current behavior is in [architecture](docs/architecture.md) and the
[runbook](docs/runbook.md). Historical notes and audit reports below retain their
original baseline claims and are not current specifications.

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
