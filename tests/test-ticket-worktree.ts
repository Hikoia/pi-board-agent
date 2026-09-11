import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { TicketWorktrees } from "../src/ticket-worktree.js";
import type { BuilderTask } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let sequence = 0;
function fixture() {
  const dir = join(root, `case-${++sequence}`);
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
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const task: BuilderTask = {
    itemId: `PVTI_${sequence}`,
    taskKey: `T${sequence}`,
    issueNumber: sequence,
    title: "Accepted ticket",
    body: "acceptance",
    taskBranch: `task/issue-${sequence}`,
    baseBranch: "main",
  };
  const store = new TicketWorktrees(repo);
  const record = store.ensure(task, "demo");
  writeFileSync(join(record.path, "feature.txt"), "feature\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "feature");
  git(record.path, "push", "-u", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  const tip = (branch = "main") =>
    git(repo, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0];
  const finish = (strategy: "squash" | "merge" = "squash") =>
    store.finalizeAccepted(task, strategy);
  const kept = () => {
    assert.equal(tip(), baseSha);
    assert.equal(store.localBranchSha(task.taskBranch), taskSha);
    assert.ok(existsSync(record.path));
  };
  return {
    repo,
    origin,
    task,
    store,
    record,
    baseSha,
    taskSha,
    tip,
    finish,
    kept,
  };
}

{
  const f = fixture();
  writeFileSync(join(f.record.path, "dirty.txt"), "keep me\n");
  assert.throws(() => f.finish(), /Dirty worktree/);
  f.kept();
  rmSync(join(f.record.path, "dirty.txt"));
  git(f.repo, "worktree", "lock", f.record.path);
  assert.throws(() => f.finish(), /Locked worktree/);
  f.kept();
  git(f.repo, "worktree", "unlock", f.record.path);
  const index = git(
    f.record.path,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  );
  const healthy = readFileSync(index);
  writeFileSync(index, "corrupt index");
  assert.equal(f.store.check(f.record, false).ok, false);
  assert.throws(() => f.finish(), /status/);
  f.kept();
  writeFileSync(index, healthy);
  writeFileSync(join(f.repo, "main-dirty.txt"), "leave main alone\n");
  const result = f.finish();
  assert.equal(f.tip(), result);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.baseSha);
  assert.equal(
    readFileSync(join(f.repo, "main-dirty.txt"), "utf8"),
    "leave main alone\n",
  );
  assert.equal(f.store.localBranchSha(f.task.taskBranch), undefined);
  assert.equal(f.tip(f.task.taskBranch), "");
  assert.equal(existsSync(f.record.path), false);
  assert.equal(f.store.has(f.task.itemId), false);
  console.log(
    "PASS: dirty, locked and unreadable task worktrees are preserved; clean finalization never modifies the main checkout",
  );
}
{
  const f = fixture();
  writeFileSync(join(f.repo, "shared.txt"), "base conflict\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "base conflict");
  git(f.repo, "push", "origin", "main");
  writeFileSync(join(f.record.path, "shared.txt"), "task conflict\n");
  git(f.record.path, "add", ".");
  git(f.record.path, "commit", "-m", "task conflict");
  const base = f.tip();
  const local = f.store.localBranchSha(f.task.taskBranch);
  assert.throws(() => f.finish(), /merge-tree/);
  assert.equal(f.tip(), base);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
  assert.ok(existsSync(f.record.path));
  console.log(
    "PASS: merge conflicts preserve the local branch and worktree without a push",
  );
}
{
  const f = fixture();
  const hook = join(f.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  assert.throws(() => f.finish(), /push/);
  f.kept();
  assert.equal(f.store.read(f.task.itemId)!.finalization, undefined);
  rmSync(hook);
  writeFileSync(join(f.repo, "later.txt"), "later base work\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "base advances");
  git(f.repo, "push", "origin", "main");
  const result = f.finish();
  assert.equal(f.tip(), result);
  assert.equal(git(f.repo, "show", "origin/main:later.txt"), "later base work");
  assert.equal(git(f.repo, "show", "origin/main:feature.txt"), "feature");
  console.log(
    "PASS: rejected pushes retain all work; retry merges into the latest base without a journal",
  );
}
{
  const f = fixture();
  const newer = git(
    f.repo,
    "commit-tree",
    git(f.repo, "rev-parse", `${f.taskSha}^{tree}`),
    "-p",
    f.taskSha,
    "-m",
    "remote-only work",
  );
  git(f.repo, "push", "origin", `${newer}:refs/heads/${f.task.taskBranch}`);
  assert.throws(() => f.finish(), /unmerged work/);
  assert.equal(f.tip(f.task.taskBranch), newer);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
  assert.ok(existsSync(f.record.path));
  git(f.record.path, "merge", "--ff-only", newer);
  f.finish("merge");
  git(f.repo, "merge-base", "--is-ancestor", newer, "origin/main");
  assert.equal(f.tip(f.task.taskBranch), "");
  console.log(
    "PASS: remote-only commits are never deleted; integrating them locally permits normal cleanup",
  );
}
{
  const f = fixture();
  const newer = git(
    f.repo,
    "commit-tree",
    git(f.repo, "rev-parse", `${f.taskSha}^{tree}`),
    "-p",
    f.taskSha,
    "-m",
    "local race",
  );
  const hook = join(f.repo, ".git", "hooks", "pre-push");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n if [ "$remote_ref" = refs/heads/main ]; then git update-ref refs/heads/${f.task.taskBranch} ${newer} ${f.taskSha}; fi\ndone\n`,
  );
  chmodSync(hook, 0o755);
  assert.throws(() => f.finish(), /Local .* moved/);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), newer);
  assert.equal(f.tip(f.task.taskBranch), f.taskSha);
  assert.ok(existsSync(f.record.path));
  console.log(
    "PASS: local branch movement during the push prevents cleanup of newer work",
  );
}
{
  const f = fixture();
  const newer = git(
    f.repo,
    "commit-tree",
    git(f.repo, "rev-parse", `${f.taskSha}^{tree}`),
    "-p",
    f.taskSha,
    "-m",
    "remote race",
  );
  git(f.repo, "push", "origin", `${newer}:refs/heads/racer`);
  const hook = join(f.repo, ".git", "hooks", "pre-push");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n if [ "$remote_ref" = refs/heads/${f.task.taskBranch} ]; then git --git-dir="$2" update-ref "$remote_ref" ${newer} ${f.taskSha}; fi\ndone\n`,
  );
  chmodSync(hook, 0o755);
  assert.throws(() => f.finish(), /push/);
  assert.equal(f.tip(f.task.taskBranch), newer);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
  assert.ok(existsSync(f.record.path));
  console.log(
    "PASS: the remote deletion lease preserves a concurrent update and keeps the local retry branch",
  );
}
{
  const f = fixture();
  const hook = join(f.origin, "hooks", "post-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = refs/heads/main ]; then git update-ref refs/heads/main ${f.baseSha}; fi\ndone\n`,
  );
  chmodSync(hook, 0o755);
  assert.throws(() => f.finish(), /is not on origin/);
  f.kept();
  rmSync(hook);
  assert.ok(f.finish());
  console.log(
    "PASS: a successful push response without verified integration never triggers cleanup",
  );
}
{
  const f = fixture();
  const outside = join(root, `outside-${sequence}`);
  git(f.repo, "worktree", "move", f.record.path, outside);
  symlinkSync(outside, f.record.path, "junction");
  assert.throws(() => f.finish(), /unmanaged/);
  assert.equal(git(outside, "rev-parse", "HEAD"), f.taskSha);
  assert.equal(f.tip(), f.baseSha);
  assert.throws(
    () => f.store.finalizeAccepted({ ...f.task, taskBranch: "main" }, "merge"),
    /must differ/,
  );
  console.log(
    "PASS: finalization never removes external worktrees, symlink aliases or the base branch",
  );
}
{
  const f = fixture();
  git(
    f.repo,
    "symbolic-ref",
    `refs/heads/${f.task.taskBranch}`,
    "refs/heads/main",
  );
  assert.throws(() => f.finish(), /symbolic/);
  assert.equal(f.tip(), f.baseSha);
  assert.throws(() => f.store.localBranchSha("-invalid"), /Invalid branch/);
  console.log(
    "PASS: symbolic or invalid local refs cannot redirect merge or deletion",
  );
}
{
  const f = fixture();
  const collision = { ...f.task, itemId: f.task.itemId.toLowerCase() };
  assert.equal(f.store.read(collision.itemId), undefined);
  assert.throws(
    () => f.store.ensure(collision, "demo"),
    /corrupt or unsupported/,
  );
  f.store.update(f.task.itemId, (record) => ({
    ...record,
    finalization: {
      targetBranch: "main",
      baseSha: f.baseSha,
      taskSha: f.taskSha,
    },
  }));
  const before = JSON.stringify(f.store.read(f.task.itemId));
  assert.throws(
    () => f.store.beginLaunch(f.task.itemId),
    /pending finalization/,
  );
  assert.equal(JSON.stringify(f.store.read(f.task.itemId)), before);
  // Legacy execution state remains protected for builders, but does not gate human-approved completion.
  assert.ok(f.finish());
  assert.equal(f.store.has(f.task.itemId), false);
  console.log(
    "PASS: builder identity and legacy-journal protections remain; closed-ticket finalization needs neither",
  );
}
