// Public TicketWorktrees/loop seams; all repositories and processes are disposable/offline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketBoardAdapter } from "../src/ticket-executor.js";
import {
  fixture,
  legacy,
  calls,
  faults,
  TicketWorktrees,
  dispose,
} from "./cleanup-fixture.js";
try {
  {
    const f = await fixture();
    const integrated = legacy(f, "merge", "none");
    mkdirSync(join(f.record.path, "unknown-empty"));
    await assert.rejects(f.finish(), /Unknown legacy residual directory/);
    assert.equal(f.tip(), integrated);
    assert.ok(existsSync(f.record.path));
    assert.equal(existsSync(f.receipt), false);
    console.log(
      "PASS: unrecorded empty directories in legacy residue block backup authorization and cleanup",
    );
  }

  {
    const f = await fixture(true);
    const recordBytes = readFileSync(f.recordFile);
    faults.beforeGit = (args) => {
      if (args[0] !== "worktree" || args[1] !== "remove") return;
      faults.beforeGit = undefined;
      f.vanish();
      throw new Error("deterministic partial worktree removal");
    };
    await assert.rejects(f.finish(), /partial worktree removal/);
    assert.notEqual(
      f.tip(),
      f.base,
      "integration was confirmed before cleanup",
    );
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.deepEqual(
      readFileSync(f.recordFile),
      recordBytes,
      "no early intent or v3 change",
    );
    assert.ok(
      existsSync(f.receipt),
      "failed removal must retain a dedicated cleanup receipt",
    );
    const receipt = readFileSync(f.receipt, "utf8");
    assert.match(
      receipt,
      /ignored\/cache.bin/,
      "snapshot includes ignored binary files",
    );
    assert.match(
      receipt,
      /ignored\/empty/,
      "snapshot includes empty directory identities",
    );
    for (const path of [
      "Cargo.lock",
      "locked",
      "node_modules/uri-js/yarn.lock",
    ]) {
      const entry = JSON.parse(receipt).snapshots[0].entries.find(
        (e: any) => e.path === path,
      );
      const bytes = readFileSync(join(f.record.path, path));
      assert.equal(entry?.type, "file");
      assert.equal(entry.size, String(bytes.length));
      assert.equal(
        entry.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    const integrated = f.tip();
    calls.length = 0;
    assert.equal(await f.finish(), integrated);
    assert.equal(f.tip(), integrated, "retry does not integrate twice");
    assert.ok(
      !calls.some((args) => ["merge-tree", "commit-tree"].includes(args[0])),
    );
    assert.equal(
      existsSync(f.record.path),
      false,
      "lost registration and .git cannot hide residual files",
    );
    assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.equal(existsSync(f.recordFile), false);
    assert.equal(existsSync(f.receipt), false, "receipt is removed last");
    console.log(
      "PASS: confirmed integration writes a full dedicated receipt; restart cleans verified registration-less leftovers before ref/record/receipt without reintegration",
    );
  }

  for (const last of ["record", "receipt"] as const) {
    const f = await fixture();
    faults.beforeFs = (operation, path) => {
      if (
        operation === "unlink" &&
        path === (last === "record" ? f.recordFile : f.receipt)
      )
        throw new Error(`controlled ${last} unlink failure`);
    };
    await assert.rejects(
      f.finish(),
      new RegExp(`controlled ${last} unlink failure`),
    );
    faults.beforeFs = undefined;
    assert.equal(existsSync(f.record.path), false);
    assert.equal(existsSync(f.admin), false);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.equal(existsSync(f.receipt), true);
    const integrated = f.tip();
    calls.length = 0;
    const { BoardLoop, createLoopState } = await import("../src/loop.js");
    const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
    const cfg = structuredClone(_DEFAULTS);
    cfg.context.enabled =
      cfg.refine.enabled =
      cfg.review.enabled =
      cfg.watchdog.enabled =
      cfg.telegram.enabled =
        false;
    cfg.task_merge_strategy = "merge";
    const card: Card = {
      itemId: f.task.itemId,
      number: f.task.issueNumber,
      type: "Task",
      contentType: "Issue",
      title: "Accepted",
      body: "acceptance",
      repoOwner: "owner",
      repoName: "repo",
      assignees: [],
      closed: true,
      status: cfg.columns.done,
    };
    const notices: string[] = [];
    const callback = (message: string) => {
      notices.push(message);
    };
    const noWrite = async (): Promise<never> =>
      assert.fail("cleanup does not mutate the card or launch repair");
    const board: TicketBoardAdapter = {
      getCard: async () => structuredClone(card),
      claim: noWrite,
      release: noWrite,
      comment: noWrite,
      listComments: noWrite,
      setStatus: noWrite,
    };
    const store = new TicketWorktrees(f.repo);
    const executor = new ManagedTicketExecutor({
      cwd: f.repo,
      cfg,
      worktrees: store,
      board,
      botLogin: "bot",
      repoOwner: "owner",
      repoName: "repo",
      callback,
      createManager: () => assert.fail("no builder"),
    });
    const loop = new BoardLoop(
      {
        cwd: f.repo,
        cfg,
        botLogin: "bot",
        repoOwner: "owner",
        repoName: "repo",
        callback,
        meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
        listCards: async () => [structuredClone(card)],
      },
      createLoopState(),
      executor,
      store,
    );
    try {
      await loop.tickNow();
    } finally {
      await loop.stop();
    }
    assert.equal(
      existsSync(f.receipt),
      false,
      `no-ref negative filter must retain pending cleanup: ${JSON.stringify(notices)}`,
    );
    assert.equal(existsSync(f.recordFile), false);
    assert.equal(f.tip(), integrated);
    assert.equal(
      notices.filter((message) => message.startsWith("Finalized")).length,
      1,
    );
    assert.ok(
      !calls.some((args) => ["merge-tree", "commit-tree"].includes(args[0])),
    );
    console.log(
      `PASS: ${last} unlink failure retains a no-ref receipt; restarted real loop/executor completes it without reintegration`,
    );
  }
} finally {
  dispose();
}
