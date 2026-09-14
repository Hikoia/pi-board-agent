import assert from "node:assert/strict";
import { fixture, settle, advanceBase } from "./conflict-handoff-fixture.js";

for (const target of [
  "request-comment",
  "status:Ready",
  "reopen",
  "queue-comment",
  "consume-comment",
  "status:In Progress",
  "claim",
])
  for (const edge of ["before", "after"] as const) {
    const f = await fixture();
    let cut = false;
    f.setHook((event) => {
      if (!cut && event === `${edge}:${target}`) {
        cut = true;
        if (!f.card.closed) advanceBase(f);
        throw new Error(`offline cut ${event}`);
      }
    });
    try {
      for (let i = 0; i < 3 && !cut; i++)
        await f.loop.tickNow().catch(() => {});
      assert.ok(cut, target);
      await f.loop.stop();
      f.setHook(() => {});
      const next = f.make();
      try {
        await next.loop.tickNow();
        if (f.calls()) await settle(f);
        await next.loop.tickNow();
        assert.ok(f.calls() <= 1, `${edge}:${target}: unique invocation`);
        assert.ok(f.runs().length <= 1, "at most one durable run");
        assert.equal(
          f.events.filter((e) => e === "request-comment").length,
          1,
          "never replay a nonidempotent request create, even after ambiguous absence",
        );
        assert.equal(
          f.comments.filter((c) =>
            c.body.startsWith("<!-- board-agent-conflict-repair:"),
          ).length,
          target === "request-comment" && edge === "before" ? 0 : 1,
        );
        if (
          [
            "request-comment",
            "status:Ready",
            "reopen",
            "queue-comment",
            "consume-comment",
          ].includes(target) &&
          edge === "before"
        ) {
          assert.equal(
            f.calls(),
            0,
            "unconfirmed attempted transition blocks, never ordinary Ready work",
          );
          assert.equal(
            f.events.filter((e) => e === target).length,
            1,
            "unconfirmed write not blindly replayed",
          );
        } else if (
          target === "consume-comment" ||
          target === "status:In Progress"
        ) {
          assert.equal(f.calls(), 0);
          assert.equal(
            f.card.status,
            f.cfg.columns.needs_human,
            f.notices.join("\n"),
          );
        } else {
          assert.equal(
            f.calls(),
            1,
            `${edge}:${target}: confirmed state resumes into one bound run\n${f.notices.join("\n")}`,
          );
          assert.equal(f.card.closed, false);
          assert.equal(f.card.status, f.cfg.columns.needs_human);
          const repair = (f.runs()[0].args as any).repair;
          assert.ok(repair?.requestKey.startsWith("conflict-"));
          assert.equal(repair.baseSha, f.baseSha);
          assert.equal(repair.taskSha, f.taskSha);
        }
        for (const event of ["reopen", "queue-comment", "consume-comment"])
          assert.ok(
            f.events.filter((e) => e === event).length <= 1,
            `never repeat ${event}`,
          );
        console.log(
          `PASS: ${edge} ${target} fault/restart with main advancing when open confirms state or blocks, never duplicates marker/run or falls back to ordinary builder`,
        );
      } finally {
        await next.loop.stop();
      }
    } finally {
      await f.loop.stop();
    }
  }

for (const target of ["read:comments", "read:card"]) {
  const f = await fixture();
  let fail = false;
  f.setHook((event) => {
    if (event === "after:reopen") {
      advanceBase(f);
      fail = true;
    }
    if (fail && event === target) throw new Error("read outcome unavailable");
  });
  try {
    await f.loop.tickNow();
    assert.equal(f.card.closed, false);
    assert.equal(f.card.status, f.cfg.columns.ready);
    assert.equal(f.calls(), 0);
    await f.loop.stop();
    f.setHook(() => {});
    const next = f.make();
    try {
      await next.loop.tickNow();
      await settle(f);
      await next.loop.tickNow();
      assert.equal(f.calls(), 1);
      assert.equal(f.runs().length, 1);
      assert.equal(f.events.filter((e) => e === "reopen").length, 1);
      assert.equal(f.events.filter((e) => e === "request-comment").length, 1);
      console.log(
        `PASS: ${target} ambiguity at open Ready blocks ordinary work, then confirms the same handoff after restart`,
      );
    } finally {
      await next.loop.stop();
    }
  } finally {
    await f.loop.stop();
  }
}
