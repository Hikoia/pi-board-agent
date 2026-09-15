import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, settle } from "./conflict-handoff-fixture.js";

const f = await fixture();
f.cfg.task_merge_strategy = "merge";
let reviews = 0;
f.setBuilder(async (prompt) => {
  assert.ok(prompt.includes(f.card.body));
  assert.ok(prompt.includes(f.baseSha));
  assert.ok(prompt.includes(f.taskSha));
  assert.ok(prompt.includes("MERGE_HEAD"));
  assert.ok(!prompt.includes("BOARD_AGENT_REPAIR_TEST"));
  if (f.calls() === 1) {
    assert.throws(() => git(f.record.path, "merge", "--no-edit", f.baseSha));
    assert.equal(git(f.record.path, "rev-parse", "MERGE_HEAD"), f.baseSha);
    return { taskKey: f.task.taskKey, itemId: f.task.itemId, status: "failure", error: "Interrupted conflict resolution; useful merge retained." };
  }
  assert.equal(git(f.record.path, "rev-parse", "MERGE_HEAD"), f.baseSha);
  assert.ok(git(f.record.path, "ls-files", "--unmerged"));
  writeFileSync(join(f.record.path, "value.json"), '{"task":true,"base":true}\n');
  git(f.record.path, "add", "value.json");
  git(f.record.path, "commit", "-m", "resolve both original requirements");
  const output = execFileSync(process.execPath, ["test.cjs"], { cwd: f.record.path, encoding: "utf8" });
  assert.match(output, /PASS both original requirements/);
  git(f.record.path, "push", "origin", f.record.taskBranch);
  return { taskKey: f.task.taskKey, itemId: f.task.itemId, status: "success", branch: f.task.taskBranch, summary: output.trim() };
});
f.setReview(async (input) => {
  reviews++;
  const taskSha = git(f.record.path, "rev-parse", "HEAD");
  assert.equal(input.taskSha, taskSha);
  assert.equal(git(f.record.path, "merge-base", "--is-ancestor", f.baseSha, taskSha), "");
  assert.equal(git(f.record.path, "merge-base", "--is-ancestor", f.taskSha, taskSha), "");
  return { verdict: "pass", taskSha, summary: "Both requirements and existing regression tests preserved.", findings: [] };
});
try {
  await f.loop.tickNow();
  assert.equal(f.card.closed, false);
  assert.equal(f.card.status, f.cfg.columns.ready);
  assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "build");
  assert.equal(f.calls(), 0, "no conflict settlement and builder in one tick");
  assert.equal(existsSync(join(f.repo, ".pi", "board-agent", "repair")), false);
  assert.ok(f.comments[0].body.includes("NEW manual close"));
  f.card.status = f.cfg.columns.done; f.card.closed = true;
  assert.equal((await f.executor.finalizeClosed(f.card)).status, "blocked", "manual Done/close cannot skip the outstanding builder");
  f.card.status = f.cfg.columns.ready; f.card.closed = false;
  await f.loop.tickNow(); await settle(f);
  const firstRun = f.runs()[0];
  const script = firstRun.script, args = JSON.stringify(firstRun.args);
  assert.equal((firstRun.args as any).repair, undefined);
  await f.loop.tickNow();
  assert.equal(f.calls(), 1, "terminal failure settlement cannot relaunch this tick");
  assert.equal(f.card.status, f.cfg.columns.ready);
  assert.equal(git(f.record.path, "rev-parse", "MERGE_HEAD"), f.baseSha);
  await f.loop.tickNow(); await settle(f);
  assert.equal(f.calls(), 2);
  assert.equal(f.runs().find((r) => r.runId === firstRun.runId)!.script, script);
  assert.equal(JSON.stringify(f.runs().find((r) => r.runId === firstRun.runId)!.args), args);
  await f.loop.tickNow();
  assert.equal(f.card.status, f.cfg.columns.review, f.notices.join("\n") + "\n" + JSON.stringify(f.runs().map((r) => ({ status: r.status, error: r.error, result: r.result })))); assert.equal(reviews, 0);
  assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "review", "successful build still requires an independent verdict");
  f.card.status = f.cfg.columns.done; f.card.closed = true;
  assert.equal((await f.executor.finalizeClosed(f.card)).status, "blocked", "manual Done/close cannot skip the outstanding review");
  f.card.status = f.cfg.columns.review; f.card.closed = false;
  await f.loop.tickNow();
  assert.equal(reviews, 1); assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.card.closed, false);
  assert.equal(git(f.repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], f.baseSha);
  assert.ok(existsSync(f.record.path));
  assert.equal(readFileSync(join(f.record.path, "value.json"), "utf8"), '{"task":true,"base":true}\n');
  await f.loop.tickNow();
  assert.equal(f.calls(), 2); assert.equal(reviews, 1); assert.equal(f.card.closed, false);
  console.log("PASS: real conflict reopens Ready; same original dirty MERGE_HEAD survives ordinary builder failure/retry; independent pinned Review reaches open Done and waits for NEW manual close");
  // Existing finalizer only; T004 owns replacement of Git integration/cleanup.
  f.card.closed = true;
  await f.loop.tickNow();
  assert.equal(f.calls(), 2); assert.equal(reviews, 1);
  assert.equal(existsSync(f.record.path), false);
  assert.equal(git(f.repo, "ls-remote", "origin", `refs/heads/${f.record.taskBranch}`), "");
  assert.equal(f.store.read(f.card.itemId), undefined);
  console.log("PASS: renewed manual close alone invokes existing finalizer; no new repair ledger or tool-history proof is written");
} finally { await f.loop.stop(); }
