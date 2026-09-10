# pi-board-agent 過度設計與優化稽核

> 稽核基準：`main@9d0b23d62ce61b4c8062b89a5015515f0ba26d33`  
> 規模：47 個 tracked files、14,525 行；`src/` 6,865 行  
> 驗證：型別檢查通過；offline suite 222/222 checks 通過  
> 方法：5 個平行研究視角、線上一手來源比對、3 個對抗式 verifier；原始碼未被修改，本文件只記錄結果。

## 結論

整體不是全面性的過度設計；較準確的判定是 **targeted over-design（局部過度設計）**。

可刪部分主要是舊 plan-PR lifecycle、被 explicit model 遮蔽的 `builder_tier`、重複 config-template fallback，以及在 Git-only 發行前提下無作用的 bundle metadata。相反地，owner lock、persistent worktree、execution record、WorkflowManager journal/lease、claim 後 fresh refetch、atomic state 與 destructive Git guards 都對應真實失敗模式，不應為了減行數而移除。

比過度設計更急迫的是三個 P0：

1. closed `Done` → base merge 主路徑不可達。
2. watchdog mention lane 預設信任未驗證作者，並可啟動帶 coding tools 的 agent。
3. Docker always-on 路徑與 Pi `--print` 生命週期、exact-SHA gate 互相矛盾。

對抗式 verifier 沒有接受最初草稿的整體判定，但一致確認上述核心問題。原草稿中未被證實的 `/init` 故障、全面刪除 Docker/watchdog/setup、API 節省與 1,400–1,900 行淨減估算均已撤回。

## 實際主流程

```text
Pi session_start 或 /board-agent run
  → config / revision preflight
  → GitHub Project metadata
  → owner.lock
  → BoardLoop tick
      1. listCards()
      2. TicketExecutor.reconcile()
      3. Task design / Story refinement
      4. PR watchdog
      5. closed Done finalization
      6. Ready builders + 最多一個 reviewer

Ready Task
  → fresh read → assignee claim → fresh read
  → persistent ticket worktree
  → WorkflowManager journal / lease / resume
  → Review → Done → 人工關閉 issue
  → direct merge 到 base（目前不可達）
```

`TicketExecutor` 已集中 builder 的 durable lifecycle；但 review 與 destructive finalization 仍由 `BoardLoop` 直接操作 `TicketWorktrees`（[`src/loop.ts:873-1005`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/loop.ts#L873-L1005)）。合理方向不是任意拆檔，而是讓 finalization invariants 回到 executor 或一個專用深模組。

## P0：先修這些

### 1. Closed Done finalizer 不可達

證據鏈：

- finalizer 只選 `card.closed === true`（[`src/loop.ts:940-948`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/loop.ts#L940-L948)）。
- 接著呼叫 `tryClaim()`（[`src/loop.ts:967-970`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/loop.ts#L967-L970)）。
- `tryClaim()` 對非 `OPEN` issue 一律回傳 `false`（[`src/gh.ts:376-413`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/gh.ts#L376-L413)）。

不能只刪 OPEN 判斷，因為後續還會：

- 使用 tick 初始 snapshot，而非 merge 前 fresh revalidation。
- 執行 `git pull --ff-only`，可能吸收批准後新增的 remote commit（[`src/ticket-worktree.ts:461-478`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/ticket-worktree.ts#L461-L478)）。
- push 後立即刪 worktree 與 branches（[`src/ticket-worktree.ts:528-552`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/ticket-worktree.ts#L528-L552)）。
- already-merged cleanup 缺 dirty check，並帶有強制／recursive fallback（[`src/ticket-worktree.ts:532-580`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/ticket-worktree.ts#L532-L580)）。

最小安全方向：建立 closed-ticket 專用 finalizer；fresh 驗證 repo、Issue、closed、Done、record、path、branch、clean/lock 狀態；固定 `origin/task` SHA；拒絕 local/remote drift；從 exact base 與 task SHA 產生結果；non-force push；驗證 remote 上的實際 merge/squash result commit 後才 cleanup。

必要 E2E：正常 merge 與重複 tick、SHA drift、dirty/locked、push race、crash-after-push，以及 merge/squash 兩種結果驗證。

### 2. Watchdog mention 的信任與 cursor 缺口

- watchdog 與 mention response 預設開啟（[`src/config.ts:95-103`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/config.ts#L95-L103)）。
- mention filter 沒有驗證 `OWNER`／`MEMBER`／`COLLABORATOR`（[`src/watchdog.ts:327-350`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/watchdog.ts#L327-L350)）。
- REST query 沒讀 `author_association`（[`src/gh.ts:821-839`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/gh.ts#L821-L839)）。
- `filter(c => c.id !== lastSeenCommentId)` 並不是 cursor，會讓舊 mention 在後續 tick 重播。
- dynamic-workflows 3.10.0 預設建立 coding tools（[上游 `agent.ts`](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/agent.ts#L658-L661)）。

最小處理：將 `respond_to_mentions` 預設改為 `false`；查詢並驗證作者關係；用 last-seen index 後的 slice 實作 cursor；reply agent 使用明確 read-only/no-coding-tools policy；補 outsider、replay 與多留言測試。

### 3. Docker always-on 目前不可用

- `entrypoint.sh` 以 `pi --print` 啟動並假定 timer 保活（[`entrypoint.sh:6-21`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/entrypoint.sh#L6-L21)），但 Pi 0.84.4 定義 `--print` 為「print response and exit」（[Pi README](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/README.md#L543-L546)）。
- Docker 以 local path 安裝 extension（[`Dockerfile:41-44`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/Dockerfile#L41-L44)），runtime gate 卻只接受 full-SHA Git ref（[`src/runtime.ts:63-108`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/runtime.ts#L63-L108)）。
- `.dockerignore` 排除 `.git`，Compose 又以 host source 覆蓋 image 內程式，Pi 也未 pin 版本。

目前應標示 Docker unavailable，而不是放寬 exact-SHA gate。若 always-on 仍是需求，需改成可長期存活的 SDK/RPC host、pin Pi/Node/gh、使用 immutable package identity、移除 production source bind mount，並加容器 lifecycle smoke test；若需求已取消，再完整刪除 Docker surface。

## P1：高信心改善

| 問題 | 最小處理 |
| --- | --- |
| Project owner 與 repo owner 混用 | 分成 `projectOwner`、origin `repoOwner/repoName`；single-repo 模式只允許目標 repo 的 Issue。證據：[`src/config.ts:178-187`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/config.ts#L178-L187)。 |
| 候選分類非 fail-closed；`task/t001` 非全域唯一 | 保存 GraphQL `__typename`；只接受 exact target-repo Issue Task；新 branch 使用 issue number/item ID，既有 record 保留舊名稱。證據：[`src/gh.ts:212-267`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/gh.ts#L212-L267)、[`src/workflow-prompt.ts:25-51`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/workflow-prompt.ts#L25-L51)。 |
| Agent 自有 runtime files 可能使 clean gate 永遠失敗 | clean predicate 精確排除 `.pi/board-agent` 與 `.pi/worktrees`，但仍檢查真正的專案檔；不要假定 `.git/info/exclude` 對 linked worktree 等價。 |
| Review isolation 可能 fail-open 到主 checkout | Board Agent 自行建立並驗證 ephemeral review worktree；建立失敗就不啟動 reviewer；前後驗證主 checkout branch/HEAD/status。上游行為：[worktree fallback](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/worktree.ts#L36-L58)。 |
| Story refine 缺 exactly-once 邊界並可能餓死其他 Story | 不引入通用 saga；只加 Story-specific deterministic marker／小 journal，restart 先 reconcile，field failure fail closed，候選採輪替。 |
| `gh`、Git、Telegram I/O 無 deadline | 建立一個有界 command runner、終止整個 Git/SSH process tree、停用 interactive credentials；HTTP 使用 abort；mutation timeout 後 refetch/reconcile，不盲 retry。 |
| Node 宣告與實際 lock 不一致 | repo 宣告 Node ≥18，但 Pi 0.84.4 要 Node ≥22.19；選定並宣告真實範圍，加 `test`/`typecheck`/`check` scripts 與 Node 22 CI。 |

`fieldValues(first:20)` 可能截斷，但尚未證明 production Project 真的受影響。若改用 `fieldValueByName`，須先取得 canonical field name，因官方 API 名稱比對區分大小寫（[GitHub GraphQL schema](https://github.com/github/docs/blob/3a6ec97402d27f2d33d7a930378874de8c2762c6/src/graphql/data/fpt/schema.docs.graphql#L41762-L41770)）。

## 真正值得刪／縮的項目

1. **刪除無 production caller 的 plan-PR lifecycle。**  
   可移除 `openPlanPr()` 與 renderers（[`src/plan.ts:49-126`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/plan.ts#L49-L126)）、只供它使用的 `openPr()`/`findPr()` 與 `commitsAhead()`。保留 production 仍使用的 `summarizePlans()`、`ensureLabels()` 與 branch helpers。

2. **移除永遠被遮蔽的 `builder_tier`。**  
   本地同時傳入 tier 與非空 model（[`src/workflow-prompt.ts:73-82`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/workflow-prompt.ts#L73-L82)）；dynamic-workflows 的 precedence 是 explicit model > agentType model > tier（[上游來源](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/v3.10.0/src/workflow.ts#L710-L716)）。依現況直接移除 tier 最小。

3. **保留可用的 `/init`，刪除約 64 行重複 template fallback。**  
   `/init` 已在 Pi 0.84.4 Jiti loader 下驗證可用；問題是 packaged `config-template.yml` 與手寫 YAML fallback 雙份維護（[`src/config.ts:212-285`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/config.ts#L212-L285)）。缺 template 應 fail fast。

4. **Git-only 前提下移除 `bundledDependencies` metadata。**  
   此 fork 為 private、Git-only；Pi 的 Git install 會執行 `npm install`（[Pi packages docs](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/packages.md#L167-L187)）。先做 clean Git-install smoke test。這不會刪除 runtime dependency。

5. **兩套 watchdog scheduler 擇一或互斥。**  
   BoardLoop 每 tick 執行 watchdog（[`src/loop.ts:450-465`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/loop.ts#L450-L465)），另有 standalone interval command（[`src/index.ts:439-513`](https://github.com/Hikoia/pi-board-agent/blob/9d0b23d62ce61b4c8062b89a5015515f0ba26d33/src/index.ts#L439-L513)）。若沒有 watchdog-only 需求就刪 standalone surface；否則必須互斥。

## 不應刪的複雜度

- Owner lock 與 token-safe release。
- Exact-SHA revision latch 與 fleet verifier。
- Ticket execution record、persistent worktree、WorkflowManager journal/lease/resume。
- Claim 後 fresh refetch 與 TOCTOU guard。
- Atomic JSON、managed-path、branch、dirty guards。
- 未完成 fleet inventory 前的 legacy v1/inflight reader 與 archive。
- `yaml` 與 `pi-dynamic-workflows` dependencies。
- 222 個 recovery/race/security checks；目前缺的是關鍵 E2E，不是測試數量。
- Persisted result normalizer。

## 不建議現在做

- 為了行數全面改寫測試成 `node:test`。
- 減少安全用途的 fresh `getCard()`。
- 在沒有 rate-limit、response bytes、p95 tick/shutdown 數據前做 API 微優化。
- 無需求證據就引入 webhook、queue、DB 或通用 saga framework。
- 未盤點 fleet 使用情況前直接刪除 Docker、watchdog、setup 或 legacy APIs。

## 建議執行順序

1. 立即停用 mention response、標示 Docker unavailable，finalizer 修好前不要依賴 close 自動 merge。
2. 先補 BoardLoop closed/Done E2E、SHA drift/dirty/locked/crash-after-push、outsider/replayed mention 測試。
3. 修 closed-specific exact-SHA finalizer 與 watchdog trust/cursor/tool policy。
4. 分離 project/repo identity、收緊 Issue Task 分類與 branch key、修 clean gate、讓 review isolation fail closed。
5. 補 Story-specific idempotency/fairness、I/O deadline、完整 config validation 與 Node 22 CI。
6. 最後才刪 plan-PR lifecycle、`builder_tier`、template fallback、Git-only bundle metadata；盤點後再決定 standalone watchdog 與 Docker 去留。

## 尚待量測／決策

- staging Project 的 closed/Done → merge E2E。
- branch protection 是否允許 direct push，以及 issue closure 批准哪個 SHA。
- production Project 是否 multi-repo、含 PR/Draft，或單卡超過 20 個 field values。
- fleet 是否仍使用 standalone watchdog、legacy records、舊 plan branches 或 `setup.sh`。
- Docker build/start/restart/shutdown smoke test。
- 真實 GraphQL rate-limit cost、response bytes、p95 tick 與 shutdown。

**Net：目前無法負責任地估算可淨減行數；可確認的 dependency 減少為 0。**
