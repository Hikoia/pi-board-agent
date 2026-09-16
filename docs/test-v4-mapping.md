# T006 retained-test mapping (repository only)

This is an assertion migration inventory, **not a passing-run certificate**.
T006 evidence records the exact checked commits, commands, outcomes and limits;
T007 still owns independent final acceptance. `tests/run-offline.sh` discovery
is unchanged. Historical audits and T003/T004 main-added safety tests are not
removed. A v4 stage/record assertion replaces only the retired protocol detail,
not the protected state, ownership, I/O or concurrency behavior.

## Ported in place (including preserved T003/T004 ports)

| Files under `tests/` | Old implementation detail replaced | Retained current assertions |
| --- | --- | --- |
| `test-conflict-handoff.ts` | requested/queued/consumed repair ledger | Ready/build conflict recovery; fresh branch/base; unique claim; original dirty worktree; real WorkflowManager launch/persistence/pause/cold resume; mandatory review and renewed close |
| `test-conflict-handoff-cuts.ts` | ledger writes after each board await | comment/reopen/status/release fault cuts; pending I/O and re-observation without model launch or false Ready |
| `test-conflict-settlement-cuts.ts` | repair evidence marker settlement | clean and dirty successful build outcomes; failed Review/release writes retain association/capacity; restart settles without replaying model |
| `test-conflict-base-advance.ts` | ledger base/request rebinding | before-launch base advance, actual conflicts after approval, already-integrated task, original branch/path; renewed review/close for build retry |
| `test-conflict-authority.ts`, `test-conflict-late-owner.ts`, `test-conflict-notices.ts` | repair-specific diagnostic keys | before/after fresh identity, lane, repository, Type, contract, assignment and duplicate branch/path ownership; authentic bot comment reconciliation; never overwrite human withdrawal |
| `test-repair-executor.ts` | admission latch assumed the launch slot was already reserved at every call | New post-ensure checkpoint sees zero slots; actual-start checkpoint sees exactly the original one. Both await orders, stop/revision veto, real review, same-run dirty recovery and MERGE_HEAD survive; unreachable test gates now fail explicitly rather than exit with an unsettled await. |
| `test-conflict-capacity.ts`, `test-conflict-launch-cuts.ts` | technical failures entering Needs Human; consumed launch quarantine | A sibling may take its later Ready/build retry without overlapping or duplicating the conflict run; zero journal matches retain the original launch window and occupied capacity across repeated ticks, never guessed safe-to-relaunch. |
| `test-conflict-success.ts` | required `testEvidence` marker | pushed clean task and ordinary successful result without mandatory telemetry; review/close/merge cleanup E2E; missing marker is no longer itself a failure |
| `test-conflict-legacy.ts`, `test-conflict-legacy-cuts.ts` | generating new repair ledgers during legacy conflict recovery | real owner-held v3 conversion; old sources read-only; current build-stage retry; rewritten/unknown base and local/remote task/path drift fail closed |
| `test-cleanup-boundaries.ts` | receipts as new finalization transaction | atomic pre-push integration publication; lost/rejected push observation; fault cuts in remote/worktree/local/Done/record order; locks, dirty work, ref movement; no new snapshots/force/prune |
| `test-cleanup-safety.ts` | snapshot/backup as permission to delete changed work | dirty tracked/untracked programs and ownership block normal v4 deletion; symlink escapes remain untouched; only existing old receipt evidence allows legacy residual removal; no inferred backup |
| `test-cleanup-receipts.ts` | creating/GC-ing receipts on every new merge | existing historical receipt/backup snapshots only, no rewrite/GC; changed unregistered content and ownership block; ignored-only content is explicitly discardable by native Git removal |
| `test-cleanup-windows-lock.ts` | receipt creation before Windows cleanup | real PowerShell `FileShare.None` lock blocks Windows normal removal; original bytes/integration retained; after unlock, normal cleanup only if Git retained registration; otherwise restart retains exact residual bytes/ref/progress for manual inspection with no inferred ownership/snapshot/fallback; non-Windows skip is explicit |
| `test-closed-done-refs.ts` | old result/ref shape; no preflight fetch after vanished local ref | reviewed v4 records; local-ref inventory is negative-only; absent refs with pending integration/retry still recover; failed inventory and fresh identity never authorize guessed cleanup; vanished local ref permits exactly one fresh base fetch but no integration/ref/path mutation |
| `test-finalization-notices.ts` | old merge/repair receipt diagnostics | durable integration retry and per-await comment/status/release failures; fresh-card checks, owner/path guards, deduplication, closed approval retained |
| `test-ticket-executor.ts` | Needs Human for every terminal failure; v3 result fields; cosmetic unused squash fixture input | v4 stages, actual Needs Human decisions, conservative occupancy, run/launch recovery, original dirty work, pending settlement and deferred cleanup record deletion; legacy squash configuration actually loads/normalizes before merge-only assertions |
| `test-merge-conflict.ts` | conflict returned without ordinary writeback; missing mandatory review SHA in fixture | Real stdout-only merge conflict classification, valid tree versus error/timeout/malformed output, exact task/base SHAs, preserved refs/work/record and no integration. Loop writeback and renewed approval moved to `test-conflict-handoff.ts`/`test-conflict-success.ts`, not removed. |
| `test-async-ticket-callers.ts` | inline hot-update check during actual start | stop during awaited ensure releases a matching claim, **no manager and no comment** (original assertion preserved); explicit later finalization works without losing approval |
| `test-builder-actual-start.ts`, `test-runtime-revision.ts` | filesystem/package polling on every admission/status | cached startup/lint revision admission/latch; actual-start stop and fresh board/capacity checks remain; explicit lint mismatch blocks admission; real lock contenders may conservatively reject transient partial publication, but exactly one owns and every loser preserves that live PID/token-safe release |

The fixtures build historical snapshots only when a test needs **pre-existing**
legacy evidence. `legacy-cleanup-fixture.ts` routes through the real exclusive
owner-held adapter. No production path creates those snapshots or receipts.

## Retired runnable files (three, and only these)

| Retired file | Why its feature assertion is obsolete | Current safety replacement |
| --- | --- | --- |
| `test-conflict-consumed-args.ts` | New builders no longer have a consumed repair ledger or mandatory repair argument hash. Recreating that protocol solely for a test is prohibited. | Original run ID/script/args/dirty MERGE_HEAD and real cold resume: `test-legacy-ticket-migration.ts`; normal launch/run ownership and unknown journal occupancy: `test-ticket-executor.ts`, `test-builder-actual-start.ts`; no new repair argument: ported `test-conflict-handoff.ts`/`test-conflict-success.ts`. Legacy `args.repair` hash equality itself is intentionally retired, not relabeled as covered. |
| `test-conflict-review-corruption.ts` | New reviews do not parse a repair success/evidence marker. Marker shape/corruption cases no longer gate review. | Malformed ordinary outcomes: `test-core.ts`; unchanged pinned SHA and fresh record/identity/claim checks: `test-review-admission.ts`, `test-card-identity.ts`; corruption of retained old migration sources/atomic publication: `test-legacy-ticket-migration.ts`, `test-legacy-migration-atomic.ts`. |
| `test-conflict-review-evidence.ts` | Successful repair no longer requires a custom `testEvidence` object or tool-telemetry marker. Tests are required by the builder mission and assessed by review/humans, not another transport schema. | Successful ordinary result without that marker still requires pushed/clean original branch, review and renewed close: `test-conflict-success.ts`; failure and malformed/decision output remain fail-closed in `test-core.ts`, `test-ticket-retries.ts`. |

## Preserved independent safety coverage

- Lifecycle/stop/startup/lease/lock tests: `test-loop-lifecycle.ts`,
  `test-workflow-shutdown.ts`, `test-runtime-revision.ts`,
  `test-stop-lifecycle.ts`, `test-conflict-cold-recovery.ts`,
  `test-builder-actual-start.ts`, `test-loop-capacity.ts`.
- Git/path/deadline safety: `test-ticket-finalization.ts`,
  `test-finalization-boundaries.ts`, `test-finalization-intent.ts`,
  `test-cleanup-symlinks.ts`, `test-merge-conflict.ts`,
  `test-clean-gate.ts`, `test-review-isolation.ts`,
  `test-process-runner.ts`, `test-process-diagnostics.ts`.
- Main-added v4/config/migration coverage: `test-ticket-store.ts`,
  `test-finalization-intent.ts`, `test-ticket-retries.ts`,
  `test-task-only.ts`, `test-task-config.ts`,
  `test-ticket-retries.ts`,
  `test-legacy-ticket-migration.ts`, `test-legacy-migration-atomic.ts`,
  `test-legacy-finalization.ts`, `test-unsupported-state.ts`.
- Runtime hot-path behavior: `test-runtime-hot-paths.ts` asserts repeated ticks,
  heartbeat/status/stop and actual admission do not scan package Git identity;
  startup and explicit lint still do. This does **not** remove live ticket,
  capacity, process deadline or ownership checks.

Offline tests use local bare remotes/fake board and model adapters. They do not
certify live GitHub permissions, real-model behavior or deployment merge/push
policy. Windows lock/process-tree assertions require a Windows run; a Linux
platform skip is not equivalent coverage.
