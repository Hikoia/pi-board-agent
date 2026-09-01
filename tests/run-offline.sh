#!/usr/bin/env bash
# tests/run-offline.sh
# Simplified offline test — runs TypeScript modules via node --import tsx and
# counts PASS/FAIL lines from their stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEN_DIR="$SCRIPT_DIR/gen"
mkdir -p "$GEN_DIR"
trap 'rm -rf /tmp/pi-board-agent-test-*; true' EXIT

PASS=0
FAIL=0

pass_line() { echo "  PASS  ${1#PASS: }"; PASS=$((PASS+1)); }
fail_line() { echo "  FAIL  ${1#FAIL: }"; FAIL=$((FAIL+1)); }

run_ts() {
  local file="$1"
  local out
  out="$(cd "$ROOT" && node --import tsx "$file" 2>&1)" || { echo "        [node error]"; fail_line "node crashed"; echo "$out"; return; }
  while IFS= read -r line; do
    case "$line" in
      PASS:*) pass_line "$line" ;;
      FAIL:*) fail_line "$line" ;;
      LOOP:*|"") ;;
      *)
        if [[ -n "$line" ]]; then
          echo "        $line"
        fi
        ;;
    esac
  done <<< "$out"
}

echo "== pi-board-agent: offline tests =="
echo

# ---- 1. Config ----
echo "--- config ---"

cat >"$GEN_DIR/test-config.ts" <<'ENDTS'
import { _DEFAULTS, loadConfig, validateConfig, ConfigError } from "../../src/config.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.env.TMP_DIR!;
const dotpi = resolve(cwd, ".pi");
mkdirSync(dotpi, { recursive: true });
const cfg = loadConfig(cwd);
if (cfg.max_workers === 2) console.log("PASS: defaults max_workers=2");
else console.log("FAIL: defaults max_workers != 2");
if (cfg.columns.ready === "Ready") console.log("PASS: defaults columns.ready=Ready");
else console.log("FAIL: defaults columns.ready != Ready");
if (!cfg.review.enabled && cfg.models.review === "deepseek-v4-flash-0731") console.log("PASS: AI review defaults disabled with model");
else console.log("FAIL: AI review defaults");

writeFileSync(resolve(dotpi, "board-agent.yml"), "max_workers: 4\ncolumns:\n  ready: Dev-Ready\n");
const cfg2 = loadConfig(cwd);
if (cfg2.max_workers === 4) console.log("PASS: overridden max_workers=4");
else console.log("FAIL: overridden max_workers != 4");
if (cfg2.columns.ready === "Dev-Ready") console.log("PASS: overridden columns.ready=Dev-Ready");
else console.log("FAIL: overridden columns.ready != Dev-Ready");

try { validateConfig({ ...cfg, project: { owner: "", number: 0 } }); console.log("FAIL: validateConfig accepted 0"); }
catch(e) { if (e instanceof ConfigError) console.log("PASS: validateConfig rejects number=0"); else console.log("FAIL: wrong error type"); }
try { validateConfig({ ...cfg, max_workers: 20 }); console.log("FAIL: validateConfig accepted max_workers=20"); }
catch(e) { if (e instanceof ConfigError) console.log("PASS: validateConfig rejects max_workers>16"); else console.log("FAIL: wrong error type"); }
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-config.ts"
echo

# ---- 2. Inflight ----
echo "--- inflight ---"

cat >"$GEN_DIR/test-inflight.ts" <<'ENDTS'
import { Inflight } from "../../src/inflight.js";
const cwd = process.env.TMP_DIR!;
const inf = new Inflight(cwd);
const rec = { itemId: "PVTI_abc", issueNumber: 42, cardTitle: "Test", plan: "test-plan", taskBranch: "task/test", planBranch: "plan/test", startedAt: Date.now() };

inf.write(rec);
if (inf.has("PVTI_abc")) console.log("PASS: inflight has item");
else console.log("FAIL: inflight has item");

const r = inf.read("PVTI_abc");
if (r?.cardTitle === "Test") console.log("PASS: inflight read cardTitle=Test");
else console.log("FAIL: inflight read cardTitle != Test");

const all = inf.list();
if (all.length === 1) console.log("PASS: inflight list length=1");
else console.log("FAIL: inflight list length != 1");

const byPlan = inf.listByPlan("test-plan");
if (byPlan.length === 1) console.log("PASS: inflight listByPlan length=1");
else console.log("FAIL: inflight listByPlan length != 1");

inf.clear("PVTI_abc");
if (!inf.has("PVTI_abc")) console.log("PASS: inflight clear removes item");
else console.log("FAIL: inflight clear did not remove");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-inflight.ts"
echo

# ---- 3. Plan summary ----
echo "--- plan summary ---"

cat >"$GEN_DIR/test-plan.ts" <<'ENDTS'
import { summarizePlans, isPlanComplete } from "../../src/plan.js";
import { loadConfig } from "../../src/config.js";
const cfg = loadConfig(process.env.TMP_DIR!);
const cards = [
  { itemId: "1", title: "T001", body: "", status: "Done", plan: "001-auth", assignees: [""], closed: false },
  { itemId: "2", title: "T002", body: "", status: "Done", plan: "001-auth", assignees: [""], closed: false },
  { itemId: "3", title: "T003", body: "", status: "Ready", plan: "001-auth", assignees: [""], closed: false },
  { itemId: "4", title: "T004", body: "", status: "Ready", plan: "002-dashboard", assignees: [""], closed: false },
  { itemId: "5", title: "T005", body: "", status: "In Progress", plan: "002-dashboard", assignees: [""], closed: false },
];
const plans = summarizePlans(cfg, cards as any);
if (plans.size === 2) console.log("PASS: 2 plans detected");
else console.log("FAIL: plans.size != 2");
const auth = plans.get("001-auth")!;
if (auth.totalCards === 3) console.log("PASS: auth totalCards=3");
else console.log("FAIL: auth totalCards != 3");
if (auth.doneCards === 2) console.log("PASS: auth doneCards=2");
else console.log("FAIL: auth doneCards != 2");
if (isPlanComplete(auth) === false) console.log("PASS: auth not complete (2/3)");
else console.log("FAIL: auth should NOT be complete");
const dash = plans.get("002-dashboard")!;
if (dash.readyCards === 1) console.log("PASS: dashboard readyCards=1");
else console.log("FAIL: dashboard readyCards != 1");
if (dash.buildingCards === 1) console.log("PASS: dashboard buildingCards=1");
else console.log("FAIL: dashboard buildingCards != 1");
auth.cards.forEach((c:any) => { c.status = "Done"; });
auth.doneCards = 3;
if (isPlanComplete(auth)) console.log("PASS: auth is complete when all Done");
else console.log("FAIL: auth should be complete");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-plan.ts"
echo

# ---- 4. Workflow prompt ----
echo "--- workflow prompt ---"

cat >"$GEN_DIR/test-wf.ts" <<'ENDTS'
import { renderWorkflowSource, buildTasksForWave, extractTaskKey } from "../../src/workflow-prompt.js";
import { loadConfig } from "../../src/config.js";
const cfg = loadConfig(process.env.TMP_DIR!);
const cards = [
  { itemId: "PVTI_1", number: 42, title: "[T001] Add login form", body: "Acceptance:\n- [ ] form renders\n- [ ] validates email", status: "Ready", plan: "001-auth", assignees: [""], closed: false, url: "", repoOwner: "org", repoName: "repo" },
  { itemId: "PVTI_2", number: 43, title: "[T002] Add auth middleware", body: "Protect /dashboard\n- [ ] 401 on unauthenticated", status: "Ready", plan: "001-auth", assignees: [""], closed: false, url: "", repoOwner: "org", repoName: "repo" },
];
if (extractTaskKey(cards[0] as any) === "T001") console.log("PASS: extractTaskKey T001");
else console.log("FAIL: extractTaskKey T001");
if (extractTaskKey(cards[1] as any) === "T002") console.log("PASS: extractTaskKey T002");
else console.log("FAIL: extractTaskKey T002");
const tasks = buildTasksForWave(cfg, "001-auth", cards as any);
if (tasks.length === 2) console.log("PASS: buildTasksForWave returns 2");
else console.log("FAIL: buildTasksForWave length != 2");
if (tasks[0].taskKey === "T001") console.log("PASS: task[0].taskKey=T001");
else console.log("FAIL: task[0].taskKey != T001");
if (tasks[1].taskBranch === "task/t002") console.log("PASS: task[1].taskBranch=task/t002");
else console.log("FAIL: task[1].taskBranch != task/t002");
const src = renderWorkflowSource({ cfg, planSlug: "001-auth", baseBranch: "main", tasks, skillName: "board-agent" });
if (src.includes("parallel(")) console.log("PASS: source contains parallel()");
else console.log("FAIL: source missing parallel()");
if (src.includes("isolation: 'worktree'")) console.log("PASS: source contains worktree isolation");
else console.log("FAIL: source missing worktree isolation");
if (src.includes("[T001] Add login form")) console.log("PASS: source embeds card title");
else console.log("FAIL: source missing card title");
if (src.includes("task_merge_strategy")) console.log("PASS: source embeds merge strategy");
else console.log("FAIL: source missing merge strategy");
if (src.includes("closes #' + (t.issueNumber")) console.log("PASS: source references issue number in commit instructions");
else console.log("FAIL: source missing issue reference");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-wf.ts"
echo

# ---- 5. Loop tick ----
echo "--- loop tick (dry-run) ---"

cat >"$GEN_DIR/test-loop.ts" <<'ENDTS'
import { createLoopState, BoardLoop, type LoopDeps } from "../../src/loop.js";
import { Inflight } from "../../src/inflight.js";
import { loadConfig } from "../../src/config.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const cwd = process.env.TMP_DIR!;
const dotpi = resolve(cwd, ".pi");
mkdirSync(dotpi, { recursive: true });
writeFileSync(resolve(dotpi, "board-agent.yml"), `project:\n  owner: "test"\n  number: 1\nmax_workers: 1\ntick_seconds: 9999\n`);
const cfg = loadConfig(cwd);
execSync("git init && git config user.email t@t && git config user.name t && git remote add origin https://github.com/test/repo.git && git checkout -b main && git commit --allow-empty -m init", { cwd, stdio: "ignore" });
const state = createLoopState();
const deps: LoopDeps = {
  cwd, cfg, repoOwner: "test", repoName: "repo", botLogin: "bot",
  meta: { projectId: "P", statusFieldId: "S", statusOptions: { Ready: "o1", "In Progress": "o2", Review: "o3", Done: "o4" } },
  callback: (msg) => void(0),
  dxRun: async () => "run-1",
  dxResult: async () => [{ taskKey: "T001", itemId: "c1", status: "success", branch: "t", commits: 1, summary: "ok" }],
};
const loop = new BoardLoop(deps, state, new Inflight(cwd));
loop.start();
if (state.running) console.log("PASS: loop.start sets running=true");
else console.log("FAIL: loop.start did not set running");
loop.stop();
if (!state.running) console.log("PASS: loop.stop clears running");
else console.log("FAIL: loop.stop did not clear running");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-loop.ts"
echo


# ---- 4. Dispatch (normalizeWaveResults) + workflow-prompt (model) ----
echo '--- dispatch ---'

cat >"$GEN_DIR/test-dispatch.ts" <<'ENDTS'
import { normalizeWaveResults } from "../../src/dispatch.js";
import { _DEFAULTS, type Config } from "../../src/config.js";
import { renderWorkflowSource, buildTasksForWave } from "../../src/workflow-prompt.js";

// normalizeWaveResults: happy path
const raw = [
  { taskKey: "T001", itemId: "PVTI_a", status: "success", branch: "task/t001", commits: 1, summary: "done" },
  { taskKey: "T002", itemId: "PVTI_b", status: "failure", error: "conflict" },
];
const out = normalizeWaveResults(raw);
if (out.length === 2 && out[0].status === "success" && out[0].branch === "task/t001") console.log("PASS: normalize happy path");
else console.log("FAIL: normalize happy path");
if (out[1].status === "failure" && out[1].error === "conflict") console.log("PASS: normalize failure keeps error");
else console.log("FAIL: normalize failure keeps error");

// normalizeWaveResults: defensive (nulls, malformed, non-array)
if (normalizeWaveResults(null).length === 0) console.log("PASS: normalize null -> []");
else console.log("FAIL: normalize null -> []");
if (normalizeWaveResults([null, { x: 1 }, { taskKey: "T3", itemId: "PVTI_c" }]).length === 1) console.log("PASS: normalize skips null/malformed");
else console.log("FAIL: normalize skips null/malformed");

// workflow-prompt: rendered script includes the configured builder model
const cfg: Config = { ..._DEFAULTS, models: { builder: "deepseek-v4-flash-0731", refine: "deepseek-v4-flash-0731", review: "deepseek-v4-flash-0731", watch: "deepseek-v4-flash-0731" } };
const card = { itemId: "PVTI_x", number: 12, title: "T001 Do the thing", body: "acceptance", status: "Ready", plan: "001-auth", closed: false };
const task = buildTasksForWave(cfg, "001-auth", [card])[0];
const script = renderWorkflowSource({ cfg, planSlug: "001-auth", baseBranch: "main", tasks: [task], skillName: "board-agent" });
if (script.includes("deepseek-v4-flash-0731")) console.log("PASS: workflow script embeds builder model");
else console.log("FAIL: workflow script embeds builder model");
if (script.includes("isolation: 'worktree'")) console.log("PASS: workflow script uses worktree isolation");
else console.log("FAIL: workflow script uses worktree isolation");
if (script.includes('"issueNumber":12')) {
  console.log("PASS: workflow payload embeds issue number");
} else {
  console.log("FAIL: workflow payload embeds issue number");
}
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-dispatch.ts"
echo

# ---- 5. Dispatch smoke (runWorkflow programmatic, no agents) ----
echo "--- dispatch smoke ---"

cat > "$GEN_DIR/test-dispatch-smoke.ts" <<'ENDTS'
import { runWorkflow } from "@quintinshaw/pi-dynamic-workflows";
const script = `
export const meta = { name: 'smoke', description: 'smoke', phases: [{ title: 'x' }] };
const results = [{ taskKey: 'T001', itemId: 'PVTI_a', status: 'success', branch: 'task/t001' }];
return results;
`;
const res = await runWorkflow(script, { cwd: process.cwd(), persistLogs: false });
const out = Array.isArray(res.result) ? res.result : [];
if (out.length === 1 && out[0].taskKey === "T001") console.log("PASS: runWorkflow smoke (programmatic dispatch works)");
else console.log("FAIL: runWorkflow smoke", JSON.stringify(res.result));
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-dispatch-smoke.ts"
echo

# ---- 6. Context digest (Phase B) ----
echo '--- context ---'

cat > "$GEN_DIR/test-context.ts" <<'ENDTS'
import { renderContext, generateContext } from "../../src/context.js";
import { _DEFAULTS, type Config } from "../../src/config.js";
import { renderWorkflowSource, buildTasksForWave } from "../../src/workflow-prompt.js";

// 1) renderContext on the pi-board-agent repo itself
const text = renderContext({ cwd: process.cwd(), maxChars: 40000, exclude: [] });
if (text.includes('Repo tree')) console.log('PASS: context has tree section');
else console.log('FAIL: context has tree section');
if (text.includes('Source files') && text.includes('dispatch.ts')) console.log('PASS: context lists source files');
else console.log('FAIL: context lists source files');
if (text.includes('Recent commits')) console.log('PASS: context has recent commits');
else console.log('FAIL: context has recent commits');

// 2) truncation
const small = renderContext({ cwd: process.cwd(), maxChars: 2000, exclude: [] });
if (small.length <= 2100 && small.includes('truncated')) console.log('PASS: context truncates at maxChars');
else console.log('FAIL: context truncates at maxChars');

// 3) cache: same hash -> same content, file written
const a = generateContext({ cwd: process.cwd(), maxChars: 40000, exclude: [] });
const b = generateContext({ cwd: process.cwd(), maxChars: 40000, exclude: [] });
if (a === b) console.log('PASS: context cache stable (hash-based)');
else console.log('FAIL: context cache stable');

// 4) workflow script embeds the context
const cfg: Config = { ..._DEFAULTS };
const card = { itemId: 'PVTI_x', number: 12, title: 'T001 Do the thing', body: 'acceptance', status: 'Ready', plan: '001-auth', closed: false };
const task = buildTasksForWave(cfg, '001-auth', [card])[0];
const withCtx = renderWorkflowSource({ cfg, planSlug: '001-auth', baseBranch: 'main', tasks: [task], skillName: 'board-agent', context: '## Repo tree\n- src/' });
if (withCtx.includes('REPO CONTEXT') && withCtx.includes('## Repo tree')) console.log('PASS: workflow embeds repo context');
else console.log('FAIL: workflow embeds repo context');
const withoutCtx = renderWorkflowSource({ cfg, planSlug: '001-auth', baseBranch: 'main', tasks: [task], skillName: 'board-agent' });
if (withoutCtx.includes('"context":null')) console.log('PASS: workflow payload context=null when absent');
else console.log('FAIL: workflow payload context=null when absent');
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-context.ts"
echo
# ---- 8. Watchdog (Phase D) ----
echo "--- watchdog ---"

cat > "$GEN_DIR/test-watchdog.ts" <<'ENDTS'
import { WatchdogStateStore } from "../../src/watchdog.js";
import { renderFixWorkflowSource, renderReplyWorkflowSource } from "../../src/watchdog.js";

// 1) state store
const cwd = process.env.TMP_DIR!;
const store = new WatchdogStateStore(cwd);
store.update(42, { fixAttempts: 1 });
store.update(42, { fixAttempts: 2, lastFixAtMs: 1234 });
const st = store.get(42);
if (st.fixAttempts === 2 && st.lastFixAtMs === 1234 && !st.needsHuman) console.log("PASS: watchdog state persists per-PR");
else console.log("FAIL: watchdog state persists per-PR");
if (store.get(999).fixAttempts === 0) console.log("PASS: watchdog state defaults for unknown PR");
else console.log("FAIL: watchdog state defaults for unknown PR");

// 2) fix workflow source embeds PR/branch/checks/model/context
const fix = renderFixWorkflowSource({
  prNumber: 42,
  repoOwner: "mancioshell",
  repoName: "pi-board-agent",
  headBranch: "plan/001-auth",
  failingChecks: ["pr-ci", "branch-ci"],
  contextDigest: "## Repo tree",
  model: "deepseek-v4-flash-0731",
  timeoutMs: 60000,
});
if (fix.includes('PR #42') && fix.includes('plan/001-auth') && fix.includes('pr-ci') && fix.includes('"repoOwner":"mancioshell"') && fix.includes('deepseek-v4-flash-0731')) console.log("PASS: fix workflow embeds PR/branch/checks/repo/model");
else console.log("FAIL: fix workflow embeds PR/branch/checks/repo/model");

// 3) reply workflow source
const reply = renderReplyWorkflowSource({
  prNumber: 7,
  mentionBody: "@board-bot what is the plan?",
  contextDigest: "ctx",
  model: "deepseek-v4-flash-0731",
  timeoutMs: 60000,
});
if (reply.includes("PR #7") && reply.includes("@board-bot what is the plan?") && reply.includes("reply")) console.log("PASS: reply workflow embeds mention + schema");
else console.log("FAIL: reply workflow embeds mention + schema");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-watchdog.ts"
echo

# ---- 9. Notify (Phase E) ----
echo "--- notify ---"

cat > "$GEN_DIR/test-notify.ts" <<'ENDTS'
import { mdToHtml } from "../../src/notify.js";
import { _DEFAULTS } from "../../src/config.js";

const html = mdToHtml("### Titolo\n- item one\n- item two\n**bold**\nplain <tag> & stuff");
if (html.includes("<b>Titolo</b>") && html.includes("• item one") && html.includes("<b>bold</b>") && html.includes("&lt;tag&gt; &amp;")) console.log("PASS: mdToHtml converts headers/bullets/bold/escape");
else console.log("FAIL: mdToHtml conversion", html);

if (_DEFAULTS.telegram.enabled && _DEFAULTS.telegram.bot_token_env === "TELEGRAM_BOT_TOKEN" && _DEFAULTS.telegram.chat_id_env === "TELEGRAM_CHAT_ID") console.log("PASS: telegram config defaults");
else console.log("FAIL: telegram config defaults");
if (_DEFAULTS.telegram.on.includes("needs_human") && _DEFAULTS.telegram.on.includes("pr_opened") && _DEFAULTS.telegram.on.includes("ci_fixed")) console.log("PASS: telegram default events");
else console.log("FAIL: telegram default events");
if (_DEFAULTS.auto_start === false) console.log("PASS: auto_start default false");
else console.log("FAIL: auto_start default false");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-notify.ts"
echo

# ---- 10. AI review gate ----
echo "--- AI review ---"

cat > "$GEN_DIR/test-review.ts" <<'ENDTS'
import { parseReviewOutput, renderReviewComment, renderReviewWorkflowSource } from "../../src/review.js";

const pass = parseReviewOutput({ verdict: "pass", summary: "Looks good", findings: [] });
if (pass?.verdict === "pass") console.log("PASS: parseReviewOutput pass");
else console.log("FAIL: parseReviewOutput pass");
const fail = parseReviewOutput({ verdict: "fail", summary: "Bug", findings: ["src/a.ts: missing guard"] });
if (fail?.findings.length === 1) console.log("PASS: parseReviewOutput fail with finding");
else console.log("FAIL: parseReviewOutput fail with finding");
if (parseReviewOutput({ verdict: "fail", summary: "Bug", findings: [] }) === null) console.log("PASS: fail verdict requires findings");
else console.log("FAIL: fail verdict requires findings");

const source = renderReviewWorkflowSource({
  cwd: process.cwd(),
  taskKey: "T001",
  title: "Add guard",
  body: "- [ ] rejects invalid input",
  issueNumber: 42,
  baseBranch: "main",
  planBranch: "plan/001-auth",
  taskBranch: "task/t001",
  model: "review-model",
  timeoutMs: 600000,
});
if (source.includes("review-model") && source.includes("task/t001") && source.includes("rejects invalid input") && source.includes("isolation: 'worktree'")) console.log("PASS: review workflow embeds task/model/schema");
else console.log("FAIL: review workflow embeds task/model/schema");
const comment = renderReviewComment(fail!);
if (comment.includes("AI review") && comment.includes("src/a.ts") && comment.includes("Ready")) console.log("PASS: review failure comment");
else console.log("FAIL: review failure comment");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-review.ts"
echo

# ---- summary ----
echo
echo "---"
if ((FAIL > 0)); then
  echo "pi-board-agent: ${FAIL} FAILED, ${PASS} passed"
  exit 1
else
  echo "pi-board-agent: ALL CHECKS PASSED (${PASS}/$((PASS+FAIL)))"
fi

# ---- 7. Refine phase (Phase C) ----
echo "--- refine ---"

cat > "$GEN_DIR/test-refine.ts" <<'ENDTS'
import { parseRefineOutput, renderRefineWorkflowSource, renderRefineComment, renderQuestionsComment, type RefineOutput } from "../../src/refine.js";

// 1) parseRefineOutput: happy path
const good = {
  goal: "Add password reset",
  impactedAreas: ["src/auth"],
  decisions: ["use Clerk API"],
  risks: ["rate limit"],
  openQuestions: [],
  tasks: [{ title: "Add form", acceptanceCriteria: ["validates email", "sends link"] }],
};
const parsed = parseRefineOutput(good);
if (parsed && parsed.tasks.length === 1 && parsed.tasks[0].acceptanceCriteria.length === 2) console.log("PASS: parseRefineOutput happy path");
else console.log("FAIL: parseRefineOutput happy path");

// 2) parseRefineOutput: defensive
if (parseRefineOutput(null) === null) console.log("PASS: parse null -> null");
else console.log("FAIL: parse null -> null");
if (parseRefineOutput({ goal: "x", tasks: "nope" }) && parseRefineOutput({ goal: "x", tasks: "nope" })!.tasks.length === 0) console.log("PASS: parse bad tasks -> []");
else console.log("FAIL: parse bad tasks -> []");
if (parseRefineOutput({ goal: 42 }) === null) console.log("PASS: parse non-string goal -> null");
else console.log("FAIL: parse non-string goal -> null");

// 3) cap tasks at 12
const many = { goal: "g", impactedAreas: [], decisions: [], risks: [], openQuestions: [], tasks: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, acceptanceCriteria: ["a"] })) };
const capped = parseRefineOutput(many)!;
if (capped.tasks.length === 12) console.log("PASS: parse caps tasks at 12");
else console.log("FAIL: parse caps tasks at 12");

// 4) refine workflow script embeds story + context + model
const script = renderRefineWorkflowSource({
  cwd: process.cwd(),
  storyTitle: "Add password reset",
  storyBody: "Users need to reset their password",
  extraContext: "",
  contextDigest: "## Repo tree\n- src/auth",
  model: "deepseek-v4-flash-0731",
  timeoutMs: 240000,
});
if (script.includes("Add password reset") && script.includes("## Repo tree") && script.includes("deepseek-v4-flash-0731") && script.includes("openQuestions")) console.log("PASS: refine workflow embeds story/context/model/schema");
else console.log("FAIL: refine workflow embeds story/context/model/schema");

// 5) comments renderers
const refine: RefineOutput = { goal: "g", impactedAreas: [], decisions: ["d1"], risks: [], openQuestions: ["q1?", "q2?"], tasks: [] };
const qc = renderQuestionsComment("001-auth", refine);
if (qc.includes("Needs Design") && qc.includes("1. q1?") && qc.includes("2. q2?")) console.log("PASS: questions comment lists open questions");
else console.log("FAIL: questions comment lists open questions");
const rc = renderRefineComment("001-auth", { ...refine, openQuestions: [] }, [{ number: 12, url: "http://x/12", taskKey: "T001" }]);
if (rc.includes("T001") && rc.includes("#12")) console.log("PASS: refine comment lists created tasks");
else console.log("FAIL: refine comment lists created tasks");
ENDTS
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-refine.ts"
echo

