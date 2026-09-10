# 0.2.0 rollout and recovery runbook

Board Agent runs inside a foreground Pi process. It is installed from one
reviewed, full Git SHA; there is no Docker/daemon deployment in 0.2.0.

## Invariants

- The effective Pi package entry is pinned to a 40-character SHA.
- The loaded module SHA, package checkout HEAD, and configured SHA are equal.
- The package checkout is clean and is never used for development.
- Exactly one owner process controls a target checkout.
- Windows requires PowerShell FullLanguage with `Add-Type`/PInvoke allowed;
  constrained hosts fail closed rather than losing subprocess containment.
- Issue mutations target only the repository from `origin`; `project.owner`
  controls Project GraphQL access only.
- Never delete dirty worktrees, branches, journals, or records merely to clear a
  warning.

## Back up before upgrading from 0.1.x

Stop every owner first:

```text
/board-agent status
/board-agent stop
```

From the target repository, record and copy all recovery evidence:

```bash
git status --porcelain=v1 --untracked-files=all
git worktree list --porcelain
git branch -avv
mkdir -p ../board-agent-backup
cp -a .pi/board-agent ../board-agent-backup/state
cp -a .pi/worktrees ../board-agent-backup/worktrees
git bundle create ../board-agent-backup/refs.bundle --all
```

On PowerShell:

```powershell
git status --porcelain=v1 --untracked-files=all
git worktree list --porcelain
git branch -avv
New-Item -ItemType Directory -Force ..\board-agent-backup | Out-Null
Copy-Item -Recurse -Force .pi\board-agent ..\board-agent-backup\state
Copy-Item -Recurse -Force .pi\worktrees ..\board-agent-backup\worktrees
git bundle create ..\board-agent-backup\refs.bundle --all
```

Use a new backup directory each time; skip only paths that do not exist. The
bundle saves committed refs, not dirty or untracked files: retain the worktree
copy as well. Copy any worktrees located outside `.pi/worktrees` separately.

Also save the Project item status, Issue number, assignees, Plan, Type, task
branch, worktree path, and HEAD for every active ticket.

### Unsupported state policy

0.2.0 deliberately has no automatic migration for:

- `.pi/board-agent/inflight/*.json`;
- malformed ticket records; or
- ticket records with schema version 1 or 2.

Startup, `/board-agent lint`, and `/board-agent run` list every unsupported path
and stop before GitHub mutation. They do not archive, rename, overwrite, or
delete anything.

After backing up, finish or manually preserve the old task work. Only then
remove/migrate the listed files. A valid 0.2.0 ticket record must be schema v3;
do not change the version number without reconstructing and verifying every
field and Git ref.

Remove these obsolete keys from `.pi/board-agent.yml`:

```text
pr
builder_tier
branches.plan_prefix
watchdog.interval_seconds
```

Use `models.builder`, `branches.base`, `branches.task_prefix`, and the main
`tick_seconds` scheduler instead. `pi-dynamic-workflows` is installed as a
normal dependency, not bundled.

## Release checklist

In a clean development clone or isolated worktree:

```bash
npm ci
npm run check
npm pack --dry-run
```

Confirm:

- package and lockfile versions are `0.2.0`;
- Node engine is `>=22.19.0`;
- the tarball contains `src/`, `skills/`, `agents/`, and
  `config-template.yml`, but no Docker files or bundled dependency metadata;
- Linux and Windows CI use exact Node `22.19.0` and run
  `npm ci && npm run check`;
- `git status --short` contains only intended release changes.

Commit and push the complete release. Record the immutable commit:

```bash
RELEASE_SHA=$(git rev-parse HEAD)
test "${#RELEASE_SHA}" -eq 40
```

## Rollout

1. Stop active owners and wait for `/board-agent stop` to settle managers.
2. Take the backup above.
3. Install the reviewed SHA:

   ```bash
   pi install "git:github.com/Hikoia/pi-board-agent@$RELEASE_SHA"
   ```

4. Restart Pi. Verify the deployment artifact:

   ```bash
   pi list
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent rev-parse HEAD
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent status --porcelain
   ```

   HEAD must equal `RELEASE_SHA`; status must be empty.

5. In each target repository:

   ```text
   /board-agent lint
   /board-agent status
   /board-agent run
   ```

6. Let startup reconciliation finish before moving new cards to `Ready`.
7. If managing several projects, run:

   ```bash
   node scripts/verify-board-agent-fleet.mjs <project-path> [more-paths...]
   ```

   `STALE`, `OVERRIDE`, `DIRTY`, `MISMATCH`, or `STOPPED` requires correction
   and a Pi restart before new work is admitted.

## State locations

```text
.pi/board-agent/owner.lock
.pi/board-agent/owner.lock.reclaim  # present only during stale-owner takeover
.pi/board-agent/runtime.json
.pi/board-agent/context.md
.pi/board-agent/refine-state.json
.pi/board-agent/watchdog-state.json
.pi/board-agent/ticket-worktrees/<safe-project-item-id>.json
.pi/worktrees/ticket-*/
.pi/worktrees/review-*/
.pi/worktrees/watchdog-*/
```

WorkflowManager journals are in Pi's workflow project storage, keyed by the
persistent ticket worktree path. Use `/board-agent status` and the record's
`activeRunId` before touching them.

## Recovery matrix

| Message / state | Automation behavior | Required human action |
| --- | --- | --- |
| `Unsupported pre-0.2.0 Board Agent state detected` | Startup/lint/run stop read-only | Stop Pi, back up the listed paths and refs, finish/preserve old work, then remove or deliberately migrate each listed artifact. |
| `In Progress` without a valid v3 record | That card moves to `Needs Human`; siblings continue | Inspect Issue history and branches. Restore a verified record/worktree from backup or restart intentionally from `Ready`. |
| Missing WorkflowManager run or mismatched persisted args | Stops/quarantines only that ticket | Preserve the worktree, inspect the run journal and record, then move to `Ready` only when ownership and intended diff are known. |
| Dirty completed worktree / wrong branch / unmanaged path | Fails closed to `Needs Human` | Do not reset automatically. Inspect and commit/push valid ticket work, or discard it explicitly; restore the expected registered branch/path before retry. |
| Usage-limit pause | Remains paused for the scheduler | Wait or repair provider access. Do not create a second run. |
| `AI review failed ... Leaving in Review` | Card stays `Review`; no reviewed SHA or Done transition | Fix fetch/auth/agent/cleanup failure. The next tick retries in a new detached worktree. |
| Main checkout changed during isolated review | Review fails and ephemeral cleanup is attempted | Inspect the main checkout immediately; preserve unexpected changes and restore its prior branch/HEAD/status before retry. |
| AI review enabled but no persisted reviewed task SHA | Closed Done finalization is blocked | Reopen the Issue, move the Task to `Review` (or `Ready` if rebuilding), and obtain a fresh PASS. With AI review disabled, manual validation plus `Done` and Issue closure approves the matching fresh local/remote SHA instead. Existing reviewed SHAs remain binding in either mode. |
| `origin/task/... moved after review` | No merge or cleanup | If movement was unauthorized, restore the exact reviewed SHA. Otherwise reopen the Issue, move to `Ready`, rebuild/review the new SHA, validate, then close again. |
| Base/task moved after the finalization journal was written | No push or cleanup; new builders cannot overwrite pending intent | Restore the journaled identities, or follow **Abandoning an unpushed finalization** below. Moving to `Ready` alone does not clear the journal. |
| Dirty, missing, unregistered, or locked finalization worktree | Card remains closed and `Done`; artifacts stay | For a lock, verify no process uses it and run `git worktree unlock <path>`. For a missing registration, restore the exact branch at the recorded path with `git worktree add <path> <task-branch>` and verify HEAD equals `reviewedTaskSha`. Dirty changes require a new review. |
| Merge conflict / unrelated history | No result is pushed | Reopen the Issue and resolve on the task branch in its retained worktree, push, run review again, validate, and close. |
| Push rejected | Journal retains `resultSha`; worktree/refs remain | Repair credentials or branch protection for a normal non-force base push. The next tick retries the same result SHA after revalidation. |
| Cleanup drift/failure after base integration | Result remains on base; record and remaining artifacts are retained | Do not merge again. Restore the task ref to the journaled SHA or remove the external lock, then let the next tick retry guarded cleanup. |
| `Story creation needs human input` | Creation journal and completed children remain; Story moves to `Needs Human` | Fix auth, Project fields, duplicate marker ambiguity, or incorrect item identity. Move the Story to `Ready`; it resumes without rerunning refinement or duplicating children. |
| Story/Task in `Needs Design` | Waits without consuming untrusted comments | Reply as repository OWNER/MEMBER/COLLABORATOR after the latest authentic question/gate. |
| Story create/add/comment attempted but result unconfirmed | Keeps attempt markers and refuses blind repetition | Inspect paginated sub-Issues, Project items, and bot comments. Restore/adopt the intended remote result where possible. Clear an attempt marker only while stopped, after backup and positive confirmation that the operation did not take effect. |
| CI fix stopped / unresolved prior CI fix worktree | Retains `.pi/worktrees/watchdog-<pr>-*`; does not start a replacement | Inspect and preserve dirty files/commits, compare the PR remote SHA, then explicitly remove only the resolved watchdog worktree. Do not force-delete unresolved work. |
| Git/`gh` timeout | Process tree is terminated; durable state remains at the last completed boundary | Repair network/credentials. Retry normally; Story/finalization reconciliation handles ambiguous remote side effects. |
| Owner lock held | A second owner refuses to start | Use the existing process. Reclaim only a provably dead same-host pid; a different-host lock requires coordination. |
| `owner.lock.reclaim` remains after interruption | Stale takeover fails closed | Stop/coordinate every owner and contender, back up both lock files, verify no takeover is active, then remove only the stale reclaim file. Never clear a live or foreign-host owner by guessing. |
| Could not pause workflow runs during stop | Owner lock remains held | Inspect the named managers/leases; stop the owning Pi process deliberately if necessary before any takeover. A stopped heartbeat is not proof that shutdown succeeded. |

## Manual verification before retry

For a ticket record, compare all immutable identities:

```bash
git -C <repo> worktree list --porcelain
git -C <worktree> status --porcelain=v1
git -C <worktree> branch --show-current
git -C <worktree> rev-parse HEAD
git -C <repo> ls-remote origin refs/heads/<task-branch> refs/heads/<base>
```

Before finalization, the worktree HEAD, local task ref, remote task ref, and
journal `taskSha` must agree. A stored `reviewedTaskSha` must also agree; it is
mandatory when AI review is enabled. Never force-push the base as a recovery
shortcut.

### Abandoning an unpushed finalization

Stop the owner and back up the record, worktree, and refs first. Fetch the base
and inspect the journal's `resultSha` and remote history. If that result is
integrated, resume guarded cleanup instead of rebuilding or merging again.
If its push/integration status cannot be established, preserve the journal.

Only after proving the intent was not integrated may an operator remove the
`finalization` member from the backed-up v3 record, preserving all other
identity fields and artifacts. Reopen the Issue and move it to `Ready` for a
new build/approval cycle. Never perform this edit while an owner is running.

## Clean-clone smoke test

After the release commit is pushed:

```bash
tmp=$(mktemp -d)
git clone https://github.com/Hikoia/pi-board-agent.git "$tmp/pi-board-agent"
git -C "$tmp/pi-board-agent" checkout "$RELEASE_SHA"
cd "$tmp/pi-board-agent"
npm ci
npm run check
npm pack --dry-run
export PI_CODING_AGENT_DIR="$tmp/pi-agent" # isolate settings and package clones
pi install "git:github.com/Hikoia/pi-board-agent@$RELEASE_SHA"
```

Start the smoke Pi session with that same environment, run `/board-agent init`
in a disposable repository, and confirm the generated file equals the packaged
template. `/board-agent lint` should reject the template's unset
`project.number`; configure a disposable Project only for deliberate live
validation. Do not use production settings, credentials, or Projects.
