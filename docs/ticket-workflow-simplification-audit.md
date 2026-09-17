# 以 Ready 重試為核心的過度設計分析

> **設計評估，尚未實作。** 基準：`e35040c51d8a7d85f634945297a5f95ecdb01759` 與分析時的 working tree。
> 使用者已澄清：一般執行失敗應「留言後回 **Ready**」；保留 **Needs Human**，但僅限缺少使用者決策，不是所有錯誤的出口。
> 本次只新增這份報告；既有 `src/index.ts` 修改與未追蹤的 `tests/test-builder-widget.ts` 均未更動。沒有操作線上 Project、啟動 builder、推送或合併目標倉庫。

## 1. 結論

**相對於使用者描述的工作流程，目前有明顯的範圍過度設計；但不是所有驗證都多餘。**

使用者要的是：

```text
Ready → In Progress → Review → Done（尚未合併）
                                  ↓ 使用者手動關閉 Issue
                            merge / push 到 main
                                  ↓
                  刪除遠端 branch、worktree、本地 branch

一般執行失敗 → 留下原因 → Ready → 下一輪重試
缺少使用者決策 → 提出具體問題 → Needs Human → 決策確認後回 Ready
```

目前實作另外承擔了 Story 拆票、PR CI 修復、提及回覆、修復交接協定、舊資料復原、全檔案清理快照、多版本部署一致性等職責。最值得刪減的是這些**額外承諾及它們帶來的交叉檢查**，不是把必要的 Git 錯誤處理或使用者決策入口刪掉。

「使用者不碰 branch」可省掉支援任意人工改動分支／檔案後的自動推理復原；不能省掉避免重複 builder、push 未成功就刪分支、誤刪其他目錄等基本保護。Agent、Git、網路及 Windows 檔案鎖仍可能出錯。

本建議以「每個 repository 只有一個 Board Agent owner；可有多個不同 ticket 的 builder；task branch/worktree 由插件管理」為目標契約。**不把使用者不碰 branch 偷換成只能用一個 worker。**

### Needs Human：等決策，不是把除錯交給使用者

- **Ready**：需求與授權足夠，剩下是 agent 應處理的實作、測試、一般 merge conflict、重試或清理問題。
- **Needs Human**：現有需求、可信留言與既有慣例無法決定產品行為、互斥需求、可接受的破壞性變更、費用或授權範圍；需要使用者選擇後才能繼續。
- Agent 應先查現有資訊；合理的技術實作選擇自行決定，不把「我不確定」「工具失敗」「已失敗幾次」直接等同缺少使用者決策。需要批准的動作也不能先執行再詢問。
- 進 Needs Human 的留言必須指出**究竟要決定什麼、為何現有資訊不足、可行選項與影響、建議選項**；不是只貼 stack trace 要使用者修 branch。只暫停受阻 ticket，保留原工作；決策確認後回 Ready 接續。
- 缺憑證、外部權限或 OS 鎖本身不自動等於決策：不得越權，保留工作、說明外部阻礙並延後重試；只有需要選擇授權範圍或替代方案時才進 Needs Human。人工 close 的最終批准流程不變。

**判斷原則：能說清楚「需要你選擇什麼」才用 Needs Human；已知道應做什麼、只是執行失敗，就不應把除錯責任丟回使用者。**

## 2. 現況和需求差在哪裡

| 情況 | 現有實作 | 目標 |
| --- | --- | --- |
| 領取 Ready Task | 要求 Plan、Type、claim、worktree、run 關聯 | 保留基本身份／重複執行保護；單純 ticket 不必依賴 Story/Plan |
| Builder 失敗 | 留言後 Needs Human | 技術失敗留言後 Ready；只有缺少使用者決策才進 Needs Human；均保留原工作 |
| 一般 AI review 有 findings | 留言後 Ready | 已符合 |
| AI review 執行／fetch／cleanup 異常 | 通常只通知，留在 Review | 可以寫回時留言後 Ready |
| 衝突修復失敗或其 review 不通過 | Needs Human | 一般技術問題回 Ready；若衝突揭露互斥產品需求，才請使用者決策 |
| 人工 close 後 merge conflict | 符合額外證據時才啟動九階段 handoff；否則阻塞 | 留言、重新開啟 Issue、Ready；原 builder 在原 branch 修復 |
| Push 或其他 finalization 錯誤 | blocked，通常留在 closed Done，下一 tick 再檢查 | 留言後 Ready，但先確認是否其實已推成功 |
| 已 merge，只是刪除失敗 | cleanup receipt 保留重試權，仍主要由 closed Done lane 處理 | Project 可回 Ready，但只能補清理，不能重新 build／merge |

證據：[`ticket-executor.ts:555–658`](../src/ticket-executor.ts#L555-L658)、[`791–1033`](../src/ticket-executor.ts#L791-L1033)、[`1595–1721`](../src/ticket-executor.ts#L1595-L1721)、[`loop.ts:1427–1689`](../src/loop.ts#L1427-L1689)。

兩個不能誤報的現況：

- 普通 finalization **已經不要求** Plan 或 `reviewedTaskSha`；closed Done 批准目前 local task tip。不能再把「必須取得 AI review 證據才准 merge」列為現有普通流程的問題。[`ticket-worktree.ts:936–1038`](../src/ticket-worktree.ts#L936-L1038)
- 普通 finalization 沒有全面整合測試門檻；嚴格測試工具歷史驗證主要是 **repair 專用**。普通 review 預設關閉；若希望 AI 自動 Review → Done，需開啟 `review.enabled`。[`config.ts:78–80`](../src/config.ts#L78-L80)

## 3. 優先刪／縮的項目

以下排序依縮減核心複雜度的價值，不是資安漏洞嚴重度。

### 3.1 `shrink:` 把衝突修復協定縮回普通 Ready 重試

[`conflict-recovery.ts:41–71`](../src/conflict-recovery.ts#L41-L71) 定義九個內部 step：

```text
comment → ready → reopen → queue → queued → consume → launching → consumed
                                                                    ↘ blocked
```

同時保留 local ledger、原 card/record 副本、request key、comment id、run id、attempted flag、terminal notice；遠端同一則留言再走 requested/queued/consumed 三個版本。每一步反覆確認留言作者、完整內容、card 身份、claim、record、Git refs、revision。

[`progress():397–488`](../src/conflict-recovery.ts#L397-L488) 的 `attempted` 分支若讀不到預期寫入結果，就拒絕重送。這是刻意保守，不是無限自動復原：連「已記錄 attempted、但尚未真正送出 API 就中斷」也可能需要人工查證。它與「失敗回 Ready 繼續處理」的操作期待不一致。

**應保留的行為：** 衝突後不刪工作、同一 ticket 不同時跑兩個 builder、重新進 Review、重新由使用者 close 批准。

**可移除的機制：** 特別的 requested/queued/consumed 遠端授權協定、永久 consumed request 名冊、repair-only settlement 規則。普通重試本來就有 execution record、runId、claim 和持久 worktree，不必再有一套平行權責。

修復留言只需要說清楚失敗階段、原因和待修內容。它是診斷資料，不應成為另一套執行權限憑證。一般可信留言／不可信輸入邊界仍保留。

目前普通 builder prompt 只要求 pull task branch，沒有一般性的 main 衝突修復步驟，因此不能只刪 `ConflictRecovery`：需同步讓普通 retry 能在原工作目錄檢查 `MERGE_HEAD`、接續 partial work、把 base 合進 task，再跑現有相關測試。[`workflow-prompt.ts:124–140`](../src/workflow-prompt.ts#L124-L140)

### 3.2 `native:` 不要把刪 worktree 做成完整檔案復原系統

目前清理記錄包含：每層父目錄的 device/inode/birth time、每個檔案的大小／SHA-256、symlink target/kind、Git administration snapshot、record 原始 bytes hash、legacy 完整備份及備份重驗。

- [`cleanup-snapshot.ts:17–29`](../src/cleanup-snapshot.ts#L17-L29)：快照資料結構。
- [`cleanup-snapshot.ts:237–326`](../src/cleanup-snapshot.ts#L237-L326)：含 ignored files 的完整遍歷及重验。
- [`ticket-worktree.ts:1271–1766`](../src/ticket-worktree.ts#L1271-L1766)：receipt、backup、驗證與多次 cleanup guard。
- [`cleanup-snapshot.ts:355–373`](../src/cleanup-snapshot.ts#L355-L373)：殘留檔案逐項刪除前重查全樹，程式明示 O(n²)。

這不是每次正常清理都走 O(n²)：正常 `git worktree remove` 若已刪完目錄，逐項 fallback 會跳過不存在的項目；但之前的多次完整快照／hash 仍會執行。O(n²) 主要是**有殘留且逐項移除**的路徑。本次沒有測量 production 延遲，不主張任何毫秒或倍數改善。

**更小的契約：** 只自動移除已確認屬於該 ticket 的 managed worktree，正常 `git worktree remove` 失敗就保留、留言、Ready 重試。不承諾自動修復所有未知／被替換／失去 Git 註冊的目錄。保留精確路徑、branch、ownership 檢查，不改成裸 `rm -rf`。

重要限制：Git 的正常 remove 會拒絕一般 untracked/dirty worktree，但 **ignored files 可能一起被刪掉**。[S1] 本次真 Git 實驗也確認了這點。因此縮掉全樹快照前，需明定可拋棄的是依賴／build 產物，不能把唯一的 `.env`、本機資料庫或人工檔案當成 disposable；可保留一個窄的保留檔案政策，不必備份並驗證整棵 node_modules。

Windows OS 鎖仍可能需要釋放占用它的 process。回 Ready 不是強制刪除權限，也不能保證純軟體重試能排除外部鎖。

### 3.3 `delete:` PR watchdog 不属于這條 direct-merge 流程

[`watchdog.ts:528–555`](../src/watchdog.ts#L528-L555) 掃描带指定 label 的 PR，再做 CI 修復、提及回覆、cooldown、fix rounds、升級給人工。它預設開啟，但目前主要 ticket 流程不是「建立 PR → 合 PR」。

不使用 PR maintenance 時，先設 `watchdog.enabled: false`；確認不需要後移出核心，包括相關 state/config/GitHub adapters。這比優化它的排程／mention 游標更直接。不是建議把 review 一起刪掉。

### 3.4 `yagni:` Story／Needs Design／Plan 不應是普通 Ready ticket 的前提

`refine.ts` 承擔 Story 拆票、子 Issue 防重複建立、Project reconciliation、question cursor、歷史截斷 journal 與 companion journal。這些是「自動產生票」的成本，不是「執行既有票」的必要條件。

- [`refine.ts:747–1005`](../src/refine.ts#L747-L1005)：子票建立協調。
- [`loop.ts:734–749`](../src/loop.ts#L734-L749)、[`ticket-executor.ts:1249–1275`](../src/ticket-executor.ts#L1249-L1275)：Ready/review/launch 仍要求 Plan。
- [`config.ts:317–334`](../src/config.ts#L317-L334)：七個狀態名必須存在於設定且彼此不同。

若起點就是寫好的 Ready ticket，先關 refinement，之後讓 Plan 成為可選分組資訊。Type 若用於隔離同一 Project 的 Story／其他項目可保留；不應因減行數讓 Draft、PR、其他 repo 的卡也可被修改。

若仍需要 AI 拆票，可保留為明確的前置命令；不要為每張普通 Task 持續承擔整套 Story recovery。若保留自動建票，也不能直接刪其去重保護而冒出重複 Issue。**Needs Human 的決策用途獨立保留，不能因停用 Story refinement 就一併刪除。**

### 3.5 `shrink:` repair 專用測試證據解析太依賴工具輸出格式

[`repair.ts:14–79`](../src/repair.ts#L14-L79) 不只檢查測試成功，還要求完整匹配的一則 bash command、相鄰 tool result、固定 BEGIN/PASS 字串、非空且未截斷輸出、精確 agent result 關聯。

這能證明「曾看到指定形狀的工具紀錄」，但不能單靠它證明測試涵蓋正確需求；程式註解也明說不是對惡意 builder 的 sandbox。成功測試輸出被截斷或用不同但等價命令執行，仍會被判定證據不合格。

**保留現有相關測試與 Review；刪掉格式化證明協定。** 衝突修復使用相同 builder/reviewer 規則，失敗留言後 Ready。這項與 3.1 有範圍重疊，不能重複計算刪減行數。

### 3.6 `shrink:` 把部署版本一致性檢查移出每次 admission 的熱路徑

[`runtime.ts`](../src/runtime.ts) 比較 configured／loaded／disk revision、dirty、settings，並以 mismatch latch 轉 recovery-only；[`index.ts:120–130`](../src/index.ts#L120-L130)、[`333–343`](../src/index.ts#L333-L343) 與 [`loop.ts:519–546`](../src/loop.ts#L519-L546) 把它接到執行時檢查。另有 fleet verifier。

在「已 pin 插件，執行期間不更新，更新必須先 stop／重啟」的契約下，保留啟動檢查、版本顯示、部署時 verifier 即可；不必每次模型 admission 都重驗整個 package checkout。

Pi 原生已支援 pinned Git refs，但這不等於 pin 後磁碟永不改變：官方文件說 update 可把 clone reconcile 回所設定的 ref。[S6] 所以這是**明確停止支援 hot update／多人改動安裝目錄後的自動復原**，不是聲稱 Pi pin 完全取代目前的每一種保護。

## 4. 最重要的簡化邊界：Ready 不等於「從頭重做」

建議保留兩種內部事實，而不是增加更多看板欄位：

| 事實 | 回 Ready 後下一輪 |
| --- | --- |
| 尚未確認整合到 main | 沿用原 task branch/worktree，讀失敗留言，再 build/review；修改後必須再次 Done + 人工 close |
| 已確認整合到 main，只剩清理 | 不啟動 builder、不重新 merge，只重試剩下的 remote/worktree/local cleanup |

例如 push 到 main 成功但網路回應遺失，不能把 timeout 當作「一定沒推成功」；先 fetch／查 refs。若已確認整合，只進 cleanup。若查不到可靠結果，保留資料，下次再查，不刪分支。[S2]

這只需要沿用 ticket record 的 run 關聯，加小型整合進度（task SHA、result SHA／待清理事實），不需要一份完整 filesystem receipt。可以在 push 前保存待確認的 result SHA；**result SHA 存在不是推送成功的證明**，清理前仍需確認它在 fresh origin/main 歷史中。

### 已關閉 Issue 的處理

- Merge conflict／未整合而需要改程式：留言、reopen、Ready。下一次 code result 仍需 Review → Done → 人工再 close。
- 已整合但清理失敗：可保留既有 closed 批准，只把 Project status 回 Ready；cleanup-only lane 依小型進度重試，成功後恢復 Done。它不是 closed Issue 的 builder admission。
- 撤回／刪除／換掉 ticket 的人工動作，不應被機械地覆蓋回 Ready。這不是工作失敗，而是輸入已改變。
- GitHub API 不可用時，連「留言＋Ready」本身也可能做不到：保留本機錯誤／待寫回狀態並通知，恢復後再補。不能假稱遠端狀態已回退。

目前 `processClosedDoneCards()` 只選 closed Done，`eligible()` 又拒絕 pending cleanup；所以**只把失敗的 setStatus 改成 Ready，會把 cleanup 移出可處理路徑**。需要一起改 retry selection。[`loop.ts:1624–1689`](../src/loop.ts#L1624-L1689)、[`ticket-executor.ts:1266–1274`](../src/ticket-executor.ts#L1266-L1274)

Ready 本來就是自動執行佇列，永久的 credentials／權限／磁碟問題不會因重新叫模型而消失。最小節流是同一票同一 tick 不重試，外部 I/O 問題先重試 I/O；不把重試耗盡當成進 Needs Human 的理由，也不增加通用 retry engine。若重複模型呼叫已有實際費用問題，再加一個簡單 cooldown。

## 5. Merge 比 squash 更容易支援簡單重試

目前預設 squash。[`config.ts:69`](../src/config.ts#L69) 使用者只說「merge to main」，沒有要求每票只能留一個 commit。

若沒有線性歷史／單 commit 要求，建議使用現有 `task_merge_strategy: merge`：Git 保留 task ancestry，重啟後可用原生 `merge-base --is-ancestor <taskSha> origin/main` 確認已整合。

Squash 不保留 task 作為 parent。[S3] 目前 fallback 使用重新 merge 的 tree 與 base tree 相等來判定已整合，原始碼也註記後續衝突需人工處理。[`ticket-worktree.ts:998–1006`](../src/ticket-worktree.ts#L998-L1006)

本次離線實驗確認：squash 成功後，main 再改到同一檔案，重新 `merge-tree` 原 task 可能衝突；因此 tree equality 不是一般性的歷史整合證明。若要保留 squash，小型 result-SHA 紀錄仍有價值，不能只靠「local branch 是否存在」。

這是建議，不是已改設定。若 GitHub rules 要求 linear history，merge commits 會被拒絕；若要求 PR，direct push 流程也會受限。[S7] 不建議插件自動修改或繞過這些規則。

## 6. 這些保留，不算過度設計

1. **一個 owner lock、每票至多一個 active run、總 worker 上限。** 不碰 branch 不代表不能誤開兩個 Pi。沿用 WorkflowManager 的 persistence／resume，不重造 engine。
2. **issue/repo/branch/path 的基本驗證。** 不得誤改其他 repo／Draft／PR，不得刪 main 或非 managed 路徑；fresh 讀取失敗不能用舊快照授權修改。
3. **持久 worktree 與少量原子 record。** 失敗回 Ready 必須能接著修，而不是 reset 掉 partial diff；先停妥舊 run，再讓新 run 接手。
4. **Review 對準實際 revision。** 不需要修復專用證明鏈，但仍要知道 reviewer 看的是哪個 commit。保留隔離 review 的基本做法，不為減行數把模型搬進主 checkout。
5. **push 成功後才清理；normal push，不 force-push main。** 對 timeout／拒絕／不明結果保留本機工作。
6. **正常 worktree remove、ref 的精確刪除條件。** 現有 remote deletion lease、本地 `update-ref -d <ref> <expectedSha>` 是幾行原生 Git 保護，不是應優先刪的膨脹點。[S2]、[S4]
7. **Git/gh deadline、非互動模式、stop/drain。** Windows process-tree containment 的複雜度是執行可靠性，不因它行數較多就換成沒有等價保證的裸 subprocess。
8. **最小功能測試。** 「不需要過度驗證機制」不等於 builder/reviewer 可以不用跑相關測試。

不要把 `git branch -d` 當成「已合進 main」的唯一檢查：它可以依 upstream 而非 main 判斷。[S5] 本次實驗已確認 task 只推到 origin/task、尚未進 main 時，`branch -d` 仍可成功。

## 7. 最小落地順序

### 先用现有設定縮範圍

若不要自動拆票與 PR maintenance：

```yaml
refine:
  enabled: false
watchdog:
  enabled: false
```

若 Review 指 AI 自動驗收，再設定 `review.enabled: true`；若指人工 Review，維持關閉即可。

這只能關 lane，**不能達成「技術失敗回 Ready、缺決策才 Needs Human」**。保留 `columns.needs_human` 的獨立用途，不把它改名為 `Ready`；設定也要求七個狀態名互異。

### 再收斂程式行為

1. 在既有 executor/loop 集中分流：一般執行失敗 reason comment → 必要時 reopen → Ready；真正缺少使用者決策才帶具體問題進 Needs Human。先結清／停止舊 run，不再追加另一套 repair state machine。
2. 分開「未整合重試」與「已整合補清理」，確保 Ready cleanup 不走普通 builder；保留小型 integration progress。
3. 修改普通 builder 的 retry 指令，沿用 worktree、理解失敗原因、接續未完成 merge，不 reset／stash／force-push。
4. 移除 repair 專用 ledger、工具輸出證明、重複 approval settlement；讓 repair 與普通工作回同一 Review/Done/close 流程。
5. 清理改用 Git 原生操作及窄路徑／資料政策；退出「任意 legacy 殘留自動修復」承諾。保留未知資料並報錯，不盲刪 state 來讓檢查變綠。
6. 確認無使用需求後刪 Story/watchdog 核心掛鉤，把 Plan 改可選，版本檢查留在啟動／部署邊界。

不需要新資料庫、webhook server、訊息佇列、DAG scheduler、通用 saga，也不需要換掉已使用的 WorkflowManager。不要只因大檔案而機械拆成更多 service/interface。

### 最小回歸情境

沿用現有測試工具，覆蓋少數端到端情境即可：正常全流程；builder/review 技術失敗回 Ready 且不重複 run；缺決策才進 Needs Human，確認決策後在原工作上接續；close 後一般 conflict 重開並重新批准；push 回應遺失後不重複整合；cleanup 失敗回 Ready 只補清理；dirty/locked/非 managed 路徑不誤刪；GitHub 寫回失敗保留可重試資訊。

先停舊 owner、備份現有 worktrees/records/workflow journals，結清 pending repair/cleanup，才移除舊協定。既有持久資料不能因為新設計較簡單就當成可刪垃圾；不為此再做常駐的自動 migration engine。

## 8. 規模、證據與限制

採同一個實體行數算法，分析時：

| 範圍 | 數量 |
| --- | ---: |
| `src/` | 23 檔、13,918 行（含既有 index.ts working-tree 差異） |
| 已追蹤 `tests/` | 75 檔、19,534 行；不含使用者新增的 widget 測試 |
| `refine.ts` + `watchdog.ts` | 2,116 行 |
| `conflict-recovery.ts` + `repair.ts` | 870 行 |
| `cleanup-snapshot.ts` | 443 行 |

後三列是可刪／重做區塊的**現有體積**，不是可保證的淨刪行數；也未計 loop/executor 交叉邏輯及替代方案。行數本身不是過度設計證據，需求之外的承諾與分歧的失敗路徑才是。

舊 audit 在不同基準、較強的 durability／自動復原承諾下認為某些檢查不應刪，本次不把它們當永久需求。新增的使用者契約允許撤掉昂貴的自動復原承諾，但不能因此讓資料遺失。

本次完成：主流程與關鍵 recovery/cleanup 原始碼追讀；官方網路來源比對；repo 外隔離 Git 倉庫的 **5/5** 行為檢查（normal merge ancestry、squash 再整合、branch -d upstream、untracked 拒刪、ignored 會刪）。這些是 Git 語意檢查，**不是插件新流程已通過**。

沒有執行全套插件測試、真實 LLM、live GitHub E2E、production benchmark 或盤點現存運行中的其他專案，因此不宣稱已驗證重構、可無痛清除全部 legacy 資料或能節省固定比例的 API／tokens。

**Net：未實作前不報虛構淨減行數；確定不需要新增依賴，暫無必要刪除現有兩個 runtime dependencies。**

## 線上一手來源

- **[S1] Git — git-worktree**：正常 remove 的 clean／force／locked 行為；linked worktrees 共用部分 repository metadata。<https://git-scm.com/docs/git-worktree>
- **[S2] Git — git-push**：normal push、遠端 ref 刪除、expected-value lease；不把跨 Git/GitHub/檔案系統操作誤當成一個交易。<https://git-scm.com/docs/git-push>
- **[S3] Git — git-merge**：squash 不記錄正常 merge parent 資訊，冲突處理與 merge continue。<https://git-scm.com/docs/git-merge>
- **[S4] Git — git-update-ref**：透過 old OID 做條件式 ref 更新／刪除。<https://git-scm.com/docs/git-update-ref>
- **[S5] Git — git-branch**：`-d` 檢查 upstream；没有 upstream 才以 HEAD 為準。<https://git-scm.com/docs/git-branch>
- **[S6] Pi — packages 文件**：原生 pinned refs／更新 reconcile 行為；並讀取本機完整 extensions/packages 文件與 lifecycle 範例。<https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md>
- **[S7] GitHub — Available rules for rulesets**：Require a pull request、Require linear history 等限制。<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
- **[S8] GitHub — Using the built-in automations**：Issue closed 可自動设為 Done，也可設定 status 變更自動 close。<https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations>
- **[S9] Anthropic — Building effective agents**：從最簡單方案開始，只有實際需要才增加複雜度；固定流程適合可預測的 workflow。這是設計參考，不是對本 repo 的測量證據。<https://www.anthropic.com/engineering/building-effective-agents>

GitHub Project 的內建 automations 要與人工批准順序一致：不要開啟「進 Done 就自動 close」而繞過使用者手動關票；也要檢查 close → Done／auto-archive 是否覆蓋失敗回 Ready 或讓 pending cleanup 卡消失。[S8]
