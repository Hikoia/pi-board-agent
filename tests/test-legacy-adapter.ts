import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRunPersistence, type PersistedRunState } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";

import type { TicketBoardAdapter, TicketWorkflowManager } from "../src/ticket-executor.js";
import type { LegacyRepair } from "../src/legacy-adapter.js";
import type { TicketExecutionRecord } from "../src/ticket-worktree.js";
import { fixture, git, faults, dispose } from "./cleanup-fixture.js";

const { ManagedTicketExecutor } = await import("../src/ticket-executor.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");
const { conflictRequestKey } = await import("../src/legacy-adapter.js");
const cfg = structuredClone(_DEFAULTS);
cfg.context.enabled = false;
const bytes = (p: string) => readFileSync(p);
const json = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, "\t") + "\r\n");
async function setup() {
  const f = await fixture();
  const original: TicketExecutionRecord = { ...f.record, schemaVersion: 3 };
  json(f.recordFile, original);
  const card: Card = { itemId: original.itemId, number: original.issueNumber, contentType: "Issue",
    title: `${original.taskKey} legacy`, body: "Original requirements: keep the user's partial diff.",
    repoOwner: "test", repoName: "repo", type: "Task", plan: "demo", status: cfg.columns.building,
    closed: false, assignees: ["bot"] };
  const cards = new Map([[card.itemId, card]]);
  const comments = new Map([[card.itemId, ["Original question: which region?", "Maintainer: EU."]]]);
  const writes: string[] = [], notices: string[] = [];
  const legacyComments: IssueComment[] = [];
  const counts = { starts: 0, resumes: 0, stops: 0 };
  const board: TicketBoardAdapter = {
    getCard: async (id) => cards.has(id) ? structuredClone(cards.get(id)!) : undefined,
    setStatus: async (id, status) => { writes.push(`status:${id}:${status}`); cards.get(id)!.status = status; },
    claim: async (c) => { writes.push(`claim:${c.itemId}`); cards.get(c.itemId)!.assignees = ["bot"]; return true; },
    release: async (c) => { writes.push(`release:${c.itemId}`); cards.get(c.itemId)!.assignees = []; },
    listComments: async (c) => comments.get(c.itemId) ?? [],
    missionComments: async () => structuredClone(legacyComments),
    reopen: async () => { card.closed = false; },
    comment: async (c, body) => { writes.push(`comment:${c.itemId}`); comments.get(c.itemId)!.push(body); },
  };
  const ownerLock = acquireOwnerLock(f.repo, "bot", f.repo, true);
  const make = () => new ManagedTicketExecutor({ cwd: f.repo, cfg, worktrees: f.store,
    ownerLock, botLogin: "bot", repoOwner: "test", repoName: "repo", board,
    callback: (m) => notices.push(m),
    createManager: (path): TicketWorkflowManager => {
      const persistence = createRunPersistence(path);
      let resumeGuard: ((runId: string) => Promise<(() => boolean) | undefined>) | undefined;
      return {
        setResumeGuard(guard) { resumeGuard = guard; },
        list: () => persistence.list(),
        start(script, args) { counts.starts++; const run = makeRun(`new-${counts.starts}`, original, "running");
          run.script = script; run.args = args; persistence.save(run); return run.runId; },
        async resume(id) { const run = persistence.load(id)!; if (run.status !== "paused") return false;
          const guard = await resumeGuard?.(id); if (resumeGuard && !guard?.()) return false;
          counts.resumes++; persistence.save({ ...run, status: "running" }); return true; },
        async pauseAndWait() {}, async stopAndWait() { counts.stops++; }, dispose() {},
      };
    },
  });
  const all = () => [...cards.values()].map((c) => structuredClone(c));
  const saveRun = (run: PersistedRunState) => createRunPersistence(original.path).save(run);
  const repair = (step: LegacyRepair["step"], runId: string | null = null) => {
    const request = { requestKey: conflictRequestKey(original.itemId, f.base, f.taskSha), baseSha: f.base, taskSha: f.taskSha };
    const { closed, status, assignees, ...identity } = card;
    const h: LegacyRepair = { schemaVersion: 1, request, card: identity as LegacyRepair["card"], record: original,
      step, attempted: false, commentId: "comment-1", runId, notice: null };
    const dir = join(f.repo, ".pi/board-agent/repair"); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${request.requestKey}.json`); json(path, h);
    legacyComments.push({ id: h.commentId!, author: "bot", createdAt: "", body:
      `<!-- board-agent-conflict-repair:v1:${request.requestKey} -->\n${JSON.stringify({ ...request, itemId: card.itemId, phase: "queued" })}` });
    return { path, h, request };
  };
  return { ...f, original, card, cards, comments, writes, notices, counts, board, ownerLock, make, all, saveRun, repair };
}
function makeRun(runId: string, record: TicketExecutionRecord, status: PersistedRunState["status"] = "paused"): PersistedRunState {
  return { runId, workflowName: "legacy-script", script: "// original script and configured model\nreturn await oldBuilder(params);",
    args: { itemId: record.itemId, taskKey: record.taskKey, issueNumber: record.issueNumber, original: "unchanged args" },
    status, phases: ["Build"], agents: [], logs: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

try {
  for (const status of ["running", "paused"] as const) {
    const f = await setup();
    const run = makeRun(`old-${status}`, f.original, status); f.saveRun(run);
    const active = { ...f.original, activeRunId: run.runId, activeRunStartedAt: 42 };
    json(f.recordFile, active); const before = bytes(f.recordFile);
    writeFileSync(join(f.record.path, "feature.txt"), "partial dirty work\n");
    writeFileSync(join(f.record.path, "untracked.txt"), "keep me");
    const diff = git(f.record.path, "diff");
    const executor = f.make(); const summary = await executor.reconcile(f.all(), () => false, () => false);
    assert.equal(summary.errors, 0, f.notices.join("\n"));
    assert.deepEqual(f.store.read(f.card.itemId), { ...active, schemaVersion: 4 });
    assert.deepEqual(bytes(f.recordFile + ".v3.bak"), before);
    assert.equal(summary.resumed, status === "paused" ? 1 : 0);
    assert.equal(f.counts.starts, 0); assert.equal(executor.activeCount(), 1);
    const saved = createRunPersistence(f.record.path).load(run.runId)!;
    assert.equal(saved.script, run.script); assert.deepEqual(saved.args, run.args);
    await executor.reconcile(f.all()); await f.make().reconcile(f.all());
    assert.equal(f.counts.starts, 0); assert.equal(f.counts.resumes, status === "paused" ? 1 : 0);
    assert.equal(git(f.record.path, "diff"), diff); assert.equal(readFileSync(join(f.record.path, "untracked.txt"), "utf8"), "keep me");
    assert.deepEqual(f.writes, []); f.ownerLock.release();
    console.log(`PASS: v3 ${status} preserves runId/script/args/path/dirty work and exact backup, resumes only the same run, reentrant without launches`);
  }

  for (const count of [0, 1, 2]) {
    const f = await setup(), launchingAt = Date.now();
    json(f.recordFile, { ...f.original, launchingAt });
    for (let n = 0; n < count; n++) f.saveRun(makeRun(`candidate-${n}`, f.original, "running"));
    // Unrelated and old journals must not count as a unique match.
    const unrelated = makeRun("other-ticket", { ...f.original, itemId: "OTHER" }); f.saveRun(unrelated);
    const old = makeRun("old-window", f.original); old.startedAt = new Date(launchingAt - 5000).toISOString(); f.saveRun(old);
    const executor = f.make(), result = await executor.reconcile(f.all());
    assert.equal(result.adopted, count === 1 ? 1 : 0);
    assert.equal(result.errors, count === 1 ? 0 : 1, f.notices.join("\n"));
    assert.equal(f.store.read(f.card.itemId)?.launchingAt, count === 1 ? undefined : launchingAt);
    assert.equal(f.store.read(f.card.itemId)?.activeRunId, count === 1 ? "candidate-0" : undefined);
    await f.make().reconcile(f.all());
    assert.equal(f.counts.starts, 0); assert.deepEqual(f.writes, []);
    assert.equal((await executor.launch(f.card, "demo")).status, "skipped");
    f.ownerLock.release();
    console.log(`PASS: launch-window ${count} matches: unique adoption only; zero/ambiguity retained across restart without duplicate builder`);
  }

  for (const step of ["queued", "consume", "launching", "consumed"] as const) {
    const f = await setup(); f.card.status = cfg.columns.ready; f.card.assignees = [];
    const r = f.repair(step), before = bytes(r.path);
    const executor = f.make(); const reconciled = await executor.reconcile(f.all());
    assert.equal(reconciled.errors, 0, f.notices.join("\n"));
    const migrated = f.store.read(f.card.itemId)!;
    assert.equal(migrated.schemaVersion, 4, f.notices.join("\n"));
    assert.equal(migrated.retry?.stage, "build");
    assert.ok(migrated.retry?.reason.includes(f.card.body));
    assert.ok(migrated.retry?.reason.includes(f.base));
    assert.equal((await executor.launch(f.card, "demo")).status, "launched");
    const run = createRunPersistence(f.record.path).load(f.store.read(f.card.itemId)!.activeRunId!)!;
    assert.equal((run.args as any).repair, undefined); assert.ok(run.script.includes("Original requirements"));
    await executor.reconcile(f.all()); await f.make().reconcile(f.all());
    assert.equal(f.counts.starts, 1); assert.deepEqual(bytes(r.path), before);
    f.ownerLock.release();
    console.log(`PASS: unlaunched ${step} repair is ordinary build retry with original requirements/diagnostics; ledger remains byte-identical`);
  }

  {
    const f = await setup(); f.card.status = cfg.columns.ready; f.card.closed = true; f.card.assignees = [];
    const r = f.repair("reopen"), before = bytes(r.path);
    const read = f.board.missionComments!;
    f.board.missionComments = async () => [];
    const executor = f.make();
    assert.equal((await executor.reconcile(f.all())).errors, 1);
    assert.equal((await executor.launch(f.card, "demo")).status, "skipped");
    assert.equal(f.counts.starts, 0); assert.equal(f.card.closed, true);
    f.board.missionComments = read;
    assert.equal((await executor.reconcile(f.all())).errors, 0, f.notices.join("\n"));
    assert.equal(f.card.closed, false); assert.equal(f.card.status, cfg.columns.ready);
    assert.deepEqual(f.card.assignees, []);
    assert.equal(f.counts.starts, 0, "legacy settlement cannot launch a builder in the same tick");
    assert.equal((await executor.launch(f.card, "demo")).status, "launched");
    assert.deepEqual(bytes(r.path), before);
    f.ownerLock.release();
    console.log("PASS: incomplete legacy comment/reopen blocks direct admission; fresh authentic evidence settles ordinary Ready before launch without ledger writes");
  }

  {
    const f = await setup(), run = makeRun("consumed-original", f.original);
    const r = f.repair("consumed", run.runId); (run.args as any).repair = r.request; f.saveRun(run);
    json(f.recordFile, { ...f.original, activeRunId: run.runId, activeRunStartedAt: 1 });
    writeFileSync(join(f.repo, "feature.txt"), "conflicting base change\n");
    git(f.repo, "add", "feature.txt"); git(f.repo, "commit", "-m", "base conflict");
    const mergeHead = git(f.repo, "rev-parse", "HEAD");
    assert.throws(() => git(f.record.path, "merge", "--no-commit", mergeHead));
    const index = bytes(join(f.admin, "index"));
    const before = bytes(r.path), executor = f.make();
    const result = await executor.reconcile(f.all());
    assert.equal(result.errors, 0, f.notices.join("\n")); assert.equal(result.resumed, 1);
    assert.equal(f.counts.starts, 0); assert.deepEqual(bytes(r.path), before);
    assert.deepEqual(createRunPersistence(f.record.path).load(run.runId)!.args, run.args);
    assert.equal(createRunPersistence(f.record.path).load(run.runId)!.script, run.script);
    await f.make().reconcile(f.all()); assert.deepEqual(bytes(r.path), before);
    assert.equal(git(f.record.path, "rev-parse", "MERGE_HEAD"), mergeHead);
    assert.deepEqual(bytes(join(f.admin, "index")), index);
    assert.ok(git(f.record.path, "ls-files", "--unmerged").includes("feature.txt"));
    f.ownerLock.release();
    console.log("PASS: consumed repair with a paused run resumes exact legacy script/args, MERGE_HEAD and unmerged index; never consumes/rewrites old ledger");
  }

  {
    const f = await setup(), run = makeRun("bound-without-association", f.original);
    const r = f.repair("consumed", run.runId); (run.args as any).repair = r.request; f.saveRun(run);
    const before = bytes(f.recordFile), ledger = bytes(r.path), executor = f.make();
    const result = await executor.reconcile(f.all());
    assert.equal(result.errors, 0, f.notices.join("\n")); assert.equal(result.resumed, 1);
    assert.equal(f.store.read(f.card.itemId)?.activeRunId, run.runId);
    assert.deepEqual(bytes(f.recordFile + ".v3.bak"), before); assert.deepEqual(bytes(r.path), ledger);
    await f.make().reconcile(f.all()); assert.equal(f.counts.starts, 0); assert.equal(f.counts.resumes, 1);
    f.ownerLock.release(); console.log("PASS: consumed ledger's exact persisted run binding repairs a lost execution association without a new builder or ledger mutation");
  }

  {
    const f = await setup(), run = makeRun("limited", f.original);
    run.pauseReason = "usage_limit"; f.saveRun(run);
    json(f.recordFile, { ...f.original, activeRunId: run.runId, activeRunStartedAt: 1 });
    const executor = f.make(); const result = await executor.reconcile(f.all());
    assert.equal(result.errors, 0); assert.equal(result.active[0]?.status, "paused");
    assert.equal(executor.activeCount(), 1); assert.equal(f.counts.resumes, 0); assert.equal(f.counts.starts, 0);
    f.ownerLock.release(); console.log("PASS: usage-limit pause retains original run and occupancy for the existing scheduler, no new builder");
  }

  {
    const f = await setup();
    const active = { ...f.original, activeRunId: "missing-journal", activeRunStartedAt: 1 };
    json(f.recordFile, active);
    const executor = f.make(); const result = await executor.reconcile(f.all());
    assert.equal(result.errors, 1); assert.equal(result.needsHuman, 0);
    assert.equal(f.store.read(f.card.itemId)?.activeRunId, active.activeRunId);
    assert.equal(executor.activeCount(), 1); assert.deepEqual(f.writes, []);
    f.saveRun(makeRun(active.activeRunId, f.original, "running"));
    assert.equal((await f.make().reconcile(f.all())).errors, 0);
    assert.equal(f.counts.starts, 0); f.ownerLock.release();
    console.log("PASS: missing legacy journal retains run/occupancy without quarantine; later observation recovers the same run");
  }

  for (const strategy of ["merge", "squash"] as const) {
    for (const pushed of [false, true]) {
      const f = await setup(); f.card.closed = true; f.card.status = cfg.columns.done;
      const resultSha = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base,
        ...(strategy === "merge" ? ["-p", f.taskSha] : []), "-m", `old ${strategy}`);
      if (pushed) git(f.repo, "push", "origin", `${resultSha}:refs/heads/main`);
      json(f.recordFile, { ...f.original, reviewedTaskSha: f.taskSha,
        finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha, resultSha } });
      const original = bytes(f.recordFile), tip = f.tip();
      const executor = f.make(), outcome = await executor.reconcile(f.all());
      assert.equal(outcome.errors, 0, f.notices.join("\n"));
      assert.deepEqual(f.store.read(f.card.itemId)?.integration, { baseSha: f.base, taskSha: f.taskSha, resultSha });
      assert.equal(f.store.read(f.card.itemId)?.retry?.stage, pushed ? "cleanup" : "integrate");
      assert.equal(f.store.read(f.card.itemId)?.finalization, undefined);
      assert.deepEqual(bytes(f.recordFile + ".v3.bak"), original);
      assert.equal((await executor.finalizeClosed(f.card)).status, "blocked");
      f.card.closed = false; f.card.status = cfg.columns.ready; f.card.assignees = [];
      assert.equal((await executor.launch(f.card, "demo")).status, "skipped");
      if (strategy === "merge" && pushed) {
        f.card.status = cfg.columns.review;
        const { BoardLoop, createLoopState } = await import("../src/loop.js");
        let reviews = 0;
        const loop = new BoardLoop({ cwd: f.repo, cfg: { ...cfg,
          safety: { ...cfg.safety, require_clean_worktree: false }, review: { ...cfg.review, enabled: true },
          refine: { ...cfg.refine, enabled: false }, watchdog: { ...cfg.watchdog, enabled: false } },
          repoOwner: "test", repoName: "repo", botLogin: "bot", meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
          listCards: async () => f.all(), callback: () => {}, review: async () => { reviews++; throw new Error("must not review pending integration"); },
        }, createLoopState(), executor, f.store);
        await loop.tickNow(); assert.equal(reviews, 0); await loop.stop();
      }
      f.card.closed = true; f.card.status = cfg.columns.done;
      await assert.rejects(() => f.store.finalizeAccepted(f.task, "merge"), /resumable finalization/);
      await f.make().reconcile(f.all());
      assert.equal(f.tip(), tip); assert.ok(existsSync(f.record.path)); assert.equal(f.counts.starts, 0);
      assert.deepEqual(f.writes, []); f.ownerLock.release();
      console.log(`PASS: recorded ${strategy} result (${pushed ? "pushed" : "not on remote"}) adopted exactly, never remerged/rebuilt/cleaned by pre-T004 paths`);
    }
  }

  for (const missing of ["remote-ref", "local-ref", "worktree", "record", "rewritten-base"] as const) {
    const f = await setup(); f.card.closed = true; f.card.status = cfg.columns.done;
    // Generate a real old receipt, cutting before the first remote deletion.
    faults.beforeGit = (args) => { if (args[0] === "push" && args.some((a) => a.startsWith(":refs/heads/task/"))) throw new Error("old cleanup cut"); };
    await assert.rejects(f.finish, /old cleanup cut/); faults.beforeGit = undefined;
    const receipt = bytes(f.receipt), oldReceipt = JSON.parse(receipt.toString("utf8"));
    if (missing === "remote-ref" || missing === "record") git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
    if (missing === "rewritten-base") git(f.origin, "update-ref", "refs/heads/main", f.base, f.tip());
    if (missing === "local-ref") git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha);
    if (missing === "worktree" || missing === "record") git(f.repo, "worktree", "remove", f.record.path);
    if (missing === "record") { git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`, f.taskSha); rmSync(f.recordFile); }
    const tip = f.tip(), executor = f.make();
    const outcome = await executor.reconcile(f.all());
    assert.equal(outcome.errors, 0, f.notices.join("\n"));
    assert.equal(f.store.read(f.card.itemId)?.integration?.resultSha, oldReceipt.resultSha);
    assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "cleanup");
    assert.deepEqual(bytes(f.receipt), receipt);
    const migrated = bytes(f.recordFile);
    await f.make().reconcile(f.all()); assert.deepEqual(bytes(f.recordFile), migrated);
    assert.equal((await executor.finalizeClosed(f.card)).status, "blocked");
    assert.equal(f.tip(), tip); assert.deepEqual(bytes(f.receipt), receipt);
    f.ownerLock.release();
    console.log(`PASS: old receipt survives missing ${missing}; exact result becomes cleanup-only even without record/ref/path; receipt remains read-only`);
  }

  {
    const f = await setup(); f.card.closed = true; f.card.status = cfg.columns.done;
    git(f.repo, "worktree", "remove", f.record.path); rmSync(f.recordFile);
    faults.beforeGit = (args) => { if (args[0] === "push" && args.some((a) => a.startsWith(":refs/heads/task/"))) throw new Error("unrecorded old cut"); };
    await assert.rejects(f.finish, /unrecorded old cut/); faults.beforeGit = undefined;
    const receipt = bytes(f.receipt); assert.equal(JSON.parse(receipt.toString("utf8")).record, null);
    const executor = f.make(); const result = await executor.reconcile(f.all());
    assert.equal(result.errors, 0, f.notices.join("\n"));
    assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "cleanup");
    assert.equal(f.store.read(f.card.itemId)?.integration?.resultSha, f.tip());
    assert.equal(existsSync(f.recordFile + ".v3.bak"), false, "never fabricate missing original bytes");
    assert.deepEqual(bytes(f.receipt), receipt); assert.equal(f.counts.starts, 0);
    f.ownerLock.release(); console.log("PASS: authentic unrecorded cleanup receipt restores only cleanup identity; no fabricated v3 bytes or builder authority");
  }

  for (const changed of [false, true]) {
    const f = await setup(); f.card.closed = true; f.card.status = cfg.columns.done;
    faults.beforeGit = (args) => { if (args[0] === "push" && args.some((a) => a.startsWith(":refs/heads/task/"))) throw new Error("old cut"); };
    await assert.rejects(f.finish, /old cut/); faults.beforeGit = undefined;
    const receipt = bytes(f.receipt), original = bytes(f.recordFile);
    f.vanish(); // a half-removed unregistered worktree: receipt still owns exact survivors
    if (changed) writeFileSync(join(f.record.path, "unknown.txt"), "unowned replacement");
    const executor = f.make(), outcome = await executor.reconcile(f.all());
    if (changed) {
      assert.ok(outcome.errors > 0); assert.deepEqual(bytes(f.recordFile), original);
      assert.equal(readFileSync(join(f.record.path, "unknown.txt"), "utf8"), "unowned replacement");
    } else assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "cleanup", f.notices.join("\n"));
    assert.deepEqual(bytes(f.receipt), receipt); assert.ok(existsSync(f.record.path));
    assert.equal((await executor.finalizeClosed(f.card)).status, "blocked");
    await f.make().reconcile(f.all()); assert.deepEqual(bytes(f.receipt), receipt);
    f.ownerLock.release();
    console.log(`PASS: unregistered receipt survivors ${changed ? "changed/unknown: conversion retained" : "unchanged: cleanup-only handoff"}; no snapshot creation or deletion during migration`);
  }

  {
    const f = await setup(); f.card.closed = true; f.card.status = cfg.columns.done;
    const finalization = { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha };
    json(f.recordFile, { ...f.original, finalization });
    const executor = f.make(); await executor.reconcile(f.all());
    assert.deepEqual(f.store.read(f.card.itemId)?.finalization, finalization);
    assert.equal(f.store.read(f.card.itemId)?.integration, undefined);
    assert.equal(f.store.read(f.card.itemId)?.retry?.stage, "integrate");
    assert.equal((await executor.finalizeClosed(f.card)).status, "blocked"); f.ownerLock.release();
    console.log("PASS: pre-result intent retains original base/task without inventing success or entering the old finalizer");
  }

  {
    const f = await setup();
    f.card.status = cfg.columns.needs_design;
    const human = { ...f.card, itemId: "HUMAN", number: 990, status: cfg.columns.needs_human };
    const protectedCards = [
      { ...f.card, itemId: "STORY", type: "Story", number: 991 },
      { ...f.card, itemId: "PR", contentType: "PullRequest" as const, number: 992 },
      { ...f.card, itemId: "FOREIGN", repoOwner: "foreign", number: 993 },
      { ...f.card, itemId: "DRAFT", contentType: "DraftIssue" as const, number: undefined },
    ];
    for (const c of [human, ...protectedCards]) f.cards.set(c.itemId, c);
    const before = structuredClone(f.comments), originals = structuredClone(protectedCards);
    const executor = f.make(); await executor.reconcile(f.all());
    assert.equal(f.card.status, cfg.columns.needs_human); assert.equal(human.status, cfg.columns.needs_human);
    assert.deepEqual(f.comments, before); assert.deepEqual(protectedCards, originals);
    const writes = [...f.writes]; await f.make().reconcile(f.all()); assert.deepEqual(f.writes, writes);
    assert.equal(f.counts.starts, 0); f.ownerLock.release();
    console.log("PASS: legacy Task Needs Design maps to Needs Human preserving questions; existing Needs Human and non-target items stay unchanged, no comment-driven resume");
  }

  {
    const f = await setup(); f.card.status = cfg.columns.ready; f.card.assignees = [];
    const stateDir = join(f.repo, ".pi/board-agent");
    const retired = ["refine-state.json", "refine-state-unblocked.json", "watchdog-state.json"];
    for (const name of retired) writeFileSync(join(stateDir, name), `opaque retained ${name}\n`);
    const story = { ...f.card, itemId: "OLD_STORY", number: 997, type: "Story" };
    f.cards.set(story.itemId, story);
    const { BoardLoop, createLoopState } = await import("../src/loop.js");
    const executor = f.make(), state = createLoopState();
    const loop = new BoardLoop({ cwd: f.repo, cfg: { ...cfg, safety: { ...cfg.safety, require_clean_worktree: false },
      refine: { ...cfg.refine, enabled: true }, watchdog: { ...cfg.watchdog, enabled: true } },
      repoOwner: "test", repoName: "repo", botLogin: "bot", meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
      listCards: async () => f.all(), callback: (m) => f.notices.push(m),
      refine: async () => { throw new Error("retired Story must not invoke a model"); },
    }, state, executor, f.store);
    await loop.tickNow();
    assert.equal(executor.preservesLegacyLane("story"), true); assert.equal(executor.preservesLegacyLane("watchdog"), true);
    assert.equal(f.counts.starts, 1, f.notices.join("\n")); assert.equal(story.status, cfg.columns.ready);
    for (const name of retired) assert.equal(readFileSync(join(stateDir, name), "utf8"), `opaque retained ${name}\n`);
    assert.ok(!f.notices.some((m) => /Story #|Watchdog tick failed/.test(m)), f.notices.join("\n"));
    await loop.stop(); f.ownerLock.release();
    console.log("PASS: cold retired Story/watchdog journals stay read-only and cannot replay lanes; already-created Ready Tasks still launch through the real loop");
  }

  {
    const f = await setup(), original = bytes(f.recordFile);
    assert.throws(() => acquireOwnerLock(f.repo, "other", f.repo, true), /already running/);
    const executor = f.make(); executor.stopScheduling();
    await executor.reconcile(f.all()); assert.deepEqual(bytes(f.recordFile), original);
    f.ownerLock.release();
    await assert.rejects(() => f.make().reconcile(f.all()));
    assert.deepEqual(bytes(f.recordFile), original); assert.deepEqual(f.writes, []);
    console.log("PASS: live owner cannot be stolen; stopped or lost-owner startup cannot publish migration or start a manager");
  }

  {
    const f = await setup(), external = join(f.repo, "unmanaged"); mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "external work");
    json(f.recordFile, { ...f.original, path: external, activeRunId: "external-run", activeRunStartedAt: 1 });
    const before = bytes(f.recordFile), executor = f.make();
    assert.equal((await executor.reconcile(f.all())).errors, 1);
    assert.deepEqual(bytes(f.recordFile), before); assert.equal(existsSync(join(external, ".pi")), false);
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "external work");
    assert.equal(f.counts.starts, 0); assert.equal(f.counts.resumes, 0); assert.deepEqual(f.writes, []);
    f.ownerLock.release(); console.log("PASS: unmanaged legacy execution path is preserved without opening a manager, adopting a run or writing external state");
  }

  {
    const f = await setup(); f.card.status = cfg.columns.ready;
    const dir = join(f.repo, ".pi/board-agent/ticket-worktrees");
    const unknown = ["{corrupt", JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 2 })];
    for (let i = 0; i < unknown.length; i++) writeFileSync(join(dir, `bad-${i}.json`), unknown[i]);
    const repairDir = join(f.repo, ".pi/board-agent/repair"); mkdirSync(repairDir, { recursive: true });
    writeFileSync(join(repairDir, "unknown.json"), "not a ledger");
    const retired = join(f.repo, ".pi/board-agent/inflight"); mkdirSync(retired, { recursive: true });
    writeFileSync(join(retired, "story.json"), "retired Story/watchdog evidence");
    const executor = f.make(), outcome = await executor.reconcile(f.all());
    assert.equal(outcome.errors, 4); assert.equal(f.store.read(f.card.itemId)?.schemaVersion, 4);
    assert.equal((await executor.launch(f.card, "demo")).status, "launched");
    await f.make().reconcile(f.all());
    unknown.forEach((v, i) => assert.equal(readFileSync(join(dir, `bad-${i}.json`), "utf8"), v));
    assert.equal(readFileSync(join(repairDir, "unknown.json"), "utf8"), "not a ledger");
    assert.equal(readFileSync(join(retired, "story.json"), "utf8"), "retired Story/watchdog evidence");
    assert.equal(f.counts.starts, 1); assert.equal(f.writes.filter((w) => w.startsWith("comment:")).length, 0);
    f.ownerLock.release(); console.log("PASS: per-ticket corrupt/v1/v2/opaque repair evidence cannot block healthy migration/launch or trigger unknown deletion; retired state is read-only");
  }
} finally { faults.beforeGit = undefined; dispose(); }
