# Reviewer 與 Builder 併行分析

> 分析基準：`b3857519f1eac1c239ee70698d7d35653252ca08`。本文假設「agent 上限 2」指 `.pi/board-agent.yml` 的 `max_workers: 2`。

## 結論

可以，而且不需要換 workflow 引擎、增加依賴或重做 executor。

最小且安全的做法是把 `max_workers` 改成 **builder + reviewer 的全域執行上限**，保留一條 reviewer lane：有 Review 卡且尚有容量時，先保留 1 個 slot，啟動其餘 builder，再等待 1 個 reviewer；review 結束後立即再補滿 builder slot。

因 builder 已透過 `WorkflowManager.startInBackground()` 背景執行，所以不需要 `Promise.all()` 或新的 queue。只要改變 `BoardLoop.tick()` 的排程順序，builder 與 reviewer 就能真正重疊。

## 現況為什麼浪費 slot

目前 `tick()` 的關鍵順序是：

1. reconcile 既有 builder。
2. `await processReviewCards(cards)`。
3. finalization / plan PR。
4. `slots = max_workers - executor.activeCount()`。
5. 啟動 Ready builders。

證據：

- Review 在 builder slot 計算前被同步等待：[`src/loop.ts#L393`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/loop.ts#L393)，builder slots 到 [`src/loop.ts#L436-L458`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/loop.ts#L436-L458) 才計算與填入。
- `processReviewCards()` 雖然 `.slice(0, cfg.max_workers)`，實際上是 `for...of` 內逐一 `await runReview()`，所以 reviewer **不是平行的**：[`src/loop.ts#L790-L861`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/loop.ts#L790-L861)。
- `runReview()` 直接 `await runWorkflow()`，會等 reviewer 完成才返回：[`src/review.ts#L101-L111`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/review.ts#L101-L111)。
- Builder 則使用 `startInBackground()`，啟動後立即返回：[`src/ticket-executor.ts#L170-L233`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/ticket-executor.ts#L170-L233)。上游 API 也明確寫著「Returns immediately」：[`workflow-manager.ts#L563-L571`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/workflow-manager.ts#L563-L571)。
- `activeCount()` 只掃描 ticket worktree 的 managed builder runs，不包含 reviewer：[`src/ticket-executor.ts#L1019-L1044`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/ticket-executor.ts#L1019-L1044)。README 與 config template 也把 `max_workers` 寫成 builder-only：[`README.md#L97`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/README.md#L97)、[`config-template.yml#L36-L37`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/config-template.yml#L36-L37)。

因此現在同時存在兩個相反問題：

| 狀態 | 現況 |
| --- | --- |
| 0 builder + 1 Review + Ready backlog | reviewer 單獨跑，另一個 slot 一直空到 review 結束 |
| `max_workers` 個 builder + 1 Review | reviewer 仍會啟動，實際 agent 數可達 `max_workers + 1` |
| 多張 Review 卡 | 一個 tick 內串行 review 最多 `max_workers` 張；最壞阻塞時間是 `max_workers × review.timeout_ms` |

換句話說，現在的 `max_workers` 既不是總 agent 上限，也沒有讓 reviewer batch 真正平行。

## 上游 workflow 引擎的限制範圍

`pi-dynamic-workflows` 支援平行 agent，但它的 limiter 是 **每個 top-level workflow run** 建立的：

- `runWorkflow()` 對每個 top-level run 建立 `SharedRuntime` 與 `createLimiter(concurrency)`；只有 nested `workflow()` 才傳入並共用同一個 `sharedRuntime`：[`workflow.ts#L474-L495`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/workflow.ts#L474-L495)。
- `WorkflowManager` 也把 resolved concurrency 傳給各 run：[`workflow-manager.ts#L751-L767`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/workflow-manager.ts#L751-L767)、[`workflow-manager.ts#L808-L824`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/workflow-manager.ts#L808-L824)。
- 本專案每個 builder run 已固定 `maxAgents: 1, concurrency: 1`：[`src/ticket-executor.ts#L979-L990`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/ticket-executor.ts#L979-L990)。Reviewer 是另一個獨立 `runWorkflow()`。

所以不能期待上游自動把「多個 ticket managers + 獨立 reviewer run」合併成全域 2-slot pool；board loop 必須自行分配容量。

截至 npm 最新的 `3.10.1`，官方 release 只列出 delivery ownership lock 修正，沒有 process-global concurrency scheduler：[v3.10.1 release](https://github.com/QuintinShaw/pi-dynamic-workflows/releases/tag/v3.10.1)。單純升級不會解決這個排程問題。

## 建議排程

維持一個 reviewer lane，並讓它與 builder 共用 `max_workers`：

```text
reconcile
finalize 已經關閉的 Done tickets / plan PR

available = max_workers - activeBuilders
reviewSlot = reviewPending && available > 0 ? 1 : 0

依序啟動 Ready builders，最多 available - reviewSlot 個
如果 reviewSlot == 1：同步等待一張 Review 卡的 reviewer
review 結束後重新讀 activeCount，再把 Ready builders 補到 max_workers
```

### `max_workers: 2`、1 Review、3 Ready 的時間線

```text
現況
  t0 ───────── reviewer R1 ─────────┐
                                     └─ builder B1 + B2

建議
  t0 ───────── reviewer R1 ─────────┐
  t0 ───────── builder B1 ──────────┼─ review 完成後立刻補 B2
```

第一個 builder 不再延後一整個 review 時間；review slot 釋放後也不必等下一個 tick。

### 容量規則

| Active builders | Pending review | `max_workers=2` 的動作 |
| ---: | ---: | --- |
| 0 | 是 | 1 reviewer + 1 new builder |
| 1 | 是 | 1 reviewer；既有 builder 繼續 |
| 2 | 是 | reviewer 等待，避免超過上限 |
| 0 | 否 | 2 new builders |
| 1 | 否 | 1 new builder |

Review 優先保留 1 slot，符合 pull/WIP 原則：只有明確容量才開始新工作。Kanban Guide 的原文要求控制 started-to-finished WIP，且「only when there is a clear signal that there is capacity」才 pull 新工作：[The Kanban Guide — Actively Managing Items](https://kanbanguides.org/the-kanban-guide/)。

## 安全性與競態

### 1. 不要直接把 review 丟成 detached promise

不要使用 `void this.processReviewCards(...)`。Reviewer 目前不是 durable `WorkflowManager` run；claim 的釋放依賴 `finally`，而 `BoardLoop.stop()` 會等待 `currentTick` 後才 shutdown builders 與釋放 owner lock：[`src/loop.ts#L313-L336`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/loop.ts#L313-L336)。

建議仍在 tick 內 `await` reviewer，只是先啟動背景 builder。這保留既有 shutdown、claim cleanup 與錯誤處理語意。

### 2. Control plane 串行，expensive agents 併行

不需要 `Promise.all([launchBuilder(), review()])`。Builder 的 `startInBackground()` 本來就立即返回；先完成 builder 的 GitHub claim/status mutation，再開始 reviewer claim，兩個 agent 仍會重疊，但 GitHub mutation 不必競跑。

GitHub 官方也建議為避免 secondary rate limits，API requests 應 serial 執行；大量 mutative requests 之間至少暫停一秒：[Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28#avoid-concurrent-requests)。本案不一定需要強制 sleep，但應避免為了 agent 併行而把 claim/status API 也平行化。

### 3. Worktree 可以安全分離

Builder 使用每-ticket persistent worktree，reviewer 要求 ephemeral `isolation: "worktree"`：[`src/review.ts#L66-L73`](https://github.com/Hikoia/pi-board-agent/blob/b3857519f1eac1c239ee70698d7d35653252ca08/src/review.ts#L66-L73)。Git 官方明確說一個 repository 可有多個 working trees 並同時 checkout 多個 branch：[git-worktree](https://git-scm.com/docs/git-worktree)。

仍應先完成既有 Done-ticket finalization，再開始新一輪 builder/reviewer 排程，避免 plan branch merge 與新 task branch 準備重疊。

## 最小實作範圍

1. **`src/loop.ts`**
   - 把 Review 從 builder admission 之前移到 finalization 之後的共用 slot 排程。
   - 有可處理 Review 且有容量時保留 1 slot。
   - 先啟動其餘 builder，再 `await` 一張 Review。
   - Review 完成後以 `activeCount()` 再補 builder。
   - 每 tick 最多啟動 1 個 reviewer；不要再用 `max_workers` 當「串行 review batch 大小」。
2. **`src/index.ts`**
   - Widget 顯示 `(active builders + reviewing ? 1 : 0) / max_workers`，避免目前的 `2/2 active + reviewing` 誤導。
3. **`README.md`、`config-template.yml`、`docs/architecture.md`**
   - 把 `max_workers` 定義改為 builder + reviewer 的全域上限。
4. **`tests/run-offline.sh`**
   - 加一個最小排程回歸檢查。

不需修改 `review.ts`、`ticket-executor.ts`、workflow schema、worktree 格式或 `pi-dynamic-workflows`。

## 必測案例

1. `M=2, activeBuilder=0, reviews=1, ready=3`：review 尚未完成前只啟動 1 builder；總 agent=2；review 完成後補第 2 builder。
2. `M=2, activeBuilder=1, reviews=1`：不再啟動 builder；review + 既有 builder=2。
3. `M=2, activeBuilder=2, reviews=1`：本 tick 不啟動 reviewer；不得出現 3 agents。
4. 無 Review：維持原本 builder 填滿行為。
5. Review claim 失敗：立即把保留 slot 還給 builder，不等下一 tick。
6. `/board-agent stop`：仍等待 current reviewer，沒有 detached review 留在 owner lock 釋放後執行。

## 不建議的替代方案

- **把 builder 與 reviewer 包進一個大型 `parallel()` workflow**：會破壞目前每-ticket durable manager、journal、lease 與 recovery 邊界。
- **新增 `max_builders` / `max_reviewers` / queue class**：目前只有一個 reviewer lane 的需求，新增設定與抽象沒有必要。
- **直接 `Promise.all()`**：容量保留、claim 失敗回補、GitHub mutation 順序與 shutdown 都更難正確。
- **只升級 `pi-dynamic-workflows`**：上游 limiter 不是跨獨立 top-level runs 的 board-global pool。

最短正確路徑是：**不改 workflow 引擎，只改 `BoardLoop` 的 slot accounting 與順序。**
