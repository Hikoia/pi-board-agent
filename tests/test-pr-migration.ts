// Offline migration acceptance: real Git and immutable legacy evidence, no GH.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fixture, git, calls, faults, dispose, useNativeGitFixture } from "./cleanup-fixture.js";
import type { TicketExecutionRecord } from "../src/ticket-worktree.js";
import type { Card } from "../src/gh.js";
useNativeGitFixture();
const { LegacyTickets } = await import("../src/legacy-tickets.js");
const { acquireOwnerLock } = await import("../src/owner-lock.js");
const { _DEFAULTS } = await import("../src/config.js");
const { historicalReceipt } = await import("./legacy-cleanup-fixture.js");
type Fixture = Awaited<ReturnType<typeof fixture>>;
function adapter(f: Fixture, status = _DEFAULTS.columns.done) {
  const card: Card = { itemId: f.task.itemId, number: f.task.issueNumber, title: f.task.title, body: f.task.body,
    contentType: "Issue", type: "Task", status, closed: true, assignees: [], plan: "demo", repoOwner: "owner", repoName: "repo" };
  return new LegacyTickets({ worktrees: f.store, cfg: structuredClone(_DEFAULTS), botLogin: "bot", repoOwner: "owner", repoName: "repo",
    board: { getCard: async () => structuredClone(card), setStatus: async () => assert.fail("no board mutation during completion migration") } });
}
const scope = (f: Fixture) => ({ owner: "owner", repo: "repo", base: f.task.baseBranch, head: f.task.taskBranch });
const backup = (f: Fixture, version: 3 | 4) => join(f.repo, ".pi", "board-agent", `legacy-v${version}`, basename(f.recordFile));
function rawSource(f: Fixture) {
  const value = JSON.parse(readFileSync(f.recordFile, "utf8"));
  const bytes = Buffer.from(JSON.stringify(value, null, "\t").replaceAll("\n", "\r\n") + "\r\n\r\n");
  writeFileSync(f.recordFile, bytes);
  return bytes;
}
function noMigrationWrites() {
  assert.ok(!calls.some((a) => ["push", "commit-tree", "update-ref", "clean"].includes(a[0]) ||
    (a[0] === "worktree" && a[1] !== "list")), "migration only observes Git and validates existing trees");
}
function resetFaults() {
  faults.beforeGit = faults.afterGit = faults.beforeFs = faults.afterFs = faults.beforeSyncFs = undefined;
}
async function preparedLegacy(f: Fixture) {
  // Reproduce a protected-base rejection using the old committed algorithm.
  // Nothing is pushed: its exact persisted result is the migration input.
  faults.beforeGit = (a) => { if (a[0] === "push") throw new Error("offline protected base rejection (#121)"); };
  try { await assert.rejects(f.store.finalizeAccepted(f.task, "merge"), /protected base rejection/); }
  finally { resetFaults(); }
  return f.store.read(f.task.itemId)!.integration!;
}
function oldV3(f: Fixture, squash = false) {
  const resultSha = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base,
    ...(squash ? [] : ["-p", f.taskSha]), "-m", "original v3 result");
  f.store.update(f.task.itemId, (r) => ({ ...r, lastRunId: "original-builder", reviewedTaskSha: f.taskSha,
    finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha, resultSha } }));
  return resultSha;
}
try {
  for (const variant of ["same", "local-only", "remote-only", "local-ahead", "remote-ahead", "divergent", "implicit-remote"] as const) {
    const f = await fixture(false, true);
    if (["remote-ahead", "divergent"].includes(variant)) {
      git(f.repo, "checkout", "--detach", f.taskSha);
      writeFileSync(join(f.repo, "remote.txt"), "remote contribution\n");
      git(f.repo, "add", "."); git(f.repo, "commit", "-m", "remote contribution");
      git(f.repo, "push", "origin", `HEAD:refs/heads/${f.task.taskBranch}`);
      git(f.repo, "checkout", "main");
    }
    if (["local-ahead", "divergent"].includes(variant)) {
      writeFileSync(join(f.record.path, "local.txt"), "local contribution\n");
      git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "local contribution");
    }
    if (variant === "local-only") git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
    if (variant === "remote-only") {
      git(f.repo, "worktree", "remove", f.record.path);
      git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`);
    }
    let state = await preparedLegacy(f);
    if (variant === "implicit-remote") {
      const old = f.store.read(f.task.itemId)!;
      delete old.integration!.remoteTaskSha;
      writeFileSync(f.recordFile, JSON.stringify(old));
      state = old.integration!;
    }
    // Base may advance, even to a conflicting tree. Validate the old sources,
    // not a new integration against this base, and keep the old head unchanged.
    writeFileSync(join(f.repo, "feature.txt"), "later conflicting base\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-m", "later base"); git(f.repo, "push", "origin", "main");
    const base = f.tip(), bytes = rawSource(f), head = git(f.repo, "rev-parse", `refs/heads/${f.task.taskBranch}`);
    const owner = acquireOwnerLock(f.repo, "bot"), legacy = adapter(f);
    try {
      calls.length = 0;
      assert.deepEqual((await legacy.migrateV5(owner)).failures, []);
      noMigrationWrites();
      assert.deepEqual(readFileSync(backup(f, 4)), bytes);
      const record = f.store.readV5(f.task.itemId)!;
      assert.equal(record.schemaVersion, 5);
      assert.deepEqual(record.integration, { kind: "pr", phase: "prepared", scope: scope(f),
        baseSha: state.baseSha, taskSha: state.taskSha, remoteTaskSha: state.remoteTaskSha === undefined ? state.taskSha : state.remoteTaskSha,
        preparedHeadSha: state.resultSha, initialPreparedHeadSha: state.resultSha });
      assert.equal(record.createdAt, f.record.createdAt);
      assert.equal(record.reviewedTaskSha, f.taskSha);
      assert.equal(legacy.blockedReason(f.task.itemId), undefined);
      await assert.rejects(f.store.finalizeAccepted(f.task, "merge"), /PR executor/);
      calls.length = 0;
      await f.store.preparePullRequest(f.task, scope(f), owner, async () => {});
      assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), state.resultSha);
      assert.equal(git(f.repo, "rev-parse", `refs/heads/${f.task.taskBranch}`), head);
      if (variant === "remote-only") assert.equal(existsSync(f.record.path), false);
      else assert.equal(git(f.record.path, "rev-parse", "HEAD"), head);
      assert.equal(f.tip(), base);
      assert.equal(calls.filter((a) => a[0] === "commit-tree" || a[0] === "merge-tree").length, 0, "prepared retry never rebuilds the result");
      assert.ok(calls.filter((a) => a[0] === "push").every((a) => a.at(-1) === `${state.resultSha}:refs/heads/${f.task.taskBranch}`));
      const published = readFileSync(f.recordFile);
      assert.deepEqual((await adapter(f).migrateV5(owner)).converted, []);
      assert.deepEqual(readFileSync(f.recordFile), published);
      console.log(`PASS: #121 ${variant} result migrates directly to v5 and normally publishes the identical prepared task head, never base or a rebuilt result`);
    } finally { owner.release(); }
  }

  for (const version of [3, 4] as const) {
    for (const squash of version === 3 ? [false, true] : [false]) {
      const f = await fixture(false, version === 4);
      const result = version === 3 ? oldV3(f, squash) : (await preparedLegacy(f)).resultSha;
      git(f.repo, "push", "origin", `${result}:refs/heads/main`);
      const advanced = git(f.repo, "commit-tree", `${result}^{tree}`, "-p", result, "-m", "later base");
      git(f.repo, "push", "origin", `${advanced}:refs/heads/main`);
      const bytes = rawSource(f), owner = acquireOwnerLock(f.repo, "bot");
      try {
        calls.length = 0;
        assert.deepEqual((await adapter(f).migrateV5(owner)).failures, []);
        noMigrationWrites();
        const record = f.store.readV5(f.task.itemId)!;
        assert.equal(record.integration?.kind, "legacy-completed");
        assert.equal(record.retry?.stage, "cleanup");
        assert.deepEqual(readFileSync(backup(f, version)), bytes);
        await assert.rejects(f.store.preparePullRequest(f.task, scope(f), owner, async () => {}), /preparation/);
        assert.throws(() => f.store.updateV5(record, (r) => ({ ...r, integration: undefined }), owner, () => {}), /evidence/);
        const sha = await f.store.cleanupLegacyCompleted(f.task, owner, async () => {});
        assert.equal(sha, result);
        assert.ok(f.store.has(f.task.itemId), "record is last, after Backlog confirmation");
        await f.store.completeFinalization(f.task, sha, async () => {}, undefined, owner);
        assert.equal(f.store.has(f.task.itemId), false);
        assert.equal(existsSync(f.record.path), false);
        assert.equal(f.tip(), advanced);
        assert.ok(!calls.some((a) => a[0] === "push" && !a.at(-1)!.startsWith(":")), "completed data never prepares a PR or pushes any result");
        console.log(`PASS: completed v${version} ${squash ? "squash" : "merge"} on advanced fresh base becomes immutable cleanup-only and never prepares a PR`);
      } finally { owner.release(); }
    }
  }

  {
    const f = await fixture();
    const result = oldV3(f, true), owner = acquireOwnerLock(f.repo, "bot"), legacy = adapter(f);
    try {
      // A valid v3 squash previously converted to v4 keeps its original proof.
      assert.deepEqual((await legacy.migrate(owner)).failures, []);
      const bytes = rawSource(f), archivedV3 = readFileSync(backup(f, 3));
      git(f.repo, "push", "origin", `${result}:refs/heads/main`);
      assert.deepEqual((await legacy.migrateV5(owner)).failures, []);
      assert.deepEqual(readFileSync(backup(f, 4)), bytes);
      assert.deepEqual(readFileSync(backup(f, 3)), archivedV3);
      assert.equal(f.store.readV5(f.task.itemId)!.integration?.kind, "legacy-completed");
      console.log("PASS: a v4 single-parent result needs matching archived v3 intent and migrates its exact completed squash without rewriting either backup");
    } finally { owner.release(); }
  }

  for (const kind of ["unknown-result", "wrong-tree", "wrong-parents", "rewritten-base", "local-mismatch", "remote-mismatch", "cleanup-missing", "cleanup-unconfirmed", "corrupt", "future-version"] as const) {
    const f = await fixture(false, true);
    const state = await preparedLegacy(f);
    let record = f.store.read(f.task.itemId)!;
    if (kind === "unknown-result") record.integration!.resultSha = "0".repeat(40);
    if (kind === "wrong-tree") record.integration!.resultSha = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-p", f.taskSha, "-m", "wrong tree");
    if (kind === "wrong-parents") record.integration!.resultSha = f.taskSha;
    if (kind === "rewritten-base") {
      const unrelated = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-m", "unrelated rewritten base");
      git(f.repo, "push", "--force", "origin", `${unrelated}:refs/heads/main`); // fixture-only rewrite
    }
    if (kind === "local-mismatch") {
      writeFileSync(join(f.record.path, "new.txt"), "new human work\n");
      git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "new work");
    }
    if (kind === "remote-mismatch") git(f.repo, "push", "--force", "origin", `${f.base}:refs/heads/${f.task.taskBranch}`);
    if (kind.startsWith("cleanup-")) {
      record.retry = { stage: "cleanup", reason: "previously confirmed; never publish again" };
      if (kind === "cleanup-missing") delete record.integration;
    }
    writeFileSync(f.recordFile, kind === "corrupt" ? "{unknown partial bytes" :
      JSON.stringify({ ...record, ...(kind === "future-version" ? { schemaVersion: 6 } : {}) }));
    const bytes = readFileSync(f.recordFile), owner = acquireOwnerLock(f.repo, "bot"), legacy = adapter(f), tip = f.tip();
    try {
      calls.length = 0;
      const report = await legacy.migrateV5(owner);
      assert.equal(report.failures.length, 1, JSON.stringify(report));
      assert.ok(legacy.blockedReason(f.task.itemId));
      noMigrationWrites();
      assert.deepEqual(readFileSync(f.recordFile), bytes);
      if (existsSync(backup(f, 4))) assert.deepEqual(readFileSync(backup(f, 4)), bytes);
      assert.equal(f.tip(), tip);
      assert.ok(existsSync(f.record.path));
      assert.ok(git(f.repo, "cat-file", "-t", state.resultSha) === "commit");
      console.log(`PASS: ${kind} blocks without losing original bytes, existing backup or work and without a base-push fallback`);
    } finally { owner.release(); }
  }

  for (const squash of [false, true]) {
    const f = await fixture();
    const result = oldV3(f, squash), bytes = rawSource(f), owner = acquireOwnerLock(f.repo, "bot");
    try {
      calls.length = 0;
      const report = await adapter(f).migrateV5(owner);
      noMigrationWrites();
      if (squash) {
        assert.match(report.failures[0].reason, /source ancestry/);
        assert.deepEqual(readFileSync(f.recordFile), bytes);
      } else {
        assert.deepEqual(report.failures, []);
        const record = f.store.readV5(f.task.itemId)!;
        assert.equal(record.integration?.kind, "pr");
        assert.equal(record.integration?.kind === "pr" && record.integration.preparedHeadSha, result);
        assert.equal(record.lastRunId, "original-builder");
      }
      console.log(`PASS: pending v3 ${squash ? "squash losing source ancestry blocks instead of guessing patch equivalence" : "merge reuses its exact result and run/review identity"}`);
    } finally { owner.release(); }
  }

  {
    const f = await fixture();
    f.store.update(f.task.itemId, (r) => ({ ...r, reviewedTaskSha: f.taskSha,
      finalization: { targetBranch: "main", baseSha: f.base, taskSha: f.taskSha } }));
    const bytes = rawSource(f), owner = acquireOwnerLock(f.repo, "bot");
    try {
      calls.length = 0;
      assert.deepEqual((await adapter(f).migrateV5(owner)).failures, []);
      noMigrationWrites();
      assert.equal(f.store.readV5(f.task.itemId)!.integration, undefined);
      assert.equal(f.store.readV5(f.task.itemId)!.retry?.stage, "integrate");
      assert.deepEqual(readFileSync(backup(f, 3)), bytes);
      await f.store.preparePullRequest(f.task, scope(f), owner, async () => {});
      assert.equal(f.store.readV5(f.task.itemId)!.integration?.kind, "pr");
      assert.equal(f.tip(), f.base);
      console.log("PASS: v3 pre-result intent migrates without a persisted v4 draft and only the PR preparation seam may finish its approved work");
    } finally { owner.release(); }
  }

  for (const cut of ["before-backup", "after-backup", "save", "after-publish", "source", "backup", "local-source", "remote-source", "owner", "stop"] as const) {
    const f = await fixture(false, true);
    await preparedLegacy(f);
    const bytes = rawSource(f);
    let owner = acquireOwnerLock(f.repo, "bot"), canMigrate = true, reached = false;
    const publish = f.store.publishV5.bind(f.store);
    if (["source", "backup", "owner", "stop"].includes(cut)) {
      f.store.publishV5 = (original, next, raw, held, guard, observed) => {
        let checks = 0;
        return publish(original, next, raw, held, () => {
          if (++checks === 2) {
            reached = true;
            if (cut === "source") writeFileSync(f.recordFile, "{externally changed source");
            if (cut === "backup") writeFileSync(backup(f, 4), "unknown backup replacement");
            if (cut === "owner") owner.release();
            if (cut === "stop") canMigrate = false;
          }
          guard();
        }, observed);
      };
    } else if (cut === "after-publish") {
      f.store.publishV5 = (...args) => { publish(...args); reached = true; throw new Error("lost publication response"); };
    } else if (cut === "save") {
      faults.beforeSyncFs = (op, from, to) => {
        if (op === "renameSync" && to === f.recordFile) {
          assert.equal(JSON.parse(readFileSync(from, "utf8")).schemaVersion, 5, "never publish an intermediate v4");
          reached = true; throw new Error("save cut");
        }
      };
    } else if (cut.endsWith("backup")) {
      faults[cut === "before-backup" ? "beforeFs" : "afterFs"] = (op, path) => {
        if (op === "link" && path.includes("legacy-v4")) { reached = true; throw new Error(cut); }
      };
    } else {
      faults.afterGit = (args) => {
        if (args[0] === "fetch" && !reached) {
          reached = true;
          if (cut === "local-source") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.base);
          else git(f.repo, "push", "--force", "origin", `${f.base}:refs/heads/${f.task.taskBranch}`);
        }
      };
    }
    try {
      if (cut === "owner" || cut === "stop") await assert.rejects(adapter(f).migrateV5(owner, () => canMigrate), /owner|cancelled/i);
      else assert.equal((await adapter(f).migrateV5(owner)).failures.length, 1);
      assert.ok(reached, cut);
      resetFaults(); f.store.publishV5 = publish;
      if (cut === "after-publish") assert.equal(f.store.readV5(f.task.itemId)!.schemaVersion, 5);
      else if (cut === "source") assert.equal(readFileSync(f.recordFile, "utf8"), "{externally changed source");
      else assert.deepEqual(readFileSync(f.recordFile), bytes);
      if (cut === "backup") assert.equal(readFileSync(backup(f, 4), "utf8"), "unknown backup replacement");
      else if (cut !== "before-backup") assert.deepEqual(readFileSync(backup(f, 4)), bytes);
      if (cut === "owner") owner = acquireOwnerLock(f.repo, "bot");
      canMigrate = true;
      // Only the fixture repairs its deliberate external changes. Migration never does.
      if (cut === "source") writeFileSync(f.recordFile, bytes);
      if (cut === "backup") writeFileSync(backup(f, 4), bytes);
      if (cut === "local-source") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      if (cut === "remote-source") git(f.repo, "push", "origin", `${f.taskSha}:refs/heads/${f.task.taskBranch}`);
      const report = await adapter(f).migrateV5(owner);
      assert.deepEqual(report.failures, []);
      assert.equal(report.converted.length, cut === "after-publish" ? 0 : 1);
      assert.equal(f.store.readV5(f.task.itemId)!.schemaVersion, 5);
      assert.deepEqual(readFileSync(backup(f, 4)), bytes);
      console.log(`PASS: ${cut} crash/race preserves exact legacy or whole v5 with a create-only raw backup; restart is retry-safe`);
    } finally { resetFaults(); owner.release(); }
  }

  {
    const { fixture: executionFixture } = await import("./legacy-migration-fixture.js");
    const f = await executionFixture();
    const expected: Array<{ file: string; bytes: Buffer; record: TicketExecutionRecord; run?: string }> = [];
    const evidence = new Map<string, Buffer>();
    for (const version of [3, 4] as const) {
      for (const status of ["running", "paused"] as const) {
        const t = await f.ticket(`v${version}-${status}`);
        const j = f.journal(t.record, `original-v${version}-${status}`, status);
        f.store.setActiveRun(t.card.itemId, j.run.runId, Date.parse(j.run.startedAt));
        const record = { ...f.store.read(t.card.itemId)!, schemaVersion: version, lastRunId: "previous-run", reviewedTaskSha: f.sha };
        writeFileSync(t.file, JSON.stringify(record));
        writeFileSync(join(t.record.path, "work.txt"), "original partial work\n");
        writeFileSync(join(t.record.path, "untracked.txt"), "original untracked work\n");
        expected.push({ file: t.file, bytes: readFileSync(t.file), record, run: j.run.runId });
        evidence.set(j.file, readFileSync(j.file));
      }
    }
    const unique = await f.ticket("launch-unique"), absent = await f.ticket("launch-absent"), ambiguous = await f.ticket("launch-ambiguous");
    for (const t of [unique, absent, ambiguous]) {
      f.store.beginLaunch(t.card.itemId, t.record.createdAt);
      expected.push({ file: t.file, bytes: readFileSync(t.file), record: f.store.read(t.card.itemId)! });
    }
    for (const [t, id] of [[unique, "unique-original"], [ambiguous, "first-original"], [ambiguous, "second-original"]] as const) {
      const j = f.journal(t.record, id); evidence.set(j.file, readFileSync(j.file));
    }
    const v4Launch = await f.ticket("v4-launch");
    const v4Launching: TicketExecutionRecord = { ...v4Launch.record, schemaVersion: 4, launchingAt: v4Launch.record.createdAt };
    writeFileSync(v4Launch.file, JSON.stringify(v4Launching));
    expected.push({ file: v4Launch.file, bytes: readFileSync(v4Launch.file), record: v4Launching });
    const v4Journal = f.journal(v4Launching, "v4-original-launch"); evidence.set(v4Journal.file, readFileSync(v4Journal.file));
    const uncertainRepair = await f.ticket("uncertain-repair", f.cfg.columns.ready);
    const uncertainLedger = f.ledger(uncertainRepair.record, uncertainRepair.card, "queued");
    evidence.set(uncertainLedger.file, readFileSync(uncertainLedger.file));
    for (const id of ["repair-first", "repair-second"]) {
      const j = f.journal(uncertainRepair.record, id, "paused", uncertainLedger.request);
      evidence.set(j.file, readFileSync(j.file));
    }
    expected.push({ file: uncertainRepair.file, bytes: readFileSync(uncertainRepair.file), record: uncertainRepair.record });
    const repair = await f.ticket("repair", f.cfg.columns.ready);
    const ledger = f.ledger(repair.record, repair.card, "queued"); evidence.set(ledger.file, readFileSync(ledger.file));
    writeFileSync(join(repair.record.path, "work.txt"), "task side\n");
    git(repair.record.path, "add", "."); git(repair.record.path, "commit", "-m", "task side");
    writeFileSync(join(f.repo, "work.txt"), "base side\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-m", "base side");
    assert.throws(() => git(repair.record.path, "merge", "--no-edit", "main"));
    const mergeHead = git(repair.record.path, "rev-parse", "MERGE_HEAD"), diff = git(repair.record.path, "diff");
    expected.push({ file: repair.file, bytes: readFileSync(repair.file), record: repair.record });
    const owner = acquireOwnerLock(f.repo, "bot"), legacy = new LegacyTickets(f.deps);
    try {
      const versions: number[] = [];
      faults.beforeSyncFs = (op, from, to) => { if (op === "renameSync" && String(to).endsWith(".json")) versions.push(JSON.parse(readFileSync(from, "utf8")).schemaVersion); };
      assert.deepEqual((await legacy.migrateV5(owner)).failures, []);
      resetFaults();
      assert.ok(versions.length > 0 && versions.every((v) => v === 5));
      for (const t of expected) {
        const r = f.store.readV5(t.record.itemId)!;
        for (const field of ["createdAt", "path", "taskBranch", "baseBranch", "lastRunId", "reviewedTaskSha"] as const) assert.equal(r[field], t.record[field]);
        if (t.run) {
          assert.equal(r.activeRunId, t.run);
          assert.equal(r.activeRunStartedAt, t.record.activeRunStartedAt);
        }
        assert.deepEqual(readFileSync(join(f.repo, ".pi", "board-agent", `legacy-v${t.record.schemaVersion}`, basename(t.file))), t.bytes);
      }
      for (const [path, bytes] of evidence) assert.deepEqual(readFileSync(path), bytes);
      assert.equal(f.store.readV5(unique.card.itemId)!.activeRunId, "unique-original");
      for (const t of [absent, ambiguous]) assert.equal(f.store.readV5(t.card.itemId)!.launchingAt, t.record.createdAt);
      const retry = f.store.readV5(repair.card.itemId)!.retry!;
      assert.equal(retry.stage, "build"); assert.match(retry.reason, /Original question/);
      assert.equal(git(repair.record.path, "rev-parse", "MERGE_HEAD"), mergeHead);
      assert.equal(git(repair.record.path, "diff"), diff);
      for (const t of expected.filter((t) => t.run)) {
        assert.equal(readFileSync(join(t.record.path, "work.txt"), "utf8"), "original partial work\n");
        assert.equal(readFileSync(join(t.record.path, "untracked.txt"), "utf8"), "original untracked work\n");
      }
      assert.equal(f.store.readV5(uncertainRepair.card.itemId)!.launchingAt, uncertainRepair.record.createdAt);
      assert.equal(f.store.readV5(v4Launch.card.itemId)!.launchingAt, v4Launching.launchingAt, "v4 execution identity is preserved, not replayed");
      assert.equal(legacy.observeLaunchV5(f.store.readV5(v4Launch.card.itemId)!, owner, () => {})?.activeRunId, v4Journal.run.runId);
      const late = f.journal(absent.record, "late-original");
      const bound = legacy.observeLaunchV5(f.store.readV5(absent.card.itemId)!, owner, () => {});
      assert.equal(bound?.activeRunId, late.run.runId);
      assert.equal(legacy.observeLaunchV5(f.store.readV5(ambiguous.card.itemId)!, owner, () => {}), undefined);
      console.log("PASS: v3/v4 active and paused runs, unique/absent/ambiguous launches, original review/worktree and conflict recovery survive direct v5 publication without managers or intermediate v4 writes");
    } finally { resetFaults(); owner.release(); }
  }

  for (const kind of ["residual", "receipt-only", "recordless-ref", "recordless-history", "missing-proof"] as const) {
    const f = await fixture();
    if (kind === "missing-proof") {
      const result = oldV3(f); git(f.repo, "push", "origin", `${result}:refs/heads/main`); f.vanish();
    } else {
      await historicalReceipt(f, kind !== "residual", kind === "residual");
      if (kind.startsWith("recordless-")) {
        const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
        Object.assign(receipt, { record: null, recordHash: null, backup: null, snapshots: receipt.snapshots.map((s: any) => ({ ...s, entries: [] })) });
        writeFileSync(f.receipt, JSON.stringify(receipt));
        if (kind === "recordless-ref") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, f.taskSha);
      }
    }
    const receipt = existsSync(f.receipt) ? readFileSync(f.receipt) : undefined;
    const owner = acquireOwnerLock(f.repo, "bot"), legacy = adapter(f, kind === "receipt-only" ? _DEFAULTS.columns.ready : _DEFAULTS.columns.done);
    try {
      assert.deepEqual((await legacy.migrateV5(owner)).failures, []);
      if (kind === "recordless-history") {
        assert.equal(f.store.has(f.task.itemId), false, "completed recordless history never invents an execution");
      } else {
        const record = f.store.readV5(f.task.itemId)!;
        assert.equal(record.integration?.kind, "legacy-completed");
        // A recordless receipt has no original taskKey; use the key derived
        // from the current card, as the executor does for the synthesized record.
        const cleanupTask = { ...f.task, taskKey: record.taskKey };
        if (kind === "missing-proof") {
          const bytes = readFileSync(f.recordFile);
          calls.length = 0;
          await assert.rejects(f.store.cleanupLegacyCompleted(cleanupTask, owner, async () => {}, (r, c) => legacy.cleanupResidual(r, c)), /legacy evidence|snapshot evidence/);
          assert.deepEqual(readFileSync(f.recordFile), bytes);
          assert.ok(existsSync(f.record.path)); noMigrationWrites();
        } else {
          if (kind === "residual") {
            const unknown = join(f.record.path, "unknown.txt"); writeFileSync(unknown, "retain unknown work\n");
            await assert.rejects(f.store.cleanupLegacyCompleted(cleanupTask, owner, async () => {}, (r, c) => legacy.cleanupResidual(r, c)), /added|snapshot|changed/i);
            assert.equal(readFileSync(unknown, "utf8"), "retain unknown work\n"); unlinkSync(unknown);
          }
          const sha = await f.store.cleanupLegacyCompleted(cleanupTask, owner, async () => {}, (r, c) => legacy.cleanupResidual(r, c));
          await f.store.completeFinalization(cleanupTask, sha, async () => {}, undefined, owner);
          assert.equal(f.store.has(f.task.itemId), false);
          assert.equal(existsSync(f.record.path), false);
          assert.deepEqual((await adapter(f).migrateV5(owner)).converted, []);
        }
      }
      if (receipt) assert.deepEqual(readFileSync(f.receipt), receipt);
      console.log(`PASS: ${kind} preserves read-only snapshots/receipt, distinguishes history from recovery and never uses broad residual deletion`);
    } finally { owner.release(); }
  }

  {
    const f = await fixture();
    await historicalReceipt(f, false, true);
    // A previous v3->v4 migration may have only a verified squash receipt,
    // where baseSha=resultSha is not an original merge intent.
    const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
    receipt.resultSha = git(f.repo, "commit-tree", `${f.taskSha}^{tree}`, "-p", f.base, "-m", "receipted squash");
    writeFileSync(f.receipt, JSON.stringify(receipt));
    git(f.repo, "push", "--force", "origin", `${receipt.resultSha}:refs/heads/main`);
    const owner = acquireOwnerLock(f.repo, "bot"), legacy = adapter(f);
    try {
      assert.deepEqual((await legacy.migrate(owner)).failures, []);
      const v3Backup = readFileSync(backup(f, 3)), bytes = rawSource(f);
      assert.deepEqual((await legacy.migrateV5(owner)).failures, []);
      assert.deepEqual(readFileSync(backup(f, 3)), v3Backup);
      assert.deepEqual(readFileSync(backup(f, 4)), bytes);
      assert.equal(f.store.readV5(f.task.itemId)!.integration?.kind, "legacy-completed");
      const sha = await f.store.cleanupLegacyCompleted(f.task, owner, async () => {}, (r, c) => legacy.cleanupResidual(r, c));
      assert.equal(sha, receipt.resultSha);
      await f.store.completeFinalization(f.task, sha, async () => {}, undefined, owner);
      console.log("PASS: a previously migrated v4 receipted squash keeps both exact versioned backups and consumes only its old verified residual snapshots");
    } finally { owner.release(); }
  }

  {
    const f = await fixture(false, true);
    await preparedLegacy(f);
    const owner = acquireOwnerLock(f.repo, "bot");
    try {
      assert.deepEqual((await adapter(f).migrateV5(owner)).failures, []);
      const saved = readFileSync(f.recordFile);
      // Retained PR state with missing refs is still recovery, not history.
      git(f.repo, "push", "origin", `:refs/heads/${f.task.taskBranch}`);
      git(f.repo, "worktree", "remove", f.record.path);
      git(f.repo, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`);
      writeFileSync(backup(f, 4), "old backup no longer readable after accepted migration");
      calls.length = 0;
      assert.deepEqual((await adapter(f).migrateV5(owner)).converted, []);
      noMigrationWrites();
      assert.deepEqual(readFileSync(f.recordFile), saved);
      assert.equal(f.store.readV5(f.task.itemId)!.integration?.kind, "pr");
      await assert.rejects(f.store.preparePullRequest(f.task, scope(f), owner, async () => {}), /local task tip/);
      console.log("PASS: already published v5 is never reinterpreted as recordless history or replayed through legacy evidence even after refs disappear");
    } finally { owner.release(); }
  }
} finally { resetFaults(); dispose(); }
