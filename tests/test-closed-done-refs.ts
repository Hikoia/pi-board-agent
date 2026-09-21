// Main's completion policy on the v4 executor: every target Issue, exact refs, Backlog.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixture,
  git,
  calls,
  faults,
  dispose,
} from "./finalization-fixture.js";
const removeRefs = (f: Awaited<ReturnType<typeof fixture>>) => {
  git(f.repo, "push", "origin", "--delete", f.task.taskBranch);
  git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
};
try {
  for (const type of ["Task", "Story", "Bug", undefined]) {
    const f = await fixture();
    f.card.type = type;
    f.card.plan = undefined;
    f.cfg.columns.backlog = "Archive backlog";
    f.store.update(f.task.itemId, (r) => ({
      ...r,
      reviewedTaskSha: undefined,
    }));
    try {
      await f.loop.tickNow();
      assert.equal(f.card.status, "Archive backlog", f.notices.join("\n"));
      assert.equal(f.card.closed, true);
      assert.equal(f.store.has(f.task.itemId), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(await f.store.remoteSha(f.task.taskBranch), undefined);
      assert.equal(f.starts(), 0);
      assert.equal(f.reviews(), 0);
      git(f.repo, "merge-base", "--is-ancestor", f.taskSha, f.tip());
      console.log(
        `PASS: closed Done ${type ?? "untyped"} integrates without Plan/review evidence and moves to custom Backlog without a model`,
      );
    } finally {
      await f.loop.stop();
    }
  }
  {
    const f = await fixture();
    removeRefs(f);
    f.board.setStatus = async (id, status) => {
      assert.equal(id, f.card.itemId);
      f.card.status = status;
    };
    writeFileSync(
      join(f.record.path, "leftover.txt"),
      "preserve unknown work\n",
    );
    const bytes = readFileSync(f.recordFile),
      read = f.board.getCard;
    let reads = 0;
    f.board.getCard = async (id) => {
      reads++;
      return read(id);
    };
    try {
      await f.loop.tickNow();
      assert.equal(f.card.status, f.cfg.columns.backlog, f.notices.join("\n"));
      assert.deepEqual(readFileSync(f.recordFile), bytes);
      assert.equal(
        readFileSync(join(f.record.path, "leftover.txt"), "utf8"),
        "preserve unknown work\n",
      );
      const previousReads = reads;
      calls.length = 0;
      await f.loop.tickNow();
      assert.equal(
        reads,
        previousReads,
        "idle Backlog records stop per-ticket polling",
      );
      assert.ok(
        !calls.some((a) =>
          ["ls-remote", "merge-tree", "push", "update-ref"].includes(a[0]),
        ),
      );
      assert.equal(f.tip(), f.base);
      console.log(
        "PASS: no-ref history preserves idle record bytes and unknown leftovers, then stops polling after Backlog",
      );
    } finally {
      await f.loop.stop();
    }
  }
  for (const patch of [
    { closed: false },
    { contentType: "PullRequest" },
    { contentType: "DraftIssue" },
    { repoOwner: "foreign" },
    { repoName: "foreign" },
    { number: undefined },
  ]) {
    const f = await fixture();
    Object.assign(f.card, patch);
    try {
      await f.loop.tickNow();
      assert.equal(f.tip(), f.base);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
      assert.ok(existsSync(f.record.path));
      assert.deepEqual(f.events, []);
      console.log(
        `PASS: ${JSON.stringify(patch)} is excluded from closed-Issue completion`,
      );
    } finally {
      await f.loop.stop();
    }
  }
  for (const lostResponse of [false, true]) {
    const f = await fixture();
    if (lostResponse) f.loseDone(true);
    else f.failDone(true);
    try {
      await f.loop.tickNow();
      const result = f.tip();
      assert.notEqual(result, f.base);
      assert.ok(
        f.store.has(f.task.itemId),
        "retain cleanup progress until Backlog acknowledgement",
      );
      f.loseDone(false);
      f.failDone(false);
      calls.length = 0;
      for (let i = 0; i < 4 && f.store.has(f.task.itemId); i++)
        await f.loop.tickNow();
      assert.equal(f.store.has(f.task.itemId), false, f.notices.join("\n"));
      assert.equal(f.card.status, f.cfg.columns.backlog);
      assert.equal(f.card.closed, true);
      assert.equal(f.tip(), result);
      assert.ok(
        !calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])),
      );
      assert.equal(f.starts(), 0);
      assert.equal(f.reviews(), 0);
      console.log(
        `PASS: Backlog ${lostResponse ? "lost response" : "write failure"} resumes cleanup-only without duplicate integration or models`,
      );
    } finally {
      await f.loop.stop();
    }
  }
  for (const change of ["reopen", "lane", "identity", "removed"] as const) {
    const f = await fixture(),
      read = f.board.getCard;
    f.board.getCard = async (id) => {
      if (!f.store.localBranchSha(f.task.taskBranch)) {
        if (change === "reopen") f.card.closed = false;
        if (change === "lane") f.card.status = f.cfg.columns.ready;
        if (change === "identity") f.card.number = 999;
        if (change === "removed") return undefined;
      }
      return read(id);
    };
    try {
      await f.loop.tickNow();
      assert.ok(!f.events.some((e) => e === `status:${f.cfg.columns.backlog}`));
      assert.ok(f.store.has(f.task.itemId));
      assert.ok(!f.notices.some((s) => s.startsWith("Finalized")));
      console.log(
        `PASS: ${change} during cleanup is never overwritten by Backlog`,
      );
    } finally {
      await f.loop.stop();
    }
  }
  for (const race of ["local", "remote", "query failure"] as const) {
    const f = await fixture();
    removeRefs(f);
    let probes = 0;
    faults.beforeGit = (a) => {
      if (a[0] !== "ls-remote") return;
      if (race === "query failure") throw new Error("remote query unavailable");
      if (++probes !== 2) return;
      git(
        race === "local" ? f.repo : f.origin,
        "update-ref",
        `refs/heads/${f.task.taskBranch}`,
        f.taskSha,
      );
    };
    try {
      await f.loop.tickNow();
      faults.beforeGit = undefined;
      assert.equal(f.card.status, f.cfg.columns.done);
      assert.equal(f.tip(), f.base);
      assert.ok(f.store.has(f.task.itemId));
      assert.ok(!f.events.includes(`status:${f.cfg.columns.backlog}`));
      console.log(
        `PASS: no-ref ${race} cannot turn unknown or racing refs into successful completion`,
      );
    } finally {
      faults.beforeGit = undefined;
      await f.loop.stop();
    }
  }
  for (const evidence of [
    "active",
    "launching",
    "corrupt record",
    "corrupt receipt",
  ] as const) {
    const f = await fixture();
    removeRefs(f);
    if (evidence === "active") f.store.setActiveRun(f.task.itemId, "unsettled");
    if (evidence === "launching") f.store.beginLaunch(f.task.itemId);
    if (evidence === "corrupt record") writeFileSync(f.recordFile, "broken");
    if (evidence === "corrupt receipt") writeFileSync(f.receipt, "broken");
    const bytes = readFileSync(f.recordFile);
    assert.equal((await f.finish()).status, "blocked");
    if (evidence === "corrupt receipt") {
      const record = f.recordNow();
      assert.equal(record.retry?.stage, "integrate", "unknown cleanup evidence is a technical failure, never approval");
      assert.deepEqual({ ...record, retry: undefined }, { ...JSON.parse(bytes.toString()), retry: undefined });
      assert.equal(readFileSync(f.receipt, "utf8"), "broken");
    } else assert.deepEqual(readFileSync(f.recordFile), bytes);
    assert.equal(f.card.status, f.cfg.columns.done);
    assert.ok(existsSync(f.record.path));
    console.log(
      `PASS: no-ref ${evidence} preserves pending recovery and cannot take the historical shortcut`,
    );
  }
} finally {
  dispose();
}
