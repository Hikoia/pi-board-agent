import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  WorkflowManager,
  type WorkflowManagerOptions,
  type WorkflowRunOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS, type Config } from "../src/config.js";
import { normalizeWaveResults } from "../src/dispatch.js";
import { renderWorkflowSource } from "../src/workflow-prompt.js";

const cwd = process.env.TMP_DIR!;
assert.ok(
  cwd &&
    process.env.PI_CODING_AGENT_DIR &&
    process.env.HOME &&
    process.env.USERPROFILE &&
    resolve(process.env.HOME) === resolve(process.env.USERPROFILE),
  "Run via bash tests/run-offline.sh: an isolated home and Pi directory are required",
);
const cfg: Config = {
  ..._DEFAULTS,
  project: { owner: "test", number: 1 },
  context: { ..._DEFAULTS.context, enabled: false },
};
const expected = {
  taskKey: "T001",
  itemId: "PVTI_manager",
  status: "success",
  branch: "task/issue-1",
  commits: 1,
  summary: "fake-agent-ok",
};
const args = { itemId: "PVTI_manager", issueNumber: 1, taskKey: "T001" };
const script = renderWorkflowSource({
  cfg,
  planSlug: "demo",
  baseBranch: "main",
  skillName: "board-agent",
  tasks: [
    {
      itemId: args.itemId,
      taskKey: args.taskKey,
      issueNumber: 1,
      title: "Manager smoke",
      body: "Persist this result",
      taskBranch: "task/issue-1",
      baseBranch: "main",
    },
  ],
});
const recoveredRunId = process.argv[2];
const pausedRunId = process.argv[3];
let calls = 0;
let entered!: () => void;
const finishEntered = new Promise<void>((resolve) => {
  entered = resolve;
});
const agent: NonNullable<WorkflowRunOptions["agent"]> = {
  async run(prompt, options) {
    calls++;
    if (options?.label === "prepare") {
      assert.equal(
        recoveredRunId,
        undefined,
        "resume must replay the journal instead of repeating completed work",
      );
      return { prepared: true };
    }
    if (options?.label === "finish") {
      if (recoveredRunId) return { finished: true };
      assert.ok(options.signal, "pause must reach the running agent");
      entered();
      return new Promise((_, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("paused", "AbortError")),
          { once: true },
        );
      });
    }
    assert.equal(
      recoveredRunId,
      undefined,
      "reading a completed ticket must not invoke its builder",
    );
    assert.ok(
      prompt.includes("Manager smoke") &&
        prompt.includes("Persist this result"),
    );
    assert.equal(options?.model, cfg.models.builder);
    return expected;
  },
};
// The manager's injection type retains the real agent's schema-generic return;
// this fixture implements only the one generated builder schema asserted below.
const manager = new WorkflowManager({
  cwd,
  concurrency: 1,
  agent: agent as NonNullable<WorkflowManagerOptions["agent"]>,
});
const errors: unknown[] = [];
manager.on("error", (error) => {
  errors.push(error);
});

if (recoveredRunId) {
  // This branch is executed by a genuinely new Node process, not a second
  // instance sharing module/global caches in the parent process.
  const recovered = manager
    .listAllRuns()
    .find((run) => run.runId === recoveredRunId);
  assert.equal(recovered?.status, "completed");
  assert.deepEqual(recovered.args, args);
  assert.deepEqual(
    normalizeWaveResults(recovered.result),
    normalizeWaveResults([expected]),
  );
  // Completed runs intentionally retain full agent results, not resume journals.
  assert.equal(recovered.agents.length, 1);
  assert.deepEqual(recovered.agents[0].result, expected);
  assert.equal(recovered.script, script);
  assert.equal(calls, 0);
  console.log(
    "PASS: a separate Node process recovers persisted args, full result, agent details, and script without invoking the builder",
  );
  const paused = manager.listAllRuns().find((run) => run.runId === pausedRunId);
  assert.equal(paused?.status, "paused");
  assert.deepEqual(paused.args, args);
  assert.equal(paused.journal?.length, 1);
  assert.deepEqual(paused.journal[0].result, { prepared: true });
  const complete = once(manager, "complete");
  assert.equal(await manager.resume(pausedRunId), true);
  await complete;
  const resumed = manager
    .listAllRuns()
    .find((run) => run.runId === pausedRunId);
  assert.equal(resumed?.status, "completed");
  assert.deepEqual(resumed.result, [{ prepared: true }, { finished: true }]);
  assert.equal(
    calls,
    1,
    "only the unfinished agent should execute in the recovery process",
  );
  assert.equal(resumed.maxAgents, 2);
  console.log(
    "PASS: cross-process resume replays the completed journal prefix and executes only unfinished work within the persisted limit",
  );
} else {
  const started = manager.startInBackground(script, args, {
    maxAgents: 1,
    concurrency: 1,
    agentRetries: 0,
  });
  const result = await started.promise;
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    normalizeWaveResults(result.result),
    normalizeWaveResults([expected]),
  );
  const persisted = manager
    .listAllRuns()
    .find((run) => run.runId === started.runId);
  assert.equal(persisted?.status, "completed");
  assert.deepEqual(persisted.args, args);
  assert.deepEqual(
    normalizeWaveResults(persisted.result),
    normalizeWaveResults([expected]),
  );
  assert.equal(persisted.maxAgents, 1);
  assert.equal(persisted.concurrency, 1);
  console.log(
    "PASS: WorkflowManager executes the real single-ticket script with one fake agent and persists identity, result, and limits",
  );

  const interrupted = manager.startInBackground(
    `
export const meta = { name: 'offline-resume', description: 'Journal recovery', phases: [{ title: 'Build' }] };
phase('Build');
const prepared = await agent('prepare', { label: 'prepare', model: 'offline-model' });
const finished = await agent('finish', { label: 'finish', model: 'offline-model' });
return [prepared, finished];
`,
    args,
    { maxAgents: 2, concurrency: 1, agentRetries: 0 },
  );
  const settled = interrupted.promise.catch(() => undefined);
  await Promise.race([finishEntered, settled]);
  assert.equal(manager.pause(interrupted.runId), true);
  await settled;
  const paused = manager
    .listAllRuns()
    .find((run) => run.runId === interrupted.runId);
  assert.equal(paused?.status, "paused");
  assert.deepEqual(paused.journal?.[0].result, { prepared: true });
  console.log(
    "PASS: pausing a real WorkflowManager preserves the completed prefix before releasing execution",
  );

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      started.runId,
      interrupted.runId,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(
    child.stdout.includes("PASS: a separate Node process"),
    "recovery child did not execute its checks",
  );
  process.stdout.write(child.stdout);
}
