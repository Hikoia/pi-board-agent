# 架構與執行流程優化分析（不增加框架）

> Historical report at the baseline below, not current guidance. See [current architecture](architecture.md) and [operator runbook](runbook.md).

> 基準：`f1140ccd8d1eda9820dce520c8405a2309e104a3`，package `0.2.0`。  
> 本次環境：Windows、Node `22.23.2`；lockfile 與實際安裝的 pi-dynamic-workflows 均為 `3.10.0`，專案內 Pi 為 `0.84.4`。  
> 方法：追讀入口、輪詢、builder recovery、Story journal、review、finalization、GitHub/process adapter，對照線上一手文件；沒有啟動真實 agent、操作線上 Project、推送或合併分支。只新增本報告，未修改程式碼。

## 結論

**保留現在的骨架；修正狀態交接，縮短控制流程，刪掉不生效的設定。不要重寫成另一套 workflow engine。**

目前的 `BoardLoop → TicketExecutor → TicketWorktrees / WorkflowManager` 分工合理。主要改善空間不是少一層 class，而是：

1. 失敗或缺失的遠端觀測，不應被當成成功／舊資料繼續使用。
2. Story 拆票必須符合實際排程能力，不能用截斷方式控制需求數量。
3. 前景模型與同步 Git 阻塞控制流程；既有 async runner 應先被利用。
4. 已完成卡片不應永遠產生逐卡遠端查詢。
5. 停止、工具權限、Plan 欄位與 context digest 應有明確且一致的契約。

原始碼約 10,044 行、20 個檔案；測試約 9,866 行、23 個檔案。**這些數字不是過度設計的證据，也不應設定任意減行目標。**

`overengineering-audit.md` 與 `review-builder-concurrency-analysis.md` 是舊基準的歷史報告。本版已具備 closed-Done finalizer、review 隔離、Story journal、防重複建立、deadline runner，以及 builder/reviewer 共用容量；不再把它們列為未完成工作。

## 1. 實際流程與狀態權責

```text
session_start / /board-agent run
  → revision / unsupported-state / config / GitHub metadata
  → owner.lock
  → BoardLoop.tick
      → 全板 listCards
      → reconcile 既有 builder
      → finalize closed Done
      → admission / clean gate
      → 等待 Needs Design Task
      → 等待 Story refine / creation
      → 等待 watchdog 全輪
      → 保留 review slot，啟動其他 Ready builder
      → 等待一個 reviewer，再補 builder slot

Ready Task
  → fresh read → claim → fresh read
  → persistent worktree → launchingAt → In Progress
  → durable WorkflowManager → activeRunId
  → 結果結算 → Review → Done
  → 人工 close → local branch 整合到 fresh origin/base → 驗證 → cleanup
```

來源：[`loop.ts:575–679`](../src/loop.ts#L575-L679)、[`ticket-executor.ts:889–1077`](../src/ticket-executor.ts#L889-L1077)。

| 資料 | 應負責的事 |
| --- | --- |
| GitHub Project／Issue | 需求、欄位狀態、人工批准 |
| ticket record | ticket 與 worktree／run 的關聯、launch recovery 證据 |
| WorkflowManager journal | agent run 狀態、結果、恢復與 lease |
| Git refs／worktrees | 實際程式碼與是否仍待整合 |
| runtime/widget/context | 可重建的觀測或提示，不是授權來源 |

這不是四套重複資料庫。它們描述不同事實。應修的是**交接契約**，不是把它們塞進新的資料庫或通用狀態機。

## 2. 優先修：遠端失敗不能被吃掉，也不能回退到舊快照

### 2.1 release 的 production adapter 隱藏了錯誤

[`gh.ts:621–632`](../src/gh.ts#L621-L632) 的 `release()` 最後是：

```ts
await runGh([...]).catch(() => undefined);
```

但 executor 的結算流程是「comment → status → release → clearExecution」：[`ticket-executor.ts:314–374`](../src/ticket-executor.ts#L314-L374)。因此解除 assignee 失敗時，上層仍會清除 execution association，以為整個結算已完成。上層已有的 release warning 也收不到錯誤。

**已重現：**使用真正的 `release/runGh/process-runner`，替換為只會 exit 1 的離線假 gh，呼叫者仍觀察到成功。

最小修法：

- 讓 `release()` 拋出錯誤；需要 best-effort 的 caller 自己 catch 並顯示警告。
- executor 保留未結算的關聯；若上一輪已成功寫入 Review，重試應補完 release／clear，不重跑 builder。
- 不新增 retry framework；也不要自動重播無法確認結果的 create/comment。

### 2.2 reconcile 把「剛確認不存在」改成「沿用舊資料」

[`ticket-executor.ts:756`](../src/ticket-executor.ts#L756) 與 [`806`](../src/ticket-executor.ts#L806) 使用：

```ts
(await board.getCard(itemId)) ?? snapshot
```

`getCard()` 的 `undefined` 表示 Project item 不存在，並不是可使用快取的訊號。這裡與 `BoardLoop.currentCard()`／finalizer 的 fail-closed 原則不一致。

**已重現：**全板快照含 In Progress ticket、隨後 fresh read 回傳 undefined、持久化 run 已完成；仍嘗試 comment、Review、release、clearExecution。這是離線 adapter 模擬，證明程式分支，不代表 GitHub 在每種 item 刪除情況都會接受後續 mutation。

最小修法：fresh 缺失就走既有 missing-card/orphan recovery，fresh 回來後重新驗證目標 Issue；禁止 snapshot 授權 mutation。snapshot 可以顯示給 UI，不能當寫入證据。

**必要檢查：**fresh item 消失／變成非目標類型；release 失敗後再次 reconcile。這兩個檢查比再加一個抽象 state-machine class 有價值。

## 3. Story 拆票：不要漏需求，也不要把排列當成依賴排程

### 3.1 `max_tasks` 目前會默默刪掉尾端任務

[`refine.ts:490–534`](../src/refine.ts#L490-L534) 以 `.slice(0, cfg.refine.max_tasks)` 建立 intents；prompt 卻固定要求 1–12 tasks，没有收到較小的 configured limit。

**已重現：**設定 `max_tasks: 2`，合法 refine output 包含 3 個 required tasks，creation plan 保留全部 refine output，卻只建立前 2 個 task intents，而且 validation 接受。後續 parent completion 依 journaled children 判斷，沒有要求第 3 個未建立任務完成。

最小修法：將 configured limit 傳入 prompt/schema；超限 fail closed 或請模型重新合併任務，**不可用 slice 丟需求**。不必新增 backlog database。

### 3.2 dependency-ordered 不等於可同時從 main 開工

- prompt 要求 dependency-ordered tasks：[`refine.ts:84–101`](../src/refine.ts#L84-L101)。
- child 都發布為 Ready：[`refine.ts:891–930`](../src/refine.ts#L891-L930)。
- builder selection 沒有 dependency gate：[`loop.ts:634–655`](../src/loop.ts#L634-L655)。
- 每個新 task 都從 fresh origin/base 建立：[`ticket-worktree.ts:573–650`](../src/ticket-worktree.ts#L573-L650)。

如果 T2 要用 T1 的新介面，T1 在 Review 或 Done 但尚未人工 close／整合時，T2 的 worktree 看不到那份程式。**即使 `max_workers: 1`，也不等於前置任務已經合併。**

最小方向：優先要求每張 Ready task 可以獨立從 base 實作與驗收；緊耦合工作合併成一票。有真實依賴的後續票，人工留在 Backlog，等前置已整合再移 Ready。只有實際需要大量自動依賴管理時，才討論 `dependsOn`，現在不建 DAG scheduler。[S1]

## 4. 純設計 agent 不應拿 coding tools 在主 checkout 執行

[`runRefine()`](../src/refine.ts#L196-L208) 與 [`runDesign()`](../src/refine.ts#L313-L324) 直接在主 cwd 呼叫 `runWorkflow()`，沒有 private agent definition／tool allowlist。這些 agent 的任務是從已提供的 contract 和 context 產生 JSON。

核對 **實際安裝版本 3.10.0** 的上游：`WorkflowAgent` 預設使用 `createCodingTools()`；工具政策透過 named agent definition 的 `tools` 傳入。prompt 寫「never edit code」不是執行權限限制。（來源 S2、S3）

最小修法：沿用本專案 [`watchdog.ts:267–290`](../src/watchdog.ts#L267-L290) 的 private registry 模式，refine/design 用 `tools: []`，schema output 工具仍由上游提供。若確實需要讀程式，再明確給最小 read-only allowlist。

不新增 sandbox、不換 SDK、不加 YAML agent registry。這是在既有 seam 上收緊權限，不是重造 agent 系統。此項是由程式與上游預設確認的權限缺口；本次沒有執行惡意 prompt 或宣稱已發生入侵。

## 5. 最有把握的效能改善：減少熱路徑同步 Git

`runProcessSync()` 不是 async：它在主執行緒呼叫 `Atomics.wait()`，worker 只負責 deadline 與子程序 supervision：[`process-runner.ts:455–521`](../src/process-runner.ts#L455-L521)。Windows 每次還會啟動 PowerShell 與 `Add-Type` Job Object bridge。

本機微量測（不是 production benchmark／p95）：

| 檢查 | 結果 |
| --- | --- |
| 3 次本機 `git rev-parse --is-inside-work-tree`，經 sync runner | 810、548、565 ms |
| 20ms timer 同時遇到 sync runner 的 300ms Node 子程序 | timer 到 882ms 才執行 |
| 相同 300ms 子程序改用既有 async `runProcess` | timer 24ms 執行；程序總耗時 959ms |

**非同步不代表 Git 變快；它避免 Pi UI、agent 串流與其他控制回呼一起停住。**Node 文件也明確區分阻塞與非阻塞子程序呼叫。[S4]

目前熱路徑還包含：

- `revisionAllowsNewWork → currentRevision → inspectPackageCheckout`：反覆 sync Git HEAD/status。
- `saveRuntime → findUnsupportedState + ownerLockHeldByOther`：再次探測 repo root。
- `updateWidget → inspectTicketExecutions → new TicketWorktrees`：通知時又做 sync Git 與磁碟掃描。
- finalization／review setup 有多個可能遇到網路的同步 Git。

來源：[`index.ts:108–126`](../src/index.ts#L108-L126)、[`210–258`](../src/index.ts#L210-L258)、[`runtime.ts:177–245`](../src/runtime.ts#L177-L245)、[`ticket-worktree.ts:654–805`](../src/ticket-worktree.ts#L654-L805)。

最小順序：

1. repo root 等同一 owner 生命週期內不變的資料，啟動時計算並傳入，避免每次 heartbeat／widget 重做。
2. widget 使用 executor/reconcile 的觀測結果，不在每次 notify 都建立 worktree store；顯示資料的短暫陳舊不能影響 mutation gate。
3. 先把 runtime network Git 的 caller 轉為使用**已有** `runProcess()`；函式依序 await，不必平行化 Git writes。
4. 保留原有 deadline、Job Object、process-tree containment。不要用裸 `execSync/spawn` 換取表面減行，也不要靠長 TTL 跳過安全重驗。

這會有局部 async signature 傳遞，但不需要 worker pool、native addon 或新依賴。先量測再考慮 supervisor 啟動成本的進一步優化。

## 6. 輪詢不要被歷史完成票拖慢

每次 tick 對所有 closed Done Task 呼叫 `finalizeClosed()`；它**先** fresh GitHub read，**後**才由 `finalizeAccepted()` 判定 local task branch 不存在。

來源：[`loop.ts:1296–1312`](../src/loop.ts#L1296-L1312)、[`ticket-executor.ts:1035–1065`](../src/ticket-executor.ts#L1035-L1065)。

**已重現：**30 次「local branch 不存在」的 finalization 檢查，仍觸發 30 次 fresh board reads。這個 probe 重複同一輸入，只量測每次呼叫的成本；程式的逐卡迴圈使 D 張符合條件的歷史票產生 D 次讀取。

若有 D 張歷史完成票，每 tick 至少多 D 次 `getCard`，另有全板分頁和仍保留 record 的 reconcile。預設 90 秒 tick 下，100 張歷史票是每完整 tick 多 100 次讀取；**不是**宣稱一定能跑完 40 ticks/h，也不能把 request 數直接當 GraphQL primary points。[S5]

最小修法：

- 先一次讀取本機 task refs 做**否定篩選**；沒有 local branch 就跳過。
- 有 branch 才 fresh GitHub revalidate，真正 finalize 時仍重讀 ref、確認批准與安全條件。
- 本機 refs 查詢失敗要報錯，不得當作全部不存在。
- 不建 completed-ticket table、不新增已完成狀態；沿用目前 local branch presence 的 completion signal。

全板 payload、field hydration、REST conditional GET 可以之後量測再改。GitHub 建議精簡 polling、序列 mutation、遵守 rate-limit backoff；但 REST ETag/304 不能直接套到這裡的 GraphQL POST。也不需要為單一桌面插件立即部署 webhook server。（來源 S5、S6）

## 7. 長任務不應壟斷 admission；stop 必須共享真正的完成狀態

### 排程

雖然 builder/reviewer 已能重疊，Ready builder 仍排在 Task design、Story、watchdog **全部 await 完成之後**。watchdog 更會串行走訪多個 PR；它不檢查 `executor.activeCount()`，文件也把它定義成額外 maintenance lane。

來源：[`loop.ts:599–679`](../src/loop.ts#L599-L679)、[`watchdog.ts:497–524`](../src/watchdog.ts#L497-L524)、[`604–622`](../src/watchdog.ts#L604-L622)。

這不是「Promise.all 加上去」能安全解決的問題。最小演進是沿用現有 reserve-slot 模式：**先保留 foreground 所需的 1 slot，填入其他 builder，再 await foreground action**。watchdog 的 agent 工作移到尾端，且沒有餘裕就延後；不要為它加第二套 timer。

如果 `max_workers` 要代表總模型上限，watchdog 也應計入；如果刻意保留 maintenance 例外，就明說最多會超過 builder/refine/review 上限 1 個，而非默默讓使用者誤判。這是明確化現有取捨，不是要求新的 semaphore framework。

### 停止

- `BoardLoop.stop()` 一開始就 `stopped = true`，第二次呼叫直接 return：[`loop.ts:500–515`](../src/loop.ts#L500-L515)。
- command／session shutdown 在 drain 完成前先把 module-level `loop = null`：[`index.ts:570–596`](../src/index.ts#L570-L596)、[`615–638`](../src/index.ts#L615-L638)。
- 前景 refine/review 沒有接 loop 的 AbortSignal，只能等模型自行完成或 timeout；上游 `runWorkflow({ signal })` 已支援取消。[S3]

**已重現：**第一次 stop 正在等待 shutdown，第二次 stop 已 resolve，但 manager 尚未 drain、owner lock 尚未 release。單次 stop 保留 lock 的既有測試是通過的；缺口是重入／session teardown 的完成語意。

最小修法：stop 使用一個共用 promise；完成前保留 loop 引用，成功後才清引用並顯示 stopped。drain 失敗保留可重试 manager／ownership 證据。先只把 loop-owned AbortSignal 傳給前景 LLM，abort 後仍 await finally cleanup；不要把破壞性 Git finalization 任意打斷後立刻 unlock，也不要 detached review promise。

## 8. 第二批：低成本修正契約，避免額外探索或人工排障

### Plan 欄位型別應在 preflight 說清楚

README 支援 text 或 single-select Plan，但 Story child creation 在需要寫 Plan 時固定走 `ops.setText`：[`refine.ts:891–900`](../src/refine.ts#L891-L900)。GitHub 的 single-select 必須傳 option ID，而不是 text。[S7]

`getProjectMetadata()` 容許 Plan／Type metadata 缺失，而 startup/lint 主要只 `validateStatusOptions()`；真正錯誤可能到建立部分 child 後才曝露。

最小處理：保留既有支援承諾時，使用已存在的 `meta.planOptions` 和 `setSingleSelect`，沒有選項就先報錯；不要自動擴充 Project schema。若決定只支援 text，則在 lint 明確拒絕 single-select，並更新文件，不能假裝支援。Story-enabled 的 Plan／Type 必要欄位檢查移到啟動／refine 前。

### builder context 應與它真正看到的 Git revision 一致

新 builder worktree 來自 fresh origin/base，但 context callback 讀取宿主 cwd：[`ticket-executor.ts:1184–1192`](../src/ticket-executor.ts#L1184-L1192)。cache key 只含該 cwd 的 HEAD 和設定：[`context.ts:276–302`](../src/context.ts#L276-L302)。finalizer 又刻意不改 main checkout。

所以遠端 base 已整合新功能、宿主 main HEAD 未移動時，新 builder 可能繼續收到舊摘要。prompt 卻說「use this instead of exploring the whole repo」。這是條件式、由流程推導的陳舊資料風險；本次沒有量測其實際 token 浪費。

最小方向：讓 builder context callback 接收 record.path，直接重用 `renderContext()` 讀實際 worktree；先不用新快取層。不要把生成檔寫入 ticket worktree 造成 dirty gate 問題。摘要定位改成導覽而非權威；真有重算成本再把 cache 留在宿主，key 對齊實際 revision。

### 可以刪減，但不要誤刪 recovery 證据

- `safety.skip_closed_issues` 僅有型別／預設／測試引用，沒有 production decision caller；closed Issue 在入口直接被排除。移除此無效開關並提供明確設定升級提示，不應因為它是 false 就讓 closed Issue 開工。
- `agents/board-agent-builder.md` 與 mission／skill 有重複說明，當前 production workflow 沒有使用此 agentType。先標示用途或確認無外部 caller 再刪，避免再增加第四份 builder 規則。
- 舊 audit 文件標示歷史基準即可，不必把它們當作目前架構規格餵給 builder。

## 9. 明確不建議現在做

- 不換 WorkflowManager、不做自己的 durable workflow engine。
- 不加入 Redis、資料庫、event sourcing、通用 saga、webhook server、分散式 lock。
- 不為每個 lane 建 service/interface/factory；TicketExecutor 的小介面已有實際 recovery 深度。
- 不因 `loop.ts` 超過千行就機械拆十個檔案。若之後 Story 協調持續修改，可把整段操作下沉至既有 refine module；不要留兩份編排責任。
- 不刪 owner lock、launch-window evidence、fresh claim checks、exact-SHA review、dirty guards、push verification。
- 不把 review 與 finalize 共用一個「worktree cleanup」：review 是可丟棄的副本，finalize 必須保留未整合工作。Git worktree 也不是權限 sandbox，refs 與 repository metadata 有共享部分。[S8]
- 不盲目把最新上游功能當成 3.10.0 已有；先依 lockfile 的實際版本驗證。
- 不為了看起來簡單而重寫全部測試框架。

## 10. 最小落地順序與驗證

| 批次 | 工作 | 最小驗證 |
| --- | --- | --- |
| 1：契約正確 | release 傳錯、fresh 缺失不 fallback、refine 不截斷、designer tools 收緊 | release 失敗重試；fresh 消失無 mutation；max_tasks 超限不丟需求；實際工具列表 |
| 2：操作穩定 | stop 共用 promise、LLM abort 後 cleanup、先填 builder slot、watchdog 低優先 | stop/stop/shutdown 重入；stop 後無新 agent；max_workers 邊界 |
| 3：可量測效率 | 減少 sync 熱路徑；local ref 否定篩選；context 對齊；Plan preflight | event-loop timer lag；每 tick gh 呼叫數；無 branch 不查遠端；新 base digest；single-select Plan |

只加幾個現有 callback／log 欄位即可量測：tick duration、各 lane duration、Git/gh 呼叫數、stop duration。先不引入 metrics 平台。測到哪個有問題，再調整哪個。

### 本次驗證結果

- `npm run typecheck`：通過。
- LSP：5 個主流程檔案沒有回報 diagnostic，但結果為 inconclusive，**不把它當成已證明 clean**。
- 既有 `tests/test-loop-lifecycle.ts`：3/3 checks 通過。
- repo 外的離線 characterization probes：5/5 成功重現本文的 truncation、stop 重入、fresh fallback、historical reads、release 吞錯。這些是確認目前行為，不是聲稱問題已修好。
- 全套 `tests/run-offline.sh`：在 900 秒執行期限內未完成，不能宣稱全套通過；測試子程序確認已結束。
- 微量測只適用本機環境；没有 production p95、API point usage、真實模型吞吐或 live GitHub E2E 的證据。

## 線上一手來源

- **[S1] Anthropic — Building effective agents**：先選最簡單方案；工作流提供可預測性，只有量測證明有效才增加 agent 複雜度。<https://www.anthropic.com/engineering/building-effective-agents>
- **[S2] pi-dynamic-workflows v3.10.0 `agent.ts`**：coding tools 預設、allowlist、schema output、abort。<https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/agent.ts>
- **[S3] pi-dynamic-workflows v3.10.0 `workflow.ts`**：`signal`、`agentRegistry`、`agentDef.tools` 傳遞。<https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/workflow.ts>
- **[S4] Node.js — Child process**：同步與非同步子程序的 event-loop 語意。<https://nodejs.org/api/child_process.html>；本專案 sync runner 本身則以 `Atomics.wait` 阻塞，非單纯 spawnSync。
- **[S5] GitHub — GraphQL rate limits**：primary/secondary limits、query cost、backoff 與精簡查詢。<https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api>
- **[S6] GitHub — REST best practices**：efficient polling、conditional GET、serial requests、mutation/backoff。<https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- **[S7] GitHub — Using the API to manage Projects**：text 與 single-select 的 mutation 差異。<https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects>
- **[S8] Git — git-worktree**：linked worktrees 與 shared repository/ref 語意。<https://git-scm.com/docs/git-worktree>

另已讀取本機 Pi 官方 README、完整 extensions/packages 文件與 extension 範例。核心生命周期原則是 session-scoped 資源在 session_start／命令開始，在 session_shutdown 完成清理；不能把模型 timeout 當成 shutdown completion。
