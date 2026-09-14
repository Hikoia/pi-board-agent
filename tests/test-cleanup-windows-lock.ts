import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, calls, faults, root, dispose } from "./cleanup-fixture.js";

try {
  const f = await fixture(true);
  if (process.platform !== "win32") {
    calls.length = 0;
    assert.ok(await f.finish());
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "worktree" && args[1] === "remove" && args.length === 3,
      ),
    );
    assert.equal(existsSync(f.record.path), false);
    console.log(
      "PASS: real registered worktree uses normal Git removal, no force/prune/unlock",
    );
    console.log(
      "SKIP: Windows FileShare.None exclusive lock requires Windows; deterministic partial-removal tests run on both platforms",
    );
  } else {
    const path = join(f.record.path, "ignored", "cache.bin"),
      release = join(root, "release-exclusive-lock");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<void> | undefined;
    faults.beforeGit = async (args) => {
      if (args[0] !== "worktree" || args[1] !== "remove") return;
      faults.beforeGit = undefined;
      assert.ok(
        !!f.store.read(f.task.itemId)?.integration,
        "lock is acquired only after result publication and fresh remote confirmation",
      );
      const script = `$ErrorActionPreference='Stop'; $f=[IO.File]::Open(${quote(path)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); $end=[DateTime]::UtcNow.AddSeconds(180); while (!(Test-Path -LiteralPath ${quote(release)})) { if ([DateTime]::UtcNow -gt $end) { throw 'exclusive lock release deadline exceeded' }; Start-Sleep -Milliseconds 50 } } finally { $f.Dispose() }`;
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "",
        errors = "";
      closed = new Promise<void>((resolve, reject) => {
        child!.once("error", reject);
        child!.stderr!.on("data", (chunk) => {
          errors += chunk;
        });
        child!.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`lock helper exit ${code}: ${errors}`)),
        );
      });
      void closed.catch(() => undefined);
      await Promise.race([
        new Promise<void>((resolve) =>
          child!.stdout!.on("data", (chunk) => {
            output += chunk;
            if (output.includes("LOCKED")) resolve();
          }),
        ),
        closed.then(() => {
          throw new Error("lock helper closed without acquiring lock");
        }),
      ]);
      assert.throws(
        () => readFileSync(path),
        /EBUSY|EACCES|EPERM/,
        "real exclusive Windows lock denies a separate file read",
      );
    };
    try {
      await assert.rejects(f.finish(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /git worktree remove .*failed/s,
          "failure must come from REAL Git, not an injected error",
        );
        console.log(`Real locked Git removal diagnostic: ${error.message}`);
        return true;
      });
      assert.ok(child, "real exclusive lock was acquired");
      const integrated = f.tip(),
        integration = f.store.read(f.task.itemId)!.integration;
      assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
      assert.ok(existsSync(path));
      assert.ok(existsSync(f.recordFile));
      await assert.rejects(f.finish(), /EBUSY|EACCES|EPERM|worktree|cleanup/i);
      assert.deepEqual(f.store.read(f.task.itemId)!.integration, integration);
      assert.equal(f.tip(), integrated);
      writeFileSync(release, "release");
      await closed;
      calls.length = 0;
      assert.equal(await f.finish(), integrated);
      assert.equal(f.tip(), integrated);
      assert.ok(
        !calls.some((args) => ["merge-tree", "commit-tree"].includes(args[0])),
      );
      assert.equal(existsSync(f.record.path), false);
      assert.equal(existsSync(f.admin), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(existsSync(f.recordFile), false);
      assert.equal(existsSync(f.receipt), false);
      console.log(
        "PASS: real Windows FileShare.None lock makes real Git removal fail; locked retry preserves evidence; release/restart completes native cleanup without reintegration",
      );
    } finally {
      writeFileSync(release, "release");
      await closed;
    }
  }
} finally {
  dispose();
}
