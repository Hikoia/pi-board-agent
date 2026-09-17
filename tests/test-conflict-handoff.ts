import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, settle } from "./conflict-handoff-fixture.js";

const f = await fixture();
try {
  const body = f.card.body;
  await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.ready, f.notices.join("\n"));
  assert.equal(
    f.card.closed,
    false,
    "confirmed conflict automatically reopens for repair",
  );
  assert.equal(f.card.body, body, "original requirements never rewritten");
  assert.equal(
    f.comments.length,
    1,
    "one bot-authored request comment, edited in place",
  );
  assert.equal(f.comments[0].author, "bot");
  assert.match(f.comments[0].body, /"phase":"queued"/);
  assert.deepEqual(f.events, [
    "request-comment",
    `status:${f.cfg.columns.ready}`,
    "reopen",
    "queue-comment",
  ]);
  assert.equal(f.calls(), 0, "closed snapshot cannot launch a builder");
  await f.loop.tickNow();
  await settle(f);
  const runs = f.runs();
  assert.equal(runs.length, 1);
  assert.equal(f.calls(), 1);
  assert.deepEqual(
    { ...(runs[0].args as any).repair, requestKey: "bound" },
    { requestKey: "bound", baseSha: f.baseSha, taskSha: f.taskSha },
  );
  assert.ok(
    f.comments[0].body.includes((runs[0].args as any).repair.requestKey),
  );
  await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.needs_human);
  for (let i = 0; i < 3; i++) await f.loop.tickNow();
  assert.equal(f.calls(), 1, "failed repair never automatically retries Ready");
  assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
  console.log(
    "PASS: real conflict durably requests -> Ready -> reopen -> queued -> one existing repair run -> Needs Human without automatic retry",
  );
} finally {
  await f.loop.stop();
}

{
  const f = await fixture();
  try {
    f.card.type = "Story";
    assert.equal((await f.executor.finalizeClosed(f.card)).status, "conflict");
    assert.deepEqual(f.events, []);
    assert.equal(f.calls(), 0);
    assert.equal(f.card.closed, true);
    assert.equal(f.card.status, f.cfg.columns.done);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
    console.log(
      "PASS: non-Task base conflict stays closed Done even with a production-capable repair adapter",
    );
  } finally {
    await f.loop.stop();
  }
}

{
  const f = await fixture();
  try {
    f.setHook((event) => {
      if (event === "before:request-comment")
        throw new Error("ambiguous request write");
    });
    assert.equal((await f.executor.finalizeClosed(f.card)).status, "blocked");
    const dir = join(f.repo, ".pi/board-agent/repair");
    const path = join(dir, readdirSync(dir)[0]);
    const ledger = readFileSync(path),
      record = f.store.read(f.card.itemId);
    git(f.repo, "push", "origin", "--delete", f.task.taskBranch);
    git(
      f.repo,
      "update-ref",
      "-d",
      `refs/heads/${f.task.taskBranch}`,
      f.taskSha,
    );
    f.setHook(() => {});
    for (let i = 0; i < 2; i++) {
      await f.loop.tickNow();
      assert.equal(f.card.status, f.cfg.columns.done);
      assert.equal(f.card.closed, true);
      assert.deepEqual(readFileSync(path), ledger);
      assert.deepEqual(f.store.read(f.card.itemId), record);
    }
    assert.equal(f.calls(), 0);
    assert.equal(
      f.events.some((event) => event === `status:${f.cfg.columns.backlog}`),
      false,
    );
    console.log(
      "PASS: pending ambiguous repair handoff survives absent refs; historical Backlog shortcut never hides it",
    );
  } finally {
    await f.loop.stop();
  }
}
