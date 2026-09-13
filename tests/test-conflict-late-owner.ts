import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTicketExecutionRecord } from "../src/ticket-worktree.js";
import { fixture, git } from "./conflict-handoff-fixture.js";

for (const owner of ["branch", "path"] as const)
for (const target of ["comment", "ready", "reopen"] as const) {
  const f = await fixture();
  const recordDir = join(f.repo, ".pi/board-agent/ticket-worktrees");
  const recordFile = join(recordDir, `${f.card.itemId.toLowerCase()}.json`);
  const duplicate = { ...f.record, itemId: `OTHER_${f.card.itemId}`, issueNumber: 999,
    taskBranch: owner === "branch" ? f.record.taskBranch : "task/issue-999",
    path: owner === "path" ? f.record.path : join(f.repo, ".pi/worktrees/ticket-issue-999-other"),
  };
  assert.ok(isTicketExecutionRecord(duplicate), "otherwise valid v3 record, not a corruption test");
  const duplicateFile = join(recordDir, `${duplicate.itemId.toLowerCase()}.json`);
  const originalBytes = readFileSync(recordFile), refs = git(f.origin, "show-ref");
  let injected = false, lastCard: unknown, priorEvents: string[] = [];
  f.setHook((event) => {
    if (injected || event !== "read:card") return;
    const dir = join(f.repo, ".pi/board-agent/repair");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    if (files.length !== 1) return;
    const h = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    // This read follows the last awaited Git/strict cleanup inventory and is
    // immediately before the first write of this phase, not its confirmation.
    if (h.step !== target || h.attempted) return;
    lastCard = structuredClone(f.card); priorEvents = [...f.events];
    writeFileSync(duplicateFile, JSON.stringify(duplicate, null, 2));
    injected = true;
  });
  try {
    await f.loop.tickNow();
    assert.ok(injected, `${owner}/${target}: must reach last fresh getCard before mutation`);
    assert.deepEqual(f.events, priorEvents, `${owner}/${target}: no comment/status/reopen after a late duplicate owner`);
    assert.deepEqual(f.card, lastCard);
    assert.equal(f.calls(), 0); assert.equal(f.runs().length, 0);
    assert.deepEqual(readFileSync(recordFile), originalBytes);
    assert.equal(readFileSync(duplicateFile, "utf8"), JSON.stringify(duplicate, null, 2));
    assert.equal(git(f.origin, "show-ref"), refs);
    assert.equal(git(f.record.path, "rev-parse", "HEAD"), f.taskSha);
    assert.equal(existsSync(f.record.path), true);
    assert.ok(f.notices.some((s) => /another.*record owner/.test(s)), f.notices.join("\n"));
    console.log(`PASS: late valid duplicate ${owner} owner at final ${target} card read blocks mutation/builder and preserves both records and Git`);
  } finally { await f.loop.stop(); }
}
