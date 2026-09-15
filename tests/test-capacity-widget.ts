// Exercise the actual entry-point widget at a held foreground model boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import type { TicketExecutor } from "../src/ticket-executor.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/owner/repo.git"], { stdio: "ignore" });
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(join(cwd, ".pi", "board-agent.yml"), `project:\n  owner: owner\n  number: 1\nbot_identity: bot\nmax_workers: 6\nsafety:\n  require_clean_worktree: false\ncontext:\n  enabled: false\nwatchdog:\n  enabled: false\n`);
const card: Card = { itemId: "ITEM_1", number: 1, contentType: "Issue", type: "Task", status: "Review", plan: "demo", title: "Task", body: "Acceptance", closed: false, assignees: [], repoOwner: "owner", repoName: "repo" };
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("config", "user.name", "Offline"); git("config", "user.email", "offline@example.test");
git("commit", "--allow-empty", "-m", "widget fixture");
const worktrees = new TicketWorktrees(cwd), path = worktrees.pathFor(card.itemId, 1), sha = git("rev-parse", "HEAD");
git("worktree", "add", "-b", "task/issue-1", path, "main");
writeFileSync(join(cwd, ".pi", "board-agent", "ticket-worktrees", "item_1.json"), JSON.stringify({
  schemaVersion: 4, itemId: card.itemId, issueNumber: 1, taskKey: "T001", plan: "demo",
  taskBranch: "task/issue-1", baseBranch: "main", path, createdAt: 1, reviewedTaskSha: sha,
}));
const globals = globalThis as any;
globals.__widgetCapacity = {
  getProjectMetadata: async () => ({
    projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT", statusOptions: Object.fromEntries(Object.values(_DEFAULTS.columns).map((name) => [name, name])),
    planFieldId: "PLAN", planFieldType: "TEXT", typeFieldId: "TYPE", typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK", Story: "STORY" },
  }),
  listCards: async () => [structuredClone(card)], getCard: async () => structuredClone(card),
  listIssueComments: async () => [], resolveIssueId: async () => "ISSUE",
  createComment: async () => "COMMENT", setStatus: async (_meta: unknown, _itemId: string, status: string) => { card.status = status; },
  runReview: async () => { enter(); await held; return { verdict: "pass", findings: [], summary: "ok", taskSha: sha }; },
  tryClaim: async () => { card.assignees = ["bot"]; return true; }, release: async () => { card.assignees = []; },
  createProductionTicketExecutor: (): TicketExecutor => ({
    observation: { active: ["running", "pending", "paused", "missing", "completed"].map((status, i) => ({ itemId: `ITEM_${i}`, runId: `run-${i}`, worktree: cwd, taskKey: `T00${i + 1}`, status })), occupiedSlots: 5 },
    reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
    activeCount: () => 5, // running + pending + paused + unverifiable + launching
    launch: async () => { throw new Error("unexpected launch"); }, finalizeClosed: async () => { throw new Error("unexpected finalize"); }, shutdown: async () => {},
  }),
  captureRuntimeIdentity: () => ({ loadedRevision: "a".repeat(40) }),
  checkRuntimeRevisionAsync: () => ({ ok: true, expectedRevision: "a".repeat(40), loadedRevision: "a".repeat(40), diskRevision: "a".repeat(40), dirty: false }),
};
const entry = new URL("../src/index.ts", import.meta.url).href;
const shim = (path: string, names: string[]) => `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL(path, entry).href)};\n${names.map((name) => `export const ${name} = globalThis.__widgetCapacity.${name};`).join("\n")}`)}`;
const stubs: Record<string, string> = {
  "./gh.js": shim("gh.ts", ["getProjectMetadata", "listCards", "getCard", "listIssueComments", "tryClaim", "release", "resolveIssueId", "createComment", "setStatus"]),
  "./review.js": shim("review.ts", ["runReview"]),
  "./ticket-executor.js": shim("ticket-executor.ts", ["createProductionTicketExecutor"]),
  "./runtime.js": shim("runtime.ts", ["captureRuntimeIdentity", "checkRuntimeRevisionAsync"]),
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  return [entry, new URL("loop.ts", entry).href].includes(context.parentURL ?? "") && stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context);
} });
let enter!: () => void, finish!: () => void;
const entered = new Promise<void>((done) => { enter = done; });
const held = new Promise<void>((done) => { finish = done; });
let command!: (name: string, ctx: any) => Promise<void>;
let widget: string[] | undefined;
const messages: string[] = [];
const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "offline-widget" }, ui: { notify: (message: string) => messages.push(message), setWidget: (_id: string, lines: string[] | undefined) => { widget = lines; } } };
try {
  (await import(entry)).default({ on: () => {}, registerCommand: (_name: string, options: any) => { command = options.handler; } });
  const running = command("run", ctx);
  try {
    await Promise.race([entered, running.then(() => { throw new Error(messages.join("\n")); })]);
    assert.equal(widget?.[0], "Board Agent ● 6/6 slots occupied · 2 models running");
    assert.ok(widget?.includes("  issue-1 [review]"));
    assert.ok(widget?.includes("  T003 [paused]"));
    assert.ok(widget?.includes("  T004 [missing]"));
  } finally { finish(); await running; }
  assert.equal(widget?.[0], "Board Agent ● 5/6 slots occupied · 1 models running");
  console.log("PASS: real widget distinguishes occupied (including launching/paused/unverifiable) slots from running models and clears foreground after drain");
} finally {
  await command?.("stop", ctx);
  hooks.deregister();
  delete globals.__widgetCapacity;
}
