import assert from "node:assert/strict";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "../src/gh.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";
import { fixture, git } from "./conflict-handoff-fixture.js";

{
  const f = await fixture();
  let reads = 0, commentReads = 0, reason = "offline handoff comments unavailable";
  f.setHook((event) => {
    if (event === "read:card") reads++;
    if (event === "read:comments") { commentReads++; throw new Error(reason); }
  });
  const tick = async (warnings: number) => {
    const before = { reads, commentReads, warnings: f.warnings.length };
    await f.loop.tickNow();
    assert.ok(reads > before.reads, "every tick freshly reads the card");
    assert.ok(commentReads > before.commentReads, "every tick retries handoff confirmation");
    assert.equal(f.warnings.length - before.warnings, warnings, f.notices.join("\n"));
    assert.ok(f.warnings.every((w) => w.source === "loop"), "executor returns blocking outcomes; only loop warns");
    assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0); assert.deepEqual(f.events, []);
  };
  try {
    const refs = git(f.origin, "show-ref");
    await tick(1); await tick(0); await tick(0);
    assert.deepEqual(f.store.read(f.card.itemId), f.record);
    assert.equal(git(f.origin, "show-ref"), refs);
    console.log("PASS: three real ticks retry an unchanged handoff blocker but warn once in the loop, not the executor or alternating wrappers");

    reason = "offline handoff permission denied";
    await tick(1); await tick(0);
    reason = "offline handoff comments unavailable";
    await tick(1); await tick(0);
    await f.loop.stop(); Object.assign(f, f.make());
    await tick(1); await tick(0);
    console.log("PASS: changed/returning handoff reasons and a new loop lifetime warn again without suppressing fresh retries");

    const eligible = structuredClone(f.card);
    for (const patch of [
      { status: f.cfg.columns.needs_human }, { closed: false }, { type: "Story" },
      { repoOwner: "other" }, { number: undefined }, { contentType: "PullRequest" },
    ] satisfies Partial<Card>[]) {
      Object.assign(f.card, patch); await tick(0);
      Object.assign(f.card, eligible); await tick(1); await tick(0);
    }
    f.cards.length = 0;
    const before = f.warnings.length;
    await f.loop.tickNow(); assert.equal(f.warnings.length, before);
    f.cards.push(f.card); await tick(1); await tick(0);
    console.log("PASS: irrelevant handoff entries are pruned for changed lane/open/type/repository/identity and absent tickets");

    const other = { ...f.card, itemId: "HANDOFF_OTHER", number: f.card.number! + 100 };
    const task = buildTasksForWave(f.cfg, "demo", [other])[0];
    const record = await f.store.ensure(task, "demo");
    assert.equal(git(record.path, "status", "--porcelain"), "");
    git(record.path, "reset", "--hard", f.taskSha); // this test's disposable, clean worktree only
    git(record.path, "push", "origin", task.taskBranch);
    f.cards.push(other);
    await tick(1); await tick(0);
    assert.match(f.warnings.at(-1)!.message, /HANDOFF_OTHER/);
    console.log("PASS: two tickets with identical handoff SHAs/reasons have independent loop blocker fingerprints");
  } finally { await f.loop.stop(); }
}

{
  const f = await fixture(); let recover = false, reads = 0;
  f.setHook((event) => {
    if (event === "read:comments" && (++reads === 1 || !recover))
      throw new Error("offline handoff comments unavailable");
  });
  try {
    await f.loop.tickNow(); assert.equal(f.warnings.length, 1);
    recover = true; reads = 0;
    // Reconcile still fails once, but the real finalizer's subsequent fresh
    // retry completes the entire handoff in this same tick.
    await f.loop.tickNow();
    assert.equal(f.card.closed, false); assert.equal(f.card.status, f.cfg.columns.ready);
    assert.match(f.comments[0].body, /"phase":"queued"/);
    assert.equal(f.warnings.length, 1); assert.equal(f.calls(), 0);
    recover = false; reads = 0;
    await f.loop.tickNow(); await f.loop.tickNow();
    assert.equal(f.warnings.length, 2, "successful same-tick handoff clears its earlier blocker before an identical new failure");
    assert.equal(f.warnings[0].message, f.warnings[1].message);
    assert.ok(f.warnings.every((w) => w.source === "loop"));
    assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
    console.log("PASS: a successful fresh handoff retry in the same tick clears the reconcile blocker before the identical later failure");
  } finally { await f.loop.stop(); }
}

for (const state of ["closed Ready", "open Ready"] as const)
for (const boundary of ["comments", "card"] as const) {
  const f = await fixture(); let reads = 0, commentReads = 0;
  f.setHook((event) => {
    if (event === "read:card") reads++;
    if (event === "read:comments") commentReads++;
    if (event === `read:${boundary}` && (state === "closed Ready" ? f.card.status === f.cfg.columns.ready : !f.card.closed))
      throw new Error("offline handoff confirmation unavailable");
  });
  try {
    for (let tick = 0; tick < 3; tick++) {
      const before = { reads, commentReads };
      await f.loop.tickNow();
      assert.ok(reads > before.reads); assert.ok(commentReads > before.commentReads);
      assert.equal(f.warnings.length, 1, f.notices.join("\n"));
      assert.equal(f.warnings[0].source, "loop");
      assert.equal(f.card.status, f.cfg.columns.ready);
      assert.equal(f.card.closed, state === "closed Ready");
    }
    assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
    assert.deepEqual(f.events, ["request-comment", `status:${f.cfg.columns.ready}`, ...(state === "open Ready" ? ["reopen"] : [])]);
    console.log(`PASS: interrupted ${state} ${boundary} reads retry on three ticks with one warning across finalizer/reconcile/Ready wrappers and no repeated write/builder`);
  } finally { await f.loop.stop(); }
}

{
  const f = await fixture();
  try {
    await f.loop.tickNow();
    const dir = join(f.repo, ".pi/board-agent/repair");
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    let commentsRead = 0;
    f.setHook((event) => { if (event === "read:comments") commentsRead++; });
    const before = f.events.length;
    for (let tick = 1; tick <= 3; tick++) {
      await f.loop.tickNow();
      assert.equal(commentsRead, tick, "Ready-only marker authorization is refreshed every tick");
      assert.equal(f.warnings.length, 1, f.notices.join("\n"));
    }
    assert.equal(f.warnings[0].source, "loop");
    assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
    assert.equal(f.events.length, before);
    console.log("PASS: Ready-only unrecognized authentic marker warns once over three real retries with no ordinary builder fallback");

    // Recovery really succeeds at the Ready authorization seam; a later human
    // lane change at launch's fresh read prevents ordinary work on this tick.
    const marker = f.comments.pop()!; let authorized = false;
    f.setHook((event) => {
      if (event === "read:comments") authorized = true;
      if (event === "read:card" && authorized) f.card.status = f.cfg.columns.needs_human;
    });
    await f.loop.tickNow();
    assert.ok(authorized); assert.equal(f.card.status, f.cfg.columns.needs_human);
    assert.equal(f.warnings.length, 1); assert.equal(f.calls(), 0); assert.equal(f.events.length, before);
    f.setHook(() => {}); f.card.status = f.cfg.columns.ready; f.comments.push(marker);
    await f.loop.tickNow(); await f.loop.tickNow();
    assert.equal(f.warnings.length, 2); assert.equal(f.warnings[0].message, f.warnings[1].message);
    console.log("PASS: recovered Ready authorization clears the blocker so the identical later failure warns anew");
  } finally { await f.loop.stop(); }
}

{
  const f = await fixture(); let reads = 0;
  f.setHook((event) => {
    // Reconcile, finalizer approval, then handoff's final fresh card read.
    // Fail before a ledger exists so the next real conflict has today's SHAs.
    if (event === "read:card" && ++reads === 3) throw new Error("handoff fresh card unavailable");
  });
  const tick = async (warnings: number) => {
    reads = 0; await f.loop.tickNow();
    assert.equal(reads, 3); assert.equal(f.warnings.length, warnings, f.notices.join("\n"));
    assert.ok(f.warnings.every((w) => w.source === "loop"));
  };
  try {
    const file = join(f.repo, ".pi/board-agent/ticket-worktrees", `${f.card.itemId.toLowerCase()}.json`);
    const bytes = readFileSync(file);
    await tick(1); await tick(1);
    git(f.repo, "commit", "--allow-empty", "-m", "new base, same conflict"); git(f.repo, "push", "origin", "main");
    await tick(2); await tick(2);
    git(f.record.path, "commit", "--allow-empty", "-m", "new task, same conflict"); git(f.record.path, "push", "origin", f.task.taskBranch);
    await tick(3); await tick(3);
    assert.equal(new Set(f.warnings.map((w) => w.message)).size, 1, "reason/wording unchanged; only actual SHAs changed");
    assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0); assert.deepEqual(f.events, []);
    assert.deepEqual(readFileSync(file), bytes);
    console.log("PASS: advancing either real conflict SHA warns again even when the handoff blocker reason is identical");
  } finally { await f.loop.stop(); }
}
