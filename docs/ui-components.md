# 共用玩家 UI

共用元件放在 `apps/web/src/components/ui/`；尺寸、互動狀態與配色變數集中在 `apps/web/src/styles/ui.css`。此 CSS 排除 mobile-forever 的像素轉換，讓 Plinko 和其他頁面的同類控制項維持相同實際尺寸。

| 元件            | 使用範圍                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppButton`     | 一般操作、主操作、返回、圖示及關閉按鈕。`variant`：primary／secondary／ghost；`size`：control／action／compact。預設 type=button，表單需指定 type=submit。busy 與 disabled 都使用原生 disabled。ref 提供 focus()。 |
| `AppSelect`     | 原生 select，保留系統選單、label、disabled、鍵盤操作；支援數字 v-model。                                                                                                                                           |
| `AppInput`      | 登入與密碼表單的原生 input，保留 autocomplete、required、maxlength 與 trim modifier。                                                                                                                              |
| `AppPageHeader` | 共用返回箭頭與 h1；actions、subtitle slots 分開排版，標題維持水平中心。                                                                                                                                            |
| `StakeControl`  | 投注額選單及 MIN／−／＋／MAX；共同處理步進、上下限、disabled。stacked 用於設定面板，compactLandscape 用於短橫向遊戲畫面。                                                                                          |
| `BalanceBar`    | MINES／Plinko 餘額、數字滾動標示及餘額不足警示；warn()／clearWarning() 共用動畫與清理，支援 reduced motion。                                                                                                       |

## 尺寸

- 一般控制项：44px，主要操作：52px，緊湊操作：36px。
- 遊戲頁可用高度 ≤650px 時，統一縮為 36／44／32px，保留棋盤與必要操作區。
- 圖示按鈕使用 icon，寬度等於同級高度。相鄰的 select 與 button 必須使用同一 size。
- 頁面只設定布局及 `--ui-accent`、`--ui-primary-bg`、`--ui-control-bg` 等色彩變數，避免重新指定按鈕 height、padding 或 Safari appearance。
- 棋盤格、籌碼、投注區與輪播卡片是遊戲內容，維持各自的尺寸與互動語意，不套一般操作按鈕尺寸。

## 驗證

共用元件測試涵蓋原生屬性、click/disabled、數字模型、投注限額、警示重觸發與清理。既有遊戲 E2E 覆蓋下注、自動投球、復原、Safari 排版；viewport E2E 檢查共用頁首對齊與彈窗焦點返回。
