# 專案 AI 開發指引

本檔是此 repository 共用的 AI 指引入口；Claude 的入口檔只連到這裡，避免維護兩份規則。以繁體中文溝通，保留常用 engineering terms。此檔補充使用者與全域指引，不取代當次明確要求。

## 開始工作

- 先確認 `git status --short`，保留既有未提交變更；不要把目前工作樹誤當成乾淨的 main。
- 小型修改直接處理，依實際風險選擇 frontend／backend／QA 的相關指引，不因碰到專案就載入所有角色或啟動 agents。
- 先讀受影響程式與對應文件，使用 targeted `rg`。README／docs 是導覽；實際 scripts、contracts、migration、service 與 workflow 才能證明目前實作。發現落差時修正文檔，不依過時文件恢復舊行為。
- 保持改動聚焦；UI 調整不要順便改 RTP、API、餘額或資料。修改文件時不需為此執行會寫入 DB 的測試。

## 專案地圖

| 路徑                                                                       | 用途                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/src/views/`                                                      | Vue 遊戲與玩家頁面                                        |
| `apps/web/src/components/ui/`、`apps/web/src/styles/ui.css`                | 共用 UI、尺寸及顏色                                       |
| `apps/web/src/stores/`、`composables/useLiveChannel.ts`、`lib/game-rpc.ts` | 狀態、共用 WS、RPC／重試                                  |
| `apps/server/src/modules/`                                                 | 各遊戲 router、service、數學規則                          |
| `apps/server/src/lib/`                                                     | 錢包 ledger、曝險查詢、schema contract、共用 repositories |
| `packages/contracts/src/`                                                  | 前後端共用 Zod contracts／金額工具                        |
| `apps/server/src/migrations/`                                              | 連續版本 migration 與 registry                            |
| `e2e/`                                                                     | Playwright；包含 mocked WS、viewport 與真實服務流程       |
| `docs/`、`deploy/`                                                         | 功能說明、驗證與部署 runbook                              |

這是 PLAYER 測試幣平台；不含充值／提領金流。百家樂、Mines、Plinko、Hi-Lo 共用錢包。`.claude/launch.json` 是本機啟動設定，不是規格；其中外部 backoffice 路徑不是本 repository 的程式。

## 啟動與資料庫

- Runtime 固定 Node `22.19.0`、npm `10.9.3`。使用現有 lockfile、`nvm use`／`npm ci`，不要任意升級 runtime。
- 本機服務：web 5173、API／WS 4000、PostgreSQL 由 Docker Compose 管理。前端使用 `/api` 代理；forwarded port 不可硬編碼使用者端的 `localhost:4000`。
- API／worker 不會自動 migrate。先查 `npm run db:migrate:status`；schema 不符時依 [migration runbook](deploy/database-migrations.md) migrate，再啟動服務。不要以 seed、清空 DB、改 migration history 或關閉 schema 檢查解決啟動失敗。
- 現有 `.env` 不得直接用 example 覆蓋；環境設定不得寫入文件、log 或 commit。`HILO_ENABLED` 的 example 預設 false；需明確設定 true 才接受新局，不要把本機開啟狀態當成預設值。
- 已套用 migration 不得修改或重新排序。新增 schema 需同步 migration registry、`schema-contract.ts` 與 migration 驗證。
- 有 ACTIVE Hi-Lo 局時，不得回退到不計 Hi-Lo 曝險的舊 server。優先關閉新局旗標並保留結算、schema、ledger 與 idempotency 資料。
- Integration tests 會寫入／清理資料，只用可丟棄專用 DB：core API 使用 `baccarat_core_api_test_*`，migration suite 使用 `baccarat_migration_test_*`。不要繞過測試內的名稱檢查。不要對一般開發 DB 或 production 執行清理型測試。

## UI：避免重複出現的對齊、閃動與動畫問題

- 遊戲大廳 `/lobby`、百家樂選桌 `/baccarat`、百家樂牌桌 `/game/:tableId`、Hi-Lo、Plinko、Mines 都使用 `AppPageHeader`，不要另畫返回箭頭或各自重寫 header。
- Header 外層左右留白統一使用 `var(--ui-page-gutter)`（目前固定 16 個 CSS px）。百家樂選桌與牌桌用頁面 `padding-inline`；大廳輪播需要滿寬，因此只在 header 設定左右 margin。不能重複加兩層留白，也不能沿用 `.player-page` 會縮放的 `12px` 當作已對齊。
- 箭頭偏移先檢查外層 padding／margin、mobile-forever 轉換及共用 grid，不用 translate、負 margin 或單頁箭頭偏移補償。Header 標題保持水平置中；右側操作使用 actions slot。
- 百家樂牌桌 header 只保留廳名與「遊戲規則」，不恢復「桌號｜秒數｜限紅」subtitle，也不保留空白副標列。這是顯示調整，不得刪改實際投注限制。
- `ui.css` 及 Hi-Lo／Plinko 頁面排除 `postcss-mobile-forever` 的 px 縮放；Mines 仍會縮放。共用尺寸以 CSS variable 傳入，修改前先檢查 `apps/web/vite.config.ts`。
- Hi-Lo 要維持 `100dvh`（含 `100vh` fallback），操作與餘額在同一螢幕內；牌序隱藏 scrollbar，以左右箭頭與觸控捲動。不要用整頁橫向溢位換空間。
- 正常等待 WS 時不新增恢復按鈕、狀態區或替換整個頁面。既有按鈕顯示忙碌狀態並鎖定操作，維持其他控制項的透明度、尺寸及位置。永久不可用（如倍率超限／不能收款）的狀態仍需可辨識。
- Hi-Lo 固定保留中央牌容器與左右兩個選項 slot；A／K 切換只更新內容、事件與 accessible label。不要以牌值、version 或 choice 當 key 反覆重建這些固定 slot。牌序清單則保留正常的 sequence key。
- Hi-Lo 猜牌結果以百家樂酒紅斜紋牌背原地翻正；免費換牌與局中跳牌共用「舊牌向左滑出，再翻開新牌」動畫，依 preview version／step 辨識新結果，相同牌面也播放。等待回覆時保持舊牌不動，換牌按鈕的 busy 狀態涵蓋通訊與動畫。等待 server 與播放動畫分開管理，動畫不得決定或重新抽取遊戲結果。
- 全站按鈕與可點擊遊戲格子不做 hover 高亮、變色或浮起；按鈕與選單（含 summary／role=button／role=combobox）聚焦時不新增 outline、邊框或光暈，滑鼠與鍵盤一致；保留鍵盤操作、按下 `:active`、選取與停用狀態及原本邊框。文字輸入框與可捲動清單的焦點提示不在移除範圍。檢查共用 UI 也要檢查各頁 scoped styles，避免單頁另加 hover 覆寫。
- 動畫只作用於牌，不能帶動 layout；完成、取消、卸載、換帳號時清理 timer／observer。尊重 reduced motion，並保留中斷動畫時的解鎖處理。
- 驗證正常、延遲 WS、斷線、回覆遺失、reduced motion 及 A／K 狀態，不能只測立即回覆。UI 詳見 [共用元件文件](docs/ui-components.md)。

## 遊戲正確性與錢包

- 牌面、地雷、Plinko 結果、勝負與派彩由 server 決定；client 只呈現結果。不得按近期輸贏／實測 RTP 動態調整 RNG。
- Hi-Lo 每次獨立、有放回抽 52 張之一，A 最小／K 最大。2～Q 選項包含同點數；A／K 使用嚴格大小與相同，沒有必勝選項。
- Hi-Lo 整局只套一次 `0.94`：倍率為 `0.94 / 累積成功機率`；skip 不更動倍率。52 是局中跳牌次數上限，不是牌堆耗盡。下注前免費換牌不占額度。
- 精確倍率用 BigInt 有理數；金額用現有分幣工具，只在最終入帳 ROUND_HALF_UP。倍率顯示兩位小數、金額顯示整數，顯示值不可回流計算。
- 倍率上限在抽牌前判斷，不截斷派彩；新增遊戲須納入共用未結算最大派彩、20 億帳戶上限、ledger、walletVersion 與每日損益。
- Plinko 目前 ruleVersion=2：所有排數／風險的左右各 2 格機率恰為 v1 的 2 倍，依新權重縮放整張倍率表，RTP 維持約 95.5%。先抽落點再抽符合落點的路徑，不再是逐排獨立左右各 50%。保留 v1 表供稽核；舊投注／重播不得按新表重算。調整需更新 ruleVersion 並驗證全部 27 表，詳見 [Plinko](docs/plinko.md)。
- Mines／Plinko／Hi-Lo client 共用 `/api/ws` 與 `createGameRpc`，不另開 socket 或自動退回 HTTP mutation。Mines／Plinko 仍有舊 client 相容 POST；Hi-Lo 沒有 HTTP mutation fallback。
- 不確定回覆以原 action／idempotency key 確認，每次 attempt 使用新 requestId。先處理重播再驗證版本；以 round／preview version、walletVersion 及使用者隔離防止舊回覆覆蓋新狀態。
- 延續既有 lock order／原子交易與 ledger 唯一約束。不要把各遊戲 lock order 隨意統一；修改前讀對應 service，避免與百家樂形成鎖循環。
- `mines.*`、`plinko.*`、`hilo.*` idempotency scope 永久保留；`hilo-preview` 沿用一般 retention，兩者不可混淆。詳見 [retention](docs/data-retention.md)。

## 驗證與交付

從 repository 根目錄執行，先選受影響範圍，不為簡單樣式／文件修改重跑所有 DB suites：

```sh
npm run typecheck --workspace web
npm run typecheck --workspace server
npm test                         # contracts + server，不包含 web
npm test --workspace web
npm run lint
npm run build
E2E_MOCKED_ONLY=true npm run test:e2e -- e2e/hilo-mocked.spec.ts e2e/viewport.spec.ts
```

- Mocked E2E 不啟動 API／worker，但需要 Vite 與 Chromium／WebKit；不等於真實 PostgreSQL／WS 交易驗證。
- Shared header／留白修改需跑跨大廳、百家樂選桌、百家樂牌桌、Hi-Lo、Plinko、Mines 的 viewport tests；手機至少檢查 320×568、390×844、483×771。
- 本機 `.env` 可能影響 env tests；例如 production 子程序不接受 `CORS_ORIGIN=*`。隔離測試環境值，不要修改 production 驗證來讓測試過關。
- ESLint 對「ignored／no matching configuration」檔案不算完成檢查。Prettier 只格式化實際修改檔，不做無關的全 repo reformat。
- CI 的實際 job 以 `.github/workflows/` 為準，不把文件中的規劃當成已啟用的 required check。參考 [CI 說明](docs/ci.md)。
- RTP 模擬沿用 server math，報告投入、含本金派彩、局數、停止策略、跳牌用盡處置及抽樣波動；不能把一次亂數結果當成理論 RTP，也不要用隨機值是否命中固定區間做 flaky assertion。[模擬報告](docs/hilo-strategy-simulation.md)
- 回覆應清楚交代變更、實際執行的驗證與尚未處理的限制；不要把未執行項目寫成通過。

進一步規則：[Hi-Lo](docs/hilo.md)、[Mines](docs/mines.md)、[Plinko](docs/plinko.md)、[部署](deploy/README.md)。
