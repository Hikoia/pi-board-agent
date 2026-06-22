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

cat >"$GEN_DIR/test-config.cts" <<'ENDTS'
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
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-config.cts"
echo

# ---- 2. Inflight ----
echo "--- inflight ---"

cat >"$GEN_DIR/test-inflight.cts" <<'ENDTS'
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
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-inflight.cts"
echo

# ---- 3. Plan summary ----
echo "--- plan summary ---"

cat >"$GEN_DIR/test-plan.cts" <<'ENDTS'
import { summarizePlans, isPlanComplete } from "../../src/plan.js";
import { loadConfig } from "../../src/config.js";
const cfg = loadConfig(process.env.TMP_DIR!);
const cards = [
  { itemId: "1", title: "T001", body: "", status: "Done", plan: "001-auth", assignees: [""], closed: false },
  { itemId: "2", title: "T002", body: "", status: "Done", plan: "001-auth", assignees: [""], closed: false },
  { itemId: "3", title: "T003", body: "", status: "Ready", plan: "001-auth", assignees: [""], closed: false },
  { itemId: "4", title: "T004", body: "", status: "Ready", plan: "002-dashboard", assignees: [""], closed: false },
  { itemId: "5", title: "T005", body: "", status: "Building", plan: "002-dashboard", assignees: [""], closed: false },
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
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-plan.cts"
echo

# ---- 4. Workflow prompt ----
echo "--- workflow prompt ---"

cat >"$GEN_DIR/test-wf.cts" <<'ENDTS'
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
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-wf.cts"
echo

# ---- 5. Loop tick ----
echo "--- loop tick (dry-run) ---"

cat >"$GEN_DIR/test-loop.cts" <<'ENDTS'
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
  meta: { projectId: "P", statusFieldId: "S", statusOptions: { Ready: "o1", Building: "o2", Review: "o3", Done: "o4" } },
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
TMP_DIR="$(mktemp -d)" run_ts "$GEN_DIR/test-loop.cts"
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