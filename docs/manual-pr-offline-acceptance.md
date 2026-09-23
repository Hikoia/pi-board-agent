# T07 最終離線驗收報告

**結論：未通過。** 2026-09-23 完整套件已實際結束，不是仍在執行：`npm run check` **exit 1**，`2 FAILED, 1163 passed`。使用者已選擇「以未通過結案」，不擴大本輪修復。

## 版本與交付

- 分支：本地 `manual-pr/integration`。
- 續行基線：`5deda8cd34702955fa7f99bea4994cfe46c077f5`；不重做 T01–T06。
- 最終程式碼／全部本輪 MAIN 驗收版本：`79970e18b6d834f83236aab6a4324930b7a231fe`。本報告所屬後續提交只更新文件，不代表另一個已通過版本。
- 一個修復 subagent 在保留的 `D:/Project/pi-board-agent-t07-repair` worktree 交付；MAIN 審查後 fast-forward 整合並獨立驗證。未啟動第二個修復 agent。
- 程式碼差異僅 `tests/test-repair-executor.ts`、`tests/test-ticket-executor.ts`。`src/`、正式 API／schema、runner、npm scripts／依賴未改。
- 未 push 真實 refs、呼叫真實 GitHub、部署、修改保護規則、操作真實 #121 或清理正式 worktree。所有測試 push 僅作用於 disposable file-only bare remotes。
- 既有 task worktrees、未追蹤 `docs/diagrams/` 及工作紀錄保留；diagram 檔案 SHA-256 與 R0 快照一致。

## 已完成的修復

兩個原始失敗都經既有隔離 runner 重現，並非只靠靜態推論：

1. Repair mock builder 要求舊文字 `do NOT close`；現行 mission 已改為禁止 base／Issue／PR mutation 的完整敘述。斷言先於 `test.cjs` 失敗，agent 為 `AGENT_EXECUTION_ERROR`，但 workflow 仍可 `completed` 並回傳 `[null]`；舊主測試最後只報 `.pi/tested` ENOENT。
2. Ticket executor 要求舊 `Only when there is no MERGE_HEAD`、`Never reset, stash, overwrite, or discard`，未配合新增 clean／committed 條件與禁止 rebase 的 mission。

修復改為驗證實際 rendered mission：status／diff／MERGE_HEAD、原 worktree 的 interrupted work、clean＋committed＋無 MERGE_HEAD 才同步、正常 merge 保留 published PR ancestry，以及 rebase／reset／stash／discard／force-push／base push／關閉 Issue／PR mutation 禁令。沒有回退 mission 或刪除安全條件。

`settled()` 現在同時驗證 workflow、實際 agent 狀態與完整成功結果，並以負向案例證明 builder assertion 直接報出，而不是被 ENOENT 掩蓋。原有真實 `test.cjs`、雙方內容與 ancestry、pushed SHA、base 不變、dirty recovery／same-run resume 的斷言保留；沒有手工偽造 `.pi/tested`。

R1 詳細原始／失敗修訂／成功修訂紀錄：`D:/Project/pi-board-agent-t07-repair/tmp/t07-r1-report.md`。修復後 subagent 為 58/58、exit 0；這不是 MAIN 的完整驗收證據。

## MAIN 實際命令與結果

下列目錄均有 `spec.json`、`run.json`、完整 `check.log` 與程序結束後才原子寫入的 `check.exit`；不把不同執行的 PASS 相加。

| 命令 | 實際結果 | repo 內證據目錄 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `tmp/t07-resume-20260922T193000Z-typecheck/` |
| `bash tests/run-offline.sh tests/test-core.ts tests/test-repair-executor.ts tests/test-ticket-executor.ts tests/test-ticket-finalization.ts` | **174/174，exit 0** | `tmp/t07-resume-20260922T193000Z-focused/` |
| `npm run check`（第一次） | fixture 隔離失敗後主動停止；exit 1，沒有完整成功總結 | `tmp/t07-resume-20260922T212300Z-full/` |
| `npm run typecheck && bash tests/run-offline.sh tests/test-card-identity.ts tests/test-core.ts tests/test-repair-executor.ts tests/test-ticket-executor.ts tests/test-ticket-finalization.ts` | **184/184，exit 0** | `tmp/t07-resume-20260923T003600Z-focused/` |
| `npm run check`（第二次、完整） | **91 檔結束；1163 passed、2 FAILED，exit 1** | `tmp/t07-resume-20260923T024900Z-full/` |

### 完整執行的身分與完整性

- 命令：`npm run check`，無縮減清單或排除參數。
- cwd：`D:/Project/pi-board-agent`；HEAD：`79970e18b6d834f83236aab6a4324930b7a231fe`。
- 獨立 OS worker PID：`43812`；實際開始：`2026-09-23T02:49:57.5364050Z`。
- 實際 exit 檔時間：`2026-09-23T14:13:13.274Z`；退出碼：`1`。
- log：`tmp/t07-resume-20260923T024900Z-full/check.log`。
- exit：`tmp/t07-resume-20260923T024900Z-full/check.exit`。
- log SHA-256：`900cb783e25aad74aa6942ca2a87f9045e9c9f282cf4f349ddef1c34c8e7215d`。
- 預先發現的 91 個 `test-*.ts`／`test-*.mjs` 與 log 的 91 個檔案名稱完全相符；每檔均有檢查結果，沒有未完成檔案。
- 唯一失敗檔是 `test-process-runner.ts`：45 PASS、一個失敗斷言，加上檔案非零退出。runner 因此計為 **2 FAILED，不是兩個不同功能失敗**。
- 穩定 fixture 根：`D:/Project/pi-board-agent-offline-tmp/t07-20260923T024900Z-full`；不依賴工具的 `.ctx-mode-*` 生命週期。
- 沿用原 `env -i`、fake GH／model、file-only Git、發現與清理邏輯。分段監看只讀 PID＋開始時間；沒有任意套件時限、沒有重疊的完整驗收程序，也沒有因單檔緩衝而重啟。

## 阻止 T07 通過的新失敗

完整 log 的實際失敗：

```text
FAIL  sync: taskkill spawn error is handled and job-owner fallback kills the tree
AssertionError [ERR_ASSERTION]: process-runner regression(s) failed
FAIL  test-process-runner.ts exited 1
pi-board-agent: 2 FAILED, 1163 passed
```

MAIN 隨後獨立執行原 `test-process-runner.ts` 與僅增加觀察輸出的忽略追蹤副本（沒有更改 production 或正式測試）：

- `tmp/t07-resume-20260923T141400Z-process-diagnostic/`：原檔通過；三個診斷副本中一個出現同步 UTF-8 斷言失敗。該次沒有記錄 encoding 的 `ProcessResult`，**原因未確認**。
- `tmp/t07-resume-20260923T141800Z-process-probe/`：十次同形診斷執行，459 passed、2 FAILED，exit 1。第二次重現同一 fallback 斷言，但為 async 模式：`ready=false`、僅 parent PID `58068` 建立且已死亡；`ok=false`、`timedOut=true`、預期 taskkill ENOENT 均成立。20 次 encoding probe 全部通過，耗時 962–1389 ms。

呼叫鏈：fallback 測試 → `runProcess`／`runProcessSync` → `startSupervisor`（deadline 包括 worker 啟動）→ `execute` → PowerShell／Add-Type Job Object bridge → parent → grandchild → ready file。證據確認 **Windows fixture 在 2 秒內尚未完成雙程序啟動的競態確實可能發生**；該重現沒有觀察到存活殘留程序。但不能據此斷言原本未加觀察的同步失敗、或另一次 UTF-8 失敗原因完全相同，也不能宣稱已修復。

詳細診斷、命令、實際結果與副本：`tmp/t07-resume-20260923T141800Z-process-probe/diagnosis.md`、`spec.json`、`check.log`、`check.exit`、`diagnostic-source.txt`。診斷副本不是正式測試替代品，其 PASS 不構成整套通過。

原 workflow 完成後，工具拒絕續接；MAIN 沒有另起第二個 agent。使用者在「MAIN 額外修測試／追加修復 agent／未通過結案」中明確選擇最後一項。因此未擴大修改、提高正式測試期限、略過測試或反覆重跑直到綠燈。

## 首次全量的隔離事故與處理

首次 MAIN 將穩定 tempRoot 放在 repository 內。`test-card-identity.ts` 的非 Git review fixture 因而向上找到整合 checkout；`TicketWorktrees.constructor` 未使用預期的 fixture cwd，導致寫入 `item.json` ENOENT。目標路徑長 201 字元，不是 MAX_PATH 問題。讀取式 `git rev-parse` 證明 repo 內 tempRoot 找到整合 repo，外部穩定根則回報非 repository。

為防止後續 fixture 延續 scope escape，MAIN 驗證 PID／開始時間後停止該已失敗程序樹；Windows/MSYS 殘留子樹亦以確切身分確認後停止，沒有對語言服務或不相關程序操作。其 log／實際 exit 1／殘留 fixture 保留，不列為完成套件。

該 fixture 曾在**本地整合 checkout** 建立自己的 `owner.lock`（PID `53288`，`2026-09-22T21:56:27.447Z`）。已備份精確位元組、確認 PID 不存活並再次比對位元組，只移除這個測試產物及同次新建的空 cleanup 目錄；既有 context／runtime／records／worktrees 保留。這項本地副作用明確揭露，不宣稱測試完全沒有碰到 checkout state；沒有啟動或切換正式 owner。

更正僅在忽略追蹤的本機 wrapper：要求明確外部穩定 tempRoot 並拒絕可發現 enclosing Git repo 的根。runner／production／正式測試不變。更正後包括 card-identity 的五檔補驗通過。事故、精確備份與 scoped cleanup 證據均在 `tmp/t07-resume-20260922T212300Z-full/`。

## 安全契約覆核及已觀察到的通過案例

MAIN 重新讀取實際呼叫鏈，且確認本轮 `src/` 沒有差異：

- `src/loop.ts` maintenance → `ManagedTicketExecutor.finalizeClosed` → `finalize`；active builder、owner／stop／新鮮 ticket 授權與 waiting 邊界保留。
- Production factory 明確注入 find／create／get PR API。`src/gh.ts` 沒有 merge-PR、Auto-merge 或 protection bypass mutation。
- `TicketWorktrees` 的兩個 Git push callsite 僅為正常 task publication 與精確 lease 的 task deletion；沒有 base push。
- Squash cleanup 仍需正確 PR 的 `merged=true`、實際 merge commit 位於新鮮 origin/base，及 merged PR head 涵蓋保存／準備／當前來源；不能拿 task 在 base 的 ancestry 代替 squash 證據。
- dirty／untracked／未涵蓋提交／nested Git／link／lock／ownership guards、remote lease、本地 compare-and-delete 保留。

**在同一份完整但失敗的 log 中**，PR 等待零 cleanup、人工 squash 後 remote → worktree → local → Backlog → record-last、六種來源形狀，以及 response-loss／restart／withdrawal 與 authorization-race 測試均有 PASS。原 repair／ticket-executor／ticket-finalization 亦通過。

該完整執行的真實 `test.cjs` 證據 SHA：builder 與 detached Review 為 `6986181d3ad4bf7967da9db17f57074c10ff91a3`；active dirty recovery 為 `03469e92f98e8426e401b9af4b4d75589d79cfbc`；launch-window recovery 為 `1f20c7ff80e43c14851ed771de2dcfc8b5f66e63`。這些局部證據不能抵銷整套 exit 1。

保留文件中的 **latest-observation 邊界，不是 GitHub／Git 跨系統原子交易**：最後 GitHub authorizer 期間重新建立的 remote task ref 仍受保護，但已合併本地 worktree／ref／record 可能被移除。未宣稱消除跨系統觀察競態。

## 未驗證項目與結案狀態

- 沒有任何一份本輪完整 `npm run check` 同時滿足 exit 0 與無 FAIL；**T07 驗收條件尚未全部成立**。
- Windows 沒有 native file symlink 權限。log 明列 Linux file／directory／dangling symlink 情境未跑，另有 `git-symlink worktree/ownership` 的 Windows EPERM skip；junction／Windows lock 覆蓋不能代表 Linux 全部通過。
- 真實 GitHub 權限、PR／CI／必要檢查與保護規則、受保護 repo 的人工 merge／cleanup、部署／遷移與真實 #121 均未驗證或操作。
- 兩個改動檔的主動 LSP probe 為 inconclusive（push-only、silent-on-clean），未將空 diagnostics 當成 clean；型別結果以實際 `tsc --noEmit` 成功為證據。
- 結案程序查核未發現本輪測試／runner／wrapper 程序存活；全部工作紀錄與獨立修復 worktree 留存。舊驗收草稿已改為最終未通過，不再標示執行中。

後續若另行授權：先釐清 Windows process-test 的原同步／UTF-8 失敗，保留 deadline 與雙程序清理證據，再於單一版本重新聚焦及完整驗收。**本次到此結案，不宣稱離線驗收、線上驗收或部署完成。**
