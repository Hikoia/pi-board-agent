// Legacy snapshots are read-only adapter evidence; fresh work uses native Git.
import assert from "node:assert/strict";
import { cpSync, rmSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, git, dispose } from "./cleanup-fixture.js";
const { legacyReceipt } = await import("./legacy-cleanup-fixture.js");
const { readLegacyReceipt } = await import("../src/legacy-adapter.js");
const { verifySnapshot, verifyBackupSnapshots } = await import("../src/cleanup-snapshot.js");
try {
  const f = await integrationFixture(true);
  try {
    const outside = join(f.repo, ".pi/outside"); mkdirSync(outside); mkdirSync(join(outside, ".git"));
    const target = join(outside, "keep.txt"); writeFileSync(target, "external data\n");
    const link = join(f.record.path, "ignored/link");
    let kind: "dir" | "junction" = "dir";
    try { symlinkSync(outside, link, kind); }
    catch (e) { if (process.platform !== "win32" || (e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      kind = "junction"; symlinkSync(outside, link, kind); console.log("NOTE: native symlinks require privilege; real Windows junction used."); }
    const receipt = await legacyReceipt(f, { backup: true });
    const bytes = readFileSync(f.receipt), original = readFileSync(f.recordFile); f.vanish();
    const validate = async () => {
      const r = await readLegacyReceipt(f.store, f.task);
      await verifyBackupSnapshots(r.backup!, r.snapshots);
      for (const snapshot of r.snapshots) await verifySnapshot(snapshot);
    };
    const mutate = [
      (r: any) => r.schemaVersion = 2, (r: any) => r.unexpected = 1, (r: any) => delete r.taskSha,
      (r: any) => r.itemId = "OTHER", (r: any) => r.snapshots[0].entries[0].extra = 1,
      (r: any) => r.snapshots[0].entries[1].path = "../escape", (r: any) => r.snapshots[0].entries.push(r.snapshots[0].entries[1]),
      (r: any) => { r.record.activeRunId = "active"; r.record.activeRunStartedAt = 1; },
      (r: any) => r.record.retry = { stage: "cleanup", reason: "mixed" },
      (r: any) => r.record.integration = { baseSha: f.base, taskSha: f.taskSha, resultSha: r.resultSha },
      ...[{ target: null }, { linkType: "unknown" }, { sha256: "a".repeat(64) }].map((invalid) => (r: any) =>
        Object.assign(r.snapshots[0].entries.find((e: any) => e.path === "ignored/link"), invalid)),
    ];
    for (const change of mutate) {
      const r = JSON.parse(bytes.toString("utf8")); change(r); writeFileSync(f.receipt, JSON.stringify(r));
      await assert.rejects(validate, /receipt/i); assert.ok(existsSync(f.record.path));
    }
    writeFileSync(f.receipt, "{corrupt"); await assert.rejects(validate, /receipt/i); writeFileSync(f.receipt, bytes);
    console.log("PASS: adapter receipt parser preserves strict versions/fields/identity, active-run separation, path traversal/duplicate entry and symlink schema safety");
    const saved = join(outside, "saved-link"); renameSync(link, saved);
    symlinkSync(join(outside, ".git"), link, kind); await assert.rejects(validate, /changed|replaced/); unlinkSync(link);
    writeFileSync(link, "replaced link"); await assert.rejects(validate, /changed/); unlinkSync(link); renameSync(saved, link);
    const cache = join(f.record.path, "ignored/cache.bin"), cacheBytes = readFileSync(cache);
    writeFileSync(cache, "dirty ignored residue"); await assert.rejects(validate, /changed/); writeFileSync(cache, cacheBytes);
    const added = join(f.record.path, "ignored/unknown"); writeFileSync(added, "new data"); await assert.rejects(validate, /changed|added/); unlinkSync(added);
    const backupLink = join(receipt.backup!, "0/ignored/link"); unlinkSync(backupLink); symlinkSync(join(outside, ".git"), backupLink, kind);
    await assert.rejects(validate, /backup/i); unlinkSync(backupLink); symlinkSync(outside, backupLink, kind);
    const backupFile = join(receipt.backup!, "0/feature.txt"), backupBytes = readFileSync(backupFile);
    writeFileSync(backupFile, "changed backup"); await assert.rejects(validate, /backup/); writeFileSync(backupFile, backupBytes);
    const backupRecord = join(receipt.backup!, "record.json"), backupRecordBytes = readFileSync(backupRecord);
    writeFileSync(backupRecord, "changed provenance");
    assert.equal((await f.executor().reconcile([structuredClone(f.card)])).errors, 1);
    assert.deepEqual(readFileSync(f.recordFile), original); writeFileSync(backupRecord, backupRecordBytes);
    const savedCache = join(outside, "saved-cache"); renameSync(cache, savedCache); writeFileSync(cache, cacheBytes);
    await assert.rejects(validate, /changed/); unlinkSync(cache); renameSync(savedCache, cache);
    const savedRoot = join(outside, "saved-worktree"); renameSync(f.record.path, savedRoot);
    cpSync(savedRoot, f.record.path, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
    await assert.rejects(validate, /changed/);
    rmSync(f.record.path, { recursive: true }); renameSync(savedRoot, f.record.path);
    renameSync(f.record.path, savedRoot); symlinkSync(savedRoot, f.record.path, "junction");
    await assert.rejects(validate, /unmanaged|symlink/i); unlinkSync(f.record.path); renameSync(savedRoot, f.record.path);
    const savedGit = join(outside, "saved-git"); renameSync(join(f.repo, ".git"), savedGit);
    cpSync(savedGit, join(f.repo, ".git"), { recursive: true }); await assert.rejects(validate, /identity changed/);
    rmSync(join(f.repo, ".git"), { recursive: true }); renameSync(savedGit, join(f.repo, ".git"));
    assert.deepEqual(readFileSync(f.receipt), bytes); assert.deepEqual(readFileSync(f.recordFile), original);
    console.log("PASS: identical file/root/Git-common replacements and root junctions invalidate old receipt identity without following external paths");
    console.log("PASS: old ignored changes/additions, link replacements/targets/kinds and changed backup bytes cannot authorize deletion of legacy residuals");
    writeFileSync(target, "target edit is external, never traversed\n");
    calls.length = 0; await f.tick();
    assert.equal(existsSync(f.record.path), false, f.notices.join("\n")); assert.equal(readFileSync(target, "utf8"), "target edit is external, never traversed\n");
    assert.ok(existsSync(join(outside, ".git"))); assert.ok(lstatSync(backupLink).isSymbolicLink());
    assert.equal(readlinkSync(backupLink), outside); assert.deepEqual(readFileSync(f.receipt), bytes);
    assert.ok(!calls.some((a) => ["merge-tree", "commit-tree"].includes(a[0])));
    await f.tick(); assert.equal(existsSync(f.recordFile), false);
    console.log("PASS: verified old residual cleanup unlinks links only, preserves external Git/data and read-only backup/receipt; no reintegration or re-adoption");
  } finally { f.ownerLock!.release(); }
  {
    const f = await integrationFixture(); const outside = join(f.repo, ".pi/native-target"); mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    const outsideRepo = join(outside, "repo"); mkdirSync(outsideRepo); git(outsideRepo, "init");
    const externalHead = readFileSync(join(outsideRepo, ".git/HEAD"));
    for (const [name, target] of [["native-link", outside], ["repo-link", outsideRepo], ["dangling-link", join(outside, "missing")]])
      symlinkSync(target, join(f.record.path, "ignored", name), process.platform === "win32" ? "junction" : "dir");
    calls.length = 0; await f.tick();
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n", "external target must survive even a native partial removal");
    assert.deepEqual(readFileSync(join(outsideRepo, ".git/HEAD")), externalHead);
    assert.equal(existsSync(join(outside, "missing")), false);
    assert.equal(existsSync(f.record.path), false, f.notices.join("\n"));
    assert.equal(existsSync(f.admin), false); assert.equal(existsSync(f.recordFile), false);
    assert.equal(await f.store.remoteSha(f.task.taskBranch), undefined);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.equal(f.card.closed, true); assert.equal(f.card.status, f.cfg.columns.done);
    assert.ok(calls.some((a) => a[0] === "clean" && a[1] === "-fdX" && a.length === 2));
    assert.ok(calls.some((a) => a[0] === "worktree" && a[1] === "remove" && a.length === 3));
    assert.equal(existsSync(f.receipt), false);
    assert.equal(existsSync(join(f.repo, ".pi/board-agent/cleanup-backups")), false);
    console.log("PASS: ignored ordinary/repository/dangling child links complete native cleanup; external data/Git survive with no snapshots");
  }
} finally { dispose(); }
