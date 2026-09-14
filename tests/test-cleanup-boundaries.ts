import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, legacy, calls, faults, git, dispose } from "./cleanup-fixture.js";

try {
  for (const kind of ["admin-index", "admin-locked", "common", "ref"] as const)
  for (const afterReceipt of [false, true]) {
    const f = await fixture();
    const lock = kind === "admin-index" ? join(f.admin, "index.lock")
      : kind === "admin-locked" ? join(f.admin, "locked")
      : kind === "common" ? join(f.repo, ".git", "index.lock")
      : join(f.repo, ".git", "refs", "heads", `${f.task.taskBranch}.lock`);
    if (afterReceipt) {
      faults.afterFs = (operation, path) => {
        if (operation === "link" && path.startsWith(f.receipt)) {
          faults.afterFs = undefined;
          writeFileSync(lock, "Git lock after snapshot");
        }
      };
    } else writeFileSync(lock, "Git lock before snapshot");
    calls.length = 0;
    await assert.rejects(f.finish(), /Locked|snapshot changed|added/i);
    faults.afterFs = undefined;
    assert.equal(existsSync(f.receipt), afterReceipt);
    assert.ok(existsSync(f.recordFile)); assert.ok(existsSync(f.record.path));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), f.taskSha);
    assert.ok(!calls.some((args) => args[0] === "worktree" && args[1] === "remove" || args[0] === "update-ref" || args[0] === "push" && args.includes(`:refs/heads/${f.task.taskBranch}`)));
    if (kind === "admin-index" && afterReceipt) {
      unlinkSync(lock);
      const integrated = f.tip(); calls.length = 0;
      assert.equal(await f.finish(), integrated);
      assert.equal(f.tip(), integrated);
      assert.ok(!calls.some((args) => args[0] === "commit-tree"));
    }
    console.log(`PASS: ${kind} Git lock ${afterReceipt ? "after" : "before"} receipt blocks cleanup and retains evidence`);
  }

  {
    const f = await fixture();
    faults.beforeGit = (args) => {
      if (args[0] === "push" && args.includes(`:refs/heads/${f.task.taskBranch}`)) {
        faults.beforeGit = undefined;
        git(f.origin, "update-ref", "refs/heads/main", f.base);
      }
    };
    await assert.rejects(f.finish(), /is not on origin/);
    assert.ok(existsSync(f.receipt)); assert.ok(existsSync(f.recordFile));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    console.log("PASS: remote base mutation during cleanup cannot delete the local retry ref or announce success");
  }

  {
    const f = await fixture();
    faults.beforeGit = (args) => {
      if (args[0] === "worktree" && args[1] === "remove") { faults.beforeGit = undefined; f.vanish(); throw new Error("partial remove"); }
    };
    await assert.rejects(f.finish(), /partial remove/);
    const saved = join(f.repo, "old-git");
    renameSync(join(f.repo, ".git"), saved); cpSync(saved, join(f.repo, ".git"), { recursive: true });
    calls.length = 0;
    await assert.rejects(f.finish(), /identity changed/);
    assert.ok(!calls.some((args) => ["fetch", "push", "update-ref"].includes(args[0])));
    assert.ok(existsSync(f.receipt)); assert.ok(existsSync(f.record.path));
    console.log("PASS: replacing the Git common directory with an identical copy invalidates receipt ownership before any remote/local cleanup");
  }

  {
    const f = await fixture(), integrated = legacy(f, "squash", "result");
    writeFileSync(join(f.repo, "feature.txt"), "later legitimate base edit\n");
    git(f.repo, "add", "feature.txt");
    const tree = git(f.repo, "write-tree");
    const later = git(f.repo, "commit-tree", tree, "-p", integrated, "-m", "later base edit");
    git(f.repo, "push", "origin", `${later}:refs/heads/main`);
    calls.length = 0;
    assert.equal(await f.finish("squash"), integrated, "known remote-confirmed old result means cleanup only, even if a fresh merge would conflict");
    assert.equal(f.tip(), later);
    assert.equal(readFileSync(join(f.repo, "feature.txt"), "utf8"), "later legitimate base edit\n");
    assert.ok(!calls.some((args) => args[0] === "commit-tree"));
    assert.equal(existsSync(f.record.path), false);
    console.log("PASS: confirmed legacy squash result survives later conflicting main edits; prove the old result and clean only, without remerging or modifying main");
  }

  {
    const f = await fixture();
    mkdirSync(join(f.record.path, "ignored", "bare", "objects"), { recursive: true });
    mkdirSync(join(f.record.path, "ignored", "bare", "refs"));
    writeFileSync(join(f.record.path, "ignored", "bare", "HEAD"), "ref: refs/heads/main\n");
    await assert.rejects(f.finish(), /Nested Git/);
    assert.ok(existsSync(f.record.path));
    assert.equal(existsSync(f.receipt), false);
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    console.log("PASS: nested bare Git identities are blocked even without a .git directory");
  }

  {
    const f = await fixture(); legacy(f, "merge", "result");
    const stale = join(f.repo, ".git", "worktrees", "ambiguous-admin");
    mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, "HEAD"), `ref: refs/heads/${f.task.taskBranch}\n`);
    await assert.rejects(f.finish(), /registration|ownership|worktree/i);
    assert.equal(existsSync(f.receipt), false);
    assert.ok(existsSync(stale));
    assert.ok(existsSync(f.record.path));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    console.log("PASS: unreceipted partial Git administration cannot be pruned, guessed or ignored before local-ref deletion");
  }

  {
    const f = await fixture();
    const original = readFileSync(f.recordFile);
    writeFileSync(f.recordFile, JSON.stringify({ ...f.record, activeRunId: "mixed", activeRunStartedAt: 1, finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha } }));
    calls.length = 0;
    await assert.rejects(f.finish(), /Corrupt|unsupported/);
    assert.ok(!calls.some((args) => ["fetch", "push", "merge-tree", "update-ref"].includes(args[0])));
    writeFileSync(f.recordFile, original);
    const remoteHook = join(f.origin, "hooks", "pre-receive");
    writeFileSync(remoteHook, "#!/bin/sh\nexit 1\n");
    const { chmodSync, unlinkSync } = await import("node:fs"); chmodSync(remoteHook, 0o755);
    await assert.rejects(f.finish(), /push/);
    assert.equal(existsSync(f.receipt), false, "no early cleanup intent on a rejected integration");
    assert.deepEqual(readFileSync(f.recordFile), original);
    unlinkSync(remoteHook);
    writeFileSync(join(f.origin, "hooks", "post-receive"), `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = refs/heads/main ]; then git update-ref refs/heads/main ${f.base}; fi\ndone\n`);
    chmodSync(join(f.origin, "hooks", "post-receive"), 0o755);
    await assert.rejects(f.finish(), /is not on origin/);
    assert.equal(existsSync(f.receipt), false, "even a successful push is not remote integration confirmation");
    assert.deepEqual(readFileSync(f.recordFile), original);
    assert.ok(existsSync(f.record.path));
    console.log("PASS: mixed v3 corruption, rejected push and unconfirmed successful push publish no receipt and preserve all source evidence");
    unlinkSync(join(f.origin, "hooks", "post-receive"));
    unlinkSync(f.recordFile);
    await assert.rejects(f.finish(), /Unknown\/unrecorded/);
    assert.ok(existsSync(f.record.path));
    assert.equal(existsSync(f.receipt), false);
    console.log("PASS: a local branch does not authorize deletion of an unrecorded managed directory");
  }

  {
    const f = await fixture();
    faults.beforeFs = (operation, path) => {
      if (operation === "link" && path.startsWith(f.receipt)) throw new Error("atomic publication refused");
    };
    await assert.rejects(f.finish(), /atomic publication refused/);
    faults.beforeFs = undefined;
    const integrated = f.tip();
    assert.notEqual(integrated, f.base);
    assert.equal(existsSync(f.receipt), false);
    assert.ok(existsSync(f.record.path)); assert.ok(existsSync(f.recordFile));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(await f.finish(), integrated, "publication failure must recover with a legacy backup, never duplicate integration");
    assert.equal(existsSync(f.record.path), false);
    assert.ok(existsSync(join(f.repo, ".pi", "board-agent", "cleanup-backups")));
    console.log("PASS: failed atomic publication leaves no partial receipt or cleanup; restart backs up the integrated legacy residual before retry");
  }

  {
    const f = await fixture();
    f.store.update(f.task.itemId, (record) => ({ ...record, finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha, resultSha: f.base } }));
    calls.length = 0;
    await assert.rejects(f.finish(), /legacy finalization result/i);
    assert.ok(!calls.some((args) => ["push", "commit-tree", "update-ref"].includes(args[0])));
    assert.equal(existsSync(f.receipt), false); assert.ok(existsSync(f.record.path));
    console.log("PASS: an ancestor OID alone cannot turn a corrupt legacy result into integration/cleanup authority");
  }

  {
    const f = await fixture();
    let injected = false, timerRan = false, scanYielded = false;
    faults.beforeFs = (operation, path) => {
      if (operation === "readdir" && path === join(f.record.path, "ignored")) setImmediate(() => { timerRan = true; });
    };
    faults.afterFs = (operation, path) => {
      if (operation === "link" && path.startsWith(f.receipt)) scanYielded = timerRan;
    };
    faults.beforeGit = (args) => {
      if (args[0] === "push" && args.includes(`:refs/heads/${f.task.taskBranch}`)) {
        assert.ok(existsSync(f.receipt));
        injected = true; writeFileSync(join(f.record.path, "ignored", "new-after-await"), "new user data");
      }
    };
    calls.length = 0;
    await assert.rejects(f.finish(), /changed|added/);
    faults.beforeGit = faults.beforeFs = faults.afterFs = undefined;
    assert.equal(injected, true); assert.equal(scanYielded, true, "full ignored snapshot yields before publication, not a synchronous traversal");
    assert.ok(!calls.some((args) => args[0] === "worktree" && args[1] === "remove"));
    assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
    assert.equal(readFileSync(join(f.record.path, "ignored", "new-after-await"), "utf8"), "new user data");
    assert.ok(existsSync(f.receipt));
    console.log("PASS: async ignored-file snapshot yields, and mutations during remote cleanup await block normal Git removal and retain receipt/ref");
  }
} finally { dispose(); }
