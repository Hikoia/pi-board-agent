// Exercise the installed workflow AND Pi SDK tool collection, not a mocked
// WorkflowAgent.run or a source-text policy check. No provider is ever called.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";

const cwd = process.env.TMP_DIR!;
assert.ok(cwd, "Run via bash tests/run-offline.sh");
const workflowEntry = import.meta.resolve("@quintinshaw/pi-dynamic-workflows");
assert.equal(JSON.parse(readFileSync(new URL("../package.json", workflowEntry), "utf8")).version, "3.10.0");
const globals = globalThis as typeof globalThis & { __designSession?: typeof sdk.createAgentSession };
const effective: string[][] = [];
let prompts = 0;
let output: Record<string, unknown> | undefined;
let receivedPolicy: unknown;
globals.__designSession = async (options) => {
  // Keep the real SDK's built-in/custom-tool merge and activation policy.
  const result = await sdk.createAgentSession(options);
  const { session } = result;
  session.prompt = async () => {
    prompts++;
    effective.push(session.agent.state.tools.map((tool) => tool.name).sort());
    if (output) {
      const tool = session.agent.state.tools.find((tool) => tool.name === "structured_output");
      assert.ok(tool, "upstream schema tool is active");
      const result = await tool.execute("offline-output", output);
      assert.deepEqual(result.details, output);
    }
    // No call to the real prompt method: no paid model, network, or tool I/O.
  };
  return result;
};
const shim = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
export const createAgentSession = globalThis.__designSession;
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent" && context.parentURL === new URL("agent.js", workflowEntry).href)
      return { url: shim, shortCircuit: true };
    return next(specifier, context);
  },
});
try {
  const { runWorkflow, WorkflowAgent } = await import("@quintinshaw/pi-dynamic-workflows");
  const { runRefine, runDesign } = await import("../src/refine.js");
  const original = WorkflowAgent.prototype.run;
  // Observe registry routing without substituting its implementation.
  WorkflowAgent.prototype.run = function (prompt, options) {
    receivedPolicy = options?.toolNames;
    return original.bind(this)(prompt, options);
  };
  try {
    const model = "anthropic/claude-sonnet-4-5";
    // Control: shows this seam can detect coding tools with the SDK defaults.
    output = { ok: true };
    await runWorkflow(`export const meta = { name: 'control', description: 'offline tools control' };
return await agent('context only; never edit code', { model: '${model}', toolNames: [], schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });`, {
      cwd, persistLogs: false, agentRegistry: new Map(),
    });
    for (const tool of ["read", "write", "edit", "bash"])
      assert.ok(effective.at(-1)!.includes(tool), `control detects ${tool}`);
    assert.equal(receivedPolicy, undefined, "inline DSL toolNames is not permission policy");
    console.log(`PASS: installed 3.10.0 + real SDK control exposes ${effective.at(-1)!.join(", ")} despite prompt/inline toolNames`);

    // Neither project nor user Markdown definitions may broaden private roles.
    for (const dir of [join(cwd, ".pi", "agents"), join(process.env.PI_CODING_AGENT_DIR!, "agents")]) {
      mkdirSync(dir, { recursive: true });
      for (const name of ["board-agent-refine", "board-agent-design"])
        writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ntools: read,write,edit,bash\n---\nUse coding tools.\n`);
    }
    const refineOutput = { goal: "Ship", impactedAreas: [], decisions: [], risks: [], openQuestions: [], tasks: [{ title: "Change", acceptanceCriteria: ["verified"] }] };
    const designOutput = { body: "Complete contract", summary: "Clarified", openQuestions: [] };
    const refine = () => runRefine({ cwd, storyTitle: "Story", storyBody: "requirements", maxTasks: 2, extraContext: "", contextDigest: "provided", model, timeoutMs: 60_000 });
    const design = () => runDesign({ cwd, title: "Task", body: "requirements", trustedComments: [], contextDigest: "provided", model, timeoutMs: 60_000 });
    for (const [label, run, value] of [["refine", refine, refineOutput], ["design", design, designOutput]] as const) {
      const before = prompts;
      output = value;
      assert.deepEqual(await run(), value);
      assert.equal(prompts, before + 1);
      assert.deepEqual(receivedPolicy, [], `${label}: named private registry supplies an empty allowlist`);
      assert.deepEqual(effective.at(-1), ["structured_output"], `${label}: final SDK tools exclude ALL coding tools`);
      console.log(`PASS: ${label} effective SDK tools: ${effective.at(-1)!.join(", ")}; private policy resists local/global shadowing and structured output works`);
    }
    output = undefined; // Invalid/no output: use the real upstream resolution path.
    const before = prompts;
    await assert.rejects(refine(), /structured_output/);
    assert.equal(prompts, before + 1, "T02: zero automatic schema repair prompts");
    console.log("PASS: actual upstream refine schema failure makes exactly one offline prompt, with zero repair turns");
  } finally {
    WorkflowAgent.prototype.run = original;
  }
} finally {
  hooks.deregister();
  delete globals.__designSession;
}
