import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, dispose, TicketWorktrees } from "./cleanup-fixture.js";
const { BoardLoop, createLoopState } = await import("../src/loop.js");
try {
  const f = await integrationFixture(), warnings: string[] = [];
  const restart = () => new BoardLoop({ cwd: f.repo, cfg: f.cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo",
    meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, listCards: async () => [structuredClone(f.card)],
    callback: (m, level) => { if (level === "warn") warnings.push(m); } }, createLoopState(), f.executor(), new TicketWorktrees(f.repo));
  let loop = restart(), reason = "fetch offline";
  faults.beforeGit = (a) => { if (a[0] === "fetch") throw new Error(reason); };
  try {
    calls.length = 0;
    await loop.tickNow(); await loop.tickNow(); await loop.tickNow();
    assert.equal(calls.filter((a) => a[0] === "fetch").length, 3);
    assert.equal(warnings.length, 1); assert.equal(f.comments.length, 1);
    assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.ready);
    assert.equal(f.tip(), f.base); assert.ok(existsSync(f.record.path));
    reason = "fetch permission denied"; await loop.tickNow(); await loop.tickNow();
    assert.equal(warnings.length, 2); assert.equal(f.comments.length, 2);
    reason = "fetch offline"; await loop.tickNow(); assert.equal(warnings.length, 3); assert.equal(f.comments.length, 2);
    console.log("PASS: integration retries EVERY tick in closed Ready; unchanged failures warn/comment once, changed or returning failures warn again without a model");
    f.card.status = f.cfg.columns.needs_human; await loop.tickNow();
    f.card.status = f.cfg.columns.ready; await loop.tickNow(); assert.equal(warnings.length, 4);
    await loop.stop(); loop = restart(); await loop.tickNow(); assert.equal(warnings.length, 5);
    assert.equal(f.comments.length, 2);
    console.log("PASS: human lane withdrawal is preserved and clears transient notices; new loop warns afresh but observes old diagnostic comments without duplication");
    faults.beforeGit = undefined;
    await loop.tickNow(); assert.equal(existsSync(f.recordFile), false, f.notices.join("\n"));
    assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.card.closed, true);
    const result = f.tip(); calls.length = 0; await loop.tickNow();
    assert.equal(f.tip(), result); assert.ok(!calls.some((a) => ["merge-tree", "commit-tree", "push"].includes(a[0])));
    console.log("PASS: successful cleanup returns Project Done, deletes record last and does not become recurring historical work");
  } finally { faults.beforeGit = undefined; await loop.stop(); }
} finally { dispose(); }
