
const { testOwner, noPullRequests } = await import("./pr-fixture.js");
const { simulateHumanFinalization } = await import("./human-finalization-fixture.js");
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, calls, faults, root, dispose, TicketWorktrees } from "./cleanup-fixture.js";

try {
  for (const lockedFile of process.platform === "win32" ? ["ignored", "tracked"] : ["native"]) {
  const f = await fixture(true, true);
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
    const path = lockedFile === "ignored" ? join(f.record.path, "ignored", "cache.bin") : join(f.record.path, "feature.txt"),
      expected = lockedFile === "ignored" ? Buffer.from([0, 1, 2, 255]) : Buffer.from("feature\n"),
      release = join(root, `release-exclusive-lock-${lockedFile}`);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<void> | undefined;
    faults.beforeGit = async (args) => {
      if (lockedFile === "ignored" ? args[0] !== "clean" : args[0] !== "worktree" || args[1] !== "remove") return;
      faults.beforeGit = undefined;
      assert.ok(
        existsSync(f.recordFile),
        "lock is acquired only after integration publication and all pre-removal checks",
      );
      const script = `$ErrorActionPreference='Stop'; $f=[IO.File]::Open(${quote(path)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); $end=[DateTime]::UtcNow.AddSeconds(180); while (!(Test-Path -LiteralPath ${quote(release)})) { if ([DateTime]::UtcNow -gt $end) { throw 'exclusive lock release deadline exceeded' }; Start-Sleep -Milliseconds 50 } } finally { $f.Dispose() }`;
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PSModuleAnalysisCachePath: join(root, "powershell-module-cache") },
        },
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
          /git (?:clean|worktree remove) .*failed/s,
          "failure must come from REAL Git, not an injected error",
        );
        console.log(`Real locked Git removal diagnostic: ${error.message}`);
        return true;
      });
      assert.ok(child, "real exclusive lock was acquired");
      if (lockedFile === "ignored") {
        assert.equal(await f.store.remoteSha(f.task.taskBranch), (f.store.read(f.task.itemId)!.integration as import("../src/ticket-worktree.js").TicketPullRequestIntegration).preparedHeadSha, "ignored-file clean fails before remote ref deletion");
        assert.ok(f.store.worktreeEntries().some((entry) => resolve(entry.path) === resolve(f.record.path)));
      }
      const integrated = f.tip(),
        progress = readFileSync(f.recordFile);
      assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
      assert.ok(existsSync(path));
      assert.ok(existsSync(f.recordFile));
      await assert.rejects(f.finish(), /EBUSY|EACCES|EPERM|worktree|git clean|cleanup|Unregistered residual/i);
      assert.deepEqual(readFileSync(f.recordFile), progress);
      assert.equal(f.tip(), integrated);
      writeFileSync(release, "release");
      await closed;
      assert.deepEqual(readFileSync(path), expected, "the exclusively locked original bytes survived the failed cleanup");
      calls.length = 0;
      const registered = f.store.worktreeEntries().some((entry) => resolve(entry.path) === resolve(f.record.path));
      if (registered) {
        assert.equal(await f.finish(), integrated);
        assert.equal(existsSync(f.record.path), false);
        assert.equal(existsSync(f.admin), false);
        assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
        assert.equal(existsSync(f.recordFile), false);
        console.log("PASS: Windows FileShare.None failure retains registered work; unlock permits normal cleanup without reintegration");
      } else {
        // Some Git-for-Windows versions remove registration even when a locked
        // child survives. V4 must not invent a snapshot or recursive fallback.
        const restarted = new TicketWorktrees(f.repo, testOwner(f.repo));
        await assert.rejects(simulateHumanFinalization(restarted, f.task), /Unregistered residual requires existing legacy evidence/);
        assert.deepEqual(readFileSync(f.recordFile), progress);
        assert.deepEqual(readFileSync(path), expected);
        assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
        assert.equal(existsSync(f.receipt), false);
        assert.equal(existsSync(join(f.repo, ".pi", "board-agent", "cleanup-backups")), false);
        assert.ok(!calls.some((args) => args[0] === "worktree" && args[1] === "remove"));
        console.log("PASS: real Windows FileShare.None failure leaves unregistered residuals on this Git; unlock/restart retains exact bytes/ref/progress for manual inspection, never inferred ownership or recursive cleanup");
      }
      assert.equal(f.tip(), integrated);
      assert.ok(!calls.some((args) => ["merge-tree", "commit-tree"].includes(args[0])), "no reintegration after unlocking");
    } finally {
      writeFileSync(release, "release");
      await closed;
    }
  }
  }
} finally {
  dispose();
}
