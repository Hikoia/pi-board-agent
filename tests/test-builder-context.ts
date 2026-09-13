// Actual production factory, worktrees, WorkflowManager and generated prompt.
// Only GitHub and the manager's documented agent runner are offline adapters;
// context observation delegates to the real helpers (including their I/O).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorkflowManager,
  type WorkflowManagerOptions,
  type WorkflowRunOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS } from "../src/config.js";
import { generateContext, renderContext, type ContextOptions } from "../src/context.js";
import type { Card } from "../src/gh.js";
import type { ManagedTicketExecutor } from "../src/ticket-executor.js";
import { TicketWorktrees, type TicketExecutionRecord } from "../src/ticket-worktree.js";

const root = process.env.TMP_DIR!;
assert.ok(root && process.env.PI_CODING_AGENT_DIR, "Run via bash tests/run-offline.sh");
const repo = join(root, "host"), origin = join(root, "origin.git"), upstream = join(root, "upstream");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
mkdirSync(join(repo, "src"), { recursive: true });
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Offline");
git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), "/.pi/\n");
writeFileSync(join(repo, "src", "initial.ts"), "export const initialFeature = true;\n");
writeFileSync(join(repo, "README.md"), "Initial host documentation\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "feat: initial fixture");
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "origin", "main");
git(root, "clone", "-b", "main", origin, upstream);
git(upstream, "config", "user.name", "Offline");
git(upstream, "config", "user.email", "offline@example.test");
const cfg = structuredClone(_DEFAULTS);
cfg.models.builder = "offline-builder";
cfg.builder_retries = 0;
cfg.context.max_chars = 20_000;
cfg.context.exclude = ["excluded.ts", "private/nested.ts", "*.hidden.ts"];
const hostOptions = { cwd: repo, maxChars: cfg.context.max_chars, exclude: cfg.context.exclude };
const cachedHost = generateContext(hostOptions);
const hostSnapshot = () => ({
  branch: git(repo, "branch", "--show-current"),
  head: git(repo, "rev-parse", "HEAD"),
  status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
  readme: readFileSync(join(repo, "README.md"), "utf8"),
  context: readFileSync(join(repo, ".pi", "board-agent", "context.md"), "utf8"),
  hash: readFileSync(join(repo, ".pi", "board-agent", "context.hash"), "utf8"),
});
const hostBefore = hostSnapshot();
writeFileSync(join(upstream, "src", "base-new.ts"), "export const newBaseFeature = true;\n");
writeFileSync(join(upstream, "README.md"), "New upstream documentation\n" + "Documented fixture behavior\n".repeat(250));
writeFileSync(join(upstream, "package.json"), JSON.stringify({ scripts: { check: "echo upstream-check" } }));
mkdirSync(join(upstream, "private"));
mkdirSync(join(upstream, "node_modules", "fixture"), { recursive: true });
for (const [path, symbol] of [
  ["src/excluded.ts", "customExcluded"],
  ["private/nested.ts", "pathExcluded"],
  ["src/private.hidden.ts", "globExcluded"],
  ["node_modules/fixture/index.ts", "defaultExcluded"],
]) writeFileSync(join(upstream, path), `export const ${symbol} = true;\n`);
git(upstream, "add", ".");
git(upstream, "commit", "-m", "feat: upstream addition");
git(upstream, "push", "origin", "main");
const newBase = git(upstream, "rev-parse", "HEAD");
assert.notEqual(newBase, hostBefore.head);
assert.equal(existsSync(join(repo, "src", "base-new.ts")), false);
assert.equal(generateContext(hostOptions), cachedHost, "host HEAD cache is genuinely unchanged");

const worktrees = new TicketWorktrees(repo);
const cards = new Map<string, Card>();
const addCard = (number: number): Card => {
  const card: Card = {
    itemId: `PVTI_${number}`, number, contentType: "Issue", type: "Task",
    title: `T00${number} context fixture`, body: "Acceptance criteria", plan: "demo",
    repoOwner: "owner", repoName: "repo", closed: false, assignees: [], status: cfg.columns.ready,
  };
  cards.set(card.itemId, card);
  return card;
};
const calls: Array<{ prompt: string; cwd: string }> = [];
const managers = new Map<string, WorkflowManager>();
const contextCalls: Array<{ kind: string; options: ContextOptions }> = [];
const notices: string[] = [];
let waitForAbort = false;
const makeAgent = (cwd: string): NonNullable<WorkflowRunOptions["agent"]> => ({
  async run(prompt, options) {
    // Upstream 3.10.0 supplies an override only for nested worktree isolation;
    // WorkflowAgent otherwise uses the cwd passed to its manager/constructor.
    const runCwd = options?.cwd ?? cwd;
    calls.push({ prompt, cwd: runCwd });
    assert.equal(options?.model, "offline-builder");
    const record = worktrees.list().find((record) => record.path === runCwd);
    assert.ok(record, "the actual model cwd must be a registered ticket path");
    if (waitForAbort) {
      assert.ok(options?.signal);
      await new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")), { once: true });
      });
    }
    return { taskKey: record.taskKey, itemId: record.itemId, status: "success", branch: record.taskBranch, summary: "Offline result" };
  },
});
const globals = globalThis as any;
globals.__builderContext = {
  getCard: async (id: string) => structuredClone(cards.get(id)),
  setStatus: async (_meta: unknown, id: string, status: string) => { cards.get(id)!.status = status; },
  tryClaim: async (card: Card) => { cards.get(card.itemId)!.assignees = ["bot"]; return true; },
  release: async (card: Card) => { cards.get(card.itemId)!.assignees = []; },
  listIssueComments: async () => [],
  resolveIssueId: async () => "ISSUE",
  createComment: async () => "COMMENT",
  WorkflowManager: class extends WorkflowManager {
    constructor(options: WorkflowManagerOptions) {
      super({ ...options, agent: makeAgent(options.cwd!) as NonNullable<WorkflowManagerOptions["agent"]> });
      managers.set(options.cwd!, this);
    }
  },
  renderContext: (options: ContextOptions) => {
    contextCalls.push({ kind: "render", options: structuredClone(options) });
    return renderContext(options);
  },
  generateContext: (options: ContextOptions) => {
    contextCalls.push({ kind: "cache", options: structuredClone(options) });
    return generateContext(options);
  },
};
const shim = (url: string, names: string[]) => `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(url)};
${names.map((name) => `export const ${name} = globalThis.__builderContext.${name};`).join("\n")}
`)}`;
const replacements: Record<string, string> = {
  "./gh.js": shim(new URL("../src/gh.ts", import.meta.url).href, ["getCard", "setStatus", "tryClaim", "release", "listIssueComments", "resolveIssueId", "createComment"]),
  "./context.js": shim(new URL("../src/context.ts", import.meta.url).href, ["renderContext", "generateContext"]),
  "@quintinshaw/pi-dynamic-workflows": shim(import.meta.resolve("@quintinshaw/pi-dynamic-workflows"), ["WorkflowManager"]),
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === new URL("../src/ticket-executor.ts", import.meta.url).href && replacements[specifier])
    return { url: replacements[specifier], shortCircuit: true };
  return next(specifier, context);
} });
const { createProductionTicketExecutor } = await import("../src/ticket-executor.js");
const makeExecutor = () => createProductionTicketExecutor({
  cwd: repo, cfg, worktrees, botLogin: "bot", repoOwner: "owner", repoName: "repo",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} }, callback: (message) => notices.push(message),
});
async function until(condition: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `offline manager did not settle: ${notices.join("\n")}`);
    await delay(10);
  }
}
const digest = (prompt: string) => {
  const match = /REPO CONTEXT[^\n]*\n----8<----\n([\s\S]*?)\n----8<----/.exec(prompt);
  assert.ok(match, "the actual builder must receive a context section");
  return match[1];
};
function clean(record: TicketExecutionRecord) {
  assert.deepEqual(worktrees.check(record, true), { ok: true, clean: true });
  // Ignored files must not conceal a generated digest from the dirty gate.
  assert.equal(git(record.path, "ls-files", "--others", "--ignored", "--exclude-standard"), "");
  assert.equal(existsSync(join(record.path, ".pi")), false, "no generated files in the ticket worktree");
}
async function launch(executor: ManagedTicketExecutor, card: Card) {
  const before = calls.length;
  const result = await executor.launch(structuredClone(card), "demo");
  assert.equal(result.status, "launched", JSON.stringify(result));
  const record = worktrees.read(card.itemId)!;
  await until(() => calls.length > before);
  assert.equal(calls.length, before + 1);
  assert.equal(calls[before].cwd, record.path);
  return { record, call: calls[before] };
}
async function complete(executor: ManagedTicketExecutor, card: Card) {
  const record = worktrees.read(card.itemId)!;
  await until(() => managers.get(record.path)!.listAllRuns().find((run) => run.runId === record.activeRunId)?.status === "completed");
  const summary = await executor.reconcile([...cards.values()].map((card) => structuredClone(card)));
  assert.equal(summary.errors, 0);
  assert.equal(summary.needsHuman, 0);
  assert.equal(card.status, cfg.columns.review, "real completion dirty gate must still pass");
  assert.equal(worktrees.read(card.itemId)?.activeRunId, undefined);
  clean(record);
}
let executor = makeExecutor();
try {
  const card = addCard(1);
  const { record, call } = await launch(executor, card);
  assert.equal(git(record.path, "rev-parse", "HEAD"), newBase);
  assert.match(digest(call.prompt), /exports: newBaseFeature/, "new builders need their fresh origin\/base worktree, not the host HEAD digest");
  assert.match(digest(call.prompt), /New upstream documentation/);
  assert.doesNotMatch(digest(call.prompt), /Initial host documentation/);
  assert.deepEqual(contextCalls, [{ kind: "render", options: { ...hostOptions, cwd: record.path } }]);
  assert.match(call.prompt, /REPO CONTEXT[^\n]*navigation[^\n]*code is authoritative/);
  assert.doesNotMatch(call.prompt, /use this instead of exploring/i);
  await complete(executor, card);
  assert.deepEqual(hostSnapshot(), hostBefore);
  console.log("PASS: production factory builder sees fresh origin/base content while host main and its cache stay unchanged; no generated dirty files");
  console.log("PASS: executed builder prompt treats context as navigation and worktree code as authoritative");

  const fullDigest = digest(call.prompt);
  assert.doesNotMatch(fullDigest, /truncated at/);
  assert.match(fullDigest, /check=echo upstream-check/);
  assert.match(fullDigest, /upstream addition/);
  assert.doesNotMatch(fullDigest, /customExcluded|pathExcluded|globExcluded|defaultExcluded|excluded\.ts|private\/nested\.ts|private\.hidden\.ts|node_modules/);
  console.log("PASS: production context retains configured basename/path/glob and default exclusions without hiding them behind truncation");

  // A manual retry belongs to its retained path/tip, not a newer origin/base.
  await executor.shutdown();
  writeFileSync(join(record.path, "src", "ticket-only.ts"), "export const ticketOnlyFeature = true;\n");
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "feat: retained ticket work");
  const ticketSha = git(record.path, "rev-parse", "HEAD");
  writeFileSync(join(upstream, "src", "later-base.ts"), "export const laterBaseFeature = true;\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "feat: later upstream work");
  git(upstream, "push", "origin", "main");
  card.status = cfg.columns.ready;
  waitForAbort = true;
  executor = makeExecutor();
  const reused = await launch(executor, card);
  assert.equal(reused.record.path, record.path);
  assert.equal(reused.record.createdAt, record.createdAt);
  assert.equal(git(reused.record.path, "rev-parse", "HEAD"), ticketSha);
  assert.match(digest(reused.call.prompt), /exports: ticketOnlyFeature/);
  assert.match(digest(reused.call.prompt), /exports: newBaseFeature/);
  assert.doesNotMatch(digest(reused.call.prompt), /laterBaseFeature/);
  assert.equal(contextCalls.length, 2);
  assert.deepEqual(contextCalls[1], { kind: "render", options: { ...hostOptions, cwd: record.path } });
  clean(reused.record);
  assert.deepEqual(hostSnapshot(), hostBefore);
  console.log("PASS: production relaunch renders the persistent ticket's own content/path instead of rebasing its digest onto the newer origin/base");

  // Recreate the actual manager and resume its persisted script without a new
  // launch/context render. All durable args/ownership/branch gates still run.
  await executor.shutdown();
  const runId = reused.record.activeRunId!;
  const paused = managers.get(record.path)!.listAllRuns().find((run) => run.runId === runId)!;
  assert.equal(paused.status, "paused");
  assert.equal(worktrees.read(card.itemId)?.activeRunId, runId);
  const callsBeforeResume = calls.length;
  const rendersBeforeResume = contextCalls.length;
  waitForAbort = false;
  executor = makeExecutor();
  const resumed = await executor.reconcile([...cards.values()].map((card) => structuredClone(card)));
  assert.equal(resumed.errors, 0);
  assert.equal(resumed.resumed, 1);
  await until(() => calls.length > callsBeforeResume);
  assert.deepEqual(calls[callsBeforeResume], reused.call);
  assert.equal(contextCalls.length, rendersBeforeResume);
  assert.equal(worktrees.read(card.itemId)?.path, record.path);
  assert.equal(worktrees.read(card.itemId)?.activeRunId, runId);
  assert.equal(managers.get(record.path)!.listAllRuns().find((run) => run.runId === runId)?.script, paused.script);
  await complete(executor, card);
  console.log("PASS: production recovery resumes the real persisted workflow in the same ticket path with its existing prompt, no replacement summary or dirty files");

  await executor.shutdown();
  cfg.context.max_chars = 2000;
  executor = makeExecutor();
  const second = addCard(2);
  const bounded = await launch(executor, second);
  const boundedDigest = digest(bounded.call.prompt);
  assert.match(boundedDigest, /exports: laterBaseFeature/);
  assert.doesNotMatch(boundedDigest, /ticketOnlyFeature/);
  assert.match(boundedDigest, /…\(truncated at 2000 chars\)$/);
  assert.ok(boundedDigest.length <= 2100, "existing maxChars bound plus the visible truncation marker");
  assert.deepEqual(contextCalls.at(-1), { kind: "render", options: { ...hostOptions, cwd: bounded.record.path, maxChars: 2000 } });
  await complete(executor, second);
  console.log("PASS: another production builder gets its own fresh base, configured maxChars and existing truncation marker/exclusions");

  await executor.shutdown();
  cfg.context.enabled = false;
  executor = makeExecutor();
  const beforeDisabled = contextCalls.length;
  const third = addCard(3);
  const disabled = await launch(executor, third);
  assert.doesNotMatch(disabled.call.prompt, /REPO CONTEXT|Repo tree/);
  assert.equal(contextCalls.length, beforeDisabled, "disabled context calls neither renderer nor cache helper, even if errors would be swallowed");
  await complete(executor, third);
  assert.equal(contextCalls.length, beforeDisabled);
  assert.ok(notices.every((message) => !message.includes("Context generation failed")));
  assert.deepEqual(hostSnapshot(), hostBefore);
  console.log("PASS: disabled production context performs no renderer/cache scan, adds no summary and leaves all worktrees and host main/cache unchanged");
} finally {
  await executor.shutdown();
  hooks.deregister();
  delete globals.__builderContext;
}
