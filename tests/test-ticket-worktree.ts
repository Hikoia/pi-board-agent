import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  TicketWorktrees,
  type TicketExecutionRecord,
} from "../src/ticket-worktree.js";
import type { BuilderTask } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) process.exitCode = 1;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const remoteSha = (repo: string, branch: string) =>
  git(repo, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0];

interface Fixture {
  origin: string;
  repo: string;
  store: TicketWorktrees;
  task: BuilderTask;
  record: TicketExecutionRecord;
  reviewedSha: string;
}

let sequence = 0;
function fixture(): Fixture {
  const id = ++sequence;
  const dir = join(root, `case-${id}`);
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(dir, "init", "--bare", origin);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, ".gitignore"), ".pi/\n");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");

  const issueNumber = 100 + id;
  const task: BuilderTask = {
    itemId: `PVTI_${id}`,
    taskKey: `T${issueNumber}`,
    issueNumber,
    title: `Ticket ${issueNumber}`,
    body: "acceptance",
    taskBranch: `task/issue-${issueNumber}`,
    baseBranch: "main",
  };
  const store = new TicketWorktrees(repo);
  let record = store.ensure(task, `plan-${id}`);
  writeFileSync(join(record.path, `feature-${id}.txt`), `feature ${id}\n`);
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", `feat: ${id}`);
  git(record.path, "push", "-u", "origin", task.taskBranch);
  const reviewedSha = remoteSha(repo, task.taskBranch);
  record = store.update(task.itemId, (current) => ({
    ...current,
    reviewedTaskSha: reviewedSha,
  }));
  return { origin, repo, store, task, record, reviewedSha };
}

function rejects(
  f: Fixture,
  label: string,
  expectWorktree = true,
  expectedReason?: RegExp,
): void {
  const before = remoteSha(f.repo, "main");
  const taskBefore = remoteSha(f.repo, f.task.taskBranch);
  let reason = "";
  try {
    f.store.finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      f.task.title,
      "main",
    );
  } catch (error) {
    reason = String(error);
  }
  if (expectedReason) assert.match(reason, expectedReason, label);
  check(
    !!reason &&
      remoteSha(f.repo, "main") === before &&
      remoteSha(f.repo, f.task.taskBranch) === taskBefore &&
      f.store.has(f.task.itemId) &&
      existsSync(f.record.path) === expectWorktree,
    label,
  );
}

// Optional focused run for the final journal-deletion crash window; by default
// every Git/recovery regression below still runs.
if (process.env.TICKET_CLEANUP_RECORD_ONLY !== "1") {
  for (const strategy of ["squash", "merge"] as const) {
    const f = fixture();
    writeFileSync(join(f.repo, "base-only.txt"), "independent base change\n");
    git(f.repo, "add", "base-only.txt");
    git(f.repo, "commit", "-m", "base advances before approval");
    git(f.repo, "push", "origin", "main");
    const baseSha = remoteSha(f.repo, "main");
    const expectedTree = git(
      f.repo,
      "merge-tree",
      "--write-tree",
      baseSha,
      f.reviewedSha,
    ).split(/\s+/)[0];
    const result = f.store.finalizeAccepted(
      f.record,
      strategy,
      f.task.title,
      "main",
    );
    const parents = git(f.repo, "show", "-s", "--format=%P", result.resultSha);
    assert.equal(
      parents,
      strategy === "merge" ? `${baseSha} ${f.reviewedSha}` : baseSha,
    );
    assert.equal(
      git(f.repo, "show", "-s", "--format=%T", result.resultSha),
      expectedTree,
    );
    assert.equal(remoteSha(f.repo, "main"), result.resultSha);
    assert.equal(result.resumed, false);
    check(
      git(f.repo, "show", `origin/main:feature-${sequence}.txt`) ===
        `feature ${sequence}` &&
        git(f.repo, "show", "origin/main:base-only.txt") ===
          "independent base change" &&
        git(f.repo, "show", "-s", "--format=%B", result.resultSha)
          .split(/\r?\n/)
          .includes(`Board-Agent-Item: ${f.task.itemId}`),
      `${strategy} finalization pushes a deterministic exact-SHA result`,
    );
    let remoteTask = true;
    try {
      git(
        f.repo,
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        f.task.taskBranch,
      );
    } catch {
      remoteTask = false;
    }
    check(
      !f.store.has(f.task.itemId) &&
        !existsSync(f.record.path) &&
        !remoteTask &&
        f.store.isMerged(f.task.itemId, "main"),
      `${strategy} cleanup runs only after verified integration`,
    );
  }

  {
    const f = fixture();
    git(f.repo, "worktree", "remove", "--force", f.record.path);
    rejects(
      f,
      "missing managed worktree blocks finalization without recreation",
      false,
    );
  }
  {
    const f = fixture();
    f.store.update(f.task.itemId, (current) => ({
      ...current,
      reviewedTaskSha: undefined,
    }));
    try {
      const result = f.store.finalizeAccepted(
        f.store.read(f.task.itemId)!,
        "squash",
        f.task.title,
        "main",
      );
      check(
        remoteSha(f.repo, "main") === result.resultSha &&
          !f.store.has(f.task.itemId),
        "human-only approval pins the exact pushed SHA without requiring AI review",
      );
    } catch (error) {
      check(false, `human-only approval blocked: ${String(error)}`);
    }
  }
  {
    const f = fixture();
    writeFileSync(join(f.record.path, "dirty.txt"), "dirty\n");
    rejects(f, "dirty reviewed worktree blocks finalization");
  }
  {
    const f = fixture();
    writeFileSync(join(f.record.path, "local-drift.txt"), "drift\n");
    git(f.record.path, "add", ".");
    git(f.record.path, "commit", "-m", "local drift");
    rejects(f, "local task SHA drift blocks finalization");
  }
  {
    const f = fixture();
    const clone = join(root, `remote-drift-${sequence}`);
    git(root, "clone", f.origin, clone);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    git(clone, "checkout", f.task.taskBranch);
    writeFileSync(join(clone, "remote.txt"), "drift\n");
    git(clone, "add", ".");
    git(clone, "commit", "-m", "remote drift");
    git(clone, "push", "origin", f.task.taskBranch);
    rejects(f, "remote task SHA drift blocks finalization");
  }
  {
    const f = fixture();
    f.record = f.store.update(f.task.itemId, (current) => ({
      ...current,
      finalization: {
        targetBranch: "main",
        baseSha: remoteSha(f.repo, "main"),
        taskSha: f.reviewedSha,
      },
    }));
    writeFileSync(join(f.repo, "base-drift.txt"), "drift\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "base drift");
    git(f.repo, "push", "origin", "main");
    rejects(f, "remote base SHA drift blocks finalization");
  }
  {
    const f = fixture();
    git(f.repo, "worktree", "lock", f.record.path);
    rejects(f, "locked managed worktree blocks finalization");
    git(f.repo, "worktree", "unlock", f.record.path);
  }
  {
    const f = fixture();
    const tree = git(f.record.path, "write-tree");
    const unrelated = git(
      f.record.path,
      "commit-tree",
      tree,
      "-m",
      "unrelated",
    );
    git(f.record.path, "reset", "--hard", unrelated);
    git(f.record.path, "push", "--force", "origin", f.task.taskBranch);
    f.record = f.store.update(f.task.itemId, (current) => ({
      ...current,
      reviewedTaskSha: unrelated,
    }));
    rejects(f, "unrelated/conflicting task history blocks finalization");
  }
  {
    const f = fixture();
    const hook = join(f.origin, "hooks", "pre-receive");
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && exit 1; done\nexit 0\n',
    );
    chmodSync(hook, 0o755);
    rejects(f, "push rejection preserves the journal, branch, and worktree");
    const savedResult = f.store.read(f.task.itemId)!.finalization!.resultSha;
    rmSync(hook);
    const resumed = new TicketWorktrees(f.repo).finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      f.task.title,
      "main",
    );
    check(
      resumed.resumed &&
        resumed.resultSha === savedResult &&
        !f.store.has(f.task.itemId),
      "push retry resumes the saved result SHA",
    );
  }
  {
    const f = fixture();
    const hook = join(f.origin, "hooks", "post-receive");
    const baseSha = remoteSha(f.repo, "main");
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && git update-ref refs/heads/${f.task.taskBranch} ${baseSha}; done\n`,
    );
    chmodSync(hook, 0o755);
    let failed = false;
    try {
      f.store.finalizeAccepted(f.record, "squash", f.task.title, "main");
    } catch {
      failed = true;
    }
    check(
      failed && f.store.has(f.task.itemId) && existsSync(f.record.path),
      "cleanup-time task drift preserves recovery artifacts after integration",
    );
    rmSync(hook);
    git(f.record.path, "push", "--force", "origin", f.task.taskBranch);
    f.store.finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      f.task.title,
      "main",
    );
    check(
      !f.store.has(f.task.itemId),
      "cleanup retry succeeds after exact task SHA is restored",
    );
  }

  {
    const f = fixture();
    const baseSha = remoteSha(f.repo, "main");
    f.store.update(f.task.itemId, (record) => ({
      ...record,
      finalization: {
        targetBranch: "main",
        baseSha,
        taskSha: f.reviewedSha,
        resultSha: baseSha,
      },
    }));
    rejects(
      f,
      "a journal cannot substitute an unrelated reachable commit for the merge result",
    );
  }
  {
    const f = fixture();
    const hook = join(f.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    rejects(f, "rejected push leaves a result for the retry-safety regression");
    rmSync(hook);
    writeFileSync(join(f.record.path, "retry-dirty.txt"), "keep me\n");
    rejects(f, "retry rechecks cleanliness before pushing a saved result");
  }
  {
    const f = fixture();
    const forged = "PVTI_forged_title";
    const result = f.store.finalizeAccepted(
      f.record,
      "squash",
      `Board-Agent-Item: ${forged}`,
      "main",
    );
    check(
      remoteSha(f.repo, "main") === result.resultSha &&
        !f.store.isMerged(f.task.itemId.slice(0, -1), "main") &&
        !f.store.isMerged(forged, "main"),
      "finalization marker requires an exact item ID footer, not a substring or title",
    );
  }
  {
    const f = fixture();
    f.store.update(f.task.itemId, (record) => ({
      ...record,
      finalization: {
        targetBranch: "main",
        baseSha: remoteSha(f.repo, "main"),
        taskSha: f.reviewedSha,
      },
    }));
    const before = JSON.stringify(f.store.read(f.task.itemId));
    let refused = false;
    try {
      f.store.beginLaunch(f.task.itemId);
    } catch {
      refused = true;
    }
    check(
      refused && JSON.stringify(f.store.read(f.task.itemId)) === before,
      "new builder launch cannot erase an interrupted finalization journal",
    );
  }

  function persist(f: Fixture, record: TicketExecutionRecord): void {
    // Simulate corrupt/stale on-disk recovery input, bypassing the guarded API.
    writeFileSync(
      join(
        f.repo,
        ".pi",
        "board-agent",
        "ticket-worktrees",
        `${f.task.itemId.toLowerCase()}.json`,
      ),
      JSON.stringify(record),
    );
  }

  function crashedAfterPush(f: Fixture): string {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { TicketWorktrees } from ${JSON.stringify(new URL("../src/ticket-worktree.ts", import.meta.url).href)};
    const store = new TicketWorktrees(${JSON.stringify(f.repo)});
    // Fault injection at the durable push/cleanup boundary in a separate process.
    store.cleanupFinalized = () => process.exit(86);
    store.finalizeAccepted(store.read(${JSON.stringify(f.task.itemId)}), 'squash', 'crash regression', 'main');
  `,
      ],
      { encoding: "utf8", timeout: 180_000 },
    );
    assert.equal(child.status, 86, child.stderr);
    const state = new TicketWorktrees(f.repo).read(f.task.itemId)!
      .finalization!;
    assert.equal(remoteSha(f.repo, "main"), state.resultSha);
    assert.equal(state.taskSha, f.reviewedSha);
    assert.ok(existsSync(f.record.path));
    return state.resultSha!;
  }

  {
    const f = fixture();
    git(f.repo, "worktree", "remove", f.record.path);
    mkdirSync(f.record.path);
    writeFileSync(join(f.record.path, "unrelated.txt"), "preserve\n");
    rejects(
      f,
      "an unregistered directory is never adopted or removed",
      true,
      /unregistered/,
    );
    assert.equal(
      readFileSync(join(f.record.path, "unrelated.txt"), "utf8"),
      "preserve\n",
    );
  }
  {
    const f = fixture();
    rmSync(f.record.path, { recursive: true });
    rejects(
      f,
      "a missing registered worktree is never recreated",
      false,
      /missing/,
    );
    assert.ok(
      git(f.repo, "worktree", "list", "--porcelain").includes(
        f.task.taskBranch,
      ),
    );
  }
  {
    const f = fixture();
    git(f.record.path, "switch", "-c", "unrelated/branch");
    rejects(
      f,
      "wrong-branch worktree is not finalized",
      true,
      /expected branch/,
    );
    git(f.record.path, "checkout", "--detach");
    rejects(f, "detached worktree is not finalized", true, /expected branch/);
  }
  {
    const f = fixture();
    const outside = join(root, `outside-${sequence}`);
    git(f.repo, "worktree", "move", f.record.path, outside);
    symlinkSync(outside, f.record.path, "junction");
    rejects(
      f,
      "a managed-looking symlink cannot alias an external worktree",
      true,
      /unmanaged/,
    );
    assert.equal(git(outside, "rev-parse", "HEAD"), f.reviewedSha);
  }
  {
    const f = fixture();
    persist(f, { ...f.record, path: f.repo });
    rejects(
      f,
      "record path drift cannot redirect cleanup to the main checkout",
      true,
      /unmanaged/,
    );
    assert.equal(git(f.repo, "branch", "--show-current"), "main");
  }
  {
    const f = fixture();
    persist(f, { ...f.record, baseBranch: "other" });
    assert.throws(
      () => f.store.finalizeAccepted(f.record, "squash", f.task.title, "main"),
      /changed v3 record/,
    );
    rejects(
      f,
      "persisted base identity is revalidated, not just the caller snapshot",
      true,
      /branch identity/,
    );
  }
  {
    const f = fixture();
    const collision = { ...f.task, itemId: f.task.itemId.toLowerCase() };
    assert.equal(f.store.read(collision.itemId), undefined);
    assert.throws(
      () => f.store.ensure(collision, f.record.plan),
      /corrupt or unsupported/,
    );
    assert.equal(f.store.read(f.task.itemId)!.itemId, f.task.itemId);
    console.log(
      "PASS: sanitized record filename collisions cannot cross ticket identities",
    );
  }
  {
    const f = fixture();
    writeFileSync(join(f.repo, "shared.txt"), "base conflict\n");
    git(f.repo, "add", "shared.txt");
    git(f.repo, "commit", "-m", "conflicting base");
    git(f.repo, "push", "origin", "main");
    writeFileSync(join(f.record.path, "shared.txt"), "task conflict\n");
    git(f.record.path, "add", "shared.txt");
    git(f.record.path, "commit", "-m", "conflicting task");
    git(f.record.path, "push", "origin", f.task.taskBranch);
    f.store.setReviewedTaskSha(
      f.task.itemId,
      remoteSha(f.repo, f.task.taskBranch),
    );
    rejects(
      f,
      "real merge conflicts retain exact intent and both branch tips",
      true,
      /merge-tree/,
    );
  }

  for (const invalid of ["tree", "parents", "marker", "strategy"] as const) {
    const f = fixture();
    const baseSha = remoteSha(f.repo, "main");
    const tree = git(
      f.repo,
      "rev-parse",
      `${invalid === "tree" ? baseSha : f.reviewedSha}^{tree}`,
    );
    const parentArgs =
      invalid === "strategy"
        ? ["-p", baseSha, "-p", f.reviewedSha]
        : ["-p", invalid === "parents" ? f.reviewedSha : baseSha];
    const resultSha = git(
      f.repo,
      "commit-tree",
      tree,
      ...parentArgs,
      "-m",
      `Board-Agent-Item: ${f.task.itemId}${invalid === "marker" ? "-different" : ""}`,
    );
    f.store.update(f.task.itemId, (record) => ({
      ...record,
      finalization: {
        targetBranch: "main",
        baseSha,
        taskSha: f.reviewedSha,
        resultSha,
      },
    }));
    rejects(
      f,
      `a saved result with wrong ${invalid} is not pushed or cleaned`,
      true,
      /exact tree, parents or item marker/,
    );
  }
  {
    const f = fixture();
    f.store.update(f.task.itemId, (record) => ({
      ...record,
      finalization: {
        targetBranch: "main",
        baseSha: remoteSha(f.repo, "main"),
        taskSha: f.reviewedSha,
      },
    }));
    const before = JSON.stringify(f.store.read(f.task.itemId));
    for (const mutate of [
      () => f.store.setReviewedTaskSha(f.task.itemId, f.reviewedSha),
      () => f.store.setActiveRun(f.task.itemId, "another-run"),
      () =>
        f.store.update(f.task.itemId, (record) => ({
          ...record,
          finalization: undefined,
        })),
      () =>
        f.store.update(f.task.itemId, (record) => {
          record.finalization!.baseSha = f.reviewedSha;
          return record;
        }),
    ])
      assert.throws(mutate, /finalization/);
    assert.equal(JSON.stringify(f.store.read(f.task.itemId)), before);
    console.log(
      "PASS: review, execution and nested updates cannot overwrite pending journal identity",
    );
  }

  {
    const f = fixture();
    const baseSha = remoteSha(f.repo, "main");
    const tree = git(f.repo, "rev-parse", `${baseSha}^{tree}`);
    const competing = git(
      f.repo,
      "commit-tree",
      tree,
      "-p",
      baseSha,
      "-m",
      "competing push",
    );
    // Copy the object into the disposable bare remote without changing main yet.
    git(f.repo, "push", "origin", `${competing}:refs/heads/racer`);
    const hook = join(f.repo, ".git", "hooks", "pre-push");
    writeFileSync(
      hook,
      `#!/bin/sh\ngit --git-dir="$2" update-ref refs/heads/main ${competing} ${baseSha}\n`,
    );
    chmodSync(hook, 0o755);
    assert.throws(
      () => f.store.finalizeAccepted(f.record, "squash", f.task.title, "main"),
      /push/,
    );
    const saved = f.store.read(f.task.itemId)!.finalization!;
    assert.equal(remoteSha(f.repo, "main"), competing);
    assert.equal(remoteSha(f.repo, f.task.taskBranch), f.reviewedSha);
    assert.ok(saved.resultSha && existsSync(f.record.path));
    rmSync(hook);
    rejects(
      f,
      "non-force base push loses a real advertisement/update race and never overwrites the winner",
      true,
      /moved from approved/,
    );
  }

  {
    const f = fixture();
    const result = crashedAfterPush(f);
    // A stale tracking ref is not proof that the result is still on the server.
    git(f.origin, "update-ref", "-d", "refs/heads/main");
    rejects(
      f,
      "failed verification fetch cannot use a stale integrated tracking ref for cleanup",
      true,
      /fetch/,
    );
    git(f.origin, "update-ref", "refs/heads/main", result);
    const descendant = git(
      f.repo,
      "commit-tree",
      git(f.repo, "rev-parse", `${result}^{tree}`),
      "-p",
      result,
      "-m",
      "later base change",
    );
    git(f.repo, "push", "origin", `${descendant}:refs/heads/main`);
    const resumed = new TicketWorktrees(f.repo).finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      "restart",
      "main",
    );
    assert.equal(resumed.resultSha, result);
    assert.equal(resumed.resumed, true);
    assert.equal(remoteSha(f.repo, "main"), descendant);
    assert.equal(
      git(
        f.repo,
        "log",
        "--format=%H",
        "--fixed-strings",
        `--grep=Board-Agent-Item: ${f.task.itemId}`,
        "origin/main",
      ),
      result,
    );
    assert.equal(f.store.has(f.task.itemId), false);
    console.log(
      "PASS: crash-after-push process restart performs cleanup only, preserving later base commits",
    );
  }
  {
    const f = fixture();
    crashedAfterPush(f);
    writeFileSync(join(f.record.path, "dirty-cleanup.txt"), "preserve\n");
    rejects(f, "post-push dirty artifacts prevent all cleanup", true, /dirty/);
    rmSync(join(f.record.path, "dirty-cleanup.txt"));
    git(f.repo, "worktree", "lock", f.record.path);
    rejects(
      f,
      "post-push locked artifacts prevent all cleanup",
      true,
      /locked/i,
    );
    git(f.repo, "worktree", "unlock", f.record.path);
    git(f.record.path, "switch", "-c", "unrelated/same-sha");
    rejects(
      f,
      "cleanup never deletes an unrelated registered branch even at the approved SHA",
      true,
      /expected branch/,
    );
    assert.equal(
      git(f.record.path, "branch", "--show-current"),
      "unrelated/same-sha",
    );
    git(f.record.path, "switch", f.task.taskBranch);
    git(f.repo, "worktree", "remove", f.record.path);
    const elsewhere = join(root, `unrelated-checkout-${sequence}`);
    git(f.repo, "worktree", "add", elsewhere, f.task.taskBranch);
    rejects(
      f,
      "partial cleanup cannot delete a task ref checked out at another path",
      false,
      /another worktree/,
    );
    assert.equal(git(elsewhere, "rev-parse", "HEAD"), f.reviewedSha);
    git(f.repo, "worktree", "remove", elsewhere);
    mkdirSync(f.record.path);
    writeFileSync(join(f.record.path, "unregistered.txt"), "preserve\n");
    rejects(
      f,
      "post-push unregistered directory is preserved",
      true,
      /unregistered/,
    );
    rmSync(f.record.path, { recursive: true });
    git(
      f.repo,
      "update-ref",
      "--no-deref",
      "-d",
      `refs/heads/${f.task.taskBranch}`,
    );
    git(
      f.repo,
      "symbolic-ref",
      `refs/heads/${f.task.taskBranch}`,
      "refs/heads/unrelated/same-sha",
    );
    rejects(
      f,
      "cleanup refuses a task ref alias to an unrelated branch",
      false,
      /symbolic/,
    );
    assert.equal(
      git(f.repo, "rev-parse", "refs/heads/unrelated/same-sha"),
      f.reviewedSha,
    );
    git(f.repo, "symbolic-ref", "--delete", `refs/heads/${f.task.taskBranch}`);
    git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.reviewedSha);
    const resumed = new TicketWorktrees(f.repo).finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      "restart",
      "main",
    );
    assert.equal(resumed.resumed, true);
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(
      git(f.repo, "rev-parse", "refs/heads/unrelated/same-sha"),
      f.reviewedSha,
    );
    console.log(
      "PASS: partial worktree-only cleanup resumes without recreation or pruning unrelated branches",
    );
  }
  {
    const f = fixture();
    const hook = join(f.origin, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = refs/heads/${f.task.taskBranch} ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi\ndone\nexit 0\n`,
    );
    chmodSync(hook, 0o755);
    assert.throws(
      () => f.store.finalizeAccepted(f.record, "squash", f.task.title, "main"),
      /push/,
    );
    const state = f.store.read(f.task.itemId)!.finalization!;
    assert.equal(remoteSha(f.repo, "main"), state.resultSha);
    assert.equal(remoteSha(f.repo, f.task.taskBranch), state.taskSha);
    assert.equal(existsSync(f.record.path), false);
    assert.throws(() =>
      git(f.repo, "rev-parse", "--verify", `refs/heads/${f.task.taskBranch}`),
    );
    rmSync(hook);
    const resumed = new TicketWorktrees(f.repo).finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      "restart",
      "main",
    );
    assert.equal(resumed.resultSha, state.resultSha);
    assert.equal(f.store.has(f.task.itemId), false);
    assert.equal(existsSync(f.record.path), false);
    assert.equal(remoteSha(f.repo, f.task.taskBranch), "");
    console.log(
      "PASS: remote-delete rejection resumes after worktree and local-ref cleanup without rebuilding",
    );
  }

  {
    const f = fixture();
    const baseSha = remoteSha(f.repo, "main");
    const hook = join(f.origin, "hooks", "post-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = refs/heads/main ]; then git update-ref refs/heads/main ${baseSha}; fi\ndone\n`,
    );
    chmodSync(hook, 0o755);
    rejects(
      f,
      "a successful push response without a reachable result cannot trigger cleanup",
      true,
      /is not on origin/,
    );
    const saved = f.store.read(f.task.itemId)!.finalization!.resultSha!;
    assert.notEqual(saved, baseSha);
    rmSync(hook);
    assert.equal(
      new TicketWorktrees(f.repo).finalizeAccepted(
        f.store.read(f.task.itemId)!,
        "squash",
        "retry",
        "main",
      ).resultSha,
      saved,
    );
    assert.equal(remoteSha(f.repo, "main"), saved);
    console.log(
      "PASS: post-push verification failure retries the same saved result after the remote is repaired",
    );
  }
  {
    const f = fixture();
    crashedAfterPush(f);
    const tree = git(f.repo, "rev-parse", `${f.reviewedSha}^{tree}`);
    const competing = git(
      f.repo,
      "commit-tree",
      tree,
      "-p",
      f.reviewedSha,
      "-m",
      "new task work during cleanup",
    );
    git(f.repo, "push", "origin", `${competing}:refs/heads/cleanup-racer`);
    const hook = join(f.repo, ".git", "hooks", "pre-push");
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n if [ "$remote_ref" = refs/heads/${f.task.taskBranch} ]; then git --git-dir="$2" update-ref "$remote_ref" ${competing} ${f.reviewedSha}; fi\ndone\n`,
    );
    chmodSync(hook, 0o755);
    assert.throws(
      () =>
        new TicketWorktrees(f.repo).finalizeAccepted(
          f.store.read(f.task.itemId)!,
          "squash",
          "cleanup race",
          "main",
        ),
      /push/,
    );
    assert.equal(remoteSha(f.repo, f.task.taskBranch), competing);
    assert.ok(f.store.has(f.task.itemId));
    assert.equal(existsSync(f.record.path), false);
    rmSync(hook);
    git(
      f.origin,
      "update-ref",
      `refs/heads/${f.task.taskBranch}`,
      f.reviewedSha,
      competing,
    );
    new TicketWorktrees(f.repo).finalizeAccepted(
      f.store.read(f.task.itemId)!,
      "squash",
      "cleanup repair",
      "main",
    );
    assert.equal(remoteSha(f.repo, "cleanup-racer"), competing);
    assert.equal(f.store.has(f.task.itemId), false);
    console.log(
      "PASS: cleanup deletion lease loses a real ref race without deleting new remote work; remaining cleanup resumes",
    );
  }
}

{
  const f = fixture();
  const index = git(
    f.record.path,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  );
  const healthyIndex = readFileSync(index);
  writeFileSync(index, "corrupt index");
  assert.equal(
    f.store.check(f.record, false).ok,
    false,
    "an unreadable status is not a safely owned dirty checkpoint",
  );
  rejects(
    f,
    "unreadable worktree status blocks finalization and dirty resume",
    true,
    /cannot read worktree status/,
  );
  writeFileSync(index, healthyIndex);

  // Interrupt the last local step, after ALL real Git cleanup has succeeded.
  // The disk journal must be sufficient even when neither task ref exists.
  (f.store as unknown as { clear(itemId: string): void }).clear = () => {
    throw new Error("interrupted before record deletion");
  };
  assert.throws(
    () => f.store.finalizeAccepted(f.record, "squash", f.task.title, "main"),
    /interrupted before record deletion/,
  );
  const saved = f.store.read(f.task.itemId)!.finalization!;
  assert.equal(remoteSha(f.repo, "main"), saved.resultSha);
  assert.equal(remoteSha(f.repo, f.task.taskBranch), "");
  assert.equal(existsSync(f.record.path), false);
  assert.throws(() =>
    git(f.repo, "rev-parse", "--verify", `refs/heads/${f.task.taskBranch}`),
  );
  const resumed = new TicketWorktrees(f.repo).finalizeAccepted(
    f.store.read(f.task.itemId)!,
    "squash",
    "restart",
    "main",
  );
  assert.equal(resumed.resultSha, saved.resultSha);
  assert.equal(resumed.resumed, true);
  assert.equal(f.store.has(f.task.itemId), false);
  assert.equal(existsSync(f.record.path), false);
  assert.equal(remoteSha(f.repo, "main"), saved.resultSha);
  console.log(
    "PASS: interruption after remote deletion resumes from the sole remaining journal without recreating either ref or worktree",
  );
}
