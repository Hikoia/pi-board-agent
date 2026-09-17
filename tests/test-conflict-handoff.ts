import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, settle } from "./conflict-handoff-fixture.js";

const f = await fixture();
try {
  const body = f.card.body;
  await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.ready);
  assert.equal(f.card.closed, false);
  assert.equal(f.card.body, body);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Merge conflict/);
  assert.deepEqual(f.events, [
    "claim",
    "ordinary-comment",
    "reopen",
    "status:Ready",
    "release",
  ]);
  assert.equal(
    f.calls(),
    0,
    "no immediate same-ticket retry in the conflict tick",
  );
  await f.loop.tickNow();
  await settle(f);
  const run = f.runs()[0];
  assert.equal(f.runs().length, 1);
  assert.equal((run.args as any).repair, undefined);
  await f.loop.tickNow();
  assert.equal(
    f.card.status,
    f.cfg.columns.ready,
    "technical failure retries build, never Needs Human",
  );
  assert.equal(f.calls(), 1, "settlement cannot relaunch on the same tick");
  assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "build");
  assert.equal(f.store.read(f.card.itemId)?.lastRunId, run.runId);
  assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
  assert.equal(existsSync(join(f.repo, ".pi/board-agent/repair")), false);
  console.log(
    "PASS: real conflict reopens Ready on original worktree; staged technical retry uses one normal builder without repair markers/ledgers or same-tick replay",
  );
} finally {
  await f.loop.stop();
}
