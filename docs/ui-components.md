# 共用玩家 UI

共用元件放在 `apps/web/src/components/ui/`；尺寸、互動狀態與配色變數集中在 `apps/web/src/styles/ui.css`。此 CSS 排除 mobile-forever 的像素轉換，讓各頁面的同類控制項維持相同實際尺寸。Hi-Lo 與 Plinko 的頁面 CSS 也排除轉換；Mines 仍會縮放，設定共用尺寸時須使用共用 CSS variable。

| 元件            | 使用範圍                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppButton`     | 一般操作、主操作、返回、圖示及關閉按鈕。`variant`：primary／secondary／ghost；`size`：control／action／compact。預設 type=button，表單需指定 type=submit。busy 與 disabled 都使用原生 disabled。ref 提供 focus()。 |
| `AppSelect`     | 原生 select，保留系統選單、label、disabled、鍵盤操作；支援數字 v-model。                                                                                                                                           |
| `AppInput`      | 登入與密碼表單的原生 input，保留 autocomplete、required、maxlength 與 trim modifier。                                                                                                                              |
| `AppPageHeader` | 共用返回箭頭與 h1；actions、subtitle slots 分開排版，標題維持水平中心。                                                                                                                                            |
| `StakeControl`  | 投注額選單及 MIN／−／＋／MAX；共同處理步進、上下限、disabled。stacked 用於設定面板，compactLandscape 用於短橫向遊戲畫面。                                                                                          |
| `BalanceBar`    | Mines／Plinko／Hi-Lo 餘額、數字滾動標示及餘額不足警示；warn()／clearWarning() 共用動畫與清理，支援 reduced motion。                                                                                                |

## 尺寸

- 一般控制项：44px，主要操作：52px，緊湊操作：36px。
- 遊戲頁可用高度 ≤650px 時，統一縮為 36／44／32px，保留棋盤與必要操作區。
- 圖示按鈕使用 icon，寬度等於同級高度。相鄰的 select 與 button 必須使用同一 size。
- 頁面只設定布局及 `--ui-accent`、`--ui-primary-bg`、`--ui-control-bg` 等色彩變數，避免重新指定按鈕 height、padding 或 Safari appearance。
- 棋盤格、籌碼、投注區與輪播卡片是遊戲內容，維持各自的尺寸與互動語意，不套一般操作按鈕尺寸。

## 按鈕互動

- 全站按鈕與可點擊遊戲格子不使用 hover 高亮：懸停不變更背景、邊框、亮度，也不浮起。`AppButton` 與各頁自訂按鈕遵循相同規則。
- 按鈕與下拉選單聚焦時不顯示額外外框（outline）、邊框變色或光暈，包含滑鼠與鍵盤聚焦、summary、role=button／role=combobox。共用 `ui.css` 統一處理，各頁 scoped styles 不再覆寫焦點外框。
- 保留原本邊框、鍵盤 Tab／Enter／方向鍵操作、`:active` 按下回饋，以及 selected／aria-pressed、disabled、busy 狀態；文字輸入框與可捲動清單仍保留焦點提示。

## Header、通訊與動畫

- `/lobby`、`/baccarat`、`/game/:tableId`、`/hilo`、`/mines`、`/plinko` 均使用 `AppPageHeader`。共用元件本身不能保證外層留白相同：header 左右留白必須使用 `var(--ui-page-gutter)`（16 個 CSS px）。
- 百家樂選桌與牌桌在頁面設定 `padding-inline: var(--ui-page-gutter)`；大廳為了保留滿寬輪播，只在 header 設定左右 margin。每頁只套一層留白。
- 曾發生百家樂仍繼承 `.player-page` 的 `12px`，經 mobile-forever 轉換後，在 320px 寬度時箭頭按鈕 x 約為 10.23px，而其他頁面為 16px。修正外層留白即可，不應改箭頭 SVG、加 translate／負 margin 或複製另一份 header。
- 共用 grid 讓標題水平置中，右側按鈕放 actions slot。百家樂牌桌保留廳名與「遊戲規則」，不顯示「桌號｜秒數｜限紅」整行 subtitle；移除 slot 呼叫及專屬樣式，避免空白列。實際投注限制仍由原有邏輯驗證。
- Hi-Lo 的兩個選項是固定 slot，跨 A／K 更新內容與 accessible label，不以每次選項值作為 key 重建。一般動態清單仍使用穩定的資料 ID／sequence。
- 通訊中使用既有按鈕 busy／disabled 與原位文字提示；避免增加額外列或把正常等待誤判為需要手動恢復。永久不可用與暫時通訊鎖定的視覺狀態要分開。
- 不要用整頁 opacity／重新掛載製造等待效果。Hi-Lo 的牌面動畫僅在 server 結果確定後播放；滑出與翻牌不影響容器布局，並支援 reduced motion。

## 驗證

共用元件測試涵蓋原生屬性、click/disabled、數字模型、投注限額、警示重觸發與清理。既有遊戲 E2E 覆蓋下注、自動投球、復原、Safari 排版；viewport E2E 檢查共用頁首對齊與彈窗焦點返回。

Header／留白變更須驗證 `e2e/viewport.spec.ts`：跨上述六個頁面比較返回按鈕與 SVG 的實際位置，檢查箭頭與標題垂直中心；手機尺寸至少 320×568、390×844、483×771，同時跑 Chromium 與 WebKit。百家樂牌桌另檢查副標不存在、「遊戲規則」仍可見，以及操作區未超出 viewport。

```sh
E2E_MOCKED_ONLY=true npm run test:e2e -- e2e/viewport.spec.ts
```
