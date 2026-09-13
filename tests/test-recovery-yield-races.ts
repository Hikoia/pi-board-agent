// Safe-outcome regressions promoted from A01. Real loop/executor/Git/store; offline board/model I/O.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import * as runner from '../src/process-runner.js';


const root = process.env.TMP_DIR!;
assert.ok(root, 'Run via bash tests/run-offline.sh');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
let intercept: ((command: runner.ProcessCommand, args: string[], options: any) => Promise<runner.ProcessResult>) | undefined;
(globalThis as any).__recoveryRaceRunProcess = (command: runner.ProcessCommand, args: string[], options: any) => intercept ? intercept(command, args, options) : runner.runProcess(command, args, options);
const shim = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/process-runner.ts', import.meta.url).href)}; export const runProcess = globalThis.__recoveryRaceRunProcess;`)}`;
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
const repo = join(root, 'repo'), origin = join(root, 'origin.git');
mkdirSync(repo); git(root, 'init', '--bare', origin); git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.name', 'Offline'); git(repo, 'config', 'user.email', 'offline@example.test');
writeFileSync(join(repo, '.gitignore'), '.pi/\n'); writeFileSync(join(repo, 'base.txt'), 'base\n');
git(repo, 'add', '.'); git(repo, 'commit', '-m', 'offline fixture'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', 'origin', 'main');
let sequence = 0;
function fixture() {
  const cfg = structuredClone(_DEFAULTS); cfg.max_workers = 1; cfg.tick_seconds = 0.02;
  cfg.refine.enabled = cfg.review.enabled = cfg.context.enabled = cfg.watchdog.enabled = cfg.telegram.enabled = false;
  const number = ++sequence;
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
  const loop = new BoardLoop({ cwd: repo, cfg, botLogin: 'bot', repoOwner: 'owner', repoName: 'repo', meta: { projectId: 'P', statusFieldId: 'S', statusOptions: {} }, callback: s => notices.push(s), listCards: async () => [structuredClone(card)], revisionCheck: async () => ({ ok: true }) }, createLoopState(), executor, store);
  return { failRead: (v = true) => readError = v, missing: () => missing = true, failRelease: (v = true) => releaseError = v, cfg, card, board, store, executor, loop, writes, notices, starts: () => starts, task: buildTasksForWave(cfg, 'demo', [card])[0] };
}
const reached = async (barrier: Promise<void>, operation: Promise<unknown>) => Promise.race([barrier, operation.then(() => { throw new Error('Barrier not reached'); })]);
const failures: unknown[] = [];
try {
  for (const mode of ['recovery', 'reset']) for (const delta of [false, true]) {
    for (const change of ['review', 'done', 'claim-transfer', 'claim-lost', 'read-error', 'release-error', 'dirty', 'record-change', 'fetch-error', 'unchanged', ...(!delta ? ['commit-during-read'] : [])]) {
      const f = fixture();
      const record = await f.store.ensure(f.task, 'demo');
      if (delta) { writeFileSync(join(record.path, 'partial.txt'), 'preserve commit'); git(record.path, 'add', '.'); git(record.path, 'commit', '-m', 'partial'); }
      if (mode === 'recovery') { f.store.beginLaunch(f.card.itemId); f.card.status = f.cfg.columns.building; f.card.assignees = ['bot']; }
      const entered = deferred(), finish = deferred();
      let fetched = false;
      intercept = async (command, args, options) => {
        const result = await runner.runProcess(command, args, options);
        if (args[0] === 'fetch') {
          entered.resolve(); await finish.promise; fetched = true;
          if (change === 'fetch-error') return { ...result, ok: false, status: 1, stderr: 'offline delta fetch failure' };
        }
        return result;
      };
      const getCard = f.board.getCard;
      f.board.getCard = async (itemId) => {
        const card = await getCard(itemId);
        if (fetched && change === 'commit-during-read') {
          fetched = false;
          writeFileSync(join(record.path, 'late.txt'), 'preserve late commit');
          git(record.path, 'add', '.'); git(record.path, 'commit', '-m', 'after delta');
        }
        return card;
      };
      // A denied actual start reaches real resetUnstarted; no private-method call.
      const operation = mode === 'recovery'
        ? f.executor.reconcile([structuredClone(f.card)])
        : f.executor.launch(structuredClone(f.card), 'demo', () => false);
      try {
        await reached(entered.promise, operation);
        let launch = f.store.read(f.card.itemId)!;
        assert.ok(launch.launchingAt);
        f.writes.length = 0;
        if (change === 'review') f.card.status = f.cfg.columns.review;
        if (change === 'done') { f.card.status = f.cfg.columns.done; f.card.closed = true; }
        if (change === 'claim-transfer') f.card.assignees = ['human'];
        if (change === 'claim-lost') f.card.assignees = [];
        if (change === 'read-error') f.failRead();
        if (change === 'release-error') f.failRelease();
        if (change === 'dirty') writeFileSync(join(record.path, 'dirty.txt'), 'preserve dirty file');
        if (change === 'record-change') { f.store.setActiveRun(f.card.itemId, 'other-run'); launch = f.store.read(f.card.itemId)!; }
        const before = structuredClone(f.card);
        assert.deepEqual(f.store.read(f.task.itemId), launch, 'pending fetch retains recovery evidence');
        finish.resolve();
        const result: any = await operation.catch((error: Error) => error);
        const uncertain = ['read-error', 'release-error', 'fetch-error', 'record-change'].includes(change);
        assert.equal(f.starts(), 0);
        assert.ok(existsSync(record.path));
        if (uncertain) {
          if (mode === 'recovery') assert.equal(result.errors, 1);
          else assert.ok(result instanceof Error, 'reset propagates uncertain observation/release');
          assert.deepEqual(f.store.read(f.task.itemId), launch, 'uncertainty retains exact recovery evidence');
          if (change !== 'release-error') { assert.deepEqual(f.writes, []); assert.deepEqual(f.card, before); }
          else {
            assert.equal(f.card.status, delta ? f.cfg.columns.needs_human : f.cfg.columns.ready);
            assert.deepEqual(f.card.assignees, ['bot']);
            f.failRelease(false);
            f.card.status = f.cfg.columns.done; f.card.closed = true;
            f.writes.length = 0;
            assert.equal((await f.executor.reconcile([structuredClone(f.card)])).errors, 0);
            assert.equal(f.card.status, f.cfg.columns.done);
            assert.deepEqual(f.writes, ['release'], 'retry settles only original claim, never stale status');
            assert.equal(f.store.read(f.task.itemId)?.launchingAt, undefined);
          }
        } else if (['review', 'done', 'claim-transfer', 'claim-lost'].includes(change)) {
          assert.equal(f.card.status, before.status, 'post-delta recovery preserves human state');
          assert.deepEqual(f.writes, change.startsWith('claim-') ? [] : ['release']);
          assert.equal(f.store.read(f.task.itemId)?.launchingAt, undefined);
        } else {
          const unsafe = delta || change === 'dirty' || change === 'commit-during-read';
          assert.equal(f.card.status, unsafe ? f.cfg.columns.needs_human : f.cfg.columns.ready);
          assert.deepEqual(f.writes, unsafe ? ['comment', f.cfg.columns.needs_human, 'release'] : [f.cfg.columns.ready, 'release']);
          assert.equal(f.store.read(f.task.itemId)?.launchingAt, undefined);
        }
        console.log(`PASS: post-delta ${mode} delta=${delta} ${change} preserves authority and recovery evidence`);
      } catch (error) { console.error(`FAIL: post-delta ${mode} delta=${delta} ${change}`, error); failures.push(error); }
      finally { finish.resolve(); await operation.catch(() => {}); intercept = undefined; f.failRead(false); f.failRelease(false); await f.loop.stop(); f.store.clearExecution(f.task.itemId); }
    }
  }
} finally { intercept = undefined; hooks.deregister(); delete (globalThis as any).__recoveryRaceRunProcess; }
if (failures.length) throw new AggregateError(failures);
