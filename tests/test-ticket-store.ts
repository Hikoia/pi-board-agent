import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isTicketExecutionRecord,
  TicketWorktrees,
  type TicketExecutionRecord,
  type TicketExecutionRecordV4,
  type TicketRetryState,
} from "../src/ticket-worktree.js";
import { findUnsupportedState } from "../src/unsupported-state.js";

const root = process.env.TMP_DIR!;
const integration = {
  baseSha: "a".repeat(40),
  taskSha: "b".repeat(40),
  resultSha: "c".repeat(40),
};
const finalization = { targetBranch: "main", ...integration };
const v4: TicketExecutionRecordV4 = {
  schemaVersion: 4,
  itemId: "PVTI_1",
  issueNumber: 1,
  taskKey: "T001",
  taskBranch: "task/issue-1",
  baseBranch: "main",
  path: join(root, "unused-worktree"),
  createdAt: 1,
};
const v3: TicketExecutionRecord = { ...v4, schemaVersion: 3, plan: "demo" };
let sequence = 0;
function fixture(record: TicketExecutionRecord = v4) {
  const repo = join(root, `store-${++sequence}`);
  mkdirSync(repo);
  const store = new TicketWorktrees(repo, testOwner(repo));
  const dir = join(repo, ".pi", "board-agent", "ticket-worktrees");
  const file = join(dir, "pvti_1.json");
  if (record.schemaVersion === 4) store.legacyCreate(record as TicketExecutionRecordV4);
  else writeFileSync(file, JSON.stringify(record, null, 2)); // exact old fixture, no conversion
  return { repo, store, dir, file };
}

{
  const valid: TicketExecutionRecord[] = [
    v3,
    { ...v3, launchingAt: 0 },
    { ...v3, activeRunId: "paused-run", activeRunStartedAt: 0 },
    { ...v3, finalization: { ...finalization, resultSha: undefined } },
    { ...v3, finalization },
    v4,
    { ...v4, plan: "optional-plan" },
    { ...v4, launchingAt: 0, lastRunId: "old-run" },
    { ...v4, activeRunId: "paused-run", activeRunStartedAt: 0 },
    { ...v4, integration, reviewedTaskSha: integration.taskSha },
    ...(["build", "review", "integrate", "cleanup"] as const).map((stage) => ({
      ...v4,
      retry: { stage, reason: "I/O failure\nKeep the original diagnostic." },
    })),
  ];
  for (const value of valid) {
    assert.ok(isTicketExecutionRecord(value), JSON.stringify(value));
    const f = fixture(value);
    const before = readFileSync(f.file);
    const reopened = new TicketWorktrees(f.repo, testOwner(f.repo));
    assert.deepEqual(reopened.legacyRead(value.itemId), JSON.parse(before.toString()));
    assert.deepEqual(reopened.legacyList(), [reopened.legacyRead(value.itemId)]);
    assert.deepEqual(findUnsupportedState(f.repo), []);
    assert.deepEqual(readFileSync(f.file), before, "read/startup inspection is read-only");
  }
  console.log("PASS: v4 optional Plan, all retry stages, integration, active/launch identities and v3 journals round-trip without migration");
}

{
  const invalid: unknown[] = [
    null, [], {},
    ...[1, 2, 5, "4"].map((schemaVersion) => ({ ...v4, schemaVersion })),
    { ...v3, plan: undefined },
    { ...v3, retry: { stage: "build", reason: "failure" } },
    { ...v3, integration },
    { ...v4, finalization },
    { ...v4, obsolete: true },
    ...[null, "", " ", "two\nlines", 2].map((plan) => ({ ...v4, plan })),
    ...["itemId", "taskKey", "taskBranch", "baseBranch", "path"].map((key) => ({ ...v4, [key]: "" })),
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((issueNumber) => ({ ...v4, issueNumber })),
    ...[-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((createdAt) => ({ ...v4, createdAt })),
    { ...v4, launchingAt: -1 },
    { ...v4, activeRunId: "run" },
    { ...v4, activeRunStartedAt: 1 },
    { ...v4, activeRunId: "run", activeRunStartedAt: 1, launchingAt: 1 },
    { ...v4, reviewedTaskSha: "not-a-sha" },
    ...[null, [], {}, { stage: "build" }, { reason: "missing stage" },
      { stage: "design", reason: "unknown lane" }, { stage: ["build"], reason: "not a string" },
      { stage: "build", reason: " " }, { stage: "build", reason: 1 },
      { stage: "build", reason: "failure", attempts: 2 },
    ].map((retry) => ({ ...v4, retry })),
    ...[null, [], {}, { ...integration, resultSha: undefined },
      { ...integration, baseSha: "bad" }, { ...integration, taskSha: 1 },
      { ...integration, resultSha: "d".repeat(39) }, { ...integration, pushed: true },
    ].map((integration) => ({ ...v4, integration })),
    { ...v4, integration, launchingAt: 1 },
    { ...v4, integration, activeRunId: "run", activeRunStartedAt: 1 },
    { ...v3, finalization, launchingAt: 1 },
    { ...v3, finalization: { ...finalization, pushed: true } },
  ];
  const f = fixture();
  const before = readFileSync(f.file);
  for (const value of invalid) {
    assert.equal(isTicketExecutionRecord(value), false, JSON.stringify(value));
    assert.throws(() => f.store.legacyCreate(value as TicketExecutionRecordV4));
    assert.throws(() => f.store.legacyUpdate(v4.itemId, () => value as TicketExecutionRecord));
    assert.deepEqual(readFileSync(f.file), before);
  }
  assert.deepEqual(readdirSync(f.dir), ["pvti_1.json"]);
  console.log("PASS: strict version-specific fields, identities, timestamps, retry and integration reject malformed writes without touching valid state");
}

{
  const retry: TicketRetryState = { stage: "build", reason: "failed tests; status/release still pending" };
  const f = fixture({ ...v4, retry });
  f.store.legacyBeginLaunch(v4.itemId, 10);
  f.store.legacySetActiveRun(v4.itemId, "original-run", 11);
  assert.throws(() => f.store.legacyBeginLaunch(v4.itemId), /active builder/);
  assert.deepEqual(f.store.legacyRead(v4.itemId)?.retry, retry);
  f.store.legacyClearExecution(v4.itemId, "original-run");
  const reopened = new TicketWorktrees(f.repo, testOwner(f.repo));
  assert.deepEqual(reopened.legacyRead(v4.itemId)?.retry, retry);
  assert.equal(reopened.legacyRead(v4.itemId)?.lastRunId, "original-run");
  assert.equal(reopened.legacyRead(v4.itemId)?.activeRunId, undefined);
  for (const stage of ["review", "integrate", "cleanup"] as const) {
    reopened.legacyUpdate(v4.itemId, (r) => ({ ...r, retry: { ...retry, stage } }));
    assert.throws(() => reopened.legacyBeginLaunch(v4.itemId), /retry cannot start a builder/);
  }
  // Only explicit successful settlement consumes retry; execution release alone never does.
  reopened.legacyUpdate(v4.itemId, (r) => ({ ...r, retry: undefined }));
  reopened.legacySetReviewedTaskSha(v4.itemId, integration.taskSha);
  reopened.legacyUpdate(v4.itemId, (r) => ({ ...r, integration, retry: { stage: "cleanup", reason: "Done write failed" } }));
  reopened.legacyClearExecution(v4.itemId);
  const before = readFileSync(f.file);
  for (const progress of [undefined,
    { ...integration, baseSha: "d".repeat(40) },
    { ...integration, taskSha: "d".repeat(40) },
    { ...integration, resultSha: "d".repeat(40) },
  ]) assert.throws(() => reopened.legacyUpdate(v4.itemId, (r) => ({ ...r, integration: progress })), /pending integration/);
  assert.throws(() => reopened.legacyUpdate(v4.itemId, (r) => ({ ...r, reviewedTaskSha: undefined })), /pending integration/);
  assert.throws(() => reopened.legacyBeginLaunch(v4.itemId), /pending finalization/);
  assert.throws(() => reopened.legacySetActiveRun(v4.itemId, "second-run"), /pending finalization/);
  assert.throws(() => reopened.legacySetReviewedTaskSha(v4.itemId, "d".repeat(40)), /pending finalization/);
  // A prepared result cannot authorize cleanup without fresh Git proof, even with no task ref.
  assert.equal("finalizeAccepted" in reopened, false, "old direct integration engine is deleted");
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(new TicketWorktrees(f.repo, testOwner(f.repo)).legacyRead(v4.itemId)?.integration, integration);
  assert.equal(new TicketWorktrees(f.repo, testOwner(f.repo)).legacyRead(v4.itemId)?.retry?.stage, "cleanup");
  console.log("PASS: execution release retains unsettled retry and immutable integration; prepared results never imply success or authorize old cleanup");
}

{
  const f = fixture(v3);
  f.store.legacyBeginLaunch(v3.itemId, 10);
  f.store.legacySetActiveRun(v3.itemId, "v3-run", 11);
  f.store.legacyClearExecution(v3.itemId, "v3-run");
  f.store.legacySetReviewedTaskSha(v3.itemId, integration.taskSha);
  f.store.legacyUpdate(v3.itemId, (r) => ({ ...r, finalization }));
  const before = readFileSync(f.file);
  assert.throws(() => f.store.legacyUpdate(v3.itemId, (r) => ({ ...r, finalization: undefined })), /pending finalization/);
  assert.throws(() => f.store.legacyUpdate(v3.itemId, (r) => ({ ...r, schemaVersion: 4, finalization: undefined })), /Invalid ticket execution update/);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(f.store.legacyRead(v3.itemId)?.schemaVersion, 3);
  assert.equal(f.store.legacyRead(v3.itemId)?.lastRunId, "v3-run");
  console.log("PASS: v3 execution updates and protected finalization journals retain their version; ordinary writes cannot migrate");
}

{
  const f = fixture();
  for (const bytes of ["{broken", JSON.stringify({ ...v3, schemaVersion: 2 }), JSON.stringify({ ...v4, integration: {} })]) {
    writeFileSync(f.file, bytes);
    assert.equal(f.store.legacyRead(v4.itemId), undefined);
    assert.equal(f.store.has(v4.itemId), true, "invalid is not absent");
    assert.deepEqual(f.store.legacyList(), []);
    assert.equal(findUnsupportedState(f.repo).length, 1);
    assert.throws(() => f.store.legacyCreate(v4), /already exists/);
    assert.throws(() => f.store.legacyClearExecution(v4.itemId), /missing or unsupported/);
    assert.throws(() => f.store.legacySetReviewedTaskSha(v4.itemId, integration.taskSha), /missing or unsupported/);
    assert.equal(readFileSync(f.file, "utf8"), bytes);
  }
  rmSync(f.file);
  assert.equal(f.store.legacyRead(v4.itemId), undefined);
  assert.equal(f.store.has(v4.itemId), false);
  assert.throws(() => f.store.legacyClearExecution(v4.itemId), /missing or unsupported/);
  assert.throws(() => f.store.legacySetReviewedTaskSha(v4.itemId, integration.taskSha), /missing or unsupported/);
  assert.equal(existsSync(f.file), false, "missing state is not recreated by completion");
  f.store.legacyCreate(v4);
  const before = readFileSync(f.file);
  assert.throws(() => f.store.legacyCreate({ ...v4, itemId: "pvti_1" }), /already exists/);
  assert.equal(f.store.legacyRead("pvti_1"), undefined);
  assert.throws(() => f.store.legacyUpdate(v4.itemId, (r) => ({ ...r, path: "other-worktree" })), /Invalid ticket execution update/);
  assert.deepEqual(readFileSync(f.file), before);
  console.log("PASS: corrupt, unsupported, missing and colliding records cannot be overwritten or completed as success");
}

import { testOwner, noPullRequests } from "./pr-fixture.js";
