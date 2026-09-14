import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, advanceBase, git, settle, repairResult } from "./conflict-handoff-fixture.js";

for (const interruptedConsume of [false, true]) {
  const f = await fixture();
  f.setBuilder((prompt, options) => repairResult(f, prompt, options));
  try {
    await f.loop.tickNow();
    assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready);
    const commentId = f.comments[0].id;
    const { requestKey, baseSha, taskSha } = JSON.parse(f.comments[0].body.split("\n")[1]);
    const request = { requestKey, baseSha, taskSha };
    if (interruptedConsume) {
      f.setHook((event) => {
        if (event === "read:comments" && f.card.assignees.includes("bot")) f.setRevision(false);
      });
      await f.loop.tickNow();
      const pending = JSON.parse(readFileSync(join(f.repo, ".pi/board-agent/repair", `${requestKey}.json`), "utf8"));
      assert.equal(pending.step, "consume"); assert.equal(pending.attempted, false);
      assert.equal(f.events.includes("consume-comment"), false);
      assert.equal(f.runs().length, 0);
    }
    await f.loop.stop(); f.setHook(() => {}); f.setRevision(true);
    const advanced = advanceBase(f), next = f.make();
    try {
      await next.loop.tickNow();
      assert.equal(f.runs().length, 1, f.notices.join("\n"));
      await settle(f); await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.calls(), 1); assert.equal(f.runs().length, 1);
      assert.deepEqual((f.runs()[0].args as any).repair, request);
      assert.equal(f.comments[0].id, commentId); assert.match(f.comments[0].body, /"phase":"consumed"/);
      for (const event of ["request-comment", "reopen", "queue-comment", "consume-comment"])
        assert.equal(f.events.filter((e) => e === event).length, 1, event);
      assert.equal(f.store.read(f.card.itemId)?.path, f.record.path);
      assert.equal(f.store.read(f.card.itemId)?.schemaVersion, 3);
      assert.equal(f.card.status, f.cfg.columns.review, f.notices.join("\n"));
      assert.equal(f.card.closed, false); assert.ok(existsSync(f.record.path));
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), advanced, "repair never merges or closes itself");
      const result = git(f.record.path, "rev-parse", "HEAD");
      git(f.repo, "merge-base", "--is-ancestor", baseSha, result);
      assert.throws(() => git(f.repo, "merge-base", "--is-ancestor", advanced, result), "repair uses the designated base, not latest main");
      console.log(`PASS: ${interruptedConsume ? "unattempted consume" : "queued"} repair survives main fast-forward/restart with the same Issue/comment/request/SHAs/worktree and one run, then waits in open Review`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}

for (const event of ["request-comment", "status:Ready"]) {
  const f = await fixture(); let advanced = "";
  f.setHook((point) => { if (!advanced && point === `after:${event}`) advanced = advanceBase(f); });
  try {
    await f.loop.tickNow(); await f.loop.stop(); f.setHook(() => {});
    const next = f.make();
    try {
      await next.loop.tickNow();
      assert.ok(advanced); assert.equal(f.card.closed, true);
      assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
      assert.equal(f.events.filter((e) => e === "request-comment").length, 1);
      assert.equal(f.events.includes("reopen"), false);
      assert.ok(f.notices.some((s) => s.includes("Conflict base advanced before handoff")));
      console.log(`PASS: main advance at closed ${event} still blocks the original handoff before reopen across restart`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}

for (const mode of ["base-rewritten", "local-task", "remote-task", "claim", "identity", "author", "data"] as const) {
  const f = await fixture();
  try {
    await f.loop.tickNow(); await f.loop.stop();
    const dir = join(f.repo, ".pi/board-agent/repair"), names = readdirSync(dir);
    const original = JSON.parse(readFileSync(join(dir, names[0]), "utf8"));
    advanceBase(f);
    if (mode === "base-rewritten") git(f.origin, "update-ref", "refs/heads/main", f.originalBase);
    if (mode === "local-task") git(f.record.path, "commit", "--allow-empty", "-m", "human task edit");
    if (mode === "remote-task") {
      const moved = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.taskSha, "-m", "remote task edit");
      git(f.repo, "push", "origin", `${moved}:refs/heads/${f.task.taskBranch}`);
    }
    if (mode === "claim") f.card.assignees = ["maintainer"];
    if (mode === "identity") f.card.body += " human changed requirements";
    if (mode === "author") f.comments[0].author = "attacker";
    if (mode === "data") f.comments[0].body = f.comments[0].body.replace(f.baseSha, f.originalBase);
    const events = [...f.events], comments = structuredClone(f.comments), next = f.make();
    try {
      await next.loop.tickNow(); await next.loop.tickNow();
      assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
      if (["base-rewritten", "local-task", "remote-task"].includes(mode)) {
        assert.equal(f.card.status, f.cfg.columns.needs_human, "existing unsafe-worktree quarantine stays authoritative");
        assert.equal(f.events.includes("consume-comment"), false);
        assert.deepEqual(f.comments[0], comments[0], "quarantine preserves the original repair marker");
      } else {
        assert.deepEqual(f.events, events); assert.deepEqual(f.comments, comments);
      }
      assert.deepEqual(readdirSync(dir), names);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, names[0]), "utf8")).request, original.request);
      assert.ok(existsSync(f.record.path));
      console.log(`PASS: open queued ${mode} drift still blocks after main advance/restart, retaining the original request and worktree`);
    } finally { await next.loop.stop(); }
  } finally { await f.loop.stop(); }
}
