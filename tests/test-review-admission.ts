// Safe-outcome regressions promoted from A01. Real loop/executor/Git/store; offline board/model I/O.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import * as runner from '../src/process-runner.js';


import { WorkflowAgent } from '@quintinshaw/pi-dynamic-workflows';
import { acquireOwnerLock } from '../src/owner-lock.js';

const root = process.env.TMP_DIR!;
assert.ok(root, 'Run via bash tests/run-offline.sh');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
let intercept: ((command: runner.ProcessCommand, args: string[], options: any) => Promise<runner.ProcessResult>) | undefined;
(globalThis as any).__reviewAdmissionRunProcess = (command: runner.ProcessCommand, args: string[], options: any) => intercept ? intercept(command, args, options) : runner.runProcess(command, args, options);
const shim = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/process-runner.ts', import.meta.url).href)}; export const runProcess = globalThis.__reviewAdmissionRunProcess;`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './process-runner.js' && /\/(ticket-worktree|review)\.ts$/.test(context.parentURL ?? '')) return { url: shim, shortCircuit: true };
  return next(specifier, context);
} });
const { _DEFAULTS } = await import('../src/config.js');
const { BoardLoop, createLoopState } = await import('../src/loop.js');
const { ManagedTicketExecutor } = await import('../src/ticket-executor.js');
const { TicketWorktrees } = await import('../src/ticket-worktree.js');
const { buildTasksForWave } = await import('../src/workflow-prompt.js');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let sequence = 0;
function fixture() {
  const cfg = structuredClone(_DEFAULTS); cfg.max_workers = 1; cfg.tick_seconds = 0.02;
  cfg.context.enabled = cfg.telegram.enabled = false;
  const number = ++sequence;
  // Each race retains its recovery evidence; it must not occupy the next case's slot.
  const repo = join(root, `repo-${number}`), origin = join(root, `origin-${number}.git`);
  mkdirSync(repo); git(root, 'init', '--bare', origin); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Offline'); git(repo, 'config', 'user.email', 'offline@example.test');
  writeFileSync(join(repo, '.gitignore'), '.pi/\n'); writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'offline fixture'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', 'origin', 'main');
  const card: any = { itemId: `AUDIT_${number}`, number, type: 'Task', contentType: 'Issue', title: `T00${number} contract`, body: 'Approved scope', repoOwner: 'owner', repoName: 'repo', plan: 'demo', status: cfg.columns.ready, closed: false, assignees: [] };
  const writes: string[] = [], notices: string[] = [];
  let starts = 0, run: any;
  let readError = false, missing = false, releaseError = false;
  const store = new TicketWorktrees(repo);
  const board = {
    getCard: async (itemId = `AUDIT_${number}`) => { if (itemId !== `AUDIT_${number}`) return undefined; if (readError) throw new Error('fresh read unavailable'); return missing ? undefined : structuredClone(card); },
    claim: async () => { card.assignees = ['bot']; return true; },
    release: async () => { writes.push('release'); if (releaseError) throw new Error('release unavailable'); card.assignees = card.assignees.filter((x: string) => x !== 'bot'); },
    setStatus: async (_id: string, status: string) => { writes.push(status); card.status = status; },
    listComments: async () => [], comment: async () => { writes.push('comment'); },
  };
  const executor = new ManagedTicketExecutor({ cwd: repo, cfg, worktrees: store, board, botLogin: 'bot', repoOwner: 'owner', repoName: 'repo', callback: s => notices.push(s), createManager: () => {
    return { start: (_source: string, args: any) => { starts++; run = { runId: `audit-run-${number}`, status: 'running', args }; return run.runId; }, list: () => run ? [run] : [], resume: async () => false, pauseAndWait: async () => { if (run) run.status = 'paused'; }, stopAndWait: async () => { if (run) run.status = 'aborted'; }, dispose() {} };
  } });
  const loop = new BoardLoop({ cwd: repo, cfg, botLogin: 'bot', repoOwner: 'owner', repoName: 'repo', meta: { projectId: 'P', statusFieldId: 'S', statusOptions: {} }, callback: s => notices.push(s), listCards: async () => [structuredClone(card)] }, createLoopState(), executor, store);
  return { repo, failRead: (v = true) => readError = v, missing: () => missing = true, failRelease: (v = true) => releaseError = v, cfg, card, board, store, executor, loop, writes, notices, starts: () => starts, task: buildTasksForWave(cfg, 'demo', [card])[0] };
}
const reached = async (barrier: Promise<void>, operation: Promise<unknown>) => Promise.race([barrier, operation.then(() => { throw new Error('Barrier not reached'); })]);
const failures: unknown[] = [];
const originalRun = WorkflowAgent.prototype.run;
try {
  for (const change of ['admission', 'stop', 'record', 'claim', 'unchanged']) {
    const f = fixture(), { repo } = f; f.cfg.safety.require_clean_worktree = false;
    const record = await f.store.ensure(f.task, 'demo'); git(record.path, 'push', 'origin', record.taskBranch);
    const taskSha = git(record.path, 'rev-parse', 'HEAD');
    f.card.status = f.cfg.columns.review;
    writeFileSync(join(repo, 'main-human.txt'), 'preserve dirty human bytes');
    const main = { head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'branch', '--show-current'), status: git(repo, 'status', '--porcelain=v1') };
    const entered = deferred(), finish = deferred();
    const cleanupEntered = deferred(), cleanupFinish = deferred(), refsEntered = deferred(), refsFinish = deferred(), releaseEntered = deferred(), releaseFinish = deferred();
    let calls = 0, releases = 0, done = false;
    intercept = async (command, args, options) => {
      assert.equal(options.signal, undefined, 'never interrupt Git setup/cleanup on admission deferral');
      const result = await runner.runProcess(command, args, options);
      if (args[0] === 'fetch' && args.includes('--atomic')) { entered.resolve(); await finish.promise; }
      if (args[0] === 'worktree' && args[1] === 'remove') { cleanupEntered.resolve(); await cleanupFinish.promise; }
      if (args[0] === 'update-ref') { refsEntered.resolve(); await refsFinish.promise; }
      return result;
    };
    WorkflowAgent.prototype.run = (async function (this: WorkflowAgent, _prompt, options) {
      calls++;
      // Installed 3.10.0 uses the constructor cwd unless per-agent isolation
      // supplies an override (runTurn has the same fallback).
      const cwd = options?.cwd ?? (this as any).cwd;
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), taskSha);
      assert.equal(git(cwd, 'branch', '--show-current'), '');
      return { verdict: 'pass', summary: 'offline exact-SHA review', findings: [] };
    }) as typeof originalRun;
    const owner = acquireOwnerLock(repo, 'bot');
    const state = createLoopState();
    const loop = new BoardLoop({ cwd: repo, cfg: f.cfg, botLogin: 'bot', repoOwner: 'owner', repoName: 'repo', meta: { projectId: 'P', statusFieldId: 'S', statusOptions: {} }, callback: s => { f.notices.push(s); }, listCards: async () => [structuredClone(f.card)], boardOps: {
      claim: f.board.claim, refresh: () => f.board.getCard(), listComments: async () => [], comment: async () => { f.writes.push('comment'); return 'unexpected'; }, setStatus: async (_card, status) => f.board.setStatus(f.card.itemId, status),
      release: async () => { releaseEntered.resolve(); await releaseFinish.promise; releases++; await f.board.release(); },
    } }, state, f.executor, f.store, owner);
    const start = loop.tickNow().finally(() => { done = true; });
    let stopping: Promise<void> | undefined;
    try {
      await reached(entered.promise, start);
      assert.equal(calls, 0);
      assert.equal(state.foreground?.kind, 'review');
      assert.equal(f.cfg.max_workers, 1, 'one reserved foreground slot must still admit a real review');
      if (change === 'admission') loop.disableAdmissions();
      if (change === 'record') f.store.setActiveRun(f.card.itemId, 'replacement-run');
      if (change === 'claim') f.card.assignees = ['human'];
      if (change === 'stop') stopping = loop.stop();
      finish.resolve();
      await reached(cleanupEntered.promise, start);
      assert.equal(done, false); assert.equal(releases, 0); assert.ok(existsSync(owner.path));
      assert.equal(state.foreground?.kind, 'review', 'deferral retains reserved slot through worktree cleanup');
      cleanupFinish.resolve();
      await reached(refsEntered.promise, start);
      assert.equal(done, false); assert.equal(releases, 0); assert.ok(existsSync(owner.path));
      assert.equal(state.foreground?.kind, 'review', 'deferral retains reserved slot through private-ref cleanup');
      refsFinish.resolve();
      const owned = change !== 'record' && change !== 'claim';
      if (owned) {
        await reached(releaseEntered.promise, start);
        assert.equal(done, false); assert.ok(existsSync(owner.path));
      }
      releaseFinish.resolve(); await start; await stopping;
      assert.equal(calls, change === 'unchanged' ? 1 : 0, 'no real Review model invocation after admission/stop closes during fetch');
      assert.deepEqual(f.writes, change === 'unchanged' ? ['comment', f.cfg.columns.done, 'release'] : owned ? ['release'] : []);
      assert.equal(releases, owned ? 1 : 0);
      assert.equal(f.card.status, change === 'unchanged' ? f.cfg.columns.done : f.cfg.columns.review);
      assert.deepEqual(f.card.assignees, owned ? [] : change === 'claim' ? ['human'] : ['bot']);
      assert.equal(f.store.read(f.task.itemId)?.reviewedTaskSha, taskSha, 'a deferred review retains its original target SHA, not a success verdict');
      assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/board-agent/reviews/'), '');
      assert.equal(git(repo, 'worktree', 'list', '--porcelain').includes('review-'), false);
      assert.equal(readdirSync(join(repo, '.pi', 'worktrees')).some(name => name.startsWith('review-')), false);
      assert.equal(readFileSync(join(repo, 'main-human.txt'), 'utf8'), 'preserve dirty human bytes');
      assert.deepEqual({ head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'branch', '--show-current'), status: git(repo, 'status', '--porcelain=v1') }, main);
      assert.ok(existsSync(record.path), 'persistent builder worktree stays intact');
      assert.equal(git(record.path, 'rev-parse', 'HEAD'), taskSha);
      console.log(`PASS: real Review delayed-fetch ${change} checks invocation authority and awaits original worktree/ref/claim cleanup`);
    } catch (error) { console.error(`FAIL: real Review admission ${change}`, error, f.notices); failures.push(error); }
    finally { finish.resolve(); cleanupFinish.resolve(); refsFinish.resolve(); releaseFinish.resolve(); await start; await loop.stop(); intercept = undefined; }
  }
} finally { WorkflowAgent.prototype.run = originalRun; intercept = undefined; hooks.deregister(); delete (globalThis as any).__reviewAdmissionRunProcess; }
if (failures.length) throw new AggregateError(failures);
