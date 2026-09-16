// Real local Git and public finalization seams; observe/inject only the process boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketBoardAdapter } from "../src/ticket-executor.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";
import {
  GIT_GH_TIMEOUT_MS, ProcessTimeoutError, runProcess, runProcessSync,
  type ProcessCommand, type ProcessOptions, type ProcessResult,
} from "../src/process-runner.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
const repo = join(root, "repo"), origin = join(root, "origin.git");
mkdirSync(repo);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.test");
git(repo, "config", "core.autocrlf", "false");
writeFileSync(join(repo, ".gitignore"), ".pi/\n");
writeFileSync(join(repo, "shared.txt"), "original\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "original");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");

const calls: string[][] = [];
const merges: ProcessResult[] = [];
let fault: { command: string; result: ProcessResult } | undefined;
let forbidMutations = false;
function observed(mode: "sync" | "async", command: ProcessCommand, args: string[], options: ProcessOptions = {}) {
  assert.equal(command, "git");
  assert.equal(options.timeoutMs, GIT_GH_TIMEOUT_MS);
  assert.deepEqual(options.env, { GIT_NO_REPLACE_OBJECTS: "1" });
  assert.equal("signal" in options, false, "finalization must not change containment/cancellation policy");
  calls.push(args);
  if (forbidMutations && (["commit-tree", "push", "update-ref"].includes(args[0]) || (args[0] === "worktree" && args[1] !== "list")))
    throw new Error(`Unexpected mutation after failed/malformed merge: ${args.join(" ")}`);
  if (fault?.command === args[0]) {
    const result = fault.result;
    fault = undefined;
    return mode === "async" ? Promise.resolve(result) : result;
  }
  if (mode === "sync") return runProcessSync(command, args, options);
  return runProcess(command, args, options).then((result) => {
    if (args[0] === "merge-tree") merges.push(result);
    return result;
  });
}
const globals = globalThis as any;
globals.__conflictGit = observed;
const worktreeUrl = new URL("../src/ticket-worktree.ts", import.meta.url).href;
const runnerUrl = new URL("../src/process-runner.ts", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === worktreeUrl && specifier === "./process-runner.js") return {
    url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(runnerUrl)};
      export const runProcess = (...args) => globalThis.__conflictGit('async', ...args);
      export const runProcessSync = (...args) => globalThis.__conflictGit('sync', ...args);`)}`,
    shortCircuit: true,
  };
  return next(specifier, context);
} });

try {
  const worktrees = await import("../src/ticket-worktree.js");
  const store = new worktrees.TicketWorktrees(repo);
  const cfg = structuredClone(_DEFAULTS);
  cfg.context.enabled = cfg.telegram.enabled = false;
  const card: Card = {
    itemId: "ITEM_11", number: 11, contentType: "Issue", type: "Task", title: "T011 accepted work", body: "Acceptance",
    repoOwner: "owner", repoName: "repo", closed: true, status: cfg.columns.done, plan: "demo", assignees: [],
  };
  const task = buildTasksForWave(cfg, "demo", [card])[0];
  const record = await store.ensure(task, "demo");
  writeFileSync(join(record.path, "shared.txt"), "task edit\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "task edit");
  git(record.path, "push", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  writeFileSync(join(repo, "shared.txt"), "base edit\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base edit");
  git(repo, "push", "origin", "main");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const localRefs = git(repo, "show-ref");
  const remoteRefs = git(origin, "show-ref");
  const registration = git(repo, "worktree", "list", "--porcelain");
  const recordFile = join(repo, ".pi", "board-agent", "ticket-worktrees", "item_11.json");
  const recordBytes = readFileSync(recordFile);
  const kept = () => {
    assert.equal(git(repo, "show-ref"), localRefs, "all local refs are preserved");
    assert.equal(git(origin, "show-ref"), remoteRefs, "all remote refs are preserved");
    assert.equal(git(repo, "worktree", "list", "--porcelain"), registration);
    assert.deepEqual(readFileSync(recordFile), recordBytes, "v3 record remains byte-identical; no early intent");
    assert.equal(existsSync(record.path), true);
    assert.equal(readFileSync(join(record.path, "shared.txt"), "utf8"), "task edit\n");
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "base edit\n");
    assert.equal(git(record.path, "status", "--porcelain"), "");
    assert.equal(git(record.path, "ls-files", "--unmerged"), "");
    assert.ok(!calls.some((args) => ["commit-tree", "push", "update-ref"].includes(args[0]) || (args[0] === "worktree" && args[1] !== "list")),
      "no integration commit, push, ref deletion or worktree cleanup after conflict");
  };

  for (const strategy of ["merge", "squash"] as const) {
    calls.length = 0;
    let caught: unknown;
    try { await store.finalizeAccepted(task, strategy); } catch (error) { caught = error; }
    const result = merges.at(-1)!;
    assert.equal(result.ok, false);
    assert.equal(result.status, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.stderr, "", "real Git reports this conflict only on stdout");
    assert.match(result.stdout, /CONFLICT \(content\): Merge conflict in shared\.txt/);
    const tree = result.stdout.split(/\r?\n/)[0];
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.equal(git(repo, "cat-file", "-t", tree), "tree", "a conflict still writes a REAL tree; never treat that as success");
    assert.ok(caught instanceof Error);
    assert.equal(caught.name, "MergeConflictError");
    assert.ok(caught instanceof worktrees.MergeConflictError);
    const conflict = caught as Error & { baseSha: string; taskSha: string; diagnostic: string };
    assert.equal(conflict.baseSha, baseSha);
    assert.equal(conflict.taskSha, taskSha);
    assert.match(conflict.diagnostic, /CONFLICT \(content\): Merge conflict in shared\.txt/);
    assert.ok(Buffer.byteLength(conflict.diagnostic) <= 8 * 1024);
    kept();
    console.log(`PASS: real stdout-only Git ${strategy} conflict is typed with exact SHAs and preserves all refs, worktrees and records without integration`);
  }

  const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
  const { BoardLoop, createLoopState } = await import("../src/loop.js");
  const notices: Array<{ message: string; level: string }> = [];
  const callback = (message: string, level = "info") => { notices.push({ message, level }); };
  const noBoardWrite = async (): Promise<never> => { assert.fail("T11 must not mutate the ticket or launch repair"); };
  const board: TicketBoardAdapter = {
    getCard: async (id) => { assert.equal(id, card.itemId); return structuredClone(card); },
    claim: noBoardWrite, release: noBoardWrite, comment: noBoardWrite,
    setStatus: noBoardWrite, listComments: noBoardWrite,
  };
  const makeExecutor = () => new ManagedTicketExecutor({
    cwd: repo, cfg, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback, board, worktrees: store,
    createManager: () => { assert.fail("T11 must not launch a model or repair workflow"); },
  });
  const beforeCard = structuredClone(card);
  calls.length = 0;
  const outcome = await makeExecutor().finalizeClosed(card);
  assert.equal(outcome.status, "conflict");
  if (outcome.status !== "conflict") assert.fail("expected explicit conflict outcome");
  assert.equal(outcome.baseSha, baseSha);
  assert.equal(outcome.taskSha, taskSha);
  assert.match(outcome.reason, /CONFLICT \(content\): Merge conflict in shared\.txt/);
  assert.equal(notices.length, 0, "loop owns the blocking notification; executor must not announce success");
  kept();
  console.log("PASS: ManagedTicketExecutor exposes exact conflict SHAs and diagnostics without ticket mutation or success");

  for (const reviewEnabled of [false, true]) {
    reviewEnabled;
    const state = createLoopState();
    const loop = new BoardLoop({
      cwd: repo, cfg, repoOwner: "owner", repoName: "repo", botLogin: "bot",
      meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, callback,
      listCards: async () => [structuredClone(card)],
      boardOps: { claim: noBoardWrite, refresh: noBoardWrite, release: noBoardWrite, listComments: noBoardWrite, comment: noBoardWrite, setStatus: noBoardWrite },
      review: noBoardWrite,
    }, state, makeExecutor(), store);
    calls.length = 0;
    notices.length = 0;
    try {
      await loop.tickNow();
      assert.equal(state.tickCount, 1);
      assert.equal(state.wavesLaunched, 0);
      assert.equal("enabled" in cfg.review, false);
      assert.equal(notices.length, 1, "one explicit warning, no false success");
      assert.equal(notices[0].level, "warn");
      assert.match(notices[0].message, /Finalization conflict.*#11/);
      assert.ok(notices[0].message.includes(task.taskBranch));
      assert.ok(notices[0].message.includes(baseSha));
      assert.ok(notices[0].message.includes(taskSha));
      assert.match(notices[0].message, /CONFLICT \(content\): Merge conflict in shared\.txt/);
      assert.match(notices[0].message, /preserv/i);
      assert.deepEqual(card, beforeCard);
      kept();
      console.log(`PASS: real loop/executor conflict warns informatively and preserves closed-Done ticket and Git state with review.enabled=${reviewEnabled}`);
    } finally { await loop.stop(); }
  }

  const realConflict = merges[0];
  const tree = realConflict.stdout.split(/\r?\n/)[0];
  const unknownTree = "0".repeat(40);
  const blob = git(repo, "rev-parse", `${baseSha}:shared.txt`);
  const cases: Array<{ label: string; command?: string; result: ProcessResult; timeout?: boolean }> = [
    { label: "permission error even with conflict-shaped stdout", result: { ...realConflict, stderr: "fatal: unable to write tree: Permission denied" } },
    { label: "stderr-only conflict words are not evidence", result: { ...realConflict, stdout: "", stderr: "CONFLICT (content): permission denied" } },
    { label: "malformed tree OID", result: { ...realConflict, stdout: realConflict.stdout.replace(tree, "not-a-tree") } },
    { label: "missing tree object", result: { ...realConflict, stdout: realConflict.stdout.replace(tree, unknownTree) } },
    { label: "commit OID is not a tree", result: { ...realConflict, stdout: realConflict.stdout.replace(tree, baseSha) } },
    { label: "blob OID is not a tree", result: { ...realConflict, stdout: realConflict.stdout.replace(tree, blob) } },
    { label: "extra data on the OID line", result: { ...realConflict, stdout: realConflict.stdout.replace(tree, `${tree} extra`) } },
    { label: "exit 1 with only a valid tree lacks conflict diagnostics", result: { ...realConflict, stdout: `${tree}\n` } },
    { label: "conflict word without merge-tree structure", result: { ...realConflict, stdout: `${tree}\nCONFLICT (content): unrelated output\n` } },
    { label: "malformed stage records", result: { ...realConflict, stdout: `${tree}\nnot a stage\n\nCONFLICT (content): unrelated output\n` } },
    { label: "missing conflict message", result: { ...realConflict, stdout: realConflict.stdout.replace(/CONFLICT \(content\):[^\r\n]*/, "Auto-merging shared.txt") } },
    { label: "non-conflict exit 128", result: { ...realConflict, status: 128 } },
    { label: "spawn failure", result: { ...realConflict, status: null, stderr: "spawn git EACCES" } },
    { label: "timeout outranks exit 1 and valid conflict output", result: { ...realConflict, timedOut: true }, timeout: true },
    { label: "failed fetch with conflict-shaped output", command: "fetch", result: realConflict },
    { label: "permission failure verifying tree", command: "cat-file", result: { ...realConflict, stdout: "tree\n", stderr: "Permission denied" } },
    { label: "timeout verifying tree", command: "cat-file", result: { ...realConflict, timedOut: true }, timeout: true },
    { label: "success flag cannot override exit 1", result: { ...realConflict, ok: true, stdout: `${tree}\n` } },
    { label: "success flag cannot override timeout", result: { ...realConflict, ok: true, status: 0, timedOut: true, stdout: `${tree}\n` }, timeout: true },
    { label: "exit 0 with conflict output is malformed, never successful", result: { ...realConflict, ok: true, status: 0 } },
    { label: "exit 0 with missing tree is not successful", result: { ...realConflict, ok: true, status: 0, stdout: `${unknownTree}\n` } },
    { label: "exit 0 with a commit OID is not successful", result: { ...realConflict, ok: true, status: 0, stdout: `${baseSha}\n` } },
  ];
  forbidMutations = true;
  for (const scenario of cases) {
    calls.length = 0;
    fault = { command: scenario.command ?? "merge-tree", result: scenario.result };
    await assert.rejects(store.finalizeAccepted(task, "merge"), (error: unknown) => {
      assert.ok(error instanceof Error, scenario.label);
      assert.ok(!(error instanceof worktrees.MergeConflictError), scenario.label);
      assert.notEqual(error.name, "MergeConflictError", scenario.label);
      if (scenario.timeout) assert.ok(error instanceof ProcessTimeoutError, scenario.label);
      return true;
    });
    assert.equal(fault, undefined, `${scenario.label}: fault reached the actual process seam`);
    kept();
    console.log(`PASS: ${scenario.label} blocks without conflict classification, success or destructive Git`);
  }
} finally {
  hooks.deregister();
  delete globals.__conflictGit;
}
