import { WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";
import { _DEFAULTS, type Config } from "../src/config.js";
import { renderWorkflowSource } from "../src/workflow-prompt.js";

const cwd = process.env.TMP_DIR!;
const cfg: Config = {
  ..._DEFAULTS,
  project: { owner: "test", number: 1 },
  context: { ..._DEFAULTS.context, enabled: false },
};
const agent = {
  async run() {
    return {
      taskKey: "T001",
      itemId: "PVTI_manager",
      status: "success",
      branch: "task/t001",
      commits: 1,
      summary: "fake-agent-ok",
    };
  },
} as any;
const script = renderWorkflowSource({
  cfg,
  planSlug: "demo",
  baseBranch: "main",
  skillName: "board-agent",
  tasks: [{
    itemId: "PVTI_manager",
    taskKey: "T001",
    issueNumber: 1,
    title: "Manager smoke",
    body: "Persist this result",
    taskBranch: "task/t001",
    planBranch: "plan/demo",
  }],
});
const args = { itemId: "PVTI_manager", issueNumber: 1, taskKey: "T001" };
const first = new WorkflowManager({ cwd, concurrency: 1, agent });
first.on("error", () => undefined);
const started = first.startInBackground(script, args, { maxAgents: 1, concurrency: 1 });
await started.promise;
const persisted = first.listAllRuns().find((run) => run.runId === started.runId);
const result = persisted?.result as Array<{ branch?: string }> | undefined;
if (persisted?.status === "completed" && result?.[0]?.branch === "task/t001") {
  console.log("PASS: WorkflowManager executes the real ticket script with an injected fake agent");
} else console.log("FAIL: WorkflowManager did not persist the generated ticket result");
const restarted = new WorkflowManager({ cwd, concurrency: 1, agent });
restarted.on("error", () => undefined);
const recovered = restarted.listAllRuns().find((run) => run.runId === started.runId);
if (recovered?.status === "completed" && (recovered.args as any)?.itemId === "PVTI_manager") {
  console.log("PASS: a new WorkflowManager process reads persisted args and result");
} else console.log("FAIL: WorkflowManager restart persistence");
