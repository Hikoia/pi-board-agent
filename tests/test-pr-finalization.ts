// Actual executor/loop/store/Git, explicit fake PR API and a separate human actor.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, calls, faults, dispose } from "./finalization-fixture.js";
import type { TicketPullRequestIntegration } from "../src/ticket-worktree.js";
const publish = (a: string[]) => a[0] === "push" && !a.at(-1)!.startsWith(":");
const deleting = (a: string[]) => a[0] === "push" && a.at(-1)!.startsWith(":");
const prep = (f: Awaited<ReturnType<typeof fixture>>) => f.recordNow().integration as TicketPullRequestIntegration;
const commit = (f: Awaited<ReturnType<typeof fixture>>, parent: string, message: string) =>
  git(f.repo, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message);
try {
  {
    const f = await fixture(false, false), bytes = readFileSync(join(f.admin, "index"));
    calls.length = 0;
    f.prs.hooks.before = (op) => {
      if (op === "create") {
        assert.equal(prep(f).phase, "prepared");
        assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.task.taskBranch}`), prep(f).preparedHeadSha);
      }
    };
    const waiting = await f.finish();
    assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
    assert.equal(f.card.status, f.cfg.columns.done); assert.equal(f.card.closed, true);
    assert.equal(f.tip(), f.base); assert.equal(f.executor.activeCount(), 0);
    assert.equal(prep(f).phase, "open"); assert.equal(f.recordNow().retry, undefined);
    assert.ok(f.prs.prs[0].body.includes("Refs #")); assert.ok(!/Closes|Fixes|Resolves/.test(f.prs.prs[0].body));
    assert.ok(f.prs.prs[0].body.includes(JSON.stringify([f.task.itemId, f.record.createdAt, prep(f).initialPreparedHeadSha])));
    assert.deepEqual(readFileSync(join(f.admin, "index")), bytes);
    assert.equal(git(f.record.path, "rev-parse", "HEAD"), f.taskSha);
    for (let i = 0; i < 3; i++) await f.loop.tickNow();
    assert.equal(f.prs.calls.filter(x => x === "create").length, 1);
    assert.equal(f.notices.filter(s => s.includes("Awaiting human PR merge")).length, 1);
    assert.equal(calls.filter(publish).length, 1);
    assert.ok(calls.filter(publish).every(a => a.at(-1)!.endsWith(`:refs/heads/${f.task.taskBranch}`)));
    assert.ok(!calls.some(deleting)); assert.ok(existsSync(f.record.path));
    const merged = f.prs.merge();
    assert.notEqual(merged, prep(f).preparedHeadSha, "squash proof is not the prepared/test merge SHA");
    assert.equal((await f.make().finalizeClosed(structuredClone(f.card))).status, "finalized");
    assert.equal(f.tip(), merged); assert.equal(f.card.status, f.cfg.columns.backlog);
    assert.equal(f.store.has(f.task.itemId), false); assert.equal(existsSync(f.record.path), false);
    assert.equal(f.starts(), 0); assert.equal(f.reviews(), 0);
    await f.loop.stop();
    console.log("PASS: closed Done creates one durable task PR, bounded/deduplicated slot-free waiting preserves work; human squash alone permits ordered cleanup");
  }
  for (const cut of ["task-push", "create", "reference-save"] as const) {
    const f = await fixture(false, false); let hit = false;
    if (cut === "task-push") faults.afterGit = a => { if (publish(a) && !hit) { hit = true; throw new Error("lost task push response"); } };
    if (cut === "create") f.prs.hooks.after = op => { if (op === "create" && !hit) { hit = true; throw new Error("lost create response"); } };
    if (cut === "reference-save") faults.beforeSyncFs = (op, path, to) => {
      if (op === "renameSync" && to === f.recordFile && JSON.parse(readFileSync(path, "utf8")).integration?.prNumber && !hit) { hit = true; throw new Error("PR identity save failed"); }
    };
    const first = await f.finish();
    assert.equal(first.status, "blocked"); assert.ok(hit);
    assert.equal(f.recordNow().retry?.stage, "integrate");
    faults.afterGit = faults.beforeSyncFs = undefined; f.prs.hooks.after = undefined;
    assert.equal((await f.make().finalizeClosed(structuredClone(f.card))).status, "waiting");
    assert.equal(f.prs.prs.length, 1); assert.equal(f.prs.calls.filter(x => x === "create").length, 1);
    assert.equal(f.recordNow().retry, undefined); assert.equal(f.tip(), f.base);
    console.log(`PASS: ${cut} response loss/restart recovers one execution PR and clears only technical integrate retry`);
  }
  for (const invalid of ["foreign", "ambiguous", "scope", "head", "number", "url", "api"] as const) {
    const f = await fixture(false, false);
    if (["foreign", "ambiguous"].includes(invalid)) {
      // Persist the prepared identity but lose the create response.
      f.prs.hooks.after = op => { if (op === "create") throw new Error("lost create"); };
      await f.finish(); f.prs.hooks.after = undefined;
      if (invalid === "foreign") f.prs.prs[0].body = "human PR without this execution marker";
      else f.prs.prs.push({ ...f.prs.prs[0], number: 2, url: f.prs.prs[0].url.replace("/1", "/2") });
    } else {
      await f.finish();
      if (invalid === "scope") f.prs.prs[0].scope.base = "wrong-base";
      if (invalid === "head") {
        git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, f.base);
        f.prs.prs[0].headSha = f.base;
      }
      if (invalid === "number") f.prs.prs[0].number++;
      if (invalid === "url") f.prs.prs[0].url += "9";
      if (invalid === "api") f.prs.hooks.before = () => { throw new Error("unknown API failure"); };
    }
    calls.length = 0;
    assert.equal((await f.finish()).status, "blocked");
    assert.equal(f.recordNow().retry?.stage, "integrate");
    assert.equal(f.tip(), f.base); assert.ok(existsSync(f.record.path));
    assert.ok(!calls.some(publish)); assert.ok(!calls.some(deleting));
    assert.equal(f.prs.calls.filter(x => x === "create").length, 1);
    console.log(`PASS: ${invalid} PR observation blocks without adoption, deletion, replacement creation or base push`);
  }
  {
    const f = await fixture(false, false); await f.finish();
    f.prs.prs[0].state = "closed";
    assert.equal((await f.finish()).status, "waiting"); assert.equal(f.recordNow().retry, undefined);
    assert.equal(f.tip(), f.base); assert.ok(existsSync(f.record.path));
    assert.equal(f.prs.calls.filter(x => x === "create").length, 1);
    console.log("PASS: closed-unmerged PR remains a normal human-action wait; no auto reopen/replacement or builder");
  }
  for (const shape of ["append", "update-branch", "deleted-head", "extra-local", "extra-remote"] as const) {
    const f = await fixture(false, false); await f.finish();
    const prepared = prep(f).preparedHeadSha;
    if (shape === "append" || shape === "update-branch") {
      const head = shape === "append" ? commit(f, prepared, "human append") : git(f.repo, "commit-tree", `${prepared}^{tree}`, "-p", prepared, "-p", commit(f, f.base, "base update"), "-m", "Update branch");
      git(f.repo, "push", "origin", `${head}:refs/heads/${f.task.taskBranch}`);
    }
    f.prs.merge();
    if (shape === "deleted-head") git(f.origin, "update-ref", "-d", `refs/heads/${f.task.taskBranch}`);
    if (shape === "extra-local") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, commit(f, f.taskSha, "uncovered local"));
    if (shape === "extra-remote") git(f.repo, "push", "origin", `${commit(f, prepared, "uncovered remote")}:refs/heads/${f.task.taskBranch}`);
    const result = await f.finish();
    if (shape.startsWith("extra")) {
      assert.equal(result.status, "blocked", JSON.stringify(result)); assert.equal(prep(f).phase, "merged");
      assert.equal(f.recordNow().retry?.stage, "cleanup"); assert.ok(existsSync(f.record.path));
      const bytes = readFileSync(f.recordFile); f.prs.prs[0].merged = false;
      await f.finish(); assert.equal(prep(f).phase, "merged");
      assert.equal(JSON.parse(bytes.toString()).integration.mergeCommitSha, (prep(f) as any).mergeCommitSha);
      f.card.closed = false; f.card.status = f.cfg.columns.ready;
      assert.equal((await f.make().launch(structuredClone(f.card), "demo")).status, "skipped");
    } else assert.equal(result.status, "finalized", JSON.stringify(result));
    console.log(`PASS: ${shape} uses actual merged head/source ancestry and never erases immutable merge evidence or uncovered work`);
  }
  for (const cut of ["remote", "worktree", "local", "backlog", "record"] as const) {
    const f = await fixture(false, false); await f.finish(); f.prs.merge();
    if (cut === "backlog") f.loseDone(true);
    if (cut === "record") faults.beforeSyncFs = (op, path) => { if (op === "unlinkSync" && path === f.recordFile) throw new Error("record cut"); };
    faults.afterGit = a => {
      if ((cut === "remote" && deleting(a)) || (cut === "worktree" && a[0] === "worktree" && a[1] === "remove") ||
          (cut === "local" && a[0] === "update-ref" && a.includes("-d"))) { faults.afterGit = undefined; throw new Error("cleanup cut"); }
    };
    assert.equal((await f.finish()).status, "blocked"); assert.equal(prep(f).phase, "merged");
    faults.afterGit = faults.beforeSyncFs = undefined; f.loseDone(false); calls.length = 0;
    assert.equal((await f.make().finalizeClosed(structuredClone(f.card))).status, "finalized");
    assert.ok(!calls.some(publish)); assert.ok(!calls.some(a => a[0] === "commit-tree"));
    assert.equal(f.store.has(f.task.itemId), false);
    console.log(`PASS: ${cut} cleanup interruption resumes only confirmed human merge, record last, without another PR or publication`);
  }
  for (const withdrawal of ["reopen", "lane", "claim"] as const) {
    const f = await fixture(false, false); await f.finish();
    const saved = prep(f);
    if (withdrawal === "reopen") f.card.closed = false;
    if (withdrawal === "lane") f.card.status = f.cfg.columns.ready;
    if (withdrawal === "claim") f.card.assignees = ["human"];
    assert.equal((await f.finish()).status, "waiting"); assert.equal(prep(f).phase, "suspended");
    assert.equal(prep(f).prNumber, saved.prNumber); assert.equal(f.tip(), f.base);
    f.prs.merge(); assert.equal((await f.finish()).status, "waiting");
    assert.equal(prep(f).phase, "merged"); assert.ok(existsSync(f.record.path));
    f.card.closed = false; f.card.status = f.cfg.columns.ready;
    assert.equal((await f.make().launch(structuredClone(f.card), "demo")).status, "skipped");
    f.card.closed = true; f.card.status = f.cfg.columns.done; f.card.assignees = [];
    assert.equal((await f.finish()).status, "finalized");
    console.log(`PASS: ${withdrawal} suspends without closing PR; merge while withdrawn is immutable cleanup-only until fresh approval`);
  }
  {
    const f = await fixture(false, false); await f.finish(); const saved = prep(f), body = f.prs.prs[0].body;
    f.card.closed = false; f.card.status = f.cfg.columns.ready; await f.finish();
    // Original builder/worktree repair; the retained PR's published head must be incorporated.
    git(f.record.path, "merge", "--ff-only", saved.preparedHeadSha);
    writeFileSync(join(f.record.path, "repair.txt"), "renewed work\n"); git(f.record.path, "add", "."); git(f.record.path, "commit", "-m", "repair");
    f.store.setReviewedTaskSha(f.task.itemId, git(f.record.path, "rev-parse", "HEAD"));
    f.card.closed = true; f.card.status = f.cfg.columns.done;
    assert.equal((await f.finish()).status, "waiting");
    assert.equal(prep(f).prNumber, saved.prNumber); assert.equal(prep(f).initialPreparedHeadSha, saved.initialPreparedHeadSha);
    assert.notEqual(prep(f).preparedHeadSha, saved.preparedHeadSha); assert.equal(f.prs.prs[0].body, body);
    assert.equal(f.prs.calls.filter(x => x === "create").length, 1);
    f.prs.merge(); assert.equal((await f.finish()).status, "finalized");
    console.log("PASS: withdrawn original-worktree repair/review/reclose updates the same open PR and stable marker without body edits");
  }
  for (const [boundary, change] of [
    ["lookup", "owner"], ["lookup", "stop"], ["lookup", "reopen"], ["lookup", "lane"], ["lookup", "claim"],
    ["lookup", "record"], ["lookup", "source"], ["authorize", "owner"], ["authorize", "stop"],
    ["authorize", "record"], ["authorize", "source"], ["authorize", "dirty"], ["authorize", "untracked"],
  ] as const) {
    const f = await fixture(false, false), executor = f.make();
    const extra = commit(f, f.taskSha, "late local work");
    let entered = false, changed = false, dispatched = 0;
    let prepared: TicketPullRequestIntegration | undefined;
    const mutate = () => {
      changed = true;
      if (change === "owner") f.owner.release();
      if (change === "stop") executor.stopScheduling();
      if (change === "reopen") f.card.closed = false;
      if (change === "lane") f.card.status = f.cfg.columns.ready;
      if (change === "claim") f.card.assignees = ["human"];
      if (change === "record") writeFileSync(f.recordFile, JSON.stringify({ ...f.recordNow(), lastRunId: "other-execution" }));
      if (change === "source") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, extra);
      if (change === "dirty") writeFileSync(join(f.record.path, "feature.txt"), "late uncommitted work\n");
      if (change === "untracked") writeFileSync(join(f.record.path, "new.txt"), "late untracked work\n");
    };
    f.prs.hooks.before = async op => {
      if (op !== "create") return;
      await Promise.resolve();
      entered = true;
      prepared = structuredClone(prep(f));
      if (boundary === "lookup") mutate();
    };
    const getCard = f.board.getCard;
    f.board.getCard = async itemId => {
      const card = await getCard(itemId);
      if (entered && !changed && boundary === "authorize") mutate();
      return card;
    };
    f.prs.hooks.after = op => { if (op === "create") dispatched++; };
    calls.length = 0;
    const result = await executor.finalizeClosed(structuredClone(f.card));
    assert.ok(entered && changed, `must reach final ${boundary} boundary: ${JSON.stringify(result)}`);
    assert.ok(["skipped", "blocked"].includes(result.status), JSON.stringify(result));
    assert.equal(f.prs.calls.filter(op => op === "create").length, 1, "create API entered once");
    assert.equal(dispatched, 0, "guard vetoes mutation dispatch, not just response handling");
    assert.equal(f.prs.prs.length, 0);
    assert.equal(prepared!.phase, "prepared"); assert.deepEqual(prep(f), prepared);
    assert.ok(existsSync(f.record.path)); assert.equal(f.tip(), f.base);
    assert.ok(!calls.some(deleting));
    assert.ok(calls.filter(publish).every(a => a.at(-1)!.endsWith(`:refs/heads/${f.task.taskBranch}`)));
    if (change === "record") assert.equal(f.recordNow().lastRunId, "other-execution");
    if (change === "source") assert.equal(f.store.localBranchSha(f.task.taskBranch), extra);
    if (change === "dirty") assert.equal(readFileSync(join(f.record.path, "feature.txt"), "utf8"), "late uncommitted work\n");
    if (change === "untracked") assert.equal(readFileSync(join(f.record.path, "new.txt"), "utf8"), "late untracked work\n");
    console.log(`PASS: ${change} during final create ${boundary} vetoes dispatch and retains preparation/work`);
  }
  {
    const f = await fixture(false, false), executor = f.make();
    let prepared: Buffer | undefined;
    f.prs.hooks.after = async op => {
      if (op !== "create") return;
      assert.equal(f.prs.prs.length, 1, "server accepted the create before stop");
      prepared = readFileSync(f.recordFile);
      await Promise.resolve();
      executor.stopScheduling();
    };
    assert.equal((await executor.finalizeClosed(structuredClone(f.card))).status, "skipped");
    assert.ok(prepared); assert.deepEqual(readFileSync(f.recordFile), prepared);
    assert.equal(prep(f).phase, "prepared"); assert.equal(prep(f).prNumber, undefined);
    assert.equal(f.prs.prs.length, 1); assert.ok(existsSync(f.record.path));
    f.prs.hooks.after = undefined;
    assert.equal((await f.finish()).status, "waiting");
    assert.equal(prep(f).prNumber, f.prs.prs[0].number);
    assert.equal(f.prs.calls.filter(op => op === "create").length, 1);
    assert.equal(f.tip(), f.base);
    console.log("PASS: stop after create dispatch retains prepared recovery data; next authorized tick recovers the server PR without replay");
  }
  for (const boundary of ["create", "delete"] as const) for (const change of ["owner", "stop", "card", "source"] as const) {
    const f = await fixture(false, false); let allowed = true, hit = false;
    if (boundary === "delete") { await f.finish(); f.prs.merge(); }
    const mutate = () => {
      hit = true;
      if (change === "owner") f.owner.release();
      if (change === "stop") allowed = false;
      if (change === "card") f.card.closed = false;
      if (change === "source") git(f.repo, "update-ref", `refs/heads/${f.task.taskBranch}`, commit(f, f.taskSha, "racing source"));
    };
    if (boundary === "create") faults.afterGit = a => { if (!hit && publish(a)) mutate(); };
    else f.prs.hooks.after = op => { if (!hit && op === "get") mutate(); };
    calls.length = 0;
    const result = await f.make().finalizeClosed(structuredClone(f.card), () => true, () => allowed);
    assert.notEqual(result.status, "finalized"); assert.ok(hit); assert.ok(existsSync(f.record.path));
    assert.ok(!calls.some(deleting));
    if (boundary === "create") assert.equal(f.prs.prs.length, 0);
    console.log(`PASS: ${change} across ${boundary} await revokes publication/deletion and preserves recovery/work`);
  }
  for (const when of ["before-start", "active"] as const) {
    const f = await fixture(false, false); await f.finish();
    f.card.closed = false; f.card.status = f.cfg.columns.ready; await f.finish();
    let starts = 0, drains = 0;
    let run: import("@quintinshaw/pi-dynamic-workflows").PersistedRunState | undefined;
    const executor = f.make(() => ({
      start: (_script, args) => { starts++; run = { runId: "original-repair", args, status: "running" } as typeof run; return "original-repair"; },
      list: () => run ? [run] : [], resume: async () => { assert.fail("merged execution cannot resume"); },
      pauseAndWait: async () => {}, stopAndWait: async () => { drains++; run!.status = "aborted"; }, dispose: () => {},
    }));
    const admission = async () => { if (when === "before-start") f.prs.merge(); return true; };
    const launched = await executor.launch(structuredClone(f.card), "demo", admission);
    if (when === "active") {
      assert.equal(launched.status, "launched"); assert.equal(starts, 1); assert.equal(executor.activeCount(), 1);
      writeFileSync(join(f.record.path, "unfinished.txt"), "original partial work");
      f.prs.merge();
      assert.equal((await executor.reconcile([structuredClone(f.card)])).errors, 0);
      assert.equal(drains, 1); assert.equal(readFileSync(join(f.record.path, "unfinished.txt"), "utf8"), "original partial work");
    } else { assert.equal(launched.status, "skipped"); assert.equal(starts, 0); assert.equal(drains, 0); }
    assert.equal(prep(f).phase, "merged"); assert.equal(executor.activeCount(), 0);
    f.card.status = f.cfg.columns.ready; f.card.closed = false;
    assert.equal((await executor.launch(structuredClone(f.card), "demo")).status, "skipped");
    assert.ok(existsSync(f.record.path)); await executor.shutdown();
    console.log(`PASS: merge ${when} retains immutable proof/work, drains only the original run and never starts/restarts a merged builder`);
  }
  {
    const f = await fixture(false, false); await f.finish();
    // A known PR can be human-rewritten; its explicit merge is irreversible,
    // but missing original ancestry never authorizes deletion or repair builders.
    git(f.origin, "update-ref", `refs/heads/${f.task.taskBranch}`, f.base);
    f.prs.merge();
    const result = await f.finish();
    assert.equal(result.status, "blocked"); assert.equal(prep(f).phase, "merged");
    assert.ok(existsSync(f.record.path)); assert.equal(f.recordNow().retry?.stage, "cleanup");
    f.prs.prs[0].merged = false; await f.finish(); assert.equal(prep(f).phase, "merged");
    console.log("PASS: known PR rewrite followed by merge persists irreversible proof but preserves uncovered source work");
  }
  {
    const f = await fixture(false, false);
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
    f.prs.hooks.before = async op => { if (op === "create") { entered(); await gate; } };
    const executor = f.make(), first = executor.finalizeClosed(structuredClone(f.card));
    await arrived;
    assert.equal(executor.activeCount(), 0);
    assert.equal((await executor.finalizeClosed(structuredClone(f.card))).status, "skipped");
    assert.equal((await executor.launch(structuredClone(f.card), "demo")).status, "skipped");
    release(); assert.equal((await first).status, "waiting");
    assert.equal(f.prs.calls.filter(x => x === "create").length, 1);
    console.log("PASS: overlapping direct launch/finalization cannot create a duplicate PR or consume a builder slot");
  }
} finally { dispose(); }
