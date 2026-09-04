# Local SHA deployment runbook

Board Agent is deployed from one global Pi package checkout. Project-local package overrides are not used. Pi remains a foreground process; this runbook does not create a daemon or container.

## Invariants

- `~/.pi/agent/settings.json` contains exactly one `Hikoia/pi-board-agent` package entry pinned to a full 40-character Git SHA.
- `.pi/settings.json` in each managed project has no Board Agent entry.
- `~/.pi/agent/git/github.com/Hikoia/pi-board-agent` is a deployment artifact. Do not edit it, switch branches in it, or use it as a development worktree.
- Never delete dirty ticket worktrees, branches, legacy inflight files, or persistent ticket records to make rollout pass. Let the executor reconcile them; ambiguous or dirty state belongs in `Needs Human`.

## Release and rollout

1. Run `bash tests/run-offline.sh` in an isolated development worktree. Commit the complete release and record its full commit as `RELEASE_SHA`.
2. In every project, run `/board-agent status`. Wait for active builders to settle, up to the configured `builder_timeout_ms`. If one times out, record its branch, HEAD, dirty file list, and worktree path; preserve it for recovery.
3. Record a pre-rollout snapshot of card status, assignees, `.pi/board-agent/inflight`, `.pi/board-agent/ticket-worktrees`, and `git worktree list`.
4. After no old-main builder is active, gracefully stop every foreground Pi session with `/board-agent stop`, then exit the sessions.
5. Update and reconcile the sole global package pin:

   ```bash
   pi install git:github.com/Hikoia/pi-board-agent@<RELEASE_SHA>
   ```

   **Do not run `pi update --extensions` while settings still pin `daab28d`; it will reconcile the deployment cache back to that old revision.** Update the pin first.
6. Verify the deployment checkout before restarting Pi:

   ```bash
   pi list
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent rev-parse HEAD
   git -C ~/.pi/agent/git/github.com/Hikoia/pi-board-agent status --porcelain
   ```

   `pi list` and `HEAD` must show `RELEASE_SHA`, and status must be empty. Confirm each project still has no Board Agent entry in `.pi/settings.json`.
7. Start exactly one Pi session in each project. `auto_start: true` starts the loop; do not start a second owner process for the same project.
8. Allow startup reconciliation to adopt or resume persistent runs. A structurally valid dirty worktree remains owned by its ticket and may be handed to the next builder without a previous active run ID; quarantine unregistered, mismatched, legacy, or uncertain state. An item must never have two active runs.
9. Verify the fleet:

   ```bash
   node scripts/verify-board-agent-fleet.mjs D:\Project\JobSkill D:\Project\makestocksgreatagain
   ```

   Every project must print `OK` and the command must exit 0. `STALE`, `OVERRIDE`, `DIRTY`, `MISMATCH`, or `STOPPED` requires correction and a Pi process restart before new work is admitted.

The heartbeat limit is `max(3 × tick_seconds, 300 seconds)`. `/board-agent status` shows the expected, loaded, and on-disk revisions, PID, runtime state, and active persistent runs.
