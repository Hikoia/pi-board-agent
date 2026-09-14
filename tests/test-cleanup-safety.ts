import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  fixture,
  legacy,
  calls,
  faults,
  git,
  root,
  dispose,
} from "./cleanup-fixture.js";

try {
  {
    const f = await fixture(true);
    calls.length = 0;
    assert.ok(await f.finish());
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "worktree" && args[1] === "remove" && args.length === 3,
      ),
    );
    assert.equal(existsSync(f.record.path), false);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
    assert.equal(existsSync(f.recordFile), false);
    assert.equal(existsSync(f.receipt), false);
    console.log(
      "PASS: ordinary Cargo.lock, locked and ignored node_modules/uri-js/yarn.lock permit normal Git removal and completed cleanup",
    );
  }

  {
    const f = await fixture();
    legacy(f, "squash", "result");
    faults.beforeFs = (operation, path) => {
      if (operation === "unlink" && path.startsWith(f.record.path))
        throw new Error("stop after durable backup/receipt");
    };
    await assert.rejects(f.finish("squash"), /stop after durable backup/);
    faults.beforeFs = undefined;
    const backup = JSON.parse(readFileSync(f.receipt, "utf8")).backup;
    assert.ok(existsSync(join(backup, "verified.json")));
    writeFileSync(
      join(backup, "0", "ignored", "cache.bin"),
      "corrupted backup",
    );
    await assert.rejects(f.finish("squash"), /backup/i);
    assert.ok(existsSync(f.receipt));
    assert.ok(
      existsSync(join(f.record.path, "feature.txt")),
      "never clean legacy sources after backup evidence is lost",
    );
    console.log(
      "PASS: legacy retry refuses a missing/changed durable backup and preserves source and receipt",
    );
  }

  for (const strategy of ["merge", "squash"] as const)
    for (const journal of ["none", "intent", "result"] as const) {
      const lockfiles = strategy === "squash" && journal === "result";
      const f = await fixture(lockfiles);
      const integrated = legacy(f, strategy, journal),
        recordBytes = readFileSync(f.recordFile);
      const files = [
        ".gitignore",
        "base.txt",
        "feature.txt",
        "ignored/cache.bin",
        ...(lockfiles
          ? ["Cargo.lock", "locked", "node_modules/uri-js/yarn.lock"]
          : []),
      ];
      const original = files.map((path) =>
        readFileSync(join(f.record.path, path)),
      );
      calls.length = 0;
      assert.equal(await f.finish(strategy), integrated);
      assert.equal(f.tip(), integrated);
      assert.ok(
        !calls.some(
          (args) =>
            args[0] === "commit-tree" ||
            (args[0] === "push" &&
              args.some((arg) => arg.endsWith(":refs/heads/main"))),
        ),
      );
      assert.equal(existsSync(f.record.path), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(existsSync(f.receipt), false);
      const backups = join(f.repo, ".pi", "board-agent", "cleanup-backups");
      const names = readdirSync(backups);
      assert.equal(names.length, 1);
      const saved = join(backups, names[0]);
      files.forEach((path, i) =>
        assert.deepEqual(readFileSync(join(saved, "0", path)), original[i]),
      );
      assert.deepEqual(readFileSync(join(saved, "record.json")), recordBytes);
      assert.ok(existsSync(join(saved, "0", "ignored", "empty")));
      assert.ok(existsSync(join(saved, "verified.json")));
      assert.equal(await f.finish(strategy), undefined);
      assert.deepEqual(
        readdirSync(backups),
        names,
        "completed backups are never auto-GC'd",
      );
      console.log(
        `PASS: legacy ${strategy}/${journal} missing .git+registration gets a complete verified retained backup before receipt/cleanup, never a second integration`,
      );
    }

  {
    const f = await fixture();
    legacy(f, "merge", "none");
    const backups = join(f.repo, ".pi", "board-agent", "cleanup-backups");
    writeFileSync(backups, "blocked destination");
    await assert.rejects(f.finish(), /directory|EEXIST|ENOTDIR/i);
    assert.equal(existsSync(f.receipt), false);
    assert.ok(existsSync(f.record.path));
    unlinkSync(backups);
    let injected = false;
    faults.afterFs = (operation, path) => {
      if (!injected && operation === "link" && path.startsWith(backups)) {
        injected = true;
        writeFileSync(
          join(f.record.path, "ignored", "cache.bin"),
          "changed during backup",
        );
      }
    };
    await assert.rejects(f.finish(), /changed|Backup/i);
    faults.afterFs = undefined;
    assert.equal(injected, true);
    assert.equal(existsSync(f.receipt), false);
    assert.ok(existsSync(f.record.path));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.ok(
      readdirSync(backups).length,
      "incomplete backup evidence is retained",
    );
    console.log(
      "PASS: backup failure and source mutation during copying cannot publish a receipt or delete any source",
    );
  }

  async function pending() {
    const f = await fixture();
    faults.beforeGit = (args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        faults.beforeGit = undefined;
        f.vanish();
        throw new Error("partial remove");
      }
    };
    await assert.rejects(f.finish(), /partial remove/);
    return f;
  }
  {
    const f = await pending();
    const receipt = readFileSync(f.receipt),
      tip = f.tip();
    for (const change of [
      (r: any) => {
        r.schemaVersion = 2;
      },
      (r: any) => {
        r.unexpected = true;
      },
      (r: any) => {
        delete r.taskSha;
      },
      (r: any) => {
        r.itemId = "OTHER";
      },
      (r: any) => {
        r.snapshots[0].entries[0].extra = 1;
      },
      (r: any) => {
        r.snapshots[0].entries[1].path = "../escape";
      },
      (r: any) => {
        r.snapshots[0].entries.push(r.snapshots[0].entries[1]);
      },
      (r: any) => {
        r.record.activeRunId = "mixed";
        r.record.activeRunStartedAt = 1;
      },
    ]) {
      const value = JSON.parse(receipt.toString());
      change(value);
      writeFileSync(f.receipt, JSON.stringify(value));
      calls.length = 0;
      await assert.rejects(f.finish(), /receipt/i);
      assert.ok(
        !calls.some((args) =>
          ["fetch", "push", "commit-tree", "update-ref"].includes(args[0]),
        ),
      );
      assert.ok(existsSync(f.record.path));
    }
    writeFileSync(f.receipt, "{corrupt");
    git(
      f.repo,
      "update-ref",
      "-d",
      `refs/heads/${f.task.taskBranch}`,
      f.taskSha,
    );
    await assert.rejects(f.finish(), /receipt/i);
    assert.equal(f.tip(), tip);
    writeFileSync(f.receipt, receipt);
    git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    console.log(
      "PASS: strict version/fields/identity/snapshot parser blocks corrupt receipts, including with no local ref",
    );

    const cache = join(f.record.path, "ignored", "cache.bin"),
      bytes = readFileSync(cache);
    writeFileSync(cache, "mutated");
    await assert.rejects(f.finish(), /changed/);
    writeFileSync(cache, bytes);
    const added = join(f.record.path, "ignored", "added");
    writeFileSync(added, "new ignored data");
    await assert.rejects(f.finish(), /changed|added/);
    unlinkSync(added);
    const moved = join(root, "saved-cache");
    renameSync(cache, moved);
    writeFileSync(cache, bytes);
    await assert.rejects(f.finish(), /changed/);
    unlinkSync(cache);
    renameSync(moved, cache);
    const saved = join(root, "saved-worktree");
    renameSync(f.record.path, saved);
    cpSync(saved, f.record.path, { recursive: true });
    await assert.rejects(f.finish(), /changed/);
    rmSync(f.record.path, { recursive: true });
    renameSync(saved, f.record.path);
    renameSync(f.record.path, saved);
    symlinkSync(saved, f.record.path, "junction");
    await assert.rejects(f.finish(), /unmanaged|symlink/i);
    unlinkSync(f.record.path);
    renameSync(saved, f.record.path);
    const nested = join(f.record.path, "ignored", "nested");
    symlinkSync(root, nested, "junction");
    await assert.rejects(f.finish(), /symlink/i);
    unlinkSync(nested);
    mkdirSync(join(f.record.path, "ignored", ".git"));
    await assert.rejects(f.finish(), /Nested Git/);
    rmSync(join(f.record.path, "ignored", ".git"), { recursive: true });
    writeFileSync(join(f.repo, ".git", "index.lock"), "lock");
    await assert.rejects(f.finish(), /Locked/);
    unlinkSync(join(f.repo, ".git", "index.lock"));
    assert.deepEqual(readFileSync(f.receipt), receipt);
    assert.equal(f.tip(), tip);
    assert.ok(existsSync(f.record.path));
    console.log(
      "PASS: ignored changes/additions, identical file/directory replacement, root/nested junctions, nested Git and Git locks block without losing evidence",
    );

    let mutated = false;
    faults.afterFs = (operation, path) => {
      if (
        !mutated &&
        operation === "unlink" &&
        path.startsWith(f.record.path)
      ) {
        mutated = true;
        writeFileSync(added, "mutation after one checked delete");
      }
    };
    await assert.rejects(f.finish(), /changed|added/);
    faults.afterFs = undefined;
    assert.equal(mutated, true);
    assert.equal(
      readFileSync(added, "utf8"),
      "mutation after one checked delete",
    );
    assert.ok(
      existsSync(join(f.record.path, "feature.txt")),
      "next deletion must recheck mutations",
    );
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    unlinkSync(added);
    assert.equal(await f.finish(), tip);
    assert.equal(existsSync(f.record.path), false);
    console.log(
      "PASS: item-by-item cleanup rechecks mutation after each deletion, retains branch/receipt on failure, and accepts already-removed matching entries on retry",
    );
  }
} finally {
  dispose();
}
