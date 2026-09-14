// Real ticket store/worktree/executor. Recovery observes the persisted run, not
// a zero-delta fetch heuristic; terminal settlements drain before GitHub writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { ManagedTicketExecutor } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(root, "repo"), origin = join(root, "origin.git");
mkdirSync(repo); git(root, "init", "--bare", origin); git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline"); git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), ".pi/\n"); git(repo, "add", "."); git(repo, "commit", "-m", "fixture");
git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
const cfg = structuredClone(_DEFAULTS);
cfg.context.enabled = false;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
let sequence = 0;
async function fixture() {
  const n = ++sequence;
  const card: Card = { itemId: `RACE_${n}`, number: n, contentType: "Issue", type: "Task", plan: "demo", title: `T${n} task`,
    body: "Original requirements", repoOwner: "owner", repoName: "repo", status: cfg.columns.building, closed: false, assignees: ["bot"] };
  const store = new TicketWorktrees(repo);
  const record = await store.ensure(buildTasksForWave(cfg, "demo", [card])[0], "demo");
  writeFileSync(join(record.path, "partial.txt"), "preserve partial bytes\n");
  const runs: PersistedRunState[] = [];
  const writes: string[] = [], comments: string[] = [], notices: string[] = [];
  let drain = async () => {}, release = async () => {}, reads = async () => {};
  let starts = 0;
  const executor = new ManagedTicketExecutor({ cwd: repo, cfg, worktrees: store, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: (s) => notices.push(s),
    board: {
      getCard: async (id) => { if (id !== card.itemId) return undefined; await reads(); return structuredClone(card); },
      claim: async () => { card.assignees = ["bot"]; return true; },
      release: async () => { await release(); writes.push("release"); card.assignees = card.assignees.filter((a) => a !== "bot"); },
      listComments: async () => comments,
      comment: async (_card, body) => { writes.push("comment"); comments.push(body); },
      setStatus: async (_id, status) => { writes.push(status); card.status = status; },
    },
    createManager: () => ({ list: () => runs, start: () => { starts++; return "unexpected"; }, resume: async () => false,
      stopAndWait: () => drain(), pauseAndWait: async () => {}, dispose() {} }),
  });
  const run = (id: string): PersistedRunState => ({ runId: id, script: "original unchanged script", workflowName: "original", status: "completed",
    args: { itemId: card.itemId, issueNumber: n, taskKey: record.taskKey }, result: [{ itemId: card.itemId, taskKey: record.taskKey, status: "failure", error: "tool failed" }],
    phases: [], agents: [], logs: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return { card, record, store, executor, runs, run, writes, comments, notices, starts: () => starts,
    setDrain: (fn: typeof drain) => { drain = fn; }, setRelease: (fn: typeof release) => { release = fn; }, setRead: (fn: typeof reads) => { reads = fn; } };
}
for (const count of [0, 2]) {
  const f = await fixture();
  f.store.beginLaunch(f.card.itemId);
  for (let i = 0; i < count; i++) f.runs.push(f.run(`window-${i}`));
  for (let tick = 0; tick < 2; tick++) {
    const result = await f.executor.reconcile([structuredClone(f.card)]);
    assert.equal(result.errors, 1); assert.ok(f.store.read(f.card.itemId)?.launchingAt);
    assert.equal(f.executor.activeCount(), 1); assert.deepEqual(f.writes, []);
    assert.equal((await f.executor.launch(f.card, "demo")).status, "skipped");
  }
  assert.equal(readFileSync(join(f.record.path, "partial.txt"), "utf8"), "preserve partial bytes\n");
  assert.equal(f.starts(), 0);
  console.log(`PASS: ${count} matching launch-window journals retain uncertainty/slot/partial work across repeated observations; never guess a new builder from a clean base`);
  await f.executor.shutdown();
  f.store.clearExecution(f.record.itemId); // next independent fixture case
}
for (const change of ["unchanged", "Backlog", "scope", "claim-transfer", "identity", "record-change", "release-failure"]) {
  const f = await fixture(), entered = deferred(), finish = deferred();
  f.runs.push(f.run("original")); f.store.setActiveRun(f.card.itemId, "original");
  f.setDrain(async () => { entered.resolve(); await finish.promise; });
  const settling = f.executor.reconcile([structuredClone(f.card)]);
  await entered.promise;
  assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "build");
  assert.equal(f.store.read(f.card.itemId)?.activeRunId, "original");
  assert.equal(f.executor.activeCount(), 1); assert.deepEqual(f.writes, []);
  assert.equal((await f.executor.launch(f.card, "demo")).status, "skipped");
  if (change === "Backlog") f.card.status = "Backlog";
  if (change === "scope") f.card.body = "Human changed requirements";
  if (change === "claim-transfer") f.card.assignees = ["human"];
  if (change === "identity") f.card.number = 999;
  if (change === "record-change") f.store.setActiveRun(f.card.itemId, "new-owner-run");
  if (change === "release-failure") f.setRelease(async () => { throw new Error("release unavailable"); });
  finish.resolve(); await settling;
  assert.equal(f.starts(), 0);
  assert.equal(readFileSync(join(f.record.path, "partial.txt"), "utf8"), "preserve partial bytes\n");
  if (change === "unchanged") { assert.deepEqual(f.writes, ["comment", "Ready", "release"]); assert.equal(f.store.read(f.card.itemId)?.activeRunId, undefined); }
  else if (change === "release-failure") {
    assert.equal(f.store.read(f.card.itemId)?.activeRunId, "original"); assert.equal(f.card.status, "Ready");
    f.setRelease(async () => {}); await f.executor.reconcile([structuredClone(f.card)]);
    assert.deepEqual(f.writes, ["comment", "Ready", "release"]); assert.equal(f.comments.length, 1);
  } else if (change === "record-change") { assert.equal(f.store.read(f.card.itemId)?.activeRunId, "new-owner-run"); assert.deepEqual(f.writes, []); }
  else { assert.deepEqual(f.writes, ["Backlog", "scope"].includes(change) ? ["release"] : []); }
  console.log(`PASS: delayed terminal drain ${change} persists result first, blocks the second builder and preserves fresh human/record authority before settlement`);
  await f.executor.shutdown();
  f.store.clearExecution(f.record.itemId); // next independent fixture case
}
