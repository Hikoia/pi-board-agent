import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type WriteFileOptions,
} from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import type { TicketExecutionRecord } from "../src/ticket-worktree.js";
import type { BuilderTask } from "../src/workflow-prompt.js";

// Real store/filesystem, faults only at atomic write boundaries (no store mock).
const root = process.env.TMP_DIR!;
assert.ok(root, "Run via bash tests/run-offline.sh");
let cut: string | undefined, reached = false;
const interrupt = (edge: string) => {
  if (cut === edge) {
    reached = true;
    throw new Error(`offline cut: ${edge}`);
  }
};
const globals = globalThis as any;
globals.__ticketStoreWrite = (path: string, data: string, options: WriteFileOptions) => {
  assert.equal(typeof options === "object" && options?.flag, "wx");
  assert.equal(typeof options === "object" && options?.flush, true);
  interrupt("before-write");
  writeFileSync(path, cut === "partial-write" ? data.slice(0, data.length / 2) : data, options);
  interrupt("partial-write");
  interrupt("after-write");
};
globals.__ticketStoreRename = (from: string, to: string) => {
  interrupt("before-rename");
  renameSync(from, to);
  interrupt("after-rename");
};
const url = new URL("../src/ticket-worktree.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === url && specifier === "node:fs")
      return {
        url: `data:text/javascript,${encodeURIComponent(`export * from 'node:fs';
          export const writeFileSync = (...args) => globalThis.__ticketStoreWrite(...args);
          export const renameSync = (...args) => globalThis.__ticketStoreRename(...args);`)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { TicketWorktrees, isTicketExecutionRecord } = await import("../src/ticket-worktree.js");
const integration = { baseSha: "a".repeat(40), taskSha: "b".repeat(40), resultSha: "c".repeat(40) };
const finalization = { targetBranch: "main", baseSha: integration.baseSha, taskSha: integration.taskSha };
const retry = { stage: "build" as const, reason: "Tests failed.\nOriginal diagnostics and requirements stay available." };
let sequence = 0;
function fixture(schemaVersion: 3 | 4 = 4) {
  const repo = join(root, `store-${++sequence}`);
  mkdirSync(repo);
  const store = new TicketWorktrees(repo);
  const record: TicketExecutionRecord = {
    schemaVersion, itemId: "ITEM", issueNumber: 1, taskKey: "T001",
    ...(schemaVersion === 3 ? { plan: "demo" } : {}),
    taskBranch: "task/issue-1", baseBranch: "main",
    path: join(repo, ".pi/worktrees/ticket-issue-1-item"), createdAt: 1,
  };
  const dir = join(repo, ".pi/board-agent/ticket-worktrees");
  const file = join(dir, "item.json");
  // Noncanonical original formatting makes read-only evidence checks meaningful.
  const put = (value: unknown) => writeFileSync(file, JSON.stringify(value, null, "\t") + "\r\n");
  put(record);
  const task: BuilderTask = { ...record, title: "Task", body: "Original requirements" };
  return { repo, store, record, dir, file, put, task };
}

try {
  for (const version of [3, 4] as const) {
    const f = fixture(version);
    for (const patch of [
      {}, { plan: "demo" }, { launchingAt: 0 },
      { activeRunId: "run-1", activeRunStartedAt: 0 },
      { lastRunId: "run-0", reviewedTaskSha: integration.taskSha },
      { finalization }, { finalization: { ...finalization, resultSha: integration.resultSha } },
    ]) assert.ok(isTicketExecutionRecord({ ...f.record, ...patch }), JSON.stringify(patch));

    for (const field of ["itemId", "issueNumber", "taskKey", "taskBranch", "baseBranch", "path", "createdAt"]) {
      const missing = { ...f.record } as Record<string, unknown>;
      delete missing[field];
      assert.equal(isTicketExecutionRecord(missing), false, `v${version} requires ${field}`);
    }
    const invalid: unknown[] = [
      null, [], "record", { ...f.record, extra: "unknown evidence" },
      { ...f.record, schemaVersion: 1 }, { ...f.record, schemaVersion: 2 },
      { ...f.record, schemaVersion: 5 }, { ...f.record, schemaVersion: String(version) },
      { ...f.record, issueNumber: 0 }, { ...f.record, activeRunId: "run-1" },
      { ...f.record, activeRunStartedAt: 1 },
      { ...f.record, activeRunId: "run-1", activeRunStartedAt: 1, launchingAt: 1 },
      { ...f.record, finalization, launchingAt: 1 },
      { ...f.record, finalization, activeRunId: "run-1", activeRunStartedAt: 1 },
      ...[null, [], {}, { ...finalization, extra: 1 }, { ...finalization, taskSha: "bad" },
        { ...finalization, resultSha: "bad" }, { ...finalization, targetBranch: "" }]
        .map((value) => ({ ...f.record, finalization: value })),
    ];
    for (const field of ["createdAt", "launchingAt", "activeRunStartedAt", "issueNumber"])
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", null])
        invalid.push({ ...f.record, [field]: value });
    for (const field of ["itemId", "taskKey", "taskBranch", "baseBranch", "path", "plan", "activeRunId", "lastRunId"])
      for (const value of ["", "  ", "line\nbreak", "nul\0byte", 1, null])
        invalid.push({ ...f.record, [field]: value });
    for (const value of ["abc", "g".repeat(40), 1, null])
      invalid.push({ ...f.record, reviewedTaskSha: value });
    for (const value of invalid)
      assert.equal(isTicketExecutionRecord(value), false, JSON.stringify(value));

    const before = readFileSync(f.file);
    assert.deepEqual(f.store.read("ITEM"), f.record);
    assert.deepEqual(new TicketWorktrees(f.repo).list(), [f.record]);
    assert.deepEqual(readFileSync(f.file), before, "reads never migrate or rewrite bytes");
    assert.deepEqual(readdirSync(f.dir), ["item.json"], "no implicit backup/migration");
    const changedVersion = version === 3 ? 4 : 3;
    assert.throws(() => f.store.update("ITEM", (r) => ({ ...r, schemaVersion: changedVersion })), /Invalid ticket execution update/);
    assert.deepEqual(readFileSync(f.file), before);
    console.log(`PASS: strict v${version} identities/progress/legacy finalization validation; read/list preserve exact bytes and update cannot change versions`);
  }

  {
    const f = fixture(), old = { ...f.record, schemaVersion: 3, plan: "demo" };
    assert.equal(isTicketExecutionRecord({ ...old, plan: undefined }), false);
    for (const field of ["retry", "integration"])
      for (const value of [undefined, field === "retry" ? retry : integration])
        assert.equal(isTicketExecutionRecord({ ...old, [field]: value }), false, `v3 rejects ${field}`);
    for (const stage of ["build", "review", "integrate", "cleanup"])
      assert.ok(isTicketExecutionRecord({ ...f.record, retry: { ...retry, stage } }));
    assert.ok(isTicketExecutionRecord({ ...f.record, retry, launchingAt: 1 }));
    assert.ok(isTicketExecutionRecord({ ...f.record, retry, activeRunId: "run", activeRunStartedAt: 1 }));
    assert.ok(isTicketExecutionRecord({ ...f.record, integration, retry: { stage: "cleanup", reason: "Release failed" } }));
    assert.ok(isTicketExecutionRecord({ ...f.record, integration: { ...integration, resultSha: "A".repeat(40) } }));
    for (const value of [null, [], {}, { stage: "build" }, { reason: "failed" },
      { ...retry, stage: "repair" }, { ...retry, stage: 1 }, { ...retry, reason: " \n" },
      { ...retry, reason: null }, { ...retry, reason: 3 }, { ...retry, settled: true }])
      assert.equal(isTicketExecutionRecord({ ...f.record, retry: value }), false, JSON.stringify(value));
    for (const field of Object.keys(integration)) {
      const missing = { ...integration } as Record<string, unknown>;
      delete missing[field];
      assert.equal(isTicketExecutionRecord({ ...f.record, integration: missing }), false);
      for (const value of [undefined, null, "", "abc", "g".repeat(40), 1])
        assert.equal(isTicketExecutionRecord({ ...f.record, integration: { ...integration, [field]: value } }), false);
    }
    for (const patch of [
      { integration: null }, { integration: [] }, { integration: { ...integration, pushed: true } },
      { integration, finalization }, { integration, launchingAt: 1 },
      { integration, activeRunId: "run", activeRunStartedAt: 1 },
    ]) assert.equal(isTicketExecutionRecord({ ...f.record, ...patch }), false, JSON.stringify(patch));
    console.log("PASS: only v4 permits optional Plan/retry/integration; exact stage/reason/SHA shapes reject incomplete, unknown and mixed execution evidence");
  }

  {
    const f = fixture();
    f.store.update("ITEM", (r) => ({ ...r, retry }));
    f.store.beginLaunch("ITEM", 2);
    f.store.setActiveRun("ITEM", "original-run", 3);
    assert.deepEqual(f.store.read("ITEM")?.retry, retry, "unfinished settlement survives launch/run binding");
    const cleared = new TicketWorktrees(f.repo).clearExecution("ITEM", "original-run");
    assert.deepEqual(cleared.retry, retry);
    assert.equal(cleared.lastRunId, "original-run");
    assert.equal(cleared.activeRunId, undefined);
    assert.equal(cleared.launchingAt, undefined);
    f.store.setReviewedTaskSha("ITEM", integration.taskSha);
    assert.deepEqual(f.store.read("ITEM")?.retry, retry);
    await assert.rejects(() => f.store.finalizeAccepted(f.task, "merge"), /Pending ticket progress/);
    const pending = readFileSync(f.file);
    for (const patch of [{ retry: { ...retry, stage: "unknown" } }, { retry: null }, { integration: { ...integration, resultSha: "" } }]) {
      assert.throws(() => f.store.update("ITEM", (r) => ({ ...r, ...patch }) as TicketExecutionRecord), /Invalid ticket execution record/);
      assert.deepEqual(readFileSync(f.file), pending);
    }
    f.store.update("ITEM", (r) => ({ ...r, integration, retry: { stage: "cleanup", reason: "Project write failed" } }));
    const before = readFileSync(f.file);
    for (const patch of [
      { integration: undefined },
      ...Object.keys(integration).map((field) => ({ integration: { ...integration, [field]: "d".repeat(40) } })),
      { reviewedTaskSha: "d".repeat(40) }, { path: "different" }, { plan: "different" },
      { taskBranch: "different" }, { issueNumber: 2 }, { createdAt: 2 },
    ]) {
      assert.throws(() => f.store.update("ITEM", (r) => ({ ...r, ...patch })), /Cannot replace|Invalid ticket/);
      assert.deepEqual(readFileSync(f.file), before);
    }
    assert.throws(() => f.store.beginLaunch("ITEM"), /pending finalization/);
    assert.throws(() => f.store.setActiveRun("ITEM", "another-run"), /pending finalization/);
    assert.throws(() => f.store.setReviewedTaskSha("ITEM", "d".repeat(40)), /pending finalization/);
    await assert.rejects(() => f.store.ensure(f.task), /pending finalization/);
    await assert.rejects(() => f.store.finalizeAccepted(f.task, "merge"), /Pending ticket progress/);
    assert.deepEqual(readFileSync(f.file), before, "a result SHA is not successful integration or cleanup authority");
    f.store.clearExecution("ITEM");
    assert.deepEqual(f.store.read("ITEM")?.integration, integration);
    assert.deepEqual(f.store.read("ITEM")?.retry, { stage: "cleanup", reason: "Project write failed" });
    f.store.update("ITEM", (r) => ({ ...r, retry: undefined }));
    assert.equal(f.store.read("ITEM")?.retry, undefined, "only explicit settlement clears retry");
    assert.deepEqual(f.store.read("ITEM")?.integration, integration);
    assert.equal(f.store.read("ITEM")?.lastRunId, "original-run");
    console.log("PASS: execution clearing retains retry/identity/run/review evidence; integration is immutable and cannot authorize legacy finalization or a second builder");
  }

  for (const version of [3, 4] as const) {
    const f = fixture(version);
    f.store.update("ITEM", (r) => ({ ...r, finalization, reviewedTaskSha: integration.taskSha }));
    const before = readFileSync(f.file);
    for (const patch of [{ finalization: undefined }, { finalization: { ...finalization, baseSha: integration.taskSha } }, { reviewedTaskSha: undefined }]) {
      assert.throws(() => f.store.update("ITEM", (r) => ({ ...r, ...patch })), /pending finalization/);
      assert.deepEqual(readFileSync(f.file), before);
    }
    f.store.update("ITEM", (r) => ({ ...r, finalization: { ...finalization, resultSha: integration.resultSha } }));
    assert.throws(() => f.store.update("ITEM", (r) => ({ ...r, finalization })), /pending finalization/);
    assert.equal(f.store.read("ITEM")?.schemaVersion, version);
    console.log(`PASS: v${version} legacy intent can gain a result but neither intent/result nor review evidence can be discarded`);
  }

  for (const version of [3, 4] as const) {
    for (const edge of ["before-write", "partial-write", "after-write", "before-rename", "after-rename"]) {
      const f = fixture(version);
      f.put({ ...f.record, activeRunId: "run-1", activeRunStartedAt: 2, ...(version === 4 ? { retry } : {}) });
      const before = readFileSync(f.file), previous = f.store.read("ITEM")!;
      cut = edge; reached = false;
      try {
        assert.throws(() => f.store.clearExecution("ITEM", "run-1"), /offline cut/);
        assert.ok(reached, edge);
      } finally { cut = undefined; }
      const reopened = new TicketWorktrees(f.repo).read("ITEM");
      if (edge === "after-rename") {
        const expected = { ...previous, lastRunId: "run-1" };
        delete expected.activeRunId; delete expected.activeRunStartedAt;
        assert.deepEqual(reopened, expected);
      } else {
        assert.deepEqual(readFileSync(f.file), before);
        assert.deepEqual(reopened, previous);
      }
      assert.deepEqual(readdirSync(f.dir), ["item.json"], "failed writer removes only its own temp");
      f.store.clearExecution("ITEM", "run-1");
      assert.equal(f.store.read("ITEM")?.lastRunId, "run-1");
      assert.equal(f.store.read("ITEM")?.schemaVersion, version);
      if (version === 4) assert.deepEqual(f.store.read("ITEM")?.retry, retry);
    }
    console.log(`PASS: v${version} cuts before/partway/after write and before/after atomic rename restart as complete old or new records with settlement evidence retained`);
  }

  for (const version of [3, 4] as const) {
    for (const edge of ["before-write", "partial-write", "after-write", "before-rename", "after-rename"]) {
      const f = fixture(version);
      f.put({ ...f.record, reviewedTaskSha: integration.taskSha, ...(version === 3 ? { finalization } : { retry: { stage: "integrate", reason: "Push pending" } }) });
      const before = readFileSync(f.file), previous = f.store.read("ITEM")!;
      const next = version === 3
        ? { ...previous, finalization: { ...finalization, resultSha: integration.resultSha } }
        : { ...previous, integration };
      cut = edge; reached = false;
      try {
        assert.throws(() => f.store.update("ITEM", () => next), /offline cut/);
        assert.ok(reached, edge);
      } finally { cut = undefined; }
      assert.deepEqual(new TicketWorktrees(f.repo).read("ITEM"), edge === "after-rename" ? next : previous);
      if (edge !== "after-rename") assert.deepEqual(readFileSync(f.file), before);
      assert.deepEqual(readdirSync(f.dir), ["item.json"]);
      f.store.update("ITEM", () => next);
      assert.deepEqual(f.store.read("ITEM"), next);
    }
    console.log(`PASS: v${version} interrupted result publication retains the entire original journal or entire result, including retry and review evidence`);
  }

  {
    const f = fixture();
    const stale = join(f.dir, "item.json.crashed.tmp"), unpublished = join(f.dir, "item.json.unpublished.tmp");
    writeFileSync(stale, '{"schemaVersion":4,"retry":');
    writeFileSync(unpublished, JSON.stringify({ ...f.record, integration }));
    rmSync(f.file);
    const files = readdirSync(f.dir);
    assert.equal(f.store.has("ITEM"), false);
    assert.equal(f.store.read("ITEM"), undefined);
    assert.deepEqual(f.store.list(), []);
    assert.throws(() => f.store.clearExecution("ITEM"), /missing or unsupported/);
    assert.deepEqual(readdirSync(f.dir), files);
    f.put(f.record);
    new TicketWorktrees(f.repo).beginLaunch("ITEM", 2);
    assert.deepEqual(readFileSync(stale, "utf8"), '{"schemaVersion":4,"retry":');
    assert.deepEqual(JSON.parse(readFileSync(unpublished, "utf8")), { ...f.record, integration });
    assert.equal(f.store.read("ITEM")?.integration, undefined, "unpublished result is never replayed");
    console.log("PASS: crash leftovers are neither authoritative records nor success; later writes leave unpublished evidence byte-identical");
  }

  {
    const f = fixture();
    const healthy = { ...f.record, itemId: "HEALTHY", issueNumber: 2, taskBranch: "task/issue-2", path: join(f.repo, "healthy") };
    writeFileSync(join(f.dir, "healthy.json"), JSON.stringify(healthy));
    for (const value of [
      "{corrupt", JSON.stringify({ ...f.record, schemaVersion: 1 }), JSON.stringify({ ...f.record, schemaVersion: 2 }),
      JSON.stringify({ ...f.record, schemaVersion: 3 }),
      JSON.stringify({ ...f.record, schemaVersion: 3, plan: "demo", future: "keep" }),
      JSON.stringify({ ...f.record, future: "keep" }), JSON.stringify({ ...f.record, integration: { resultSha: integration.resultSha } }),
      JSON.stringify({ ...f.record, itemId: "OTHER" }),
    ]) {
      writeFileSync(f.file, value);
      const before = readFileSync(f.file);
      assert.equal(f.store.has("ITEM"), true);
      assert.equal(f.store.read("ITEM"), undefined);
      assert.deepEqual(f.store.list(), [healthy]);
      assert.throws(() => f.store.update("ITEM", () => { throw new Error("must not mutate"); }), /missing or unsupported/);
      await assert.rejects(() => f.store.ensure(f.task), /corrupt or unsupported/);
      assert.deepEqual(readFileSync(f.file), before);
    }
    rmSync(f.file);
    const external = join(root, "external-evidence");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "external work");
    for (const target of [external, join(root, "absent-evidence")]) {
      symlinkSync(target, f.file, "junction");
      assert.equal(lstatSync(f.file).isSymbolicLink(), true);
      assert.equal(f.store.has("ITEM"), true, "dangling evidence is still present");
      assert.equal(f.store.read("ITEM"), undefined);
      await assert.rejects(() => f.store.ensure(f.task), /corrupt or unsupported/);
      assert.equal(lstatSync(f.file).isSymbolicLink(), true);
      rmSync(f.file);
    }
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "external work");
    f.put(f.record);
    const receipt = join(f.repo, ".pi/board-agent/cleanup/item.json");
    writeFileSync(receipt, "{corrupt receipt");
    const before = readFileSync(f.file);
    assert.throws(() => f.store.clearExecution("ITEM"), /pending cleanup receipt/);
    await assert.rejects(() => f.store.finalizeAccepted(f.task, "merge"), /Corrupt cleanup receipt/);
    assert.deepEqual(readFileSync(f.file), before);
    assert.equal(readFileSync(receipt, "utf8"), "{corrupt receipt");
    assert.ok(existsSync(join(f.dir, "healthy.json")));
    console.log("PASS: old/unknown/corrupt/mismatched/link evidence is retained without hiding healthy records; a corrupt cleanup receipt is never success");
  }
} finally {
  cut = undefined;
  hooks.deregister();
  delete globals.__ticketStoreWrite;
  delete globals.__ticketStoreRename;
}
