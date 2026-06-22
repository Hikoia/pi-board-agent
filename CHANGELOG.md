# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-22

### Added

- Initial release.
- `/board-agent run` command — autonomous polling loop that picks `Ready`
  cards from a GitHub Project (v2), dispatches parallel builder agents
  via pi-dynamic-workflows with `isolation: "worktree"`, and monitors
  the board until all cards are resolved.
- `/board-agent status` — live board snapshot with column counts, per-plan
  progress, and loop statistics.
- `/board-agent stop` — graceful shutdown: releases assignee mutexes,
  clears inflight lockfiles, posts "stopped mid-flight" comments.
- `/board-agent init` — scaffold a `.pi/board-agent.yml` config from the
  template.
- `/board-agent lint` — pre-flight checks: config validity, `gh` auth,
  project existence, Status/Plan field presence.
- `skills/board-agent/SKILL.md` — builder agent procedure: worktree →
  task branch → implement → conventional commit → push → merge into plan
  branch → return JSON outcome.
- `agents/board-agent-builder.md` — agentType for pi-dynamic-workflows
  with board-agent skill and git + gh tools pre-bound.
- Plan-level PR batching: when all cards in a plan reach the `Done`
  column, a single PR `plan/<slug>` → `main` is opened via `gh pr create`,
  with optional reviewers (`config.pr.reviewers`) and labels.
- Safety rails: assignee mutex (atomic claim via `gh issue edit
  --add-assignee`), local inflight lockfiles, orphan scan, dirty-worktree
  guard, stuck-building guard.
- Configurable concurrency (`max_workers`: 1–16), polling interval
  (`tick_seconds`), task merge strategy (`squash` / `merge`), tier routing
  (`builder_tier`), per-agent timeout (`builder_timeout_ms`), retries
  (`builder_retries`).
- Offline test runner: mocks `gh` + `git`, validates polling logic,
  card-claim round-trip, plan-summary computation, PR-opening flow, and
  inflight file lifecycle.