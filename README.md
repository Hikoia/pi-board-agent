# pi-board-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev/)

A durable GitHub Project (v2) executor for [Pi](https://pi.dev/). Move a **Task
Issue** to `Ready`; Board Agent builds it in a persistent worktree, independently
reviews the pushed SHA, and waits for your validation before integration.

## Workflow

```text
Ready → In Progress → AI Review (configured Review lane)
      → Done, Issue OPEN, task worktree retained
      → user validates and manually closes the Issue
      → ordinary two-parent merge / normal push to branches.base
      → verified remote integration / safe task cleanup
```

AI review is always enabled. Plan is optional read-only grouping: neither a
Plan field nor a value is required. There is no Story refinement, Task design,
PR watchdog, or `init-project` command. Only Task Issues in the configured
`origin` repository enter execution; PRs, drafts, cross-repository Issues,
Stories and untyped cards are not mutated.

Technical failures retry through `Ready`, using one of `build`, `review`,
`integrate`, or `cleanup`. Only a genuine missing product, requirements, cost
or authorization decision with a concrete question, context, feasible options
and recommendation goes to `Needs Human`. A trusted maintainer reply alone
**does not resume work**: manually move the card to `Ready` too.

## Requirements and setup

- Node.js `>=22.19.0`, Pi `>=0.80.8`, Git, and authenticated `gh` with Project scope.
- Windows: PowerShell FullLanguage with `Add-Type`/PInvoke permitted for
  deadline-enforced process Job Objects.
- Project single-select Status options matching configured `Ready`,
  `In Progress`, `Review`, `Done`, `Needs Human`; a single-select type field
  (default name `Kind`) with `Task`. Backlog is a manual hold, not a requirement.
- The bot must be able to push the task branch, **normally push the configured
  base**, and delete the integrated remote task ref. The base must permit merge
  commits. PR-only/linear-history/protected-base policies may prevent this
  workflow; confirm permissions and protections before deployment. Board Agent
  does not change them or force-push the base.

```bash
pi install git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>
gh auth refresh -s project
# Restart Pi after installing/changing the pin.
```

This is a Git-only package, not an npm publication. Install a reviewed immutable
SHA, not a branch, tag or abbreviated SHA. In the target repository:

```text
/board-agent init
# Edit .pi/board-agent.yml: project.number and matching field/lane names.
/board-agent lint
/board-agent run
```

Project access uses `project.owner`; Issue identity comes from `origin`.
Preflight reads existing Project metadata and never creates fields/options.

## Configuration

[`config-template.yml`](config-template.yml) is the full annotated schema.
Project `.pi/board-agent.yml` overrides `~/.pi/board-agent.yml` defaults.

```yaml
project:
  owner: "" # defaults to the origin repository owner
  number: 12
status_field: "Status"
type_field: "Kind"
plan_field: "Plan" # optional grouping, never an admission requirement
branches:
  base: "main"
  task_prefix: "task/" # task/issue-<number>
task_merge_strategy: "merge"
max_workers: 2
tick_seconds: 90
builder_timeout_ms: 21600000
builder_retries: 1
models:
  builder: "deepseek-v4-flash-0731"
  review: "deepseek-v4-flash-0731"
review:
  timeout_ms: 600000
safety:
  require_clean_worktree: true
auto_start: false
```

Configured builder/reviewer models, timeouts, retries, context digest,
notifications and provider backoff remain in use. Counts/timers must be finite
safe integers within supported bounds.

Narrow compatibility normalization warns by source file without rewriting it:
old refine/watchdog/model keys are ignored; `review.enabled` is ignored (review
always runs); `squash` becomes `merge` for new integrations. The retired
`columns.needs_design` name remains migration provenance only.
`safety.skip_closed_issues` warns for either boolean; closed Issues never start
builders/review. Unrelated unknown keys and invalid types remain errors. See
[the runbook](docs/runbook.md#configuration-and-project-preflight).

## Runtime and scheduling

Package SHA/settings/clean-checkout coherence is checked at **startup, explicit
run/promotion, lint and deployment verification**, not on heartbeat, UI refresh,
ticks or ordinary builder/reviewer admission. Runtime status shows the last
startup/lint observation, not a live package scan. Installation identity is
immutable; a detected mismatch requires a new Pi process and prevents new
admissions. Do not update package files or configuration under an active owner.

`max_workers` is a shared budget for builders plus one foreground AI reviewer.
Launching, pending, paused, missing/unreadable and unsettled associated runs
occupy slots; a terminal journal is not drain/release proof. Widget observations
never authorize execution. Each tick reconciles owned work and closed-Done
finalization first, reserves a review slot if available, pre-fills other slots
with Ready builders, reviews, then back-fills. A ticket is not retried twice in
the same tick.

Live owner, stop, capacity, fresh ticket identity/requirements/sole claim, and
exact execution checks still apply after awaited preparation and immediately
before model invocation. Existing owned runs and approved finalization can
recover while new admissions are disabled. A dirty host checkout blocks new
work, not recovery. Ready Tasks must be independently implementable and
verifiable from the available base; worker count and task numbering are not
dependency scheduling. Hold dependencies in Backlog until integrated.

## Retries, review and integration

- Continue the original branch/worktree, including partial dirty work and
  `MERGE_HEAD`. Do not reset/stash/discard it to make a retry start.
- Builder failures and actionable review findings retry `build`. Review
  execution/tool/timeout failures retry `review` at the original successful
  build SHA, not a second builder.
- Comment/status/reopen/release settlement is persisted before I/O. Retry that
  I/O before invoking models; drain the previous run before releasing its slot.
  Failed GitHub writes are reported locally, never treated as successful Ready.
  Fresh human identity/lane/claim changes are preserved, not classified as failure.
- Review runs in an owned detached worktree, verifies the exact pushed build
  SHA, and leaves the Issue **open** in Done on pass. Validate the retained task
  worktree, then manually close. Outstanding build/review obligations cannot be
  bypassed by manually moving to Done and closing.
- After closure, merge-tree/commit-tree prepares a normal two-parent merge
  without editing the main checkout. If task history is already integrated,
  no extra merge is needed. Persisted integration intent is **not push success**:
  a fresh fetch must prove the result is an ancestor of `origin/base`.
- A verified conflict comments, reopens and returns to Ready. The ordinary
  builder merges base into the same task, resolves both sides and tests, then
  returns through Review and open Done. **Validate and close again.**
- A lost push response first observes remote outcome. Once integrated, retry
  only cleanup; do not rebuild/review/remerge. Cleanup failure keeps the Issue
  **closed** (approval retained) while the Project retries via Ready.

Normal integration does not itself run a blanket post-merge test suite. Review
and human validation assess relevant tests; they are not proof against every
later base change.

## Cleanup and stopped upgrades

After freshly verifying remote integration, cleanup deletes the remote task ref
with its expected SHA, uses normal `git worktree remove`, deletes the local ref
with its expected SHA, observes Project Done, then removes the ticket record.
Missing refs/path are normal retry input. The record survives unfinished cleanup
and final Project I/O.

Ignored-only native preclean (`git clean -fdX`) happens **while registration and
ownership still exist**, before remote-ref deletion; this avoids losing Windows
registration on an ignored locked-file removal failure. Remaining ignored links
may be unlinked nonrecursively, never followed into their targets. Tracked or
non-ignored dirty files, Git/worktree locks, nested repositories, external paths,
changed refs and unknown remnants prevent unsafe cleanup. No force-worktree
removal, prune, unlock or recursive fallback is used for managed ticket cleanup.
New work emits no cleanup snapshots, receipts or repair ledgers.

Upgrade only after **all owners have successfully stopped and drained**. Back
up records, worktrees (including dirty/untracked/ignored files), refs and external
WorkflowManager journals first. Restart Pi after installation; `/reload` is not
an upgrade procedure.

The stopped-owner legacy adapter converts supported v3 tickets to the existing
atomic v4 store, creating `<record>.json.v3.bak` with the **exact original bytes**
(create-only) before publication. Active/paused/launch-window runs retain their
run ID, script, args and worktree. Old recorded merge/squash results are adopted,
not newly squashed. Old receipts/ledgers/backups remain read-only and are never
automatically garbage-collected. Unregistered legacy residual cleanup needs
existing positive ownership and unchanged evidence; unknown data is preserved.
Malformed/v1/v2 evidence is not guessed; unhealthy tickets are isolated from
healthy work. Old Story/watchdog state stays untouched; already-created Tasks
continue. Legacy Task Needs Design maps to Needs Human with the question retained.

See [architecture](docs/architecture.md) and the [rollout/recovery
runbook](docs/runbook.md) for boundaries and operator steps.

## Commands

| Command | Purpose |
| --- | --- |
| `/board-agent init` | Create the packaged config template if absent |
| `/board-agent lint` | Check revision, state, config, auth and Project metadata |
| `/board-agent run` | Start or explicitly promote an eligible recovery loop |
| `/board-agent status` | Board/runtime/execution observations; no package scan |
| `/board-agent stop` | Close admissions, cancel foreground work, drain/pause, release owner only after successful cleanup |
| `/board-agent context` | Generate the host digest; new builders use their own worktree digest |

Concurrent/reentrant stop and shutdown requests share a completion barrier.
Failed drains retain the loop, managers and owner for a later stop retry. Stop
waits for already-started destructive Git rather than cancelling it or unlocking
early. Successful stop, lint, then a new loop are required after config/schema
changes; cached recovery promotion does not replace its configuration snapshot.

## Development and verification

```bash
npm ci
npm run typecheck
bash tests/run-offline.sh tests/test-runtime-revision.ts tests/test-runtime-hot-paths.ts
npm run check # full offline suite
```

The offline runner isolates credentials/state and uses disposable local bare
origins for pushes. Run native Git suites serially. CI is configured for exact
Node `22.19.0` on Linux and Windows; that configuration is not a claim of a
completed deployment or live GitHub validation. Release validation and normal
base-push permissions must be confirmed separately.

## License

MIT © Alessandro Mancini. See [LICENSE](LICENSE).
