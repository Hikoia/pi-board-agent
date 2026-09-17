import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, git } from "./conflict-handoff-fixture.js";

{
  const f = await fixture(false);
  f.store.update(f.card.itemId, (r) => ({
    ...r,
    finalization: {
      targetBranch: "main",
      baseSha: "0".repeat(40),
      taskSha: f.taskSha,
    },
  }));
  const file = join(
      f.repo,
      ".pi/board-agent/ticket-worktrees",
      `${f.card.itemId.toLowerCase()}.json`,
    ),
    bytes = readFileSync(file);
  try {
    await f.loop.tickNow();
    assert.equal(
      existsSync(file),
      true,
      "unknown legacy base cannot authorize even a clean new integration/cleanup",
    );
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(f.calls(), 0);
    assert.equal(f.comments.length, 0);
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
    console.log(
      "PASS: unknown no-result base remains blocking even when current branches would merge cleanly",
    );
  } finally {
    await f.loop.stop();
  }
}

{
  const f = await fixture();
  f.store.update(f.card.itemId, (r) => ({
    ...r,
    reviewedTaskSha: f.taskSha,
    finalization: {
      targetBranch: "main",
      baseSha: f.baseSha,
      taskSha: f.taskSha,
    },
  }));
  const file = join(
      f.repo,
      ".pi/board-agent/ticket-worktrees",
      `${f.card.itemId.toLowerCase()}.json`,
    ),
    original = readFileSync(file);
  assert.throws(
    () =>
      f.store.update(f.card.itemId, (r) => ({ ...r, finalization: undefined })),
    /pending finalization/,
  );
  try {
    await f.loop.tickNow();
    assert.equal(f.card.status, f.cfg.columns.ready, f.notices.join("\n"));
    assert.equal(f.card.closed, false);
    assert.equal(f.store.read(f.card.itemId)?.finalization, undefined);
    const backups = join(f.repo, ".pi/board-agent/repair-intent-backups");
    assert.equal(readdirSync(backups).length, 1);
    assert.deepEqual(
      readFileSync(join(backups, readdirSync(backups)[0])),
      original,
      "archive original bytes durably BEFORE dedicated checked clear",
    );
    assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
    assert.equal(f.calls(), 0);
    console.log(
      "PASS: proven old pre-result conflict intent is archived exactly, dedicated-cleared then requested; ordinary update protection remains",
    );
  } finally {
    await f.loop.stop();
  }
}

for (const mode of [
  "never-pushed-result",
  "pushed-then-rewritten",
  "unknown-result",
  "review-mismatch",
  "old-task-mismatch",
  "rewritten-base",
] as const) {
  const f = await fixture(
    mode === "review-mismatch" || mode === "old-task-mismatch",
  );
  let resultSha: string | undefined;
  let oldBase = f.baseSha;
  if (["never-pushed-result", "pushed-then-rewritten"].includes(mode)) {
    resultSha = git(
      f.repo,
      "commit-tree",
      `${f.taskSha}^{tree}`,
      "-p",
      f.originalBase,
      "-m",
      "old result",
    );
    oldBase = f.originalBase;
    if (mode === "pushed-then-rewritten") {
      git(f.repo, "push", "origin", `${resultSha}:refs/heads/main`);
      // Disposable origin only: simulate history rewrite, NOT proof of never pushed.
      git(f.origin, "update-ref", "refs/heads/main", f.baseSha);
    }
  }
  if (mode === "unknown-result") resultSha = "0".repeat(40);
  if (mode === "rewritten-base")
    oldBase = git(
      f.repo,
      "commit-tree",
      `${f.baseSha}^{tree}`,
      "-m",
      "unrelated historical base",
    );
  f.store.update(f.card.itemId, (r) => ({
    ...r,
    ...(mode === "review-mismatch" ? { reviewedTaskSha: f.baseSha } : {}),
    finalization: {
      targetBranch: "main",
      baseSha: oldBase,
      taskSha: mode === "old-task-mismatch" ? f.baseSha : f.taskSha,
      ...(resultSha ? { resultSha } : {}),
    },
  }));
  const file = join(
      f.repo,
      ".pi/board-agent/ticket-worktrees",
      `${f.card.itemId.toLowerCase()}.json`,
    ),
    bytes = readFileSync(file);
  try {
    await f.loop.tickNow();
    await f.loop.stop();
    const next = f.make();
    try {
      await next.loop.tickNow();
      assert.deepEqual(
        readFileSync(file),
        bytes,
        `${mode}: never clear uncertain intent`,
      );
      assert.equal(f.card.closed, true);
      assert.equal(f.card.status, f.cfg.columns.done);
      assert.equal(f.comments.length, 0);
      assert.equal(f.calls(), 0);
      assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.baseSha);
      assert.equal(existsSync(f.record.path), true);
      console.log(
        `PASS: legacy ${mode} stays intact and blocking across restart, never interpreted as pre-push`,
      );
    } finally {
      await next.loop.stop();
    }
  } finally {
    await f.loop.stop();
  }
}

for (const strategy of ["merge", "squash"] as const) {
  const f = await fixture(false);
  const result = git(
    f.repo,
    "commit-tree",
    `${f.taskSha}^{tree}`,
    "-p",
    f.originalBase,
    ...(strategy === "merge" ? ["-p", f.taskSha] : []),
    "-m",
    "old confirmed integration",
  );
  git(f.repo, "push", "origin", `${result}:refs/heads/main`);
  const later = git(
    f.repo,
    "commit-tree",
    `${f.originalBase}^{tree}`,
    "-p",
    result,
    "-m",
    "later base edits",
  );
  git(f.repo, "push", "origin", `${later}:refs/heads/main`);
  f.store.update(f.card.itemId, (r) => ({
    ...r,
    finalization: {
      targetBranch: "main",
      baseSha: f.originalBase,
      taskSha: f.taskSha,
      resultSha: result,
    },
  }));
  try {
    await f.loop.tickNow();
    await f.loop.tickNow();
    assert.equal(f.calls(), 0);
    assert.equal(f.comments.length, 0);
    assert.deepEqual(f.events, [`status:${f.cfg.columns.backlog}`]);
    assert.equal(f.card.closed, true);
    assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(existsSync(f.record.path), false);
    assert.equal(f.store.read(f.card.itemId), undefined);
    assert.equal(f.store.hasCleanupReceipt(f.card.itemId), false);
    assert.equal(
      git(f.origin, "rev-parse", "refs/heads/main"),
      later,
      "cleanup never creates another integration",
    );
    assert.equal(
      readdirSync(join(f.repo, ".pi/board-agent/cleanup-backups")).length,
      1,
      "T12 durable backup retained",
    );
    console.log(
      `PASS: confirmed legacy ${strategy} result ancestor takes T12 backup/cleanup ONLY despite later base edits, never a repair builder`,
    );
  } finally {
    await f.loop.stop();
  }
}
