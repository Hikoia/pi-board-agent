# pi-board-agent 工作流程圖：交付紀錄

- [互動 HTML](pi-board-agent-workflow.html) · [可編輯規格](pi-board-agent-workflow.json)
- 圖表類型：`workflow`，規格版本：`2`，Archify：`2.17`。
- 依據程式碼版本：`21918074819ddef7caf3b69e48b202410368612f`。
- 圖文為繁體中文；Archify 未支援繁體中文 locale，固定 Viewer UI 與 `<html lang>` 回退為英文。

## 驗證與檔案身分

```text
diagram_type: workflow
output: D:/Project/pi-board-agent/docs/diagrams/pi-board-agent-workflow.html
specification_sha256: cae24ef4b22d7938d6517f95745c66130aea147a7dd448ddaeefe52f4b020893
specification_bytes: 6467
artifact_sha256: b8da70590d1597e6575d94f8bc89b3bfea37e7b44b6bedacc8b5f296c341c59f
artifact_bytes: 818845
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 0
```

- [確定性產物驗證 receipt](pi-board-agent-workflow.delivery.json)：`deliver` exit 0，九項檢查通過，composition 無錯誤或警告。
- [自動瀏覽器證據](pi-board-agent-workflow.visual-check.json)：`visual-check` exit 0，狀態 `pass`，綁定上述 HTML SHA-256；預設 READ／Still。
- `correction_rounds` 指首次交付後的視覺修正次數，不含交付前的規格驗證修正。

| 瀏覽器尺寸 | 文件 scrollWidth × scrollHeight | 水平／垂直溢出 |
| --- | --- | --- |
| 1440 × 900 | 1440 × 900 | 無／無 |
| 1600 × 1000 | 1600 × 1000 | 無／無 |
| 1920 × 1080 | 1920 × 1080 | 無／無 |
| 2048 × 1320 | 2048 × 1320 | 無／無 |

視覺檢視另由具影像能力的助理實際檢視 1440 × 900、2048 × 1320 的明暗主題共四張截圖：節點與標籤未截斷，箭頭可追蹤，未見不相關連線交叉，圖例與控制列分離，三張說明卡完整呈現。未另行手動測試搜尋、聚焦或匯出操作；不把截圖檢視當作完整互動測試。自動 receipt 的 `visualReview: pending` 保持原樣，與本次獨立視覺檢視分開記錄。

[查看四張實際截圖](pi-board-agent-workflow.visual-check.html)

## 已核對的程式碼依據

| 圖中內容 | 程式碼／文件 |
| --- | --- |
| 啟動檢查、獨占 owner、遷移後才開放執行 | `src/index.ts:203–452`：`performStart` |
| 每輪恢復、共享模型容量、單一非阻塞 finalizer | `src/loop.ts:374–483, 747–808`：`tick`、`processClosedDoneCards` |
| 認領、保留原 worktree、持久 run、可信回覆授權 | `src/ticket-executor.ts:1047–1294`：`launch` |
| 成功／技術失敗／Needs Human 分流 | `src/ticket-executor.ts:505–548`：`outcome`；`src/loop.ts:502–745`：`processReviewCards` |
| 強制隔離的精確 SHA 審查 | `src/review.ts:314–472`：`runReview` |
| 人工關閉後的授權、衝突與技術重試、Backlog 確認 | `src/ticket-executor.ts:1303–1600`：`finalizeClosed` |
| 原生 merge、正常 push、遠端證明、依序清理 | `src/ticket-worktree.ts:930–1301`：`finalizeAccepted` |
| Builder 操作、恢復條件與安全邊界 | [架構](../architecture.md)、[操作手冊](../runbook.md)、[Builder 程序](../../skills/board-agent/SKILL.md) |

圖中主線描述正常 Task 執行；已關閉 Done 的其他 Issue、技術重試與清理保護由說明卡補充。無 task refs 的歷史收尾仍須通過身分與恢復狀態檢查，不代表可忽略損壞／待恢復紀錄。Diagram 驗證不等於插件測試；本次未改動插件程式碼，也未啟動模型任務或操作 GitHub 看板。
