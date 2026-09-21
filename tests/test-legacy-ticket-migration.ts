import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRunPersistence, workflowProjectPaths, type PersistedRunState, type WorkflowManagerOptions } from "@quintinshaw/pi-dynamic-workflows";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { ManagedTicketExecutor, createWorkflowManagerAdapter, type TicketWorkflowManager } from "../src/ticket-executor.js";
import { fixture, git } from "./legacy-migration-fixture.js";

const f = await fixture();
const originals = new Map<string, Buffer>(), journals = new Map<string, Buffer>(), ledgers = new Map<string, Buffer>();
const active: Array<Awaited<ReturnType<typeof f.ticket>> & ReturnType<typeof f.journal> & { diff: string }> = [];
for (const [name, status] of [["active", "running"], ["paused", "paused"], ["quota", "paused"]] as const) {
  const t = await f.ticket(name);
  const j = f.journal(t.record, `${name}-original`, status);
  if (name === "quota") { j.run.pauseReason = "usage_limit"; writeFileSync(j.file, JSON.stringify(j.run)); }
  f.store.legacySetActiveRun(name, j.run.runId, Date.parse(j.run.startedAt));
  writeFileSync(join(t.record.path, "work.txt"), `${name} partial dirty diff\n`);
  writeFileSync(join(t.record.path, "untracked.txt"), "keep this too\n");
  active.push({ ...t, ...j, diff: git(t.record.path, "diff") });
  journals.set(j.file, readFileSync(j.file));
}
const unique = await f.ticket("launch_unique"), absent = await f.ticket("launch_absent"), ambiguous = await f.ticket("launch_ambiguous");
for (const t of [unique, absent, ambiguous]) f.store.legacyBeginLaunch(t.card.itemId, t.record.createdAt);
const match = f.journal(unique.record, "unique-original");
const first = f.journal(ambiguous.record, "ambiguous-a"), second = f.journal(ambiguous.record, "ambiguous-b");
for (const j of [match, first, second]) journals.set(j.file, readFileSync(j.file));
const queued = await f.ticket("queued", f.cfg.columns.ready), consumed = await f.ticket("consumed", f.cfg.columns.ready);
for (const [t, step] of [[queued, "queued"], [consumed, "consumed"]] as const) {
  const h = f.ledger(t.record, t.card, step);
  ledgers.set(h.file, readFileSync(h.file));
  writeFileSync(join(t.record.path, "work.txt"), "unlaunched repair partial diff\n");
}
const badLedger = await f.ticket("badledger", f.cfg.columns.ready);
const brokenLedger = f.ledger(badLedger.record, badLedger.card, "queued");
writeFileSync(brokenLedger.file, "{unreadable ledger");
const repair = await f.ticket("repair");
const h = f.ledger(repair.record, repair.card, "consumed", "repair-original");
const rj = f.journal(repair.record, "repair-original", "paused", h.request);
f.store.legacySetActiveRun(repair.card.itemId, rj.run.runId, Date.parse(rj.run.startedAt));
ledgers.set(h.file, readFileSync(h.file)); journals.set(rj.file, readFileSync(rj.file));
// An interrupted merge is real Git state, not a clean-gate mock.
writeFileSync(join(repair.record.path, "work.txt"), "task change\n");
git(repair.record.path, "add", "."); git(repair.record.path, "commit", "-m", "task");
writeFileSync(join(f.repo, "work.txt"), "base change\n"); git(f.repo, "add", "work.txt"); git(f.repo, "commit", "-m", "base");
const base = git(f.repo, "rev-parse", "HEAD");
assert.throws(() => git(repair.record.path, "merge", "--no-edit", base));
const mergeHead = git(repair.record.path, "rev-parse", "MERGE_HEAD"), dirtyRepair = git(repair.record.path, "diff");
const design = await f.ticket("design", "Needs Design"), human = await f.ticket("human", f.cfg.columns.needs_human);
const leased = await f.ticket("leased");
const lj = f.journal(leased.record, "leased-original", "running");
f.store.legacySetActiveRun(leased.card.itemId, lj.run.runId, Date.parse(lj.run.startedAt));
const lease = join(workflowProjectPaths(leased.record.path).runsDir, `${lj.run.runId}.lock`);
writeFileSync(lease, JSON.stringify({ runId: lj.run.runId, pid: process.pid }));
for (const t of [design, human]) originals.set(t.file, readFileSync(t.file));
for (const record of f.store.listStored()) originals.set(f.store.recordPath(record.itemId), readFileSync(f.store.recordPath(record.itemId)));
const badFiles = new Map<string, string>();
for (const version of [1, 2]) badFiles.set(join(f.store.recordsDir, `v${version}.json`), JSON.stringify({ ...unique.record, schemaVersion: version }));
badFiles.set(join(f.store.recordsDir, "corrupt.json"), "{bad");
for (const [file, bytes] of badFiles) writeFileSync(file, bytes);
// Non-Task/PR/foreign identities are never converted or remotely mutated.
for (const [i, type, contentType, repoName] of [[90, "Story", "Issue", "repo"], [91, "Task", "PullRequest", "repo"], [92, "Task", "Issue", "other"]] as const) {
  const itemId = `excluded${i}`, card = { ...unique.card, itemId, number: i, type, contentType, repoName, status: "Needs Design" };
  f.cards.push(card);
  const file = f.store.recordPath(itemId), bytes = JSON.stringify({ ...unique.record, itemId, issueNumber: i, taskBranch: `task/issue-${i}`, path: join(f.repo, ".pi", "worktrees", `ticket-issue-${i}-${itemId}`) });
  writeFileSync(file, bytes); badFiles.set(file, bytes);
}
const resumes: string[] = [], managers = new Map<string, TicketWorkflowManager>();
let starts = 0, allowOrdinary = false;
let ordinaryScript = "", ordinaryArgs: unknown;
function fakeManager(path: string): TicketWorkflowManager {
  let manager = managers.get(path);
  if (manager) return manager;
  const runs: PersistedRunState[] = createRunPersistence(path).list().map((r) => ({ ...r, status: r.status === "running" ? "paused" as const : r.status }));
  manager = { list: () => runs, start: (script, args) => {
      assert.ok(allowOrdinary, "No new builder during migration/recovery");
      starts++; ordinaryScript = script; ordinaryArgs = args;
      runs.push({ runId: "ordinary-retry", workflowName: "retry", script, args, status: "running", agents: [], logs: [], phases: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return "ordinary-retry";
    },
    resume: async (id) => { resumes.push(id); runs.find((r) => r.runId === id)!.status = "running"; return true; },
    pauseAndWait: async () => {}, stopAndWait: async () => {}, dispose() {} };
  managers.set(path, manager); return manager;
}
let executor = new ManagedTicketExecutor({ ...f.deps, createManager: fakeManager });
const owner = f.deps.owner;
try {
  assert.throws(() => acquireOwnerLock(f.repo, "bot"), /already running/);
  const report = await executor.migrateLegacy(owner);
  assert.ok(report.failures.some((e) => e.reason.includes("still alive")));
  assert.equal(f.store.readStored("leased")?.schemaVersion, 3);
  assert.equal(f.store.readStored("badledger")?.schemaVersion, 3);
  assert.ok(executor.legacyBlocked("badledger"));
  assert.equal(readFileSync(brokenLedger.file, "utf8"), "{unreadable ledger");
  assert.equal(existsSync(join(f.repo, ".pi", "board-agent", "legacy-v3", "leased.json")), false);
  assert.equal(managers.size, 0, "conversion opens no WorkflowManager");
  for (const record of f.store.list().filter((r) => r.schemaVersion === 5)) {
    const file = f.store.recordPath(record.itemId);
    assert.deepEqual(readFileSync(join(f.repo, ".pi", "board-agent", "legacy-v3", file.split(/[\\/]/).at(-1)!)), originals.get(file));
  }
  for (const [file, bytes] of [...journals, ...ledgers]) assert.deepEqual(readFileSync(file), bytes);
  for (const [file, bytes] of badFiles) assert.equal(readFileSync(file, "utf8"), bytes);
  assert.equal(f.store.read("launch_unique")!.activeRunId, "unique-original");
  for (const t of [absent, ambiguous]) assert.equal(f.store.read(t.card.itemId)!.launchingAt, t.record.createdAt);
  assert.equal(design.card.status, f.cfg.columns.needs_human);
  assert.equal(human.card.status, f.cfg.columns.needs_human);
  assert.equal(design.card.body, human.card.body, "original question retained");
  assert.deepEqual(f.writes, [`status:design:${f.cfg.columns.needs_human}`]);
  for (const t of [queued, consumed]) {
    const record = f.store.read(t.card.itemId)!;
    assert.equal(record.retry?.stage, "build");
    assert.match(record.retry!.reason, /Original question/);
    assert.match(record.retry!.reason, /requestKey/);
    assert.equal("repairFor" in executor, false, "no repair protocol API survives migration");
  }
  console.log("PASS: owner-only per-ticket v3 conversion archives exact raw bytes, isolates v1/v2/corrupt/live-lease/non-Task data, maps only Task Needs Design and preserves questions/Needs Human");

  const unrecordedDesign = { ...design.card, itemId: "unrecorded-design", number: 300, status: "Needs Design" };
  f.cards.push(unrecordedDesign);
  const setStatus = f.board.setStatus;
  f.board.setStatus = async (id, status) => {
    if (id === unrecordedDesign.itemId) throw new Error("offline lane write failed");
    await setStatus(id, status);
  };
  const corruptJournal = join(workflowProjectPaths(ambiguous.record.path).runsDir, "corrupt.json");
  writeFileSync(corruptJournal, "{a journal list must not silently skip this");
  await executor.reconcile(structuredClone(f.cards));
  assert.ok(resumes.includes("active-original") && resumes.includes("paused-original") && resumes.includes("repair-original"));
  assert.ok(executor.legacyBlocked(unrecordedDesign.itemId), "failed lane I/O cannot fall through to the staged designer");
  assert.equal(unrecordedDesign.status, "Needs Design", "no false successful status write");
  f.board.setStatus = setStatus;
  assert.ok(!resumes.includes("quota-original"), "provider backoff still owns quota pause");
  assert.equal(starts, 0);
  for (const t of [absent, ambiguous]) {
    assert.equal((await executor.launch(t.card, "demo")).status, "skipped");
    assert.equal(f.store.read(t.card.itemId)!.launchingAt, t.record.createdAt);
  }
  assert.ok(executor.activeCount() >= 7, "uncertain/paused/live-lease runs conservatively occupy slots");
  for (const t of active) {
    assert.equal(f.store.read(t.card.itemId)!.activeRunId, t.run.runId);
    assert.equal(git(t.record.path, "diff"), t.diff);
    assert.equal(readFileSync(join(t.record.path, "untracked.txt"), "utf8"), "keep this too\n");
  }
  assert.equal(git(repair.record.path, "rev-parse", "MERGE_HEAD"), mergeHead);
  assert.equal(git(repair.record.path, "diff"), dirtyRepair);
  for (const [file, bytes] of ledgers) assert.deepEqual(readFileSync(file), bytes, "repair resume cannot bind/rewrite old ledger");
  const late = f.journal(absent.record, "late-original");
  unlinkSync(corruptJournal);
  unlinkSync(second.file); // only the fixture resolves its deliberately ambiguous journal
  await executor.reconcile(structuredClone(f.cards));
  assert.equal(unrecordedDesign.status, f.cfg.columns.needs_human);
  assert.equal(executor.legacyBlocked(unrecordedDesign.itemId), undefined);
  assert.equal(unrecordedDesign.body, design.card.body);
  assert.equal(f.store.read(absent.card.itemId)!.activeRunId, late.run.runId);
  assert.equal(f.store.read(ambiguous.card.itemId)!.activeRunId, first.run.runId);
  assert.equal(starts, 0);
  console.log("PASS: active/paused/quota and repair runs keep IDs/script/args/dirty diff/MERGE_HEAD; zero/multiple launch matches stay occupied and uniquely reobserve without a builder");

  const v4 = new Map(f.store.list().filter((r) => r.schemaVersion === 5).map((r) => [f.store.recordPath(r.itemId), readFileSync(f.store.recordPath(r.itemId))]));
  await executor.shutdown();
  executor = new ManagedTicketExecutor({ ...f.deps, createManager: fakeManager });
  const again = await executor.migrateLegacy(owner);
  assert.equal(again.converted.length, 0);
  for (const [file, bytes] of v4) assert.deepEqual(readFileSync(file), bytes);
  unlinkSync(lease);
  const retry = await executor.migrateLegacy(owner);
  assert.deepEqual(retry.converted, ["leased"], "one failed ticket can retry without replaying accepted v4");
  console.log("PASS: restart never replays published v4 conversion; a failed ticket alone retries after its old process lease is stopped");

  allowOrdinary = true;
  assert.equal((await executor.launch(consumed.card, "demo")).status, "launched");
  allowOrdinary = false;
  assert.equal(starts, 1);
  assert.ok(!Object.hasOwn(ordinaryArgs as object, "repair"));
  assert.match(ordinaryScript, /Unlaunched legacy repair/);
  assert.match(ordinaryScript, /Original question/);
  assert.equal(f.store.read(consumed.card.itemId)!.path, consumed.record.path);
  assert.equal(readFileSync(join(consumed.record.path, "work.txt"), "utf8"), "unlaunched repair partial diff\n");
  for (const [file, bytes] of ledgers) assert.deepEqual(readFileSync(file), bytes);
  console.log("PASS: explicitly retried unlaunched repair uses the ordinary builder in its dirty original worktree with original diagnostics, never a new repair request/consume write");

  // Real WorkflowManager recovery, not only fake-manager matching. Only this
  // original run uses an offline agent; all other paths keep the inert fake.
  await executor.shutdown();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let actualCalls = 0;
  executor = new ManagedTicketExecutor({ ...f.deps, createManager: (path) => path === repair.record.path ? createWorkflowManagerAdapter({
    cwd: path, defaultAgentRetries: 0, deferScheduling: true, callback: () => {}, agent: { run: async (prompt, options) => {
      actualCalls++; assert.equal(prompt, "original script and args"); entered();
      return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("offline paused")), { once: true }));
    } } as NonNullable<WorkflowManagerOptions["agent"]>,
  }) : fakeManager(path) });
  await executor.migrateLegacy(owner);
  await executor.reconcile(structuredClone(f.cards));
  await Promise.race([started, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("original run did not resume")), 10_000); timer.unref(); })]);
  await executor.shutdown();
  const resumed = createRunPersistence(repair.record.path).load(rj.run.runId)!;
  assert.equal(actualCalls, 1);
  assert.equal(resumed.runId, rj.run.runId);
  assert.equal(resumed.script, rj.run.script);
  assert.deepEqual(resumed.args, rj.run.args);
  assert.equal(git(repair.record.path, "diff"), dirtyRepair);
  assert.equal(git(repair.record.path, "rev-parse", "MERGE_HEAD"), mergeHead);
  for (const [file, bytes] of ledgers) assert.deepEqual(readFileSync(file), bytes);
  console.log("PASS: real WorkflowManager cold-resumes the original repair script/args/runId and drains without changing MERGE_HEAD, dirty diff or the read-only repair ledger");
} finally { await executor.shutdown(); owner.release(); }
