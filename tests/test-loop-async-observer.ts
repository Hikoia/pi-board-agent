import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { _DEFAULTS } from "../src/config.js";
import type { Card } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
const cfg = structuredClone(_DEFAULTS);
cfg.safety.require_clean_worktree = cfg.context.enabled = cfg.review.enabled = cfg.watchdog.enabled = false;
const card: Card = { itemId: "ITEM", number: 1, contentType: "Issue", type: "Task", title: "Task", body: "Acceptance", plan: "demo", status: cfg.columns.needs_design, closed: false, assignees: [], repoOwner: "owner", repoName: "repo" };
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
  taskDesignOps: {
    claim: async () => { card.assignees = ["bot"]; return true; },
    refresh: async () => structuredClone(card),
    release: async () => { released = true; },
    listComments: async () => [
      { id: "gate", author: "bot", body: "<!-- board-agent-requirements-gate:1 -->\nApprove", createdAt: "2025-01-01" },
      { id: "decision", author: "owner", authorAssociation: "OWNER", body: "Approved", createdAt: "2025-01-02" },
    ],
    design: async () => { throw new Error("early model failure"); },
    updateBody: async () => { mutations++; }, comment: async () => { mutations++; }, setReady: async () => { mutations++; },
  },
}, state, {
  reconcile: async () => ({ active: [], resumed: 0, adopted: 0, needsHuman: 0, orphans: 0, errors: 0 }),
  activeCount: () => 0, shutdown: async () => {},
  launch: async () => { throw new Error("unexpected launch"); }, finalizeClosed: async () => { throw new Error("unexpected finalize"); },
}, new TicketWorktrees(cwd), owner);
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
