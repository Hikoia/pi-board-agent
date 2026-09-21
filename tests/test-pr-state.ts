import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireOwnerLock, type OwnerLock } from "../src/owner-lock.js";
import {
  isStoredTicketExecutionRecord,
  isTicketExecutionRecord,
  isTicketExecutionRecordV5,
  isTicketIntegrationStateV5,
  TicketStateChangedError,
  TicketWorktrees,
  type TicketExecutionRecord,
  type TicketExecutionRecordV4,
  type TicketExecutionRecordV5,
  type TicketLegacyCompletedIntegration,
  type TicketPullRequestIntegration,
  type TicketPullRequestPreparation,
} from "../src/ticket-worktree.js";

const sha = (letter: string) => letter.repeat(40);
const preparation: TicketPullRequestPreparation = {
  scope: { owner: "offline-owner", repo: "offline-repo", base: "main", head: "task/issue-7" },
  baseSha: sha("a"), taskSha: sha("b"), remoteTaskSha: null, preparedHeadSha: sha("c"),
};
const prepared: TicketPullRequestIntegration = {
  ...preparation, kind: "pr", phase: "prepared", initialPreparedHeadSha: preparation.preparedHeadSha,
};
const reference = { prNumber: 19, prUrl: "https://github.com/offline-owner/offline-repo/pull/19" };
const open: TicketPullRequestIntegration = { ...prepared, ...reference, phase: "open" };
const suspended: TicketPullRequestIntegration = { ...open, phase: "suspended" };
const merged: TicketPullRequestIntegration = {
  ...open, phase: "merged", mergedHeadSha: sha("d"), mergeCommitSha: sha("e"),
};
const legacy: TicketLegacyCompletedIntegration = {
  kind: "legacy-completed", scope: preparation.scope,
  baseSha: preparation.baseSha, taskSha: preparation.taskSha, remoteTaskSha: null, resultSha: sha("f"),
};
const direct = { baseSha: legacy.baseSha, taskSha: legacy.taskSha, remoteTaskSha: null, resultSha: legacy.resultSha };
const idle: TicketExecutionRecordV5 = {
  schemaVersion: 5, itemId: "PVTI_PR", issueNumber: 7, taskKey: "T007",
  taskBranch: preparation.scope.head, baseBranch: preparation.scope.base,
  path: join(process.env.TMP_DIR!, "unused"), createdAt: 100,
};
const noop = () => {};
const owners: OwnerLock[] = [];
let sequence = 0;
function fixture(record: TicketExecutionRecordV5 = idle) {
  const repo = join(process.env.TMP_DIR!, `pr-state-${++sequence}`);
  mkdirSync(repo);
  const store = new TicketWorktrees(repo);
  const owner = acquireOwnerLock(repo, "offline-bot");
  owners.push(owner);
  const file = store.recordPath(record.itemId);
  const value = { ...record, path: store.pathFor(record.itemId, record.issueNumber) };
  // Seed any valid persisted observation to test readers independently of progression.
  writeFileSync(file, JSON.stringify(value, null, "\t").replaceAll("\n", "\r\n") + "\r\n");
  return { repo, store, owner, file, record: value };
}
function expectUnchanged(f: ReturnType<typeof fixture>, action: () => unknown, error?: RegExp) {
  const before = readFileSync(f.file);
  if (error) assert.throws(action, error); else assert.throws(action);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readdirSync(f.store.recordsDir), ["pvti_pr.json"]);
}

try {
  {
    const valid: TicketExecutionRecordV5[] = [
      idle, { ...idle, plan: "original-plan", lastRunId: "original-run" },
      { ...idle, launchingAt: 0 }, { ...idle, activeRunId: "run", activeRunStartedAt: 1 },
      ...[prepared, open, suspended, merged, legacy,
        { ...prepared, ...reference }, { ...prepared, phase: "suspended" as const },
        { ...prepared, remoteTaskSha: sha("d") },
        { ...prepared, preparedHeadSha: sha("f") },
      ].map((integration) => ({ ...idle, integration })),
      { ...idle, integration: suspended, activeRunId: "original-builder", activeRunStartedAt: 1,
        retry: { stage: "build", reason: "renewed work" } },
      { ...idle, integration: suspended, launchingAt: 2 },
      { ...idle, integration: suspended, retry: { stage: "review", reason: "review original worktree" } },
      { ...idle, integration: prepared, retry: { stage: "integrate", reason: "unknown API\nRetain observation." } },
      { ...idle, integration: merged, retry: { stage: "cleanup", reason: "verify fresh base before removal" } },
      { ...idle, integration: legacy, retry: { stage: "cleanup", reason: "legacy proof" } },
    ];
    for (const record of valid) {
      assert.ok(isTicketExecutionRecordV5(record), JSON.stringify(record));
      assert.ok(isStoredTicketExecutionRecord(record));
      assert.equal(isTicketExecutionRecord(record), false, "v5 cannot masquerade as old direct integration");
      const f = fixture(record), bytes = readFileSync(f.file), restart = new TicketWorktrees(f.repo);
      assert.deepEqual(restart.readV5(idle.itemId), f.record);
      assert.deepEqual(restart.readStored(idle.itemId), f.record);
      assert.deepEqual(restart.listStored(), [f.record]);
      assert.throws(() => restart.read(idle.itemId), /PR executor/);
      assert.throws(() => restart.list(), /PR executor/);
      assert.throws(() => restart.update(idle.itemId, (r) => r), /PR executor/);
      assert.deepEqual(readFileSync(f.file), bytes, "all readers are read-only");
      f.store.assertOwnedPath(f.record);
    }
    console.log("PASS: v5 idle, prepared/open/suspended/merged and legacy-completed records round-trip with original identity; old direct readers fail closed");
  }

  {
    const invalidStates: unknown[] = [
      null, [], {}, direct, { ...prepared, kind: "direct" }, { ...prepared, phase: ["open"] },
      { ...prepared, phase: "closed" }, { ...prepared, phase: "unknown" },
      ...["baseSha", "taskSha", "remoteTaskSha", "preparedHeadSha", "initialPreparedHeadSha"].flatMap((key) =>
        [undefined, "bad", 1, sha("z")].map((value) => ({ ...prepared, [key]: value }))),
      { ...prepared, taskSha: null },
      ...[null, [], {}, { ...preparation.scope, owner: "two/owners" },
        { ...preparation.scope, repo: "../outside" }, { ...preparation.scope, repo: ".." },
        { ...preparation.scope, headOwner: "a-fork" }, { ...preparation.scope, head: "main" },
        ...["bad branch", "refs/../bad", "bad.lock", "bad/.part", "bad//part", "bad\\part", "bad@{part", "bad.", "-option", "bad:ref"].map((head) => ({ ...preparation.scope, head })),
      ].map((scope) => ({ ...prepared, scope })),
      ...[undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "19"].map((prNumber) => ({ ...open, prNumber })),
      { ...prepared, prNumber: 19 }, { ...prepared, prUrl: reference.prUrl },
      { ...prepared, prNumber: undefined, prUrl: undefined },
      ...[undefined, null, "", "not a URL", reference.prUrl + "?x=1", reference.prUrl + "#x", reference.prUrl + "/",
        reference.prUrl.replace("19", "20"), reference.prUrl.replace("offline-repo", "other-repo"),
        reference.prUrl.replace("https:", "http:"), reference.prUrl.replace("github.com", "user:pass@github.com"),
      ].map((prUrl) => ({ ...open, prUrl })),
      { ...prepared, phase: "open" }, { ...prepared, phase: "merged" },
      ...[prepared, open, suspended].flatMap((state) => [
        { ...state, mergedHeadSha: sha("d") }, { ...state, mergeCommitSha: sha("e") },
        { ...state, mergedHeadSha: undefined }, { ...state, resultSha: sha("e") },
        { ...state, merged: false },
      ]),
      { ...merged, mergedHeadSha: undefined }, { ...merged, mergeCommitSha: null },
      { ...merged, mergeCommitSha: "test-merge-is-not-proof" }, { ...merged, extra: true },
      { ...legacy, phase: "merged" }, { ...legacy, ...reference },
      { ...legacy, preparedHeadSha: sha("c") }, { ...legacy, resultSha: undefined },
    ];
    for (const value of invalidStates) {
      assert.equal(isTicketIntegrationStateV5(value), false, JSON.stringify(value));
      assert.equal(isTicketExecutionRecordV5({ ...idle, integration: value }), false);
    }
    const invalidRecords: unknown[] = [
      { ...idle, schemaVersion: 4, integration: prepared }, { ...idle, schemaVersion: 6 },
      { ...idle, baseBranch: "bad branch" }, { ...idle, taskBranch: "bad..branch" },
      { ...idle, taskBranch: idle.baseBranch },
      { ...idle, finalization: undefined }, { ...idle, extra: true },
      { ...idle, integration: { ...prepared, scope: { ...preparation.scope, head: "other-task" } } },
      { ...idle, integration: { ...prepared, scope: { ...preparation.scope, base: "other-base" } } },
      { ...idle, retry: { stage: "cleanup", reason: "no proof" } },
      { ...idle, integration: open, retry: { stage: "cleanup", reason: "unmerged test SHA" } },
      ...[prepared, open, merged, legacy].flatMap((integration) => [
        { ...idle, integration, launchingAt: 0 },
        { ...idle, integration, activeRunId: "run", activeRunStartedAt: 0 },
        { ...idle, integration, retry: { stage: "build", reason: "waiting is not a builder failure" } },
        { ...idle, integration, retry: { stage: "review", reason: "review cannot consume approval" } },
      ]),
      ...[suspended, merged, legacy].map((integration) => ({ ...idle, integration,
        retry: { stage: integration === suspended ? "cleanup" : "integrate", reason: "wrong lane" } })),
      ...[undefined, suspended].map((integration) => ({ ...idle, integration, launchingAt: 1,
        retry: { stage: "integrate", reason: "wait does not use builder slots" } })),
    ];
    const f = fixture();
    for (const value of invalidRecords) {
      assert.equal(isTicketExecutionRecordV5(value), false, JSON.stringify(value));
      expectUnchanged(f, () => f.store.updateV5(f.record, () => value as TicketExecutionRecordV5, f.owner, noop));
    }
    console.log("PASS: exact fields, source SHAs, same-repository refs/PR URL, paired reference, merged-only proof and execution/retry stages reject malformed state");
  }

  {
    const f = fixture();
    let record = f.store.preparePullRequest(f.record, preparation, f.owner, noop);
    assert.deepEqual(record.integration, prepared);
    assert.equal(record.retry, undefined, "normal preparation/waiting is not a failure");
    const unchanged = (action: () => unknown) => expectUnchanged(f, action);
    for (const integration of [undefined, { ...prepared, baseSha: sha("d") },
      { ...prepared, taskSha: sha("d") }, { ...prepared, remoteTaskSha: sha("d") },
      { ...prepared, preparedHeadSha: sha("d") }, { ...prepared, initialPreparedHeadSha: sha("d") }, open, merged, legacy,
    ]) unchanged(() => f.store.updateV5(record, (r) => ({ ...r, integration }), f.owner, noop));
    unchanged(() => f.store.updateV5(record, (r) => ({ ...r, reviewedTaskSha: sha("d") }), f.owner, noop));
    unchanged(() => f.store.preparePullRequest(record, preparation, f.owner, noop));
    // A response lost after create is recovered into this same prepared execution.
    record = f.store.progressPullRequest(record, open, undefined, f.owner, noop);
    assert.deepEqual(new TicketWorktrees(f.repo).readV5(idle.itemId)?.integration, open);
    for (const replacement of [prepared, { ...open, scope: { ...open.scope, repo: "different" } },
      { ...open, prNumber: 20, prUrl: reference.prUrl.replace("19", "20") },
      { ...open, baseSha: sha("d") }, { ...open, taskSha: sha("d") },
      { ...open, remoteTaskSha: sha("d") }, { ...open, preparedHeadSha: sha("d") },
      { ...open, initialPreparedHeadSha: sha("d") },
    ]) unchanged(() => f.store.progressPullRequest(record, replacement, undefined, f.owner, noop));
    record = f.store.progressPullRequest(record, suspended, undefined, f.owner, noop);
    unchanged(() => f.store.progressPullRequest(record, { ...prepared, phase: "suspended" }, undefined, f.owner, noop));
    unchanged(() => f.store.progressPullRequest(record, open, undefined, f.owner, noop));
    unchanged(() => f.store.progressPullRequest(record, { ...prepared, ...reference }, undefined, f.owner, noop));
    // Open Ready retires approval but retains the one PR while the original run continues.
    record = f.store.updateV5(record, (r) => ({ ...r, launchingAt: 200, reviewedTaskSha: undefined }), f.owner, noop);
    unchanged(() => f.store.preparePullRequest(record, preparation, f.owner, noop));
    record = f.store.updateV5(record, (r) => ({ ...r, launchingAt: undefined,
      activeRunId: "original-builder", activeRunStartedAt: 201 }), f.owner, noop);
    record = f.store.updateV5(record, (r) => ({ ...r, activeRunId: undefined, activeRunStartedAt: undefined,
      lastRunId: "original-builder", reviewedTaskSha: sha("d") }), f.owner, noop);
    const renewed = { ...preparation, baseSha: sha("d"), taskSha: sha("e"), remoteTaskSha: sha("e"), preparedHeadSha: sha("f") };
    unchanged(() => f.store.preparePullRequest(record, renewed, f.owner, () => { throw new Error("approval withdrawn"); }));
    unchanged(() => f.store.preparePullRequest(record, { ...renewed, scope: { ...renewed.scope, repo: "other" } }, f.owner, noop));
    record = f.store.preparePullRequest(record, renewed, f.owner, noop);
    assert.deepEqual(record.integration, { ...renewed, kind: "pr", phase: "prepared", ...reference,
      initialPreparedHeadSha: prepared.initialPreparedHeadSha });
    assert.equal(record.lastRunId, "original-builder");
    assert.equal(record.createdAt, idle.createdAt);
    const current = record.integration as TicketPullRequestIntegration;
    record = f.store.progressPullRequest(record, { ...current, phase: "merged", ...reference,
      mergedHeadSha: sha("a"), mergeCommitSha: sha("b") }, undefined, f.owner, noop);
    for (const replacement of [prepared, open, suspended, { ...record.integration, mergeCommitSha: sha("c") }])
      unchanged(() => f.store.progressPullRequest(record, replacement as TicketPullRequestIntegration, undefined, f.owner, noop));
    unchanged(() => f.store.preparePullRequest(record, renewed, f.owner, noop));
    unchanged(() => f.store.updateV5(record, (r) => ({ ...r, integration: undefined }), f.owner, noop));
    record = f.store.updateV5(record, (r) => ({ ...r, retry: { stage: "cleanup", reason: "later uncovered work blocks cleanup" } }), f.owner, noop);
    assert.equal((record.integration as typeof merged).mergeCommitSha, sha("b"));
    assert.deepEqual(new TicketWorktrees(f.repo).readV5(idle.itemId), JSON.parse(JSON.stringify(record)));
    console.log("PASS: guarded PR progression retains sources/reference/marker across suspended builder repair; merged proof never downgrades or authorizes a new submission");
  }

  {
    const f = fixture();
    const current = f.store.updateV5(f.record, (r) => ({ ...r, lastRunId: "newer-run" }), f.owner, noop);
    expectUnchanged(f, () => f.store.preparePullRequest(f.record, preparation, f.owner, noop), /changed before publication/);
    assert.throws(() => f.store.updateV5(f.record, (r) => r, f.owner, noop), TicketStateChangedError);
    f.owner.release();
    expectUnchanged(f, () => f.store.preparePullRequest(current, preparation, f.owner, noop), /owner.lock|owner was lost/);
    const other = fixture();
    expectUnchanged(other, () => other.store.updateV5(other.record, (r) => r, f.owner, noop), /owner was lost/);
    console.log("PASS: stale snapshots and missing/wrong owners cannot publish v5 progress or reinterpret later work");
  }

  {
    for (const schemaVersion of [3, 4] as const) {
      for (const execution of [{ lastRunId: "saved-run", reviewedTaskSha: sha("b") },
        { launchingAt: 123 }, { activeRunId: "original-run", activeRunStartedAt: 123 },
      ]) {
        const f = fixture();
        const { integration: _integration, ...identity } = f.record;
        const original: TicketExecutionRecord = { ...identity, schemaVersion, plan: "original-plan", ...execution };
        const raw = Buffer.from(JSON.stringify(original, null, "\t").replaceAll("\n", "\r\n") + "\r\n\r\n");
        writeFileSync(f.file, raw);
        const next: TicketExecutionRecordV5 = { ...f.record, plan: "original-plan", ...execution };
        const checks: number[] = [];
        assert.deepEqual(f.store.read(idle.itemId), original);
        assert.throws(() => f.store.readV5(idle.itemId), /migration/);
        expectUnchanged(f, () => f.store.publishV5(original, { ...next, lastRunId: "replacement" }, raw, f.owner, noop), /execution identity/);
        expectUnchanged(f, () => f.store.publishV5({ ...original, taskKey: "different" }, next, raw, f.owner, noop));
        expectUnchanged(f, () => f.store.publishV5({ ...original, reviewedTaskSha: sha("c") }, { ...next, reviewedTaskSha: sha("c") }, raw, f.owner, noop), /source does not match/);
        f.store.publishV5(original, next, raw, f.owner, () => checks.push(1));
        assert.equal(checks.length, 2, "authority/source checked both before I/O and at publication");
        assert.deepEqual(f.store.readV5(idle.itemId), next);
        expectUnchanged(f, () => f.store.publishV5(original, next, raw, f.owner, noop), /atomic write boundary/);
      }
    }
    for (const source of ["unconfirmed", "confirmed", "v3-result"] as const) {
      const f = fixture();
      const { integration: _integration, ...identity } = f.record;
      const original: TicketExecutionRecord = source === "v3-result"
        ? { ...identity, schemaVersion: 3, plan: "plan", finalization: {
          targetBranch: idle.baseBranch, baseSha: direct.baseSha, taskSha: direct.taskSha, resultSha: direct.resultSha,
        } }
        : { ...f.record, schemaVersion: 4, integration: direct,
          ...(source === "confirmed" ? { retry: { stage: "cleanup", reason: "fresh base confirmed" } as const } : {}) };
      const raw = Buffer.from(JSON.stringify(original));
      writeFileSync(f.file, raw);
      const remoteTaskSha = source === "v3-result" ? direct.taskSha : null;
      const next: TicketExecutionRecordV5 = { ...f.record, plan: original.plan,
        integration: { ...legacy, remoteTaskSha }, retry: { stage: "cleanup", reason: "fresh legacy result proven by caller" } };
      expectUnchanged(f, () => f.store.publishV5(original, { ...next, integration: undefined }, raw, f.owner, noop));
      expectUnchanged(f, () => f.store.publishV5(original, { ...next, integration: { ...legacy, taskSha: sha("d") } }, raw, f.owner, noop));
      expectUnchanged(f, () => f.store.publishV5(original, { ...next, integration: { ...legacy, remoteTaskSha, resultSha: sha("d") } }, raw, f.owner, noop));
      if (source === "confirmed")
        expectUnchanged(f, () => f.store.publishV5(original, { ...next, retry: undefined, integration: prepared }, raw, f.owner, noop));
      f.store.publishV5(original, next, raw, f.owner, noop);
      assert.equal(f.store.readV5(idle.itemId)?.integration?.kind, "legacy-completed");
      expectUnchanged(f, () => f.store.updateV5(next, (r) => ({ ...r, integration: prepared }), f.owner, noop));
    }
    const f = fixture();
    for (const stage of ["build", "review"] as const) {
      const { integration: _integration, ...identity } = f.record;
      const original: TicketExecutionRecordV4 = { ...identity, schemaVersion: 4,
        retry: { stage, reason: "pending original writeback/diagnostic" } };
      const raw = Buffer.from(JSON.stringify(original));
      writeFileSync(f.file, raw);
      expectUnchanged(f, () => f.store.publishV5(original, f.record, raw, f.owner, noop));
      const next = { ...f.record, retry: original.retry };
      f.store.publishV5(original, next, raw, f.owner, noop);
      assert.deepEqual(f.store.readV5(idle.itemId)?.retry, original.retry);
    }
    console.log("PASS: explicit raw-source v3/v4 migration preserves worktree/run identity, unsettled retry and legacy sources; confirmed old completion remains separately discriminated and immutable");
  }

  {
    const f = fixture();
    const { integration: _integration, ...identity } = f.record;
    const original: TicketExecutionRecordV4 = { ...identity, schemaVersion: 4 };
    // Do not invent source bytes for a recordless receipt.
    unlinkSync(f.file);
    const next: TicketExecutionRecordV5 = { ...f.record, integration: legacy };
    assert.throws(() => f.store.publishV5(original, next, undefined, f.owner, noop), /Invalid v5/);
    const receipt = join(f.repo, ".pi", "board-agent", "cleanup", "pvti_pr.json");
    writeFileSync(receipt, "caller validates and archives this receipt, not fabricated ticket bytes");
    assert.throws(() => f.store.createV5(f.record, f.owner, noop), /pending cleanup receipt/);
    f.store.publishV5(original, next, undefined, f.owner, noop);
    assert.deepEqual(f.store.readV5(idle.itemId), next);
    const receiptBytes = readFileSync(receipt);
    // Old cleanup may retain a ticket with no finalization journal; its receipt
    // is still the completion source and the caller must validate/archive both.
    const raw = Buffer.from(JSON.stringify(original));
    writeFileSync(f.file, raw);
    expectUnchanged(f, () => f.store.publishV5(original, { ...f.record, integration: prepared }, raw, f.owner, noop));
    let checks = 0;
    expectUnchanged(f, () => f.store.publishV5(original, next, raw, f.owner, () => {
      if (++checks === 2) unlinkSync(receipt);
    }), /receipt presence changed/);
    writeFileSync(receipt, receiptBytes);
    f.store.publishV5(original, next, raw, f.owner, noop);
    assert.deepEqual(f.store.readV5(idle.itemId), next);
    assert.deepEqual(readFileSync(receipt), receiptBytes);
    console.log("PASS: receipt-backed and recordless migration require retained receipt presence and explicit caller proof; ordinary v5 creation/PR preparation cannot bypass recovery");
  }

  {
    const f = fixture();
    for (const bytes of ["{broken", JSON.stringify({ ...f.record, integration: direct }), JSON.stringify({ ...f.record, schemaVersion: 6 })]) {
      writeFileSync(f.file, bytes);
      assert.equal(f.store.readV5(idle.itemId), undefined);
      assert.equal(f.store.has(idle.itemId), true);
      assert.deepEqual(f.store.listStored(), []);
      assert.throws(() => f.store.createV5(f.record, f.owner, noop), /atomic write boundary/);
      assert.throws(() => f.store.updateV5(f.record, (r) => r, f.owner, noop), /changed before publication/);
      assert.equal(readFileSync(f.file, "utf8"), bytes);
    }
    console.log("PASS: corrupt/unsupported v5 sources stay present, cannot be overwritten as absence and never authorize completion");
  }
} finally {
  for (const owner of owners) owner.release();
}
