# 沙海神殿

> 以下原始數學規則屬於 v1。平穩型 v2、完整參數 v3、手動 RTP 草稿與確認發布流程見 [RTP 設定](storm-rtp-control.md)；未發布前維持 v1。

入口 `/storm-demo`，大廳第六張「沙海神殿」。需要登入 PLAYER 帳戶，使用平台共用測試幣；不含充值、提領或現實獎品。盤面、免費回合與派彩全部由 server 決定，前端只播放 server 回傳的動畫事件。

## 帳戶與結算

- 投注選單依序為 10／50／100／200／500／1000／2000／5000，預設 10。免費系列沿用觸發時的投注額。移除任意重設 10,000 點、免費體驗與固定結果入口。
- 每次 spin 在單一 PostgreSQL transaction 內保存盤面、更新免費進度、記錄投注 debit 與派彩 credit；零額免費回合亦保留完整 ledger。
- `storm_sessions` 每個帳戶一份進度；`storm_rounds` 保存不可修改的每局結果、ruleVersion、版本與動畫 frames。重新整理恢復最新盤面與免費回合；API 保留最近五局資料，規則視窗不顯示歷史列表。
- 共用 `walletVersion` 防止舊餘額覆蓋新結果。計算以分幣工具處理；畫面顯示整數，不將動畫數字回流結算。
- 同一帳戶以 user-first lock order 序列化交易。`expectedVersion` 拒絕其他分頁已更新的舊操作，idempotency replay 先於版本檢查；`storm.spin` keys 永久保留。
- 回覆遺失時，瀏覽器保留原 action 與 idempotency key，重連使用新 requestId 確認同一操作。確認前鎖定投注額，沒有 HTTP mutation fallback。換帳號或卸載時隔離舊回覆並清理動畫。
- 每日損益包含實際扣幣與派彩；免費回合的投注金額為 0。

## API 與 WS

前端統一使用 `/api` proxy。

| 介面                       | 用途                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/storm/config`    | 投注額、開關、ruleVersion、最高派彩與 RTP 狀態                                                        |
| `GET /api/storm/state`     | 帳戶進度、最後一局、最近五局、餘額與 walletVersion                                                    |
| `/api/ws`：`storm_command` | `action: { kind: "spin", amount, expectedVersion, ruleVersion: 1 }`，另帶 requestId 與 idempotencyKey |
| `/api/ws`：`storm_result`  | 成功回傳 session、round、balance、walletVersion；失敗沿用共用錯誤 contract                            |

Contracts 在 `packages/contracts/src/storm.ts`，client 不可提交盤面、RNG、免費次數、派彩或展示選項。所有讀取與 mutation 均驗證登入與 PLAYER 權限。

## 規則與風險上限

`ruleVersion=1` 沿用原創展示版的符號權重與派彩表，改用 Node `crypto.randomInt`，不依近期輸贏調整 RNG。**RTP 尚未校準，config 的 rtp 為 null**，不能宣稱為參考遊戲的機率或 RTP。

- 6×5，任意位置 8+ 一般符號消除，最多 12 次連消。8–9 個倍率：紅寶石 1.2、翡翠 1、藍晶 0.5、琥珀 0.6、蓮花 0.8、聖甲蟲 0.4、日守衛 2、月守衛 1.5；10–11 個乘 2，12+ 乘 3。
- 八種一般符號權重依序 12、13、16、17、14、15、3、3%；神殿 3%、超級神殿 1%、倍數球 3%。球值 2／3／5／10 等機率。
- 任一盤面 4+ 神殿觸發 15 免費回合；免費中 3+ 神殿加 5，系列總授予上限 100。
- 本局有基礎贏分才收集最終盤面的倍數球。免費有贏分時，每顆球以一般 20%／強化 60% 機率翻倍，可連續升級，上限 1000。
- 有新球時套用本局收集值加此前免費累積值；沒有新球只派基礎分。普通回合不保留累積值。
- 同盤 4+ 神殿觸發免費回合時，1／2／3／4 個超級神殿分別給 100／500／5000／25000 倍一次性獎勵；有超級神殿進入強化系列。
- 每局最高派彩為投注額 × 25,000，達上限立即停止連消、升級與剩餘免費回合。觸發獎勵不重複計入免費系列總分。

開始付費局前預留「本局＋最多 100 免費回合」的最高派彩空間。免費系列剩餘曝險為 `(freeLeft + 100 - freeGranted) × amount × 25000`；沒有免費回合時為 0。加上其他遊戲曝險及扣款後餘額不得超過 20 億。此檢查在抽選前進行，不因帳戶餘額截斷派彩或重抽結果。

## RTP 測算（2026-10-25）

目前 `ruleVersion=1` 的 **Monte Carlo 實測 RTP 為 5,501.43%**，約為投注額的 55.01 倍總派彩。這是目前未校準規則的估計，並非設定值或精確理論 RTP；config 仍維持 `rtp: null`。

直接呼叫 server 的 `spin` 與預設 `crypto.randomInt`，模擬 **5,000,000 次付費轉動＋全部 3,259,929 次免費轉動**。每個獨立樣本包含一次付費轉動及其完整免費系列、加送回合、超級神殿獎勵與封頂停止，沒有未完成系列。固定投注 20 幣，不加減碼、不設停利停損；每個樣本重新提供虛擬資金，排除破產或帳戶上限造成的停止偏差。沒有呼叫投注 API、讀寫 DB 或操作玩家錢包，也沒有使用展示盤面、固定結果或 Godly 選項。

| 項目                         |                 結果 |
| ---------------------------- | -------------------: |
| 總投注                       |       100,000,000 幣 |
| 總派彩                       |     5,501,431,270 幣 |
| 玩家淨損益                   |    +5,401,431,270 幣 |
| RTP＝總派彩 ÷ 總投注         |         5,501.43127% |
| 標準誤                       |       42.62 個百分點 |
| 常態近似 95% 區間            | 5,417.91%～5,584.96% |
| 完整樣本派彩高於 20 幣的比例 |            31.95022% |

標準誤以完整付費／免費系列為獨立樣本計算，沒有把同一系列內相依的免費轉動當成獨立樣本。另一批獨立 1,000,000 個樣本得到 5,522.31%（近似 95% 區間 5,330.08%～5,714.55%），與主樣本一致。高額獎勵造成明顯長尾，這些區間是抽樣估計，不能當成未來回報保證。

### 回報來源

以下各列都以總付費投注額為分母，可以直接相加；不是各模式個別的 RTP。

| 來源                                 |          派彩 | RTP 貢獻（百分點） |
| ------------------------------------ | ------------: | -----------------: |
| 付費回合符號與倍數球（不含觸發獎勵） |   383,760,810 |             383.76 |
| 超級神殿一次性觸發獎勵               |   169,164,000 |             169.16 |
| 一般免費系列                         | 1,273,235,908 |           1,273.24 |
| 強化免費系列                         | 3,675,270,552 |           3,675.27 |
| 合計                                 | 5,501,431,270 |           5,501.43 |

免費系列合計占總派彩 **89.95%**。不含免費與觸發獎勵的付費回合已貢獻 383.76%，因此單獨降低免費觸發率仍不足以把 RTP 降到 100% 以下。

### 免費回合為何容易得到高派彩

| 項目                         |  一般免費 |    強化免費 |
| ---------------------------- | --------: | ----------: |
| 觸發系列數                   |    81,876 |      33,233 |
| 每次付費觸發率               |  1.63752% |    0.66466% |
| 每系列平均免費轉動           |     28.31 |       28.34 |
| 單次免費轉動有派彩           |    37.14% |      37.14% |
| 整個系列平均派彩／原投注額   | 777.54 倍 | 5,529.55 倍 |
| 整個系列派彩中位數／原投注額 |  395.5 倍 |  1,952.2 倍 |
| 系列派彩大於原投注額         |  99.9206% |    99.9248% |

平均系列派彩不含付費觸發那局的派彩；最後一列只比較免費系列派彩與觸發那局的 20 幣，沒有扣除此前等待觸發的累計投注。整體免費觸發率 2.30218%，約每 43.44 次付費觸發一次。

- 初始授予 15 轉，3+ 神殿再加 5，實測平均延長到 28.32 轉。
- 有贏分且有新倍數球時，舊累積值會與本次球值一起放大派彩，並繼續保留到後續免費回合。
- 倍數球以一般 20%／強化 60% 機率反覆翻倍，單球上限 1000。升級可以連續發生，不是每顆最多升一次。
- 目前 25,000 倍是**單次轉動**上限；某一轉封頂才取消剩餘免費回合，並非把整段系列總派彩限制為 25,000 倍。本次最高完整樣本派彩 3,291,976 幣，為原投注的 164,598.8 倍。

### 重跑與驗證

```sh
NODE_OPTIONS=--conditions=development npx tsx apps/server/src/scripts/simulate-storm-rtp.ts 5000000
```

從 repository 根目錄使用 Node 22.19.0 執行。stdout 輸出 JSON，stderr 顯示進度；採用 crypto RNG，重跑數值會不同。原始主樣本見 [500 萬次結果](storm-rtp-simulation-result.json)，獨立複核見 [100 萬次結果](storm-rtp-simulation-1m-result.json)，包含 math／contract SHA-256 與分批結果。

每個樣本檢查付費只扣一次、免費不扣款、每系列最多 100 轉、最終餘額守恆與派彩分項合計。既有 20 項 Storm math tests、server typecheck 與模擬腳本 ESLint 通過。本次僅新增離線測算腳本與結果文件，沒有調整遊戲規則或錢包。

## UI 與資產

遊戲採置中直式舞台，寬度上限 430px，頁面固定 `100dvh`（`100vh` fallback）。Navbar、盤面、餘額、操作列與 safe-area 都包含在同一個視窗高度內；`html`、`body` 與 `#app` 共用高度及整頁捲動限制，規則／設定與紀錄區仍可內部捲動。Header 使用 `AppPageHeader`。主標題改為一行，避免壓到盤面；五個操作按鈕使用固定尺寸並置中。Icon font 保留原始 left side bearing，修正字形偏左。

2026-10-25 修正固定高度：移除舊有 `max-height: 932px`，解決 430×1024 視窗只顯示 932px 遊戲、底部短少 92px 的問題；沙海神殿加入共用頁面高度鎖定，離開遊戲後解除。`e2e/storm-portrait-mocked.spec.ts` 新增一般／免費模式在 390×844、430×1024、1024×1366、393×600、393×780 之間連續調整大小的驗證，檢查各層高度、盤面比例、操作區完整可見及整頁不捲動。

此次固定高度修正通過 Chromium／WebKit 共 46 項 E2E（沙海神殿直式布局、共用 viewport 與橫向提醒），web typecheck、變更頁面 ESLint 與 E2E TypeScript 檢查亦通過；全部使用 mocked transport，未操作玩家錢包。

Navbar 沿用其他遊戲的 16px 留白、返回按鈕尺寸與置中標題；右上角只保留規則，音效按鈕及底部音效／錢包說明整列移除。排版、互動與驗證方式見 [沙海神殿 Navbar](storm-navbar.md)。

保留逐欄進出、連消、重力補位、倍數升級與收集、免費開始／結束及快速模式；音效入口與合成音效程式移除，維持靜音。等待 WS 時盤面不動；忙碌狀態涵蓋通訊與動畫。自動模式可在當局結束後停止，支援單局派彩、累計淨贏／淨損停止條件與 reduced motion。

自動回合選項依序為 10／50／100／∞，預設 10；無限選項以 `infinity` font icon 呈現，accessible label 為「無限」。「無限」只取消回合數上限，每局仍獨立向 server 請求及結算；手動停止、停止條件達標、餘額不足、斷線、錯誤、離頁或換帳戶仍會停止。無限狀態不保存，也不因重連而自動恢復。觸發免費回合時沿用既有流程，結束免費系列後不會自動回到付費投注。

2026-10-26 操作區依最新要求恢復投注加減按鈕，由左至右為快速動畫、減少、轉動、增加、AUTO，使用既有 `AppIcon` 的 `minus`／`plus` font icon。每次依 10／50／100／200／500／1000／2000／5000 切換一個級距，到達上下限時停用對應按鈕。「每次探索」保留原生金額選單，但移除箭頭並將金額置中，仍可點選或用鍵盤操作；選單與加減按鈕共用同一個值。等待回覆、播放動畫、自動進行、尚有未確認投注、免費系列與慶祝提示期間鎖定金額；調整金額本身不發出投注或改動餘額。控制列維持原本高度，只調整水平間距，所有按鈕包含在既有 100dvh 內。

2026-10-25 曾移除加減按鈕以精簡操作列，已由上述最新要求取代；「本回合消除紀錄」整列仍維持移除。

恢復操作列驗證（2026-10-26）：45 項 `StormDemoView` component tests，以及 Chromium／WebKit 共 30 項操作與直式排版 E2E 通過。涵蓋八個級距增減、選單同步、上下限、Enter 操作、等待 WS 時鎖定且不閃動、舊 20 幣免費系列鎖定、5000 幣單次結算及重整後保留；選單 `appearance: none`，沒有箭頭。目視檢查 320px 與 549px 截圖，五個按鈕同列置中，維持單一視窗高度。web typecheck、E2E TypeScript、變更檔 ESLint、Prettier、web build 與 `git diff --check` 通過。投注使用 mocked transport，未操作玩家帳戶。

投注額由共用 contracts 定義，三個 server math 版本均接受新級距；migration 19 擴充 session／round 金額限制，並將免費累計派彩欄位上限對齊既有 20 億 money contract。舊 20 幣仍可由舊 client 使用，歷史資料、未確認原 key 與免費系列保留原額；新版選單只有在確認舊投注／完成舊免費系列時暫時顯示 20，結束後回到 10。未進入免費系列的舊 20 幣選擇直接改為 10。

新級距不更動 RNG、RTP、profile、派彩上限或共用曝險檢查。若尚未啟用 math profile 而使用 v1，1000／2000／5000 的新付費局預留額分別為 25.25 億／50.5 億／126.25 億，超過 20 億帳戶上限，會在抽選及扣款前被拒絕。要開放這些金額實際投注，需另外發布最高系列派彩可容納的 profile；本次不自動發布或修改配率。其他級距仍依餘額與其他遊戲未結算曝險判斷。

本次驗證：50 項 Storm component／store tests、35 項 server math／stake contract tests、8 項 migration tests、10 項 Storm API／WS integration tests，以及 Chromium／WebKit 共 48 項 E2E 通過。涵蓋八個級距、5000 幣扣款／原 key replay、舊 20 幣免費回合、餘額與曝險拒絕、100dvh、斷線恢復及大獎動畫。DB suites 使用獨立、可丟棄的測試資料庫；沒有對玩家帳戶下注。本機明確套用 migration 19，schema 檢查為 19/19。

新觸發免費回合時，開始提示停留 3 秒後自動進行；仍可按「開始免費回合」立即開始。這段閱讀時間不隨快速動畫或 reduced motion 縮短。手動開始、Esc 關閉提示、換帳戶與離開頁面會清除計時；斷線期間不啟動，恢復可遊玩狀態後重新等待完整 3 秒。只針對新觸發的開始提示自動執行，刷新恢復或主動停止的免費進度仍由玩家手動繼續；不會自動回到付費投注。

「神殿探索完成」提示也停留完整 3 秒後自動關閉，返回一般盤面；仍可按「返回神殿」或 Esc 立即關閉。快速動畫與 reduced motion 不縮短閱讀時間，斷線或無法開始下一局也不影響關閉。手動關閉、換帳戶或離頁會清除計時，關閉只恢復畫面與焦點，不發起新投注。

單局派彩達投注額 20 倍時，顯示 BIG WIN 慶祝動畫：金色立體標題、獎金數字跳動、金幣粒子與擴散光環。沿用既有大獎門檻及 server 結果，不改機率或派彩。一般停留 3 秒、快速模式 1.8 秒後自動收起；「繼續」或 Esc 可立即跳過。reduced motion 顯示靜態獎金並保留閱讀時間。觸發免費回合時，慶祝結束後接免費開始提示；最後一個免費回合則接完成提示。離頁／換帳戶清理等待、粒子 animation frame 與 observer。

慶祝視覺共用 `WinCelebration.vue`；沙海神殿以遊戲幣顯示金額，不帶貨幣符號，其他遊戲沿用元件預設顯示。對應瀏覽器測試為 `e2e/storm-big-win-mocked.spec.ts`。

2026-10-26 修正慶祝提示的溢出：免費開始／完成提示原本使用 `overflow: auto`，170% 寬的旋轉光芒會撐出水平與垂直捲動範圍；Big Win 原本以 1.65 倍放大進場，也會使獎金文字超出左右邊界。現在光芒放在獨立裁切層，提示外層使用 `overflow: clip`，不產生 scroll container。Big Win 的文字改為從較小尺寸進場，最多放大至原尺寸，字級同時依容器寬高與獎金位數調整；底部說明及「繼續」按鈕有獨立 grid 列，不與獎金重疊。只裁切裝飾特效，標題、完整獎金與操作按鈕必須完整可見。所有提示都包含於遊戲既有的 `100dvh`（`100vh` fallback）高度內，並保留 reduced motion。

本次驗證：45 項 `StormDemoView` component tests、Chromium／WebKit 共 14 個 Big Win browser cases 通過。新增檢查涵蓋 320×480、320×568、390×844、549×761，5000 幣投注的 125,000,000 派彩、免費開始／完成提示、動畫初始／中途／最大縮放／完成、光芒旋轉及視窗 resize。檢查 document 與提示外層的雙軸溢出、內層 scrollbars、必要內容的 bounding box、獎金與按鈕是否重疊，以及提示無法捲動；使用 mocked transport，沒有操作玩家錢包。web typecheck、E2E TypeScript、變更檔 ESLint、Prettier、web build 與 `git diff --check` 通過；build 僅有既有 PWA `inlineDynamicImports` 棄用警告。手機瀏覽器工具列與真機縮放仍需實機驗收。

2026-10-25 驗證：大獎動畫、開始／完成提示與操作流程通過 39 項 `StormDemoView` component tests，另有 24 項 Plinko component tests 驗證共用元件相容性。Chromium／WebKit 合計 30 項 E2E（`storm-big-win-mocked`、`storm-demo-mocked`、`storm-special-mocked`）涵蓋大獎門檻、獎金跳動、手動跳過、快速／reduced motion、免費回合銜接、倒數與不重複投注；web typecheck、變更檔案 ESLint、E2E TypeScript 與格式檢查亦通過。全部投注測試使用 mocked transport，沒有操作實際帳戶。

原創美術概念為藍天雲海、沙漠浮空神殿、金色建築、青綠護甲、隼首石質守衛與日輪權杖。背景與海報為生成的 WebP，遊戲符號為原創 SVG。完整生成 prompt、檔案尺寸與全站圖示規範見 [圖片與圖示資產](image-assets.md)。

## 啟動與維護

1. 備份並停止 API／worker，確認目前 migration 狀態。
2. `npm run db:migrate` 套用 migration 15；`npm run db:migrate:status` 必須為 15/15、pending none。
3. 新增 `STORM_ENABLED=true` 到本機 server 設定後啟動 API／worker 與 web。範例設定保持 false，需明確開啟才接受新付費局。
4. `STORM_ENABLED=false` 只停止新付費局；已取得的免費回合、歷史與原請求 replay 繼續可用。

若有免費回合尚未完成，不可回退到不計 Storm 曝險的舊程式。保留新 schema、ledger、idempotency 與結算能力，關閉新投注後向前修復。詳見 [migration runbook](../deploy/database-migrations.md)。

## 驗證

- server math：20 項，包括重力順序、免費上限、升級／收集順序、封頂停止、seeded 金額守恆與小數餘額 contract。
- PostgreSQL：完整 core API integration 53 項，含 7 項 Storm 驗證；migration suite 6 項。均使用獨立可丟棄測試 DB，沒有清理一般開發資料。
- Storm 前端：12 項 store／component 測試，包含延遲結果、原 key 重試、換帳號、舊版本防護、自動停止、儲存失敗及卸載清理。
- Chromium／WebKit 各 14 項 Storm E2E，驗證 WS 遺失回覆重連、刷新恢復、動畫階段、自然免費觸發／封頂、長數字及 320×568、390×844、483×771、549×761、1440×900 排版。

重跑：

```sh
npm run typecheck --workspace web
npm run typecheck --workspace server
CORS_ORIGIN=http://localhost:5173 npm test
npm test --workspace web
npm run lint
npm run build
E2E_MOCKED_ONLY=true npm run test:e2e -- e2e/storm-demo-mocked.spec.ts e2e/storm-portrait-mocked.spec.ts e2e/storm-special-mocked.spec.ts
```

最終驗證另包含兩種瀏覽器各 11 項共用 viewport cases，以及 Chromium 大廳導覽，共 51 個不同 browser cases；最後調整等待狀態與 AUTO 停止後，兩瀏覽器 8 項通訊案例再次通過。完整 contracts 12 項、server 176 項（2 項環境限定項目 skip）、web 151 項 Vitest 與 12 項 Node 檢查通過；lint、全 workspace build、E2E TypeScript／ESLint 與 `git diff --check` 通過。Build 有既有 PWA `inlineDynamicImports` 棄用警告。

本機 migration 15 已套用，API／worker readiness 為 ready。實際瀏覽器讀到原帳戶共用餘額並可進入遊戲。最後資料檢查發現開發庫有 3 筆 `financial_balance_reconciliation` 差異；將變更前 backup 完整還原至隔離 DB 後同樣有 3 筆。本次驗收結束時開發庫 `storm_rounds` 為 0；交易驗證均在可丟棄測試 DB 完成。既有帳本差異尚待另行追查，沒有以補款、改餘額或清空資料處理。

DB suites 必須依 runbook 使用 `baccarat_core_api_test_*`／`baccarat_migration_test_*` 的空測試資料庫；不得對開發或 production DB 執行清理型測試。
