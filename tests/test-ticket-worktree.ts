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
async function fixture() {
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
  const record = await store.ensure(task, "demo");
  writeFileSync(join(record.path, "feature.txt"), "feature\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "feature");
  git(record.path, "push", "-u", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  const tip = (branch = "main") =>
    git(repo, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0];
  const finish = async (strategy: "squash" | "merge" = "squash") => {
    const result = await store.finalizeAccepted(task, strategy);
    if (result) await store.completeFinalization(task, async () => {});
    return result;
  };
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
  const f = await fixture();
  assert.equal(f.record.schemaVersion, 4);
  const task = { ...f.task, itemId: "NO_PLAN", issueNumber: 101, taskBranch: "task/issue-101" };
  const record = await f.store.ensure(task);
  assert.equal(record.schemaVersion, 4);
  assert.equal(Object.hasOwn(record, "plan"), false);
  const file = join(f.repo, ".pi/board-agent/ticket-worktrees/no_plan.json");
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, "utf8")), "plan"), false);
  writeFileSync(join(record.path, "partial.txt"), "unfinished builder work\n");
  assert.deepEqual(await new TicketWorktrees(f.repo).ensure(task), record);
  assert.equal(readFileSync(join(record.path, "partial.txt"), "utf8"), "unfinished builder work\n");
  await assert.rejects(() => f.store.ensure(task, "changed-plan"), /no longer matches/);
  const invalid = { ...task, itemId: "INVALID", issueNumber: 102, taskBranch: "task/issue-102" };
  await assert.rejects(() => f.store.ensure(invalid, ""), /Invalid ticket execution record/);
  assert.equal(f.store.has(invalid.itemId), false);
  assert.equal(f.store.localBranchSha(invalid.taskBranch), undefined);
  // T001 retains the old execution path, not an implicit v3 -> v4 conversion.
  const legacyFile = join(f.repo, ".pi/board-agent/ticket-worktrees", `${f.task.itemId.toLowerCase()}.json`);
  const legacy = { ...f.record, schemaVersion: 3 };
  writeFileSync(legacyFile, JSON.stringify(legacy, null, "\t") + "\r\n");
  const original = readFileSync(legacyFile);
  assert.deepEqual(await new TicketWorktrees(f.repo).ensure(f.task, "demo"), legacy);
  assert.deepEqual(readFileSync(legacyFile), original);
  console.log("PASS: ensure creates v4 with optional Plan, resumes original dirty work, validates before creating refs, and retains v3 reads byte-for-byte");
}
{
  const f = await fixture();
  writeFileSync(join(f.record.path, "dirty.txt"), "keep me\n");
  await assert.rejects(() => f.finish(), /Dirty worktree/);
  f.kept();
  rmSync(join(f.record.path, "dirty.txt"));
  git(f.repo, "worktree", "lock", f.record.path);
  await assert.rejects(() => f.finish(), /locked/i);
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
  await assert.rejects(() => f.finish(), /status/);
  f.kept();
  writeFileSync(index, healthy);
  writeFileSync(join(f.repo, "main-dirty.txt"), "leave main alone\n");
  const result = await f.finish();
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
  const f = await fixture();
  writeFileSync(join(f.repo, "shared.txt"), "base conflict\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "base conflict");
  git(f.repo, "push", "origin", "main");
  writeFileSync(join(f.record.path, "shared.txt"), "task conflict\n");
  git(f.record.path, "add", ".");
  git(f.record.path, "commit", "-m", "task conflict");
  git(f.record.path, "push", "origin", f.task.taskBranch);
  const base = f.tip();
  const local = f.store.localBranchSha(f.task.taskBranch);
  await assert.rejects(() => f.finish(), /merge-tree/);
  assert.equal(f.tip(), base);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), local);
  assert.ok(existsSync(f.record.path));
  console.log(
    "PASS: merge conflicts preserve the local branch and worktree without a push",
  );
}
{
  const f = await fixture();
  const hook = join(f.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  await assert.rejects(() => f.finish(), /push/);
  f.kept();
  assert.equal(f.store.read(f.task.itemId)!.finalization, undefined);
  rmSync(hook);
  writeFileSync(join(f.repo, "later.txt"), "later base work\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "base advances");
  git(f.repo, "push", "origin", "main");
  await assert.rejects(f.finish(), /push/); // normal rejection prepares the next tick
  const result = await f.finish();
  assert.equal(f.tip(), result);
  assert.equal(git(f.repo, "show", "origin/main:later.txt"), "later base work");
  assert.equal(git(f.repo, "show", "origin/main:feature.txt"), "feature");
  console.log(
    "PASS: rejected pushes retain all work; retry merges into the latest base with the atomic integration journal",
  );
}
{
  const f = await fixture();
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
  await assert.rejects(() => f.finish(), /unmerged work/);
  assert.equal(f.tip(f.task.taskBranch), newer);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
  assert.ok(existsSync(f.record.path));
  git(f.record.path, "merge", "--ff-only", newer);
  await f.finish("merge");
  git(f.repo, "merge-base", "--is-ancestor", newer, "origin/main");
  assert.equal(f.tip(f.task.taskBranch), "");
  console.log(
    "PASS: remote-only commits are never deleted; integrating them locally permits normal cleanup",
  );
}
{
  const f = await fixture();
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
  await assert.rejects(() => f.finish(), /Local .* moved/);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), newer);
  assert.equal(f.tip(f.task.taskBranch), f.taskSha);
  assert.ok(existsSync(f.record.path));
  console.log(
    "PASS: local branch movement during the push prevents cleanup of newer work",
  );
}
{
  const f = await fixture();
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
  await assert.rejects(() => f.finish(), /push/);
  assert.equal(f.tip(f.task.taskBranch), newer);
  assert.equal(f.store.localBranchSha(f.task.taskBranch), f.taskSha);
  assert.ok(existsSync(f.record.path));
  console.log(
    "PASS: the remote deletion lease preserves a concurrent update and keeps the local retry branch",
  );
}
{
  const f = await fixture();
  const hook = join(f.origin, "hooks", "post-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = refs/heads/main ]; then git update-ref refs/heads/main ${f.baseSha}; fi\ndone\n`,
  );
  chmodSync(hook, 0o755);
  await assert.rejects(() => f.finish(), /is not on origin/);
  f.kept();
  rmSync(hook);
  assert.ok(await f.finish());
  console.log(
    "PASS: a successful push response without verified integration never triggers cleanup",
  );
}
{
  const f = await fixture();
  const outside = join(root, `outside-${sequence}`);
  git(f.repo, "worktree", "move", f.record.path, outside);
  symlinkSync(outside, f.record.path, "junction");
  await assert.rejects(() => f.finish(), /unmanaged/);
  assert.equal(git(outside, "rev-parse", "HEAD"), f.taskSha);
  assert.equal(f.tip(), f.baseSha);
  await assert.rejects(
    () => f.store.finalizeAccepted({ ...f.task, taskBranch: "main" }, "merge"),
    /must differ/,
  );
  console.log(
    "PASS: finalization never removes external worktrees, symlink aliases or the base branch",
  );
}
{
  const f = await fixture();
  git(
    f.repo,
    "symbolic-ref",
    `refs/heads/${f.task.taskBranch}`,
    "refs/heads/main",
  );
  await assert.rejects(() => f.finish(), /symbolic|ownership/);
  assert.equal(f.tip(), f.baseSha);
  assert.throws(() => f.store.localBranchSha("-invalid"), /Invalid branch/);
  console.log(
    "PASS: symbolic or invalid local refs cannot redirect merge or deletion",
  );
}
{
  const f = await fixture();
  const collision = { ...f.task, itemId: f.task.itemId.toLowerCase() };
  assert.equal(f.store.read(collision.itemId), undefined);
  await assert.rejects(
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
  // Raw old intent cannot enter v4 finalization without stopped-owner conversion.
  await assert.rejects(f.finish(), /stopped-owner conversion/);
  assert.equal(JSON.stringify(f.store.read(f.task.itemId)), before);
  console.log(
    "PASS: builder identity and legacy-journal protections remain; raw old intents require the stopped-owner adapter",
  );
}
