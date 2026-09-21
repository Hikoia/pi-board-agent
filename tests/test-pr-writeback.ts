// Recovery metadata remains authoritative after Git cleanup, before Backlog.
import assert from "node:assert/strict";
import { fixture, dispose } from "./finalization-fixture.js";
const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
const { noPullRequests } = await import("./pr-fixture.js");
try {
  {
    assert.throws(() => new ManagedTicketExecutor({ pullRequests: noPullRequests } as never), /owner/i);
    assert.throws(() => new ManagedTicketExecutor({ owner: {} } as never), /pull request|pullRequests/i);
    console.log("PASS: executor requires explicit owner and PR API injection before any operation; no live fallback");
  }
  for (const change of ["owner", "stop"] as const) {
    const f = await fixture(false, false), executor = f.make();
    f.card.closed = false; f.card.status = f.cfg.columns.ready;
    const original = f.recordNow(), claim = f.board.claim, release = f.board.release;
    const effects: string[] = [];
    f.board.release = async card => { effects.push("release"); await release(card); };
    f.board.claim = async card => {
      effects.push("claim");
      const claimed = await claim(card);
      f.card.status = f.cfg.columns.needs_human;
      if (change === "owner") f.owner.release(); else executor.stopScheduling();
      return claimed;
    };
    await executor.launch(structuredClone(f.card), "demo").catch(() => {});
    assert.deepEqual(effects, ["claim"], "lost authority after claim cannot authorize a late release");
    assert.deepEqual(f.recordNow(), original);
    assert.equal(f.card.status, f.cfg.columns.needs_human);
    assert.deepEqual(f.card.assignees, ["bot"]);
    assert.equal(f.starts(), 0);
    console.log(`PASS: ${change} loss across claim prevents late remote release or builder reservation`);
  }
  {
    const f = await fixture(false, false);
    assert.equal((await f.finish()).status, "waiting");
    f.prs.merge();
    let cleaned = false, replaced = false;
    const cleanup = f.store.cleanupMergedPullRequest.bind(f.store);
    f.store.cleanupMergedPullRequest = async (...args) => {
      const result = await cleanup(...args); cleaned = true; return result;
    };
    const remote = f.store.remoteSha.bind(f.store);
    f.store.remoteSha = async (...args) => {
      const result = await remote(...args);
      if (cleaned && !replaced) {
        replaced = true;
        const record = f.recordNow();
        f.store.updateV5(record, r => ({ ...r, retry: { stage: "cleanup", reason: "outside replacement during final observation" } }), f.owner, () => {});
      }
      return result;
    };
    const first = await f.make(undefined, f.store).finalizeClosed(structuredClone(f.card));
    assert.ok(replaced, `reach the post-cleanup remote observation, not an earlier guard: ${JSON.stringify(first)}`);
    assert.equal(first.status, "skipped");
    assert.equal(f.card.status, f.cfg.columns.done);
    assert.equal(f.recordNow().retry?.reason, "outside replacement during final observation");
    assert.equal(f.recordNow().integration?.kind, "pr");
    assert.equal((await f.make().finalizeClosed(structuredClone(f.card))).status, "finalized");
    assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(f.prs.calls.filter(op => op === "create").length, 1);
    console.log("PASS: changed recovery record after Git cleanup vetoes Backlog/deletion; fresh restart confirms the same PR proof and completes once");
  }
} finally { dispose(); }
