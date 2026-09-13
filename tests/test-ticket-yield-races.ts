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
(globalThis as any).__ticketRaceRunProcess = (command: runner.ProcessCommand, args: string[], options: any) => intercept ? intercept(command, args, options) : runner.runProcess(command, args, options);
const shim = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/process-runner.ts', import.meta.url).href)}; export const runProcess = globalThis.__ticketRaceRunProcess;`)}`;
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
  for (const change of ['done', 'review', 'contract', 'claim-transfer', 'missing', 'replaced', 'read-error', 'unchanged', 'release-error', 'partial-evidence']) {
    const f = fixture(), entered = deferred(), finish = deferred();
    intercept = async (command, args, options) => {
      if (args[0] === 'fetch') { entered.resolve(); await finish.promise; return { ok: false, status: 1, stdout: '', stderr: 'offline transport failure', timedOut: false, signal: null } as any; }
      return runner.runProcess(command, args, options);
    };
    const tick = f.loop.tickNow();
    let evidence: ReturnType<typeof f.store.read>;
    try {
      await reached(entered.promise, tick);
      if (change === 'partial-evidence') {
        // Another local observation appeared while ensure's first fetch was held.
        // The failing prepare has no returned record authorizing its deletion.
        const held = intercept; intercept = undefined;
        await f.store.ensure(f.task, 'demo'); f.store.beginLaunch(f.task.itemId);
        evidence = f.store.read(f.task.itemId); intercept = held;
      }
      if (change === 'done' || change === 'partial-evidence') { f.card.status = f.cfg.columns.done; f.card.closed = true; }
      if (change === 'review') f.card.status = f.cfg.columns.review;
      if (change === 'contract') f.card.body = 'Human changed scope';
      if (change === 'claim-transfer') f.card.assignees = ['human'];
      if (change === 'missing') f.missing();
      if (change === 'replaced') f.card.number = 999;
      if (change === 'read-error') f.failRead();
      if (change === 'release-error') f.failRelease();
      const before = structuredClone(f.card);
      finish.resolve();
      const error = await tick.catch((error: Error) => error);
      assert.equal(f.starts(), 0);
      assert.deepEqual(f.store.read(f.task.itemId), evidence, 'failed prepare never deletes uncertain recovery evidence');
      if (evidence) assert.ok(existsSync(evidence.path));
      if (change === 'unchanged' || change === 'release-error') {
        assert.equal(f.card.status, f.cfg.columns.needs_human);
        assert.deepEqual(f.writes, ['comment', f.cfg.columns.needs_human, 'release']);
        if (change === 'release-error') {
          assert.match(error?.message ?? '', /release unavailable/);
          assert.deepEqual(f.card.assignees, ['bot']);
        }
      } else {
        assert.equal(f.card.status, before.status, 'failed preparation must not overwrite human state');
        assert.equal(f.card.body, before.body);
        const canRelease = ['done', 'review', 'contract', 'partial-evidence'].includes(change);
        assert.deepEqual(f.writes, canRelease ? ['release'] : [], 'only verified original-target claim cleanup is authorized');
        assert.deepEqual(f.card.assignees, canRelease ? [] : before.assignees);
        if (change === 'read-error') assert.match(error?.message ?? '', /fresh read unavailable/);
      }
      console.log(`PASS: preparation rejection ${change} preserves fresh card authority`);
    } catch (error) { console.error(`FAIL: preparation rejection ${change}`, error); failures.push(error); }
    finally { finish.resolve(); await tick.catch(() => {}); intercept = undefined; await f.loop.stop(); }
  }
} finally { intercept = undefined; hooks.deregister(); delete (globalThis as any).__ticketRaceRunProcess; }
if (failures.length) throw new AggregateError(failures);
