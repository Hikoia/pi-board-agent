import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fixture, git, calls, dispose } from "./finalization-fixture.js";
import { historicalReceipt } from "./legacy-cleanup-fixture.js";
const { LegacyTickets } = await import("../src/legacy-tickets.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");
try {
  for (const version of [1, 2])
    for (const pending of [false, true]) {
      const f = await fixture(true);
      await historicalReceipt(f, true);
      const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      Object.assign(receipt, {
        schemaVersion: version,
        record: null,
        recordHash: null,
        backup: null,
        snapshots: receipt.snapshots.map((s: any) => ({ ...s, entries: [] })),
      });
      if (version === 2) receipt.remoteTaskSha = null;
      writeFileSync(f.receipt, JSON.stringify(receipt));
      if (pending)
        git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      f.card.type = "Bug";
      if (!pending)
        f.board.setStatus = async (id, status) => {
          assert.equal(id, f.card.itemId);
          f.card.status = status;
        };
      const bytes = readFileSync(f.receipt),
        base = f.tip(),
        owner = acquireOwnerLock(f.repo, "bot");
      const adapter = new LegacyTickets({
        worktrees: f.store,
        cfg: f.cfg,
        board: f.board,
        botLogin: "bot",
        repoOwner: "owner",
        repoName: "repo",
      });
      try {
        const report = await adapter.migrate(owner);
        assert.deepEqual(report.failures, []);
        assert.equal(f.store.has(f.task.itemId), pending);
        calls.length = 0;
        assert.equal(
          (await f.finish()).status,
          pending ? "finalized" : "backlogged",
        );
        assert.equal(f.card.status, f.cfg.columns.backlog);
        assert.equal(f.store.has(f.task.itemId), false);
        assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
        assert.equal(f.tip(), base);
        assert.deepEqual(readFileSync(f.receipt), bytes);
        assert.ok(
          !calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])),
        );
        assert.deepEqual((await adapter.migrate(owner)).converted, []);
        console.log(
          `PASS: recordless v${version} ${pending ? "pending ref" : "completed"} receipt finishes a closed non-Task without rewriting old evidence or reintegrating`,
        );
      } finally {
        owner.release();
      }
    }
} finally {
  dispose();
}
