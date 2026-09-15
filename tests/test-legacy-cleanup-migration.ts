import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { fixture, git, calls, faults, dispose } from "./cleanup-fixture.js";
const { LegacyTickets } = await import("../src/legacy-tickets.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");

function adapter(f: Awaited<ReturnType<typeof fixture>>) {
  const card: Card = { itemId: f.task.itemId, number: f.task.issueNumber, title: f.task.title, body: f.task.body,
    contentType: "Issue", type: "Task", plan: "demo", status: _DEFAULTS.columns.done, closed: true, assignees: [], repoOwner: "owner", repoName: "repo" };
  return new LegacyTickets({ worktrees: f.store, cfg: structuredClone(_DEFAULTS), botLogin: "bot", repoOwner: "owner", repoName: "repo",
    board: { getCard: async () => card, setStatus: async () => assert.fail("cleanup adoption does not mutate the Issue/Project") } });
}
function noNewEvidence(f: Awaited<ReturnType<typeof fixture>>, receipts: string[], backups: string[]) {
  assert.deepEqual(readdirSync(join(f.repo, ".pi", "board-agent", "cleanup")), receipts);
  const dir = join(f.repo, ".pi", "board-agent", "cleanup-backups");
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], backups);
  assert.ok(!calls.some((args) => ["commit-tree", "push", "update-ref"].includes(args[0]) || (args[0] === "worktree" && args[1] === "remove")), "conversion only observes Git; no new result, push or deletion");
}
try {
  {
    const f = await fixture();
    const result = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base, "-m", "old squash result");
    f.store.update(f.task.itemId, (r) => ({ ...r, finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha, resultSha: result } }));
    const raw = readFileSync(f.recordFile), owner = acquireOwnerLock(f.repo, "bot");
    try {
      calls.length = 0;
      let report = await adapter(f).migrate(owner);
      assert.deepEqual(report.failures, []);
      assert.deepEqual(f.store.read(f.task.itemId)!.integration, { baseSha: f.base, taskSha: f.taskSha, resultSha: result });
      assert.equal(f.store.read(f.task.itemId)!.retry!.stage, "integrate", "recorded result is not proof it was pushed");
      noNewEvidence(f, [], []);
      // Second independent old-state observation: remote accepted this squash,
      // then advanced. Reuse the fixture's exact original v3 bytes, never guess.
      git(f.repo, "push", "origin", `${result}:refs/heads/main`);
      const advanced = git(f.repo, "commit-tree", `${result}^{tree}`, "-p", result, "-m", "base advanced");
      git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
      writeFileSync(f.recordFile, raw);
      calls.length = 0;
      report = await adapter(f).migrate(owner);
      assert.deepEqual(report.failures, []);
      assert.equal(f.store.read(f.task.itemId)!.integration!.resultSha, result);
      assert.equal(f.store.read(f.task.itemId)!.retry!.stage, "cleanup");
      assert.equal(f.tip(), advanced);
      noNewEvidence(f, [], []);
      assert.deepEqual(readFileSync(join(f.repo, ".pi", "board-agent", "legacy-v3", f.recordFile.split(/[\\/]/).at(-1)!)), raw);
      await assert.rejects(f.finish("squash"), /v4 finalization requires staged/);
      console.log("PASS: old squash result is adopted exactly; fresh remote observation distinguishes pending integration from cleanup even after base advances, without a new squash or snapshots");
    } finally { owner.release(); }
  }
  {
    const f = await fixture();
    faults.beforeGit = (args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        faults.beforeGit = undefined; f.vanish(); throw new Error("offline halfway cleanup");
      }
    };
    await assert.rejects(f.finish(), /halfway cleanup/);
    const raw = readFileSync(f.recordFile), receipt = readFileSync(f.receipt), result = f.tip();
    const unknown = join(f.record.path, "unknown.txt"); writeFileSync(unknown, "unknown program work\n");
    const owner = acquireOwnerLock(f.repo, "bot");
    try {
      calls.length = 0;
      const rejected = await adapter(f).migrate(owner);
      assert.equal(rejected.failures.length, 1);
      assert.match(rejected.failures[0].reason, /snapshot changed|added/i);
      assert.deepEqual(readFileSync(f.recordFile), raw);
      assert.deepEqual(readFileSync(f.receipt), receipt);
      assert.equal(readFileSync(unknown, "utf8"), "unknown program work\n");
      noNewEvidence(f, [f.receipt.split(/[\\/]/).at(-1)!], []);
      unlinkSync(unknown); // fixture removes only its deliberately injected unknown data
      calls.length = 0;
      const report = await adapter(f).migrate(owner);
      assert.deepEqual(report.failures, []);
      assert.equal(f.store.read(f.task.itemId)!.integration!.resultSha, result);
      assert.equal(f.store.read(f.task.itemId)!.retry!.stage, "cleanup");
      assert.equal(existsSync(f.record.path), true, "migration adopts, not recursively removes, known residuals");
      assert.equal(existsSync(join(f.record.path, ".git")), false);
      assert.equal(readFileSync(join(f.record.path, "feature.txt"), "utf8"), "feature\n");
      assert.deepEqual(readFileSync(f.receipt), receipt, "existing receipt stays byte-for-byte read-only");
      noNewEvidence(f, [f.receipt.split(/[\\/]/).at(-1)!], []);
      console.log("PASS: halfway unregistered cleanup adopts only existing unchanged receipt evidence; unknown added files isolate the ticket, with no deletions or new snapshot evidence");
    } finally { owner.release(); }
  }
  {
    const f = await fixture();
    faults.beforeFs = (operation, path) => { if (operation === "unlink" && path === f.receipt) throw new Error("offline last receipt unlink"); };
    await assert.rejects(f.finish(), /last receipt unlink/);
    faults.beforeFs = undefined;
    assert.equal(existsSync(f.recordFile), false);
    const receipt = readFileSync(f.receipt), owner = acquireOwnerLock(f.repo, "bot");
    try {
      calls.length = 0;
      const report = await adapter(f).migrate(owner);
      assert.deepEqual(report.failures, []);
      const record = f.store.read(f.task.itemId)!;
      assert.equal(record.schemaVersion, 4);
      assert.equal(record.retry!.stage, "cleanup");
      assert.equal(record.integration!.resultSha, f.tip());
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(existsSync(f.record.path), false);
      const backup = join(f.repo, ".pi", "board-agent", "legacy-v3", `receipt-${f.receipt.split(/[\\/]/).at(-1)!}`);
      assert.deepEqual(readFileSync(backup), receipt, "archive the actual remaining source, not fabricated raw v3 bytes");
      assert.deepEqual(readFileSync(f.receipt), receipt);
      noNewEvidence(f, [f.receipt.split(/[\\/]/).at(-1)!], []);
      const saved = readFileSync(f.recordFile);
      assert.deepEqual((await adapter(f).migrate(owner)).converted, []);
      assert.deepEqual(readFileSync(f.recordFile), saved);
      console.log("PASS: receipt-only cleanup (ticket/ref/worktree already removed) restores v4 progress from the validated surviving source, archives its exact raw receipt and never deletes or replays it");
    } finally { owner.release(); }
  }
} finally { dispose(); }
