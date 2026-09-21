# Closed Issue → PR → 人工合併：實作方案

狀態：規劃，尚未實作。使用者已選擇「人工合併 PR」。

查核基準：本地 `21918074819ddef7caf3b69e48b202410368612f`，以及 GitHub 上 `Hikoia/lazypie` 的目前設定。

## 1. 已決定的行為

- 保留 `Done + Issue closed` 作為提交整合的觸發條件。
- Bot 準備 task 分支、建立或找回 PR、監看結果；**不合併 PR、不啟用 Auto-merge、不推送 main**。
- 人工在 GitHub 完成最後批准與合併，建議使用 **Squash and merge**。
- GitHub 負責必要檢查、審核與主線保護；Bot 不另做一套 CI 放行規則。
- 只有確認 PR 已合併、結果存在於遠端 base，且待刪除工作均已被涵蓋，才清理。
- 沿用原來的一個 Issue／task 分支／worktree，不新增整合分支、排程器、資料庫或依賴套件。
- 不保留 direct-push fallback，也不在遇到保護規則時自動降級或繞過。

這是明確的語意調整：**關閉 Issue 表示「提交 PR」；人工合併 PR 才表示「程式碼整合完成」。**

### 已查核的 lazypie 設定

- base：`main`；允許 squash 與 rebase。
- `main` 要求 PR、線性歷史，且保護規則適用管理員。
- 必要檢查採 strict 模式，PR 分支需跟上 base：
  - `Build and test`
  - `Supabase DB compatibility`
  - `Dependency audit`
- `.github/workflows/ci.yml`、`security.yml` 已有 `pull_request` 觸發。
- GitHub Auto-merge 關閉；本方案不需要開啟，也不修改現有保護設定。

## 2. 新流程

```text
Ready → Builder → AI Review → Done（Issue 仍開啟）
  → 人工驗證並關閉 Issue
  → Bot 準備並正常推送 task 分支
  → 建立／找回 task → main 的 PR
  → 等待 GitHub 檢查、人工處理與人工合併
  → Bot 確認 merged PR 與遠端合併結果
  → 刪 remote task ref → 移除 worktree → 刪 local task ref
  → 確認 Project Backlog → 最後刪除執行紀錄
```

PR 等待期間，Issue 維持 closed、Project 維持 Done，分支與 worktree 全部保留。

不改變 Issue／repository 身份檢查、active builder 排除、owner lock、停止與恢復規則。非 Task 的 closed Done Issue 仍可進入整合；PR／Draft／外部 repository 的卡片仍不當成工作 ticket。

## 3. 整合實作

### 3.1 重用目前準備合併內容的程式

重用 `TicketWorktrees.finalizeAccepted()` 目前的來源驗證、`merge-tree` 與 `commit-tree`：

1. 取得新鮮的 base 與 task 本地／遠端來源，保存來源 SHA。
2. 保留 local-only、remote-only、local-ahead、remote-ahead、divergent 的既有支援；不得只選 origin/task 而丟棄本地提交。
3. 必要時合併本地／遠端 task 來源，再與最新 base 準備 PR head。
4. **先原子保存 prepared head 與來源，才進行遠端寫入。**
5. 將 prepared head 以正常、非 force 的 push 推到既有 task 分支，不推 base，也不改動使用者目前 checkout 的 main 或 task worktree。

```text
舊：git push origin <preparedSha>:refs/heads/main
新：git push origin <preparedSha>:refs/heads/task/issue-121
```

prepared head 可以是 merge commit；它只存在於 task 分支。人工 squash merge 後，main 上是 GitHub 產生的線性提交。**prepared head 不等於最終 merged commit。**

首次 push 前要重新確認來源與 Issue 狀態；push 回應遺失時先查遠端 ref，不重建或覆蓋已有結果。既有 pending result 的不可任意覆寫保護仍須保留。

### 3.2 PR 建立與找回

在 `src/gh.ts` 重用 `runGh`／JSON 驗證／分頁與 timeout，新增最少的查詢、建立、讀取 PR 操作，不新增 merge API。

- head 固定為 ticket 的 task 分支，base 固定為設定的 base，兩端皆須在目標 repository。
- PR body 寫入 Issue URL、Project item ID、提交批次的 prepared head SHA。用 `Refs #121`，不使用會在重新合併時再次關閉 Issue 的 `Closes`／`Fixes` 指令。
- 每個提交批次先查 `state=all` 的相符 PR，再決定是否建立；不能只找 open PR，否則回應遺失或人工已合併時會重複建立。
- PR marker 只用於尋址；認領還須驗證 repository、base/head refs、ticket 身份及來源證據，不能只憑標題或文字標記。
- 建立成功但回應遺失／儲存失敗：下一 tick 查回同一個 PR 並保存 number、URL。
- 有多個候選，或同 head/base 已有不屬於本批次的 PR：保留現況並提示，不擅自認領、關閉或取代。
- Bot 不把 Issue 本身轉換成 PR；Project 上的 Issue 身份不變。

### 3.3 等待人工合併

使用現有 maintenance round-robin，每次只查一次 PR 後返回。新增 `waiting` outcome 與 PR URL，不使用 `gh pr checks --watch`、長時間等待或獨立輪詢程序。

- 顯示「等待人工合併 PR #N」與連結；這不是 `Maintenance blocked` 技術錯誤。
- 等待不占 builder 名額，也不占住唯一 finalizer，其他 ticket 可繼續前進。
- CI pending／failed、required review 未滿足時仍保留 PR，GitHub 負責阻止合併。
- strict checks 下 main 前進時，提示人工在 GitHub 更新 PR 分支；第一版不自動替等待中的 PR 產生更新提交。
- 人工用 merge 方式 Update branch 或追加修正是正常流程；不能要求最終 PR head 永遠等於首次 prepared head。

### 3.4 已合併證據與清理

不能把舊的 `taskSha isAncestor(origin/main)` 當 squash 成功判據；squash 會產生不同 SHA。

清理前，必須同時驗證：

1. 查回紀錄中的同一個 PR，repository 與 base/head 身份仍正確。
2. GitHub 明確回報 `merged=true`；只有 `state=closed` 不算合併。
3. 取得已合併 PR 的 head SHA 與實際 `merge_commit_sha`。PR 未合併時的 `merge_commit_sha` 是測試合併，絕不能作完成證據。
4. fetch 新鮮 origin/base，確認實際 merged commit 在 base 的歷史上。
5. 取得 merged PR head 的 Git object（必要時 fetch PR head ref），確認 prepared head／保存的來源包含於該 head。
6. 清理當下重新讀取本地／遠端 task tips，確認它們也包含於 merged PR head；未提交變更、額外新提交、來源被重寫或不可確認時，保留工作並阻擋清理。

人工追加提交或 Update branch 後，採用**已合併 PR 的 head** 作為覆蓋證據，而不是將新的 head 誤判成必須刪除或重新建 PR。若人工 rebase／force rewrite 令 ancestry 證據消失，安全阻擋；第一版不做 patch-equivalence 猜測。

merged 證據必須先保存，再執行清理。沿用現有 dirty／nested Git／symlink／Windows lock／ref race 防護；remote task 刪除繼續使用精確 lease，本地 ref 刪除使用 compare-and-delete。這不是 force-push base。

如果 GitHub／人工已刪除 task 遠端分支，不能因此判定 ticket 沒有 PR 或完成；必須照已保存的 PR 合併證據繼續驗證。

## 4. 持久化與恢復

### Schema

新增 ticket schema v5；已知 v3/v4 透過既有遷移入口處理，新執行只寫 v5。新 PR 狀態不能偽裝成舊版的 direct integration result，讓舊程式繼續嘗試推 main。

PR 整合紀錄至少包含：

- 已有的 Issue／Project item／repository／task/base 身份。
- 初次提交的 base SHA、本地／遠端來源 SHA、prepared head SHA。
- PR number、URL（建立／找回後保存）。
- merged head SHA、實際 merged commit SHA（確認已合併後保存）。
- 暫停的 PR 關聯與尚未完成的技術重試，不能因 UI 或一次 API 錯誤消失。

沿用 `retry.stage = integrate | cleanup`，不新增另一個重試引擎；正常等待 PR 不算重試失敗。修改 record validation、原子寫入及不可回退檢查，讓合法的 prepared → PR known → merged → cleanup 可以推進，但不能抹除 confirmed merged 證據。

### 人工退回工作

Issue 重新開啟或移出已批准 lane 時，停止本批次整合／清理，保留 PR 與 worktree，不代替人關閉 PR。

若人工明確退回 open Ready，未合併 PR 的關聯本身不能永久卡住 `assertNoFinalization()`：退役本次提交批准／技術等待，保留 PR 身份，允許既有 builder 在原 worktree 修復。重新 AI Review → Done → 人工 close 後，驗證並更新同一個仍開啟的受管 PR。已確認 merged 的 cleanup-only 狀態不可直接退回重建。

若有人在 Issue 已撤回或 builder 仍工作時合併 PR，Bot 不立即刪除工作；必須重新符合 lane／execution 及目前來源覆蓋條件。舊 merged PR 沒有涵蓋後續工作時，明確提示需要新的提交／PR，不拿舊證據清理。

### 其他情況

| 情況 | 行為 |
| --- | --- |
| PR 已開啟，尚未合併 | 等待，保留 closed Done、分支與 worktree |
| CI 失敗或 PR 落後 base | 提示 PR 連結；不自動 rebuild／reopen Issue |
| PR closed 但未 merged | 提示「PR 未合併即關閉」，不清理、不自動重開或另建 PR |
| API timeout、403、限流、JSON 不完整 | 記錄技術診斷；不把未知當成 absence 或 merged |
| 合併成功後程序重啟 | 重新查同一 PR、驗證 base，繼續 cleanup，不再提交整合 |
| 清理或 Backlog 寫入失敗 | 只重試尚未完成的清理／看板步驟 |
| 最初準備遇到確定且可修復的 base conflict | 沿用原有 builder conflict handoff、review 與 renewed close；不能改為忽略衝突 |
| 沒有 refs 且沒有 PR／整合／待恢復證據 | 保留原本 no-ref 歷史處理：只移 Backlog，不刪未知殘留 |
| 有 PR 紀錄但 refs 消失 | 查 PR 證據，不走 no-ref shortcut |

## 5. 舊資料與 #121 的處理

部署前停止並 drain 舊 owner，備份現有 ticket 紀錄與 refs；不刪除 worktree、prepared commit 或 recovery evidence。所有寫入端一起升級到新版本，不混跑 direct executor。

每筆舊 integration 先觀察遠端：

1. **舊 result 已在 origin/base 上**：保留為 legacy completed evidence，只走原本安全 cleanup；不再開 PR。
2. **尚未整合且 stage=integrate**：重新驗證來源。舊 prepared result 若吻合來源，可以重用為 PR head，正常推到 task 分支，再建立 PR；不再推 main。
3. **已進入 cleanup 但 result 不在遠端，或資料／refs 不明**：保留並阻擋，不猜測、不把它當全新 ticket。

因此 #121 的 `f103630...` 不必直接刪掉，也不代表工作要重做：經來源驗證後，它可以成為 task 分支上的 PR head；你透過 GitHub squash merge，Bot 再使用新的 merged SHA 做清理。

遷移需先備份原始位元組、確認 owner 與來源未變，再原子發布新紀錄。active／paused builder 的 run ID、worktree、review 及既有 conflict recovery 都要保留，不能為升 schema 另開 builder。

## 6. 改動範圍與實作順序

| 階段 | 主要檔案 | 交付與驗證 |
| --- | --- | --- |
| 1. 狀態與遷移 | `src/ticket-worktree.ts`、`src/legacy-tickets.ts`、`src/ticket-retry.ts`、版本判斷呼叫點 | v5 PR 證據、單調推進、舊整合分類；遷移及 crash-cut 測試先行 |
| 2. PR 建立／找回 | `src/gh.ts`、`src/ticket-worktree.ts` | 重用現有 Git preparation，push 目的地改為 task；嚴格 API 驗證、冪等找回與回應遺失測試 |
| 3. 人工合併觀測／清理 | `src/ticket-executor.ts`、`src/ticket-worktree.ts` | 將大 finalizer 拆出 PR preparation 與 merged-proof cleanup；不另加通用策略層 |
| 4. 等待狀態與生命週期 | `src/loop.ts`、`src/operation.ts`、`src/runtime.ts`／`src/index.ts` 的必要顯示與版本接點 | PR 連結、waiting outcome、非阻塞 round-robin、stop/drain、人工退回 Ready |
| 5. 設定與文件 | `src/config.ts`、`config-template.yml`、`README.md`、`docs/runbook.md`、現行架構文件及 builder 操作說明 | 移除 direct-push 部署要求；退休 `task_merge_strategy`，舊值驗證後警告忽略；不新增只有一種值的模式設定 |
| 6. 驗收與部署 | 現有 `tests/test-finalization-*`、`tests/test-ticket-finalization.ts`、`tests/test-gh-boundaries.ts` 及最少的新 PR 測試 | 離線回歸通過，再做受保護測試 repo 的人工合併驗收，最後處理 #121 |

不需要獨立 PR watchdog：PR 的所有前進由現有 `finalizeClosed()`／maintenance tick 驅動。GitHub 呼叫集中在現有 `gh.ts`，Git／filesystem 保護集中在 `TicketWorktrees`。

## 7. 驗收條件

1. closed Done 只建立一個受管 PR；重試、重啟、push／PR-create 回應遺失都不重複建立。
2. 所有新整合路徑均不包含 push base、PR merge mutation、Auto-merge 或 admin bypass。
3. CI pending／failed、等待審核或等待人工合併期間，零 cleanup、零 Backlog 寫入，builder 排程不受阻。
4. 真正的 squash PR 合併後，即使 task SHA 不是 main 祖先，仍以 merged PR 證據安全完成清理。
5. 人工 Update branch／追加提交後仍能完成；未被 PR 涵蓋的本地／遠端新提交、dirty worktree 必須阻擋刪除。
6. 測試同名錯誤 repo/base/head、偽造或重複 marker、PR closed-not-merged、未合併 test merge SHA、主線證據消失，均不得誤清理。
7. 涵蓋 local-only、remote-only、ahead、divergent、GitHub 已刪 head branch，以及每個 durable write／遠端 side effect 之間的 crash cut。
8. Issue 撤回／重新 Ready、重新 close、stop、owner 變更及 active run 恢復不產生第二個 builder 或不受批准的清理。
9. #121 類型的 rejected direct result 可轉 PR；舊 completed integration 只 cleanup；corrupt／未知狀態仍 fail closed。
10. 執行 `npm run check`；另在保留 PR + linear history + required checks 的測試 repository，人工確認不能提前合併、Squash and merge 後 main 無新增 merge commit、Bot 隨後完成清理。

實作與部署都不得修改 main 保護規則來讓驗收過關。

## 8. 本輪範圍

本輪只產出方案。沒有修改程式、建立 PR、push、合併、刪除任何 ticket artifact 或更動 GitHub 設定。

第一版刻意不做：自動合併、原生 Auto-merge、merge queue 整合、自動重跑 CI、自動更新等待中的 PR、rebase 後的 patch-equivalence 推測，以及不相符 PR 的自動接管。

## 參考

- 現行入口：`src/loop.ts:747`、`src/ticket-executor.ts:1303`。
- 現行 direct preparation／push／cleanup：`src/ticket-worktree.ts:930–1301`。
- 現行嚴格狀態驗證／不可覆寫檢查：`src/ticket-worktree.ts:258–318`、`:547–600`。
- [GitHub REST：Get a pull request；merged 與 merge_commit_sha 的意義](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)。
- [GitHub REST：Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)。
- [GitHub：Pull request merge strategies](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges)。
