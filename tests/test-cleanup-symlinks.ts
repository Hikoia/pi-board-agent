// Public cleanup seam: links are evidence, never paths to traverse or delete through.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, legacy, calls, faults, git, dispose } from "./cleanup-fixture.js";

try {
  const f = await fixture();
  const outside = join(f.repo, ".pi", "link-targets");
  mkdirSync(join(outside, ".git"), { recursive: true });
  const targetFile = join(outside, "keep.txt");
  writeFileSync(targetFile, "outside data must survive\n");
  const links: { path: string; target: string; kind: "file" | "dir" | "junction" }[] = [];
  let nativeSymlinks = true;
  for (const link of [
    { path: "ignored/file-link", target: targetFile, kind: "file" },
    { path: "ignored/directory-link", target: outside, kind: "dir" },
    { path: "ignored/dangling-link", target: "missing-target", kind: "file" },
  ] as const) {
    try { symlinkSync(link.target, join(f.record.path, link.path), link.kind); links.push(link); }
    catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      nativeSymlinks = false;
    }
  }
  if (process.platform === "win32") {
    const junction = { path: "ignored/junction", target: outside, kind: "junction" } as const;
    symlinkSync(junction.target, join(f.record.path, junction.path), junction.kind); links.push(junction);
  }
  if (!nativeSymlinks) console.log("NOTE: Windows lacks native symlink privilege; real junction coverage runs here, file/directory/dangling symlinks require the Linux run.");
  if (nativeSymlinks) {
    const tracked = { path: "tracked-link", target: targetFile, kind: "file" } as const;
    symlinkSync(tracked.target, join(f.record.path, tracked.path), tracked.kind); links.unshift(tracked);
    git(f.record.path, "config", "core.symlinks", "true");
    git(f.record.path, "add", tracked.path); git(f.record.path, "commit", "-m", "tracked symlink");
    git(f.record.path, "push", "origin", f.task.taskBranch);
    f.taskSha = git(f.record.path, "rev-parse", "HEAD");
    assert.match(git(f.repo, "ls-tree", f.taskSha, "--", tracked.path), /^120000 blob /);
  }
  const integrated = legacy(f, "merge", "none");
  if (nativeSymlinks) {
    const tracked = join(f.record.path, "tracked-link"), original = join(outside, "original-tracked-link");
    renameSync(tracked, original);
    // core.symlinks=false-style text files are not proof of Git's link mode.
    writeFileSync(tracked, targetFile);
    await assert.rejects(f.finish(), /Legacy tracked residual mode\/kind changed/);
    unlinkSync(tracked); symlinkSync("wrong-target", tracked, "file");
    await assert.rejects(f.finish(), /Legacy tracked residual changed/);
    unlinkSync(tracked); renameSync(original, tracked);
    const regular = join(f.record.path, "base.txt"), originalRegular = join(outside, "original-base.txt");
    renameSync(regular, originalRegular); symlinkSync(originalRegular, regular, "file");
    await assert.rejects(f.finish(), /Legacy tracked residual mode\/kind changed/);
    unlinkSync(regular); renameSync(originalRegular, regular);
    assert.equal(existsSync(f.receipt), false);
    assert.ok(existsSync(join(f.record.path, "feature.txt")));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.ok(!calls.some((args) => args[0] === "hash-object" && args.some((arg) => arg.startsWith(f.record.path))), "never ask Git to hash a residual path that could be a link");
    console.log("PASS: legacy tracked links require Git mode 120000 and the exact target blob; file/link mode ambiguity and changed targets block before receipt or cleanup");
  }
  // Keep the source intact after receipt publication so both durable artifacts can be inspected.
  faults.beforeFs = (operation, path) => {
    if (links.some((link) => path === join(f.record.path, link.path)) && ["open", "readdir"].includes(operation))
      assert.fail(`cleanup followed a source link via ${operation}: ${path}`);
    if (operation === "unlink" && path.startsWith(f.record.path)) throw new Error("hold symlink cleanup");
  };
  await assert.rejects(f.finish(), /hold symlink cleanup/);
  const receiptBytes = readFileSync(f.receipt);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  for (const link of links) {
    const entry = receipt.snapshots[0].entries.find((entry: any) => entry.path === link.path);
    assert.equal(entry?.type, "symlink");
    assert.equal(entry.target, link.target);
    assert.ok(entry.identity);
    const saved = join(receipt.backup, "0", link.path);
    assert.ok(lstatSync(saved).isSymbolicLink(), "backup reproduces a link, not its target contents");
    assert.equal(readlinkSync(saved), link.target);
    assert.ok(!receipt.snapshots[0].entries.some((entry: any) => entry.path.startsWith(`${link.path}/`)));
  }
  assert.ok(existsSync(join(receipt.backup, "verified.json")));
  faults.beforeFs = undefined;
  for (const invalid of [{ target: null }, { linkType: "unsupported-reparse" }, { sha256: "a".repeat(64) }]) {
    const corrupt = structuredClone(receipt);
    Object.assign(corrupt.snapshots[0].entries.find((entry: any) => entry.path === links[0].path), invalid);
    writeFileSync(f.receipt, JSON.stringify(corrupt));
    await assert.rejects(f.finish(), /receipt/i);
    assert.ok(existsSync(f.record.path));
  }
  writeFileSync(f.receipt, receiptBytes);
  for (const gitPath of [".git", "ignored/.git"]) {
    const path = join(f.record.path, gitPath);
    symlinkSync(links[0].target, path, links[0].kind);
    await assert.rejects(f.finish(), /Nested Git identity/);
    unlinkSync(path);
  }

  const source = join(f.record.path, links[0].path), saved = join(outside, "original-link");
  renameSync(source, saved);
  for (const replacement of [join(outside, ".git"), links[0].target]) {
    symlinkSync(replacement, source, links[0].kind);
    await assert.rejects(f.finish(), /changed|replaced/i);
    assert.deepEqual(readFileSync(f.receipt), receiptBytes);
    assert.ok(existsSync(join(f.record.path, "feature.txt")));
    unlinkSync(source);
  }
  writeFileSync(source, "replaced by regular file");
  await assert.rejects(f.finish(), /changed|replaced/i);
  unlinkSync(source); renameSync(saved, source);
  faults.beforeFs = (operation, path) => {
    if (operation === "readlink" && path === source) throw Object.assign(new Error("unsupported reparse readlink"), { code: "EINVAL" });
  };
  await assert.rejects(f.finish(), /unsupported reparse/);
  faults.beforeFs = undefined;
  let changedDuringRead = false;
  faults.afterFs = (operation, path) => {
    if (!changedDuringRead && operation === "readlink" && path === source) {
      changedDuringRead = true; renameSync(source, saved); symlinkSync(join(outside, ".git"), source, links[0].kind);
    }
  };
  await assert.rejects(f.finish(), /changed|replaced/i);
  faults.afterFs = undefined;
  assert.ok(changedDuringRead);
  unlinkSync(source); renameSync(saved, source);
  assert.deepEqual(readFileSync(f.receipt), receiptBytes);
  assert.ok(existsSync(join(f.record.path, "feature.txt")));

  const backupLink = join(receipt.backup, "0", links[0].path);
  unlinkSync(backupLink); symlinkSync(join(outside, ".git"), backupLink, links[0].kind);
  await assert.rejects(f.finish(), /backup/i);
  assert.ok(existsSync(f.record.path));
  unlinkSync(backupLink); symlinkSync(links[0].target, backupLink, links[0].kind);

  // Changes behind a link are not changes to the worktree or its backup.
  writeFileSync(targetFile, "outside target edited after receipt\n");
  calls.length = 0;
  const unlinked: string[] = [];
  faults.beforeFs = (operation, path) => {
    if (links.some((link) => path === join(f.record.path, link.path))) {
      assert.ok(!["open", "readdir"].includes(operation), "never read/traverse the target");
      if (operation === "unlink") unlinked.push(path);
    }
  };
  assert.equal(await f.finish(), integrated);
  assert.equal(existsSync(f.record.path), false);
  assert.deepEqual(unlinked.sort(), links.map((link) => join(f.record.path, link.path)).sort(), "each source link is unlinked only");
  assert.equal(readFileSync(targetFile, "utf8"), "outside target edited after receipt\n");
  assert.ok(existsSync(join(outside, ".git")), "a target's Git identity is not traversed");
  for (const link of links) assert.equal(readlinkSync(join(receipt.backup, "0", link.path)), link.target);
  assert.ok(!calls.some((args) => ["merge-tree", "commit-tree"].includes(args[0])));
  assert.equal(existsSync(f.receipt), false);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
  console.log(`PASS: original child ${nativeSymlinks ? "file/directory/dangling symlinks" : "Windows junction"} survive receipt and verified backup; changed/replaced links block; cleanup unlinks links without touching targets`);

  faults.beforeFs = undefined;
  const registered = await fixture();
  const registeredTarget = join(registered.repo, ".pi", "registered-link-target");
  mkdirSync(registeredTarget);
  writeFileSync(join(registeredTarget, "keep.txt"), "normal Git removal must not follow this link\n");
  const child = join(registered.record.path, "ignored", "original-link");
  symlinkSync(registeredTarget, child, nativeSymlinks ? "dir" : "junction");
  let normalRemoval = false;
  faults.beforeGit = (args) => {
    if (args[0] === "worktree" && args[1] === "remove") {
      normalRemoval = true;
      const published = JSON.parse(readFileSync(registered.receipt, "utf8"));
      const link = published.snapshots[0].entries.find((entry: any) => entry.path === "ignored/original-link");
      assert.equal(link.type, "symlink"); assert.equal(link.target, registeredTarget);
      assert.equal(published.backup, null, "fresh integration does not require a legacy backup");
    }
  };
  await registered.finish();
  faults.beforeGit = undefined;
  assert.ok(normalRemoval, "registered worktrees still use normal git worktree remove");
  assert.equal(existsSync(registered.record.path), false);
  assert.equal(readFileSync(join(registeredTarget, "keep.txt"), "utf8"), "normal Git removal must not follow this link\n");
  assert.equal(existsSync(registered.receipt), false);
  console.log("PASS: fresh integration receipts preserve original child links and normal registered Git removal never deletes their targets");
} finally { dispose(); }
