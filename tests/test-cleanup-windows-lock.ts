import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./integration-fixture.js";
import { calls, faults, git, root, dispose } from "./cleanup-fixture.js";

try {
  const f = await integrationFixture();
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
      if (args[0] !== "clean") return;
      assert.deepEqual(args, ["clean", "-fdX"], "only ignored files are authorized for discard");
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
          /git clean -fdX failed/s,
          "failure must come from REAL Git, not an injected error",
        );
        console.log(`Real locked Git preparation diagnostic: ${error.message}`);
        return true;
      });
      assert.ok(child, "real exclusive lock was acquired");
      const integrated = f.tip(),
        integration = f.store.read(f.task.itemId)!.integration;
      assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
      assert.ok(existsSync(path));
      assert.ok(existsSync(f.recordFile));
      const registered = () => {
        assert.ok(existsSync(join(f.record.path, ".git")));
        assert.ok(existsSync(f.admin));
        assert.ok(git(f.repo, "worktree", "list", "--porcelain").includes(`branch refs/heads/${f.task.taskBranch}`));
        assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), f.taskSha);
        assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
        assert.ok(!calls.some((a) => a[0] === "worktree" && a[1] === "remove"));
      };
      registered();
      calls.length = 0;
      await f.tick(); // Real caller keeps CLOSED approval and retries only cleanup on Ready.
      registered();
      assert.equal(f.card.closed, true);
      assert.equal(f.card.status, f.cfg.columns.ready);
      assert.equal(f.store.read(f.task.itemId)!.retry?.stage, "cleanup");
      assert.deepEqual(f.store.read(f.task.itemId)!.integration, integration);
      assert.equal(f.tip(), integrated);
      writeFileSync(release, "release");
      await closed;
      calls.length = 0;
      await f.tick();
      assert.equal(f.card.closed, true);
      assert.equal(f.card.status, f.cfg.columns.done);
      assert.equal(f.tip(), integrated);
      assert.ok(calls.some((a) => a[0] === "worktree" && a[1] === "remove" && a.length === 3));
      assert.equal(await f.store.remoteSha(f.task.taskBranch), undefined);
      assert.ok(
        !calls.some((args) => ["merge-tree", "commit-tree"].includes(args[0]) ||
          (args[0] === "push" && args.some((a) => a.endsWith(":refs/heads/main")))),
        "cleanup does not repeat integration or the base push",
      );
      assert.equal(existsSync(f.record.path), false);
      assert.equal(existsSync(f.admin), false);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
      assert.equal(existsSync(f.recordFile), false);
      assert.equal(existsSync(f.receipt), false);
      console.log(
        "PASS: real Windows FileShare.None lock fails ignored Git preparation with registration/record/both refs retained; CLOSED Ready retry and release/restart complete native cleanup without reintegration",
      );
    } finally {
      writeFileSync(release, "release");
      await closed;
    }
  }
} finally {
  dispose();
}
