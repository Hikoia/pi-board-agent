// No-Plan Ready -> real WorkflowManager builder -> pinned AI review -> manual
// close -> bare-origin merge/cleanup. No live GitHub/provider or child/PR adapter.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRunPersistence, type WorkflowManagerOptions } from "@quintinshaw/pi-dynamic-workflows";
import { loadConfig, validateConfig } from "../src/config.js";
import { isTargetIssue, validateProjectMetadata, type Card } from "../src/gh.js";
import { BoardLoop, createLoopState } from "../src/loop.js";
import { acquireOwnerLock } from "../src/owner-lock.js";
import { createWorkflowManagerAdapter, ManagedTicketExecutor, type TicketBoardAdapter } from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { git } from "./conflict-handoff-fixture.js";

const root = process.env.TMP_DIR!;
assert.ok(root, "Use tests/run-offline.sh");
const repo = join(root, "repo"), origin = join(root, "origin.git");
mkdirSync(repo);
git(root, "init", "--bare", origin);
git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Offline"); git(repo, "config", "user.email", "offline@example.test");
writeFileSync(join(repo, ".gitignore"), ".pi/\n");
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, "add", "."); git(repo, "commit", "-m", "base");
git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
const baseSha = git(repo, "rev-parse", "HEAD");
mkdirSync(join(repo, ".pi"));
const configFile = join(repo, ".pi", "board-agent.yml");
const yaml = `project: {number: 1}
max_workers: 2
builder_timeout_ms: 60000
builder_retries: 0
models: {builder: offline-builder, review: offline-review, refine: retired, watch: retired}
refine: {enabled: true}
watchdog: {enabled: true, respond_to_mentions: true}
review: {enabled: false, timeout_ms: 4321}
task_merge_strategy: squash
telegram: {enabled: false}
`;
writeFileSync(configFile, yaml);
const warnings: string[] = [];
const cfg = loadConfig(repo, m => warnings.push(m)); validateConfig(cfg);
const meta = { projectId: "P", statusFieldId: "S", statusFieldType: "SINGLE_SELECT",
  statusOptions: Object.fromEntries(["Ready", "In Progress", "Review", "Done", "Needs Human"].map(s => [s, s])),
  typeFieldId: "T", typeFieldType: "SINGLE_SELECT", typeOptions: { Task: "TASK" } };
validateProjectMetadata(meta, cfg); // No Plan field, no Story/Needs Design/Backlog options.
const card: Card = { itemId: "TASK", number: 42, contentType: "Issue", type: "Task", title: "T042 no Plan",
  body: "Write accepted.txt", status: "Ready", closed: false, assignees: [], repoOwner: "owner", repoName: "repo" };
const protectedCards = [
  { contentType: "DraftIssue" }, { contentType: "PullRequest" }, { repoOwner: "elsewhere" },
  { repoName: "elsewhere" }, { type: "Story" }, { type: undefined }, { type: "Epic" },
].flatMap((patch, i) => ["Ready", "Review", "Done", "Needs Design"].map((status, j) => ({
  ...structuredClone(card), ...patch, itemId: `PROTECTED_${i}_${j}`, number: 100 + i * 4 + j, status, closed: status === "Done",
})));
const beforeProtected = JSON.stringify(protectedCards);
const cards = [card, ...protectedCards], comments: string[] = [], statuses: string[] = [];
const checkTarget = (c: Card) => { assert.equal(c.itemId, card.itemId); assert.ok(isTargetIssue(c, "owner", "repo")); };
const board: TicketBoardAdapter = {
  getCard: async id => structuredClone(cards.find(c => c.itemId === id)),
  claim: async c => { checkTarget(c); card.assignees = ["bot"]; return true; },
  release: async c => { checkTarget(c); card.assignees = []; },
  comment: async (c, body) => { checkTarget(c); comments.push(body); },
  listComments: async c => { checkTarget(c); return [...comments]; },
  setStatus: async (id, status) => { assert.equal(id, card.itemId); statuses.push(status); card.status = status; },
  reopen: async () => assert.fail("normal integration must not reopen"),
};
const store = new TicketWorktrees(repo), path = store.pathFor(card.itemId, 42);
const legacyDir = join(repo, ".pi", "board-agent");
for (const file of ["refine-state.json", "refine-state-unblocked.json", "watchdog-state.json"])
  writeFileSync(join(legacyDir, file), `untouched retired evidence: ${file}\n`);
const owner = acquireOwnerLock(repo, "bot", repo, true);
let builders = 0, reviewers = 0, taskSha = "";
const notices: string[] = [];
type Agent = NonNullable<WorkflowManagerOptions["agent"]>;
const executor = new ManagedTicketExecutor({ cwd: repo, cfg, board, worktrees: store, ownerLock: owner,
  botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: m => notices.push(m),
  context: async record => { assert.equal(record.path, path); return "offline worktree context"; },
  createManager: cwd => createWorkflowManagerAdapter({ cwd, defaultAgentRetries: 0, deferScheduling: true, callback: () => {},
    agent: { run: async (...[prompt, options]: Parameters<Agent["run"]>) => {
      builders++; assert.equal(cwd, path); assert.equal(options?.model, "offline-builder");
      assert.equal(cfg.builder_timeout_ms, 60000); assert.ok(prompt.includes("offline worktree context"));
      assert.ok(!prompt.includes("Plan slug:")); assert.equal(store.read(card.itemId)?.plan, undefined);
      writeFileSync(join(cwd, "accepted.txt"), "accepted\n"); git(cwd, "add", "accepted.txt"); git(cwd, "commit", "-m", "accepted task");
      taskSha = git(cwd, "rev-parse", "HEAD"); git(cwd, "push", "origin", "task/issue-42");
      return { taskKey: "T042", itemId: card.itemId, status: "success", branch: "task/issue-42", summary: "accepted" };
    } } as Agent,
  }),
});
const loop = new BoardLoop({ cwd: repo, cfg, meta, botLogin: "bot", repoOwner: "owner", repoName: "repo", callback: () => {},
  listCards: async () => structuredClone(cards), boardOps: {
    claim: board.claim, refresh: c => board.getCard(c.itemId), release: board.release,
    listComments: async () => comments.map((body, i) => ({ id: String(i), body, author: "bot", createdAt: "2026-01-01" })),
    comment: async (c, body) => { await board.comment(c, body); return String(comments.length); },
    setStatus: (c, status) => board.setStatus(c.itemId, status),
  }, review: async input => {
    reviewers++; assert.equal(input.model, "offline-review"); assert.equal(input.timeoutMs, 4321); assert.equal(input.taskSha, taskSha);
    assert.equal(readFileSync(join(path, "accepted.txt"), "utf8"), "accepted\n");
    return { verdict: "pass", taskSha, summary: "acceptance met", findings: [] };
  },
}, createLoopState(), executor, store, owner);
try {
  await loop.tickNow(); assert.equal(card.status, "In Progress"); assert.ok(store.has(card.itemId));
  for (let i = 0; i < 400 && !createRunPersistence(path).list().some(r => r.status === "completed"); i++)
    await new Promise(r => setTimeout(r, 20));
  assert.equal(createRunPersistence(path).list()[0]?.status, "completed");
  await loop.tickNow(); assert.equal(card.status, "Review", notices.join("\n") + JSON.stringify(createRunPersistence(path).list())); assert.equal(reviewers, 0);
  await loop.tickNow(); assert.equal(card.status, "Done"); assert.equal(card.closed, false); assert.equal(reviewers, 1);
  await loop.tickNow(); assert.equal(card.closed, false); assert.equal(existsSync(path), true);
  assert.equal(git(repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], baseSha);
  card.closed = true; // The ONLY Issue close is manual acceptance in this fixture.
  await loop.tickNow();
  const result = git(repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
  assert.equal(git(repo, "show", "-s", "--format=%P", result), `${baseSha} ${taskSha}`, "normal two-parent merge, never squash");
  assert.equal(git(repo, "show", `${result}:accepted.txt`), "accepted");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseSha, "host checkout untouched");
  assert.equal(git(repo, "ls-remote", "origin", "refs/heads/task/issue-42"), "");
  assert.equal(store.localBranchSha("task/issue-42"), undefined); assert.equal(existsSync(path), false); assert.equal(store.has(card.itemId), false);
  assert.equal(card.status, "Done"); assert.equal(card.closed, true); assert.equal(builders, 1); assert.equal(reviewers, 1);
  assert.deepEqual(statuses, ["In Progress", "Review", "Done"]);
  assert.equal(JSON.stringify(protectedCards), beforeProtected);
  for (const file of ["refine-state.json", "refine-state-unblocked.json", "watchdog-state.json"])
    assert.equal(readFileSync(join(legacyDir, file), "utf8"), `untouched retired evidence: ${file}\n`);
  assert.equal(readFileSync(configFile, "utf8"), yaml); assert.equal(warnings.length, 6);
  console.log("PASS: no-Plan Task completes Ready/build/always-on Review/open Done/manual close/merge/native cleanup using real WorkflowManager and bare Git");
  console.log("PASS: configured models/timeouts/context survive retired enabled flags; protected cards and legacy Story/watchdog bytes untouched; no PR/child/schema operations");
} finally { await loop.stop(); }
