import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
const cfg = structuredClone(_DEFAULTS);
cfg.safety.require_clean_worktree = cfg.context.enabled =  false;
const card: Card = { itemId: "ITEM", number: 1, contentType: "Issue", type: "Task", title: "Task", body: "Acceptance", plan: "demo", status: cfg.columns.review, closed: false, assignees: [], repoOwner: "owner", repoName: "repo" };
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("config", "user.name", "Offline"); git("config", "user.email", "offline@example.test");
git("commit", "--allow-empty", "-m", "observer fixture");
const worktrees = new TicketWorktrees(cwd), path = worktrees.pathFor(card.itemId, 1);
git("worktree", "add", "-b", "task/issue-1", path, "main");
writeFileSync(join(cwd, ".pi", "board-agent", "ticket-worktrees", "item.json"), JSON.stringify({
  schemaVersion: 4, itemId: card.itemId, issueNumber: 1, taskKey: "T001", plan: "demo",
  taskBranch: "task/issue-1", baseBranch: "main", path, createdAt: 1, reviewedTaskSha: git("rev-parse", "HEAD"),
}));
let enter!: () => void, finish!: () => void;
const observing = new Promise<void>((done) => { enter = done; });
const observer = new Promise<void>((done) => { finish = done; });
const unhandled: unknown[] = [], messages: string[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("unhandledRejection", onUnhandled);
const state = createLoopState();
const owner = acquireOwnerLock(cwd, "bot");
let mutations = 0, released = false;
const loop = new BoardLoop({
  cwd, cfg, repoOwner: "owner", repoName: "repo", botLogin: "bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
  callback: (message) => messages.push(message), listCards: async () => [structuredClone(card)],
  onTick: async () => { if (state.foreground) { enter(); await observer; } },
  review: async () => { throw new Error("early model failure"); },
  boardOps: {
    claim: async () => { card.assignees = ["bot"]; return true; },
    refresh: async () => structuredClone(card),
    release: async () => { released = true; },
    listComments: async () => [],
    comment: async () => { mutations++; return "comment"; }, setStatus: async () => { mutations++; },
  },
}, state, {
  reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
  activeCount: () => 0, shutdown: async () => {},
  launch: async () => { throw new Error("unexpected launch"); }, finalizeClosed: async () => { throw new Error("unexpected finalize"); },
}, worktrees, owner);
const tick = loop.tickNow();
let stopped: Promise<void> | undefined;
try {
  await Promise.race([observing, tick.then(() => { throw new Error(messages.join("\n")); })]);
  stopped = loop.stop();
  await new Promise<void>((done) => setImmediate(done));
  assert.ok(existsSync(owner.path));
  assert.equal(released, false, "model slot and claim stay held until observer/drain completes");
  assert.deepEqual(unhandled, [], "a foreground failure while awaiting revision/UI observation is immediately handled");
} finally {
  finish();
  await tick;
  await (stopped ?? loop.stop());
  process.off("unhandledRejection", onUnhandled);
}
assert.equal(released, true);
assert.equal(mutations, 0);
assert.equal(state.foreground, null);
assert.equal(existsSync(owner.path), false);
assert.match(messages.join("\n"), /early model failure/);
console.log("PASS: async foreground observation handles early rejection without unhandled promises, drains before releasing claim/slot/owner, and reports the model error");
