// Offline GH boundary + real loop/executor/WorkflowManager and disposable local Git.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createRunPersistence,
  compactAgentHistory,
  type WorkflowManagerOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { _DEFAULTS } from "../src/config.js";
import type { Card, IssueComment } from "../src/gh.js";
import { BoardLoop, createLoopState, type LoopDeps } from "../src/loop.js";
import {
  ManagedTicketExecutor,
  createWorkflowManagerAdapter,
  type TicketBoardAdapter,
} from "../src/ticket-executor.js";
import { TicketWorktrees } from "../src/ticket-worktree.js";
import { buildTasksForWave } from "../src/workflow-prompt.js";
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let sequence = 0;
export async function fixture(conflict = true) {
  assert.ok(process.env.TMP_DIR, "Use tests/run-offline.sh");
  const dir = join(process.env.TMP_DIR!, `handoff-${++sequence}`),
    repo = join(dir, "repo"),
    origin = join(dir, "origin.git");
  mkdirSync(repo, { recursive: true });
  git(dir, "init", "--bare", origin);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Offline");
  git(repo, "config", "user.email", "offline@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), ".pi/\n");
  writeFileSync(join(repo, "value.json"), '{"task":false,"base":false}\n');
  writeFileSync(
    join(repo, "test.cjs"),
    `require('node:assert/strict').deepEqual(require('./value.json'), {task:true,base:true}); console.log('PASS both original requirements');\n`,
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "original");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "origin", "main");
  const originalBase = git(repo, "rev-parse", "HEAD");
  const cfg = structuredClone(_DEFAULTS);
  cfg.max_workers = 1;
  cfg.builder_retries = 0;
  cfg.context.enabled =
    cfg.review.enabled =
    cfg.refine.enabled =
    cfg.watchdog.enabled =
    cfg.telegram.enabled =
    cfg.safety.require_clean_worktree =
      false;
  const card: Card = {
    itemId: `HANDOFF_${sequence}`,
    number: sequence,
    contentType: "Issue",
    type: "Task",
    title: "T015 retain both requirements",
    body: "Keep original task edits and integrate base behavior.",
    plan: "demo",
    status: cfg.columns.done,
    closed: true,
    assignees: [],
    repoOwner: "owner",
    repoName: "repo",
  };
  const task = buildTasksForWave(cfg, "demo", [card])[0];
  const store = new TicketWorktrees(repo),
    record = await store.ensure(task, "demo");
  writeFileSync(
    join(record.path, "value.json"),
    '{"task":true,"base":false}\n',
  );
  git(record.path, "add", ".");
  git(record.path, "commit", "-m", "task");
  git(record.path, "push", "origin", task.taskBranch);
  const taskSha = git(record.path, "rev-parse", "HEAD");
  if (conflict) {
    writeFileSync(join(repo, "value.json"), '{"task":false,"base":true}\n');
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "push", "origin", "main");
  }
  const baseSha = git(repo, "rev-parse", "HEAD");
  const cards = [card];
  const comments: IssueComment[] = [],
    events: string[] = [],
    notices: string[] = [];
  const warnings: Array<{ source: "executor" | "loop"; message: string }> = [];
  let hook: (event: string) => void | Promise<void> = () => {},
    calls = 0,
    revision = true;
  const io = async (name: string, action: () => void) => {
    events.push(name);
    await hook(`before:${name}`);
    action();
    await hook(`after:${name}`);
  };
  const board: TicketBoardAdapter = {
    getCard: async (id) => {
      await hook("read:card");
      return structuredClone(cards.find((c) => c.itemId === id));
    },
    claim: async (target) => {
      await io("claim", () => {
        cards.find((c) => c.itemId === target.itemId)!.assignees = ["bot"];
      });
      return true;
    },
    release: async (target) => {
      await io("release", () => {
        const c = cards.find((c) => c.itemId === target.itemId)!;
        c.assignees = c.assignees.filter((a) => a !== "bot");
      });
    },
    setStatus: async (id, status) =>
      io(`status:${status}`, () => {
        cards.find((c) => c.itemId === id)!.status = status;
      }),
    listComments: async () => comments.map((c) => c.body),
    comment: async (_card, body) =>
      io("ordinary-comment", () => {
        comments.push({
          id: `C${comments.length + 1}`,
          author: "bot",
          body,
          createdAt: new Date().toISOString(),
        });
      }),
  };
  // Optional capability: old offline adapters cannot accidentally fall back to live gh.
  const conflictOps = {
    listComments: async () => {
      await hook("read:comments");
      return structuredClone(comments);
    },
    createComment: async (_card: Card, body: string) => {
      let id = "";
      await io(
        body.startsWith("<!-- board-agent-conflict-repair:")
          ? "request-comment"
          : "ordinary-comment",
        () => {
          id = `C${comments.length + 1}`;
          comments.push({
            id,
            author: "bot",
            body,
            createdAt: new Date().toISOString(),
          });
        },
      );
      return id;
    },
    updateComment: async (_card: Card, id: string, body: string) =>
      io(
        body.includes('"phase":"consumed"')
          ? "consume-comment"
          : "queue-comment",
        () => {
          comments.find((c) => c.id === id)!.body = body;
        },
      ),
    reopen: async () =>
      io("reopen", () => {
        card.closed = false;
      }),
  };
  Object.assign(board, { conflict: conflictOps });
  type Agent = NonNullable<WorkflowManagerOptions["agent"]>;
  type Builder = (...args: Parameters<Agent["run"]>) => Promise<unknown>;
  let builder: Builder = async () => ({
    taskKey: task.taskKey,
    itemId: task.itemId,
    branch: task.taskBranch,
    status: "failure",
    error: "offline builder blocker",
  });
  let managerHook: (event: string) => void = () => {};
  let review: LoopDeps["review"] = async () => {
    throw new Error("Offline Review adapter not configured");
  };
  const make = () => {
    const executor = new ManagedTicketExecutor({
      cwd: repo,
      cfg,
      board,
      worktrees: new TicketWorktrees(repo),
      botLogin: "bot",
      repoOwner: "owner",
      repoName: "repo",
      callback: (s, level) => {
        notices.push(s);
        if (level === "warn") warnings.push({ source: "executor", message: s });
      },
      createManager: (cwd) => {
        const manager = createWorkflowManagerAdapter({
          cwd,
          defaultAgentRetries: 0,
          deferScheduling: true,
          callback: () => {},
          agent: {
            run: async (...args: Parameters<Agent["run"]>) => {
              calls++;
              return builder(...args);
            },
          } as Agent,
        });
        const start = manager.start;
        manager.start = (...args) => {
          managerHook("before:start");
          const id = start(...args);
          managerHook("after:start");
          return id;
        };
        return manager;
      },
    });
    const state = createLoopState();
    const loop = new BoardLoop(
      {
        cwd: repo,
        cfg,
        botLogin: "bot",
        repoOwner: "owner",
        repoName: "repo",
        meta: { projectId: "P", statusFieldId: "S", statusOptions: {} },
        callback: (s, level) => {
          notices.push(s);
          if (level === "warn") warnings.push({ source: "loop", message: s });
        },
        revisionCheck: () => ({ ok: revision }),
        revisionCheckNow: () => ({ ok: revision }),
        listCards: async () => structuredClone(cards),
        review: (input) => review!(input),
        boardOps: {
          claim: board.claim,
          refresh: async () => board.getCard(card.itemId),
          release: board.release,
          listComments: conflictOps.listComments,
          comment: conflictOps.createComment,
          setStatus: async (_card, status) =>
            board.setStatus(card.itemId, status),
        },
      },
      state,
      executor,
      new TicketWorktrees(repo),
    );
    return { loop, state, executor };
  };
  return {
    ...make(),
    make,
    repo,
    origin,
    cfg,
    card,
    cards,
    task,
    store,
    record,
    originalBase,
    baseSha,
    taskSha,
    board,
    conflictOps,
    comments,
    events,
    notices,
    warnings,
    calls: () => calls,
    setHook: (h: typeof hook) => {
      hook = h;
    },
    setManagerHook: (h: typeof managerHook) => {
      managerHook = h;
    },
    setBuilder: (b: Builder) => {
      builder = b;
    },
    setRevision: (v: boolean) => {
      revision = v;
    },
    setReview: (value: LoopDeps["review"]) => {
      review = value;
    },
    runs: () => createRunPersistence(record.path).list(),
  };
}
export function advanceBase(f: Awaited<ReturnType<typeof fixture>>) {
  git(
    f.repo,
    "commit",
    "--allow-empty",
    "-m",
    "main advances while original repair waits",
  );
  git(f.repo, "push", "origin", "main");
  return git(f.repo, "rev-parse", "HEAD");
}

export async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 400; i++) {
    const runs = f.runs();
    if (
      runs.length &&
      runs.every((r) =>
        ["completed", "failed", "aborted", "paused"].includes(r.status),
      )
    )
      return runs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Workflow did not settle (not a pass)");
}

export async function repairResult(
  f: Awaited<ReturnType<typeof fixture>>,
  prompt: string,
  options: Parameters<NonNullable<WorkflowManagerOptions["agent"]>["run"]>[1],
) {
  let sha = "";
  assert.ok(prompt.includes(f.card.body));
  assert.ok(prompt.includes(f.baseSha));
  assert.ok(prompt.includes(f.taskSha));
  assert.throws(() => git(f.record.path, "merge", "--no-edit", f.baseSha));
  writeFileSync(
    join(f.record.path, "value.json"),
    '{"task":true,"base":true}\n',
  );
  git(f.record.path, "add", ".");
  git(f.record.path, "commit", "-m", "resolve retaining both requirements");
  sha = git(f.record.path, "rev-parse", "HEAD");
  const command = `set -euo pipefail
export GIT_NO_REPLACE_OBJECTS=1
head=$(git rev-parse HEAD)
status=$(git status --porcelain=v1 --untracked-files=all)
test "$head" = '${sha}'
test -z "$status"
printf '%s\\n' 'BOARD_AGENT_REPAIR_TEST_BEGIN ${sha}'
(
node test.cjs
)
head=$(git rev-parse HEAD)
status=$(git status --porcelain=v1 --untracked-files=all)
test "$head" = '${sha}'
test -z "$status"
printf '%s\\n' 'BOARD_AGENT_REPAIR_TEST_PASS ${sha}'`;
  const result = await createBashTool(f.record.path).execute(
    "test",
    { command },
    options?.signal,
  );
  options?.onHistory?.(
    compactAgentHistory([
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command } }],
      },
      {
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: result.content,
      },
    ]),
  );
  git(f.record.path, "push", "origin", f.task.taskBranch);
  return {
    taskKey: f.task.taskKey,
    itemId: f.task.itemId,
    branch: f.task.taskBranch,
    status: "success",
    testEvidence: { resultSha: sha, command: "node test.cjs" },
  };
}
