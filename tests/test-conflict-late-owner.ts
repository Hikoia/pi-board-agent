import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTicketExecutionRecordV5 } from "../src/ticket-worktree.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";
import { fixture, git } from "./conflict-handoff-fixture.js";

for (const owner of ["branch", "path"] as const)
for (const target of ["comment", "reopen", "ready"] as const) {
  const f = await fixture();
  const recordFile = f.store.recordPath(f.task.itemId);
  const duplicate = { ...f.store.read(f.task.itemId)!, itemId: `OTHER_${f.task.itemId}`, issueNumber: 999,
    taskBranch: owner === "branch" ? f.record.taskBranch : "task/issue-999",
    path: owner === "path" ? f.record.path : join(f.repo, ".pi/worktrees/ticket-issue-999-other"),
  };
  assert.ok(isTicketExecutionRecordV5(duplicate));
  const duplicateFile = f.store.recordPath(duplicate.itemId), refs = git(f.origin, "show-ref");
  let injected = false, beforeEvents: string[] = [], beforeRecord = Buffer.alloc(0);
  f.setHook((event) => {
    if (injected || event !== "read:card" || !pendingTicketWrite(f.store.read(f.task.itemId)!)) return;
    if (target === "reopen" && !f.comments.length || target === "ready" && f.card.closed) return;
    beforeEvents = [...f.events]; beforeRecord = readFileSync(recordFile);
    writeFileSync(duplicateFile, JSON.stringify(duplicate)); injected = true;
  });
  try {
    await f.loop.tickNow(); assert.ok(injected, `${owner}/${target}`);
    assert.deepEqual(f.events, beforeEvents, "late duplicate ownership cannot authorize the next settlement mutation");
    assert.deepEqual(readFileSync(recordFile), beforeRecord);
    assert.equal(f.calls(), 0); assert.equal(git(f.origin, "show-ref"), refs);
    assert.equal(existsSync(f.record.path), true); assert.ok(existsSync(duplicateFile));
    console.log(`PASS: late duplicate ${owner} ownership before conflict ${target} preserves both records and prevents further writes`);
  } finally { await f.loop.stop(); }
}
