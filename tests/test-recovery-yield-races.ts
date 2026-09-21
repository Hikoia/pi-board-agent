// Replaces the retired delta-fetch recovery barrier with the actual v4 fresh
// card/writeback barrier. Dirty/committed work no longer requires quarantine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { ManagedTicketExecutor } from "../src/ticket-executor.js";
import { pendingTicketWrite } from "../src/ticket-retry.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(root, "repo"), origin = join(root, "origin.git");
mkdirSync(repo); git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline"); git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), ".pi/\n"); writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, "add", "."); git(repo, "commit", "-m", "base"); git(repo, "init", "--bare", origin);
git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
let sequence = 0;
for (const mode of ["recovery", "reset"]) for (const committed of [false, true]) {
  for (const change of ["review", "done", "contract", "claim-transfer", "claim-lost", "read-error", "release-error", "dirty", "record-change", "unchanged", "commit-during-read"]) {
    const number = ++sequence, cfg = structuredClone(_DEFAULTS), store = new TicketWorktrees(repo, testOwner(repo));
    cfg.context.enabled = false;
    const card: Card = { itemId: `RECOVERY_${number}`, number, contentType: "Issue", type: "Task", title: `T${number} task`, body: "approved", plan: "demo", repoOwner: "owner", repoName: "repo", status: cfg.columns.ready, closed: false, assignees: [] };
    const record = await store.ensure(buildTasksForWave(cfg, "demo", [card])[0], "demo");
    if (committed) { writeFileSync(join(record.path, "partial.txt"), "keep commit\n"); git(record.path, "add", "."); git(record.path, "commit", "-m", "partial"); }
    const entered = deferred(), finish = deferred();
    let held = false, readError = false, releaseError = false, starts = 0;
    const writes: string[] = [];
    const executor = new ManagedTicketExecutor({ owner: testOwner(repo), pullRequests: noPullRequests, cwd: repo, cfg, worktrees: store, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {}, board: {
      getCard: async (id) => {
        if (id !== card.itemId) return undefined;
        if (!held && (mode === "recovery" || pendingTicketWrite(store.read(card.itemId)!))) {
          held = true; entered.resolve(); await finish.promise;
        }
        if (readError) throw new Error("fresh read unavailable");
        return structuredClone(card);
      },
      claim: async () => { card.assignees = ["bot"]; return true; },
      release: async () => { writes.push("release"); if (releaseError) throw new Error("release unavailable"); card.assignees = card.assignees.filter((a) => a !== "bot"); },
      setStatus: async (_id, status) => { writes.push(status); card.status = status; },
      listComments: async () => [], comment: async () => { writes.push("comment"); },
    }, createManager: () => ({ start: () => { starts++; return "unexpected"; }, list: () => [], resume: async () => false, pauseAndWait: async () => {}, stopAndWait: async () => {}, dispose() {} }) });
    if (mode === "recovery") { store.beginLaunch(card.itemId); card.status = cfg.columns.building; card.assignees = ["bot"]; }
    const operation = mode === "recovery" ? executor.reconcile([structuredClone(card)]) : executor.launch(structuredClone(card), "demo", () => false);
    const handled = operation.catch((error: Error) => error);
    try {
      await Promise.race([entered.promise, handled.then(() => { throw new Error("writeback barrier not reached"); })]);
      writes.length = 0;
      if (change === "review") card.status = cfg.columns.review;
      if (change === "done") { card.status = cfg.columns.done; card.closed = true; }
      if (change === "contract") card.body = "withdrawn contract";
      if (change === "claim-transfer") card.assignees = ["human"];
      if (change === "claim-lost") card.assignees = [];
      if (change === "read-error") readError = true;
      if (change === "release-error") releaseError = true;
      if (change === "dirty") writeFileSync(join(record.path, "dirty.txt"), "keep dirty\n");
      if (change === "commit-during-read") { writeFileSync(join(record.path, "late.txt"), "late commit\n"); git(record.path, "add", "."); git(record.path, "commit", "-m", "late"); }
      if (change === "record-change") store.setActiveRun(card.itemId, "different-run");
      const before = structuredClone(card), saved = store.read(card.itemId)!;
      finish.resolve();
      const result = await handled;
      assert.equal(starts, 0);
      if (mode === "recovery") {
        assert.deepEqual(store.read(card.itemId), saved, "uncertain launch never becomes permission for a replacement builder");
        assert.deepEqual(card, before); assert.deepEqual(writes, []);
      } else if (["read-error", "record-change", "release-error"].includes(change)) {
        assert.ok(result instanceof Error);
        assert.deepEqual(store.read(card.itemId), saved, "unsettled read/release retains the execution association and writeback");
        if (change !== "release-error") { assert.deepEqual(writes, []); assert.deepEqual(card, before); }
        else {
          assert.equal(card.status, cfg.columns.ready); assert.deepEqual(card.assignees, ["bot"]);
          releaseError = false; card.status = cfg.columns.done; card.closed = true; writes.length = 0;
          await executor.reconcile([structuredClone(card)]);
          assert.deepEqual(writes, ["release"], "fresh manual Done permits release only, not stale Ready");
          assert.equal(store.read(card.itemId)?.launchingAt, undefined);
        }
      } else {
        assert.equal(store.read(card.itemId)?.launchingAt, undefined);
        const withdrawn = ["review", "done", "contract", "claim-transfer", "claim-lost"].includes(change);
        assert.equal(card.status, withdrawn ? before.status : cfg.columns.ready);
        assert.deepEqual(writes, change.startsWith("claim-") ? [] : withdrawn ? ["release"] : [cfg.columns.ready, "release"]);
      }
      if (committed) assert.equal(readFileSync(join(record.path, "partial.txt"), "utf8"), "keep commit\n");
      if (change === "dirty") assert.equal(readFileSync(join(record.path, "dirty.txt"), "utf8"), "keep dirty\n");
      if (change === "commit-during-read") assert.equal(readFileSync(join(record.path, "late.txt"), "utf8"), "late commit\n");
      assert.equal(git(record.path, "branch", "--show-current"), record.taskBranch);
      console.log(`PASS: ${mode} committed=${committed} ${change} preserves fresh authority, work and pending I/O`);
    } finally { finish.resolve(); await handled; await executor.shutdown(); store.clearExecution(card.itemId); }
  }
}

import { testOwner, noPullRequests } from "./pr-fixture.js";
