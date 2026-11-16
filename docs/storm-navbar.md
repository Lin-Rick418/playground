# 沙海神殿 Navbar

`/storm-demo` 與其他遊戲共用 `AppPageHeader`、`AppButton` 及 `styles/ui.css` 的尺寸。返回按鈕在左側，標題「沙海神殿」水平置中，右側只保留規則。

## 排版規範

| 項目            | 規格                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 左右留白        | `var(--ui-page-gutter)`，固定 16 個 CSS px，只套在 header                                                                   |
| 一般高度        | 返回按鈕 44px，header 最小高度 52px                                                                                         |
| 視窗高度 ≤650px | 沿用 `.player-page` 共用變數，按鈕 36px、header 最小高度 44px                                                               |
| 返回箭頭        | 使用共用元件的 24×24 SVG，不加位移補償                                                                                      |
| 標題            | 沿用共用 20px 字級與 grid，左右欄等寬，避免操作區使標題偏移                                                                 |
| 右側操作        | `actions` slot 只放規則，左右欄沿用共用 `var(--ui-control-height)` 寬度                                                     |
| 頁面            | 置中、最大寬度 430px，固定 `100dvh`（`100vh` fallback）；navbar 與 safe-area 包含在高度內，場景滿寬、不另加頁面水平 padding |

先前頁面自行指定 40px header、32px 返回按鈕及 15px 標題，造成與其他遊戲不一致。現在移除這些覆寫，透過 `.player-page` 繼承共用短螢幕尺寸；頁面只負責留白及操作區寬度。

## 操作與底部

- 音效按鈕及已無入口的合成音效程式已移除，維持靜音。
- 免費回合提示顯示時，整個 header 一樣設為 inert。
- 移除底部 `secondary-controls` 整列及其專屬樣式，包含「共用錢包 · 每局自動結算」與暫停提示。免費回合仍可使用中央轉動按鈕繼續。
- 不新增 hover 高亮或聚焦外框；保留共用按鈕的按下狀態及鍵盤操作。
- 自動模式回合選項依序為 10／50／100／∞；最後一項使用 `infinity` font icon，accessible label 為「無限」。無限沒有固定回合上限，仍受手動停止、單局贏分、累計淨贏／淨損、餘額與連線狀態限制。完整行為見 [沙海神殿](storm-demo.md)。

## 相關檔案與驗證

- `apps/web/src/views/StormDemoView.vue`：頁面、自動模式與 scoped styles。
- `apps/web/src/components/ui/AppPageHeader.vue`、`AppButton.vue`、`apps/web/src/styles/ui.css`：共用規格來源。
- `e2e/viewport.spec.ts`：比較大廳、百家樂、Hi-Lo、Mines、Plinko、Blackjack 與沙海神殿的返回按鈕及 SVG 實際位置。
- `e2e/storm-portrait-mocked.spec.ts`：檢查標題置中、操作區不重疊、音效按鈕移除、規則與自動模式視窗、無限選項鍵盤選取，以及盤面與控制列不超出視窗。

以 Chromium 與 WebKit 驗證；跨遊戲比較包含 320×568、390×844、483×771，沙海神殿另外涵蓋 549×761 與 1440×900。遊戲操作使用 mocked transport。

2026-10-24 最新驗證：`StormDemoView` component tests 23 項通過，包括無限模式超過 100 回合、手動停止、三種停止條件、斷線及餘額不足；下列三份 E2E 在 Chromium／WebKit 合計 44 項通過。web typecheck、E2E TypeScript、變更程式 ESLint 與格式檢查通過。

```sh
npm run typecheck --workspace web
npm exec --workspace web -- vitest run src/views/StormDemoView.test.ts
E2E_MOCKED_ONLY=true npm run test:e2e -- e2e/viewport.spec.ts e2e/storm-portrait-mocked.spec.ts e2e/storm-demo-mocked.spec.ts
```

共用元件維護細節見 [共用玩家 UI](ui-components.md)，遊戲規則與 API 見 [沙海神殿](storm-demo.md)。
