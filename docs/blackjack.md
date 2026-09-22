# Blackjack

`/blackjack` 與大廳第五個入口共用 PLAYER session、測試幣錢包及 `/api/ws`。不含金流、旁注、投降、自動投注或多人同桌。`BLACKJACK_ENABLED` 預設 false，只限制新局；已接受的牌局與重播不受旗標影響。

## 規則

- 初注 100–5,000 幣，步進 100。每人最多一局 ACTIVE；離頁、登出、斷線或 server 重啟後可繼續，沒有操作倒數。
- 每局獨立以 `crypto.randomInt` 做 Fisher–Yates 洗牌，使用 6 副完整牌、局內不放回。server 保存 312 張實體牌 ID 與抽牌位置；公開牌面使用 0–51（與 Hi-Lo 相同編碼），不同副牌可出現相同牌面。
- 初始發牌順序為玩家、莊家明牌、玩家、莊家暗牌。A 算 1 或 11；J/Q/K 算 10。莊家不足 17 補牌，達 17 點即停牌（包含 A 算作 11 點的情況）。
- 原始兩張 21 為 Blackjack，勝局淨賠 3:2（含本金 2.5 倍）；一般勝局淨賠 1:1（含本金 2 倍），和局退本金。雙方 Blackjack 和局，Blackjack 勝過一般 21。
- 任意首兩張可加倍，包含分牌後；追加等額投注，只補一張即停牌。21 自動停牌，爆牌結束該手。
- 同點數可分牌，包括不同牌面的 10 點牌；最多 4 手，非 A 可重分。每次追加初注，左右兩手立即各補一張，從左到右依序操作。新手牌有新的固定 ID。
- A 只分一次，各補一張，不能加倍／重分；分牌後 21 以一般勝局派彩。
- 莊家明牌 A 時，玩家先選保險或拒絕，即使自己有 Blackjack 亦同。保險固定初注一半，莊家 Blackjack 時淨賠 2:1（含保險本金 3 倍），否則沒收。
- 明牌 A 在保險選擇後檢查暗牌；明牌 10 點立即檢查。莊家 Blackjack 直接結算，不開放加倍／分牌。
- 最後一手完成後 server 同一交易完成莊家補牌與整局結算。所有玩家手牌爆牌時揭示暗牌但不再補莊家牌。
- 使用標準隨機牌組，沒有固定 RTP 承諾，也不依帳號、近期輸贏或觀察到的 RTP 調整結果。金額使用分幣整數，派彩按精確比例計算，最終 ROUND_HALF_UP；目前投注步進使所有規則派彩均可精確表示。

## API

GET 均需 PLAYER、只查自己的資料，`Cache-Control: no-store`：

| 路徑                                       | 內容                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| `/api/blackjack/config`                    | 初注限制、6 副牌、最多 4 手、ruleVersion=1、enabled、rtp=null |
| `/api/blackjack/state`                     | `{ round }`，ACTIVE 局或 null                                 |
| `/api/blackjack/rounds/:id`                | 指定已接受牌局的公開快照                                      |
| `/api/blackjack/history?limit=20&cursor=…` | `{ items, nextCursor }`，終局時間倒序，limit 1–50             |

WS 沿用原 `/api/ws`、bearer subprotocol、每 socket 一個遊戲指令，以及每 10 秒 60 次的共用遊戲額度。不提供 HTTP mutation fallback。

```json
{
  "type": "blackjack_command",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "idempotencyKey": "22222222-2222-4222-8222-222222222222",
  "action": { "kind": "start", "amount": 100 }
}
```

- `hit`／`stand`／`double`／`split` 帶 roundId、expectedVersion、handId。
- `insurance` 帶 roundId、expectedVersion、accept（boolean），不能自訂保險金額。
- 成功：`{ type: "blackjack_result", requestId, result: { ok: true, data: { round, balance, walletVersion } } }`。
- 失敗：`{ type: "blackjack_result", requestId, result: { ok: false, status: 409, error: { code: "CONFLICT", message: "牌局已更新，請同步後再試。", requestId } } }`。
- 非法／餘額／額度 400、未登入 401、非 PLAYER 403、找不到自己的局 404、版本／狀態／key 衝突 409、停用新局 503。
- strict contracts 拒絕 client 指定身份、牌面或派彩。round 包含每手點數、投注、結果、派彩、activeHandId 及規則上可執行的 allowedActions；餘額與帳戶額度仍由 server 在執行時檢查。
- 結算前 dealerCards 只有明牌、dealerHidden=true、dealerTotal/dealerSoft=null。任何公開介面都不回傳剩餘牌組或抽牌位置；結算後亦不公開未使用的牌。

## 資料、錢包及恢復

Migration 14 新增 `blackjack_rounds` 與 `blackjack_round_actions`；手牌與私有牌組保存在 round 的 JSONB state，每局保存 ruleVersion=1。歷史結果直接讀取當時紀錄。

先鎖 user，再處理 `blackjack.mutation` idempotency，再鎖 round。相同 key／內容先重播，之後才檢查版本；不同內容回 409。入場額度檢查先於抽牌；拒絕追加投注不消耗牌。牌局、操作、扣款、派彩、通知及 idempotency 同 transaction 提交。

初注／分牌／加倍／保險使用 `BLACKJACK_BET_DEBIT` + `BLACKJACK_ACTION` + 操作 UUID，唯一約束防止重扣；終局以 `BLACKJACK_SETTLEMENT_CREDIT` + `BLACKJACK_ROUND` + roundId 入帳一次（包含零派彩），同步 walletVersion。每日損益以 total_bet（含追加投注及保險）與 payout 計算。

開局預留初注 2.5 倍；其後以公開手牌的保守上界估算：Blackjack 2.5 倍、其他手牌 2 倍、保險 3 倍。追加前將本局新上界及其他遊戲 ACTIVE 曝險合計，連同扣款後餘額不得超過 20 億。額度估算不讀暗牌決定，因此不能用拒絕訊息探測暗牌。

`blackjack.*` scope 與遊戲、ledger 紀錄永久保留。client 使用帳號專屬 sessionStorage 保存不確定 action/key，鎖住操作；重連先同步、以原 key 確認、再讀最新牌局。每次 attempt 使用新 requestId，重播快照不覆蓋新版本，換帳號隔離 pending 與舊回覆。

## UI 與驗證

綠金牌桌沿用共用 header／投注／餘額元件，header 右側提供「遊戲規則」，位置與百家樂一致；不提供局內歷史入口或視窗。玩家牌組只顯示置中的點數與牌面，與莊家牌組對齊，不顯示手牌編號、投注額或狀態文字。分牌後一次只顯示一手，使用原生橫向分頁，可觸控滑動、觸控板橫向捲動、滑鼠拖曳、按箭頭或方向鍵查看各手點數；牌組會隨拖曳移動並在放開後對齊，箭頭沿用 Plinko 的樣式並支援 reduced motion。查看非操作中的牌組時停用手牌操作，可按「返回操作牌組」繼續；停牌確認後切到下一手，加倍或要牌結束該手則先完成補牌動畫再切換。恢復時顯示目前操作的一手，結算後預設顯示最後一手，仍可切換查看其他牌組。手機固定操作區及餘額；100dvh 含 fallback，Blackjack CSS 排除 mobile-forever 縮放。牌桌不顯示品牌字樣與莊家文字標籤。雙方牌面依螢幕高度放大，短螢幕保留完整操作區。莊家牌組置中，正下方顯示目前已開牌的點數；開局只計明牌，翻牌及補牌動畫依序更新點數。收到 server 結果後先翻開暗牌，再逐張播放補牌，結束後顯示結算。每次補牌才加入該張牌，牌組逐張展寬、平滑置中，不預留未出現的補牌空位；動畫期間保留操作區並鎖定操作。支援 reduced motion（中途啟用也會完成呈現並解鎖），恢復不重播；離頁或切換帳號時清理動畫。餘額增加沿用 Plinko 的 800ms 數字遞增效果，派彩呈現等候開牌動畫完成；扣款立即顯示，首次載入、恢復與 reduced motion 直接顯示最新餘額。

規則／contract tests 包含洗牌組成、A、莊家 A＋6 停牌、保險、Blackjack、加倍、分牌及暗牌遮蔽。core API integration suite 在專用 `baccarat_core_api_test_*` 空資料庫驗證真實 PG／WS、重試、並發、回滾、ledger、曝險、每日損益、權限和停用。migration suite 只使用 `baccarat_migration_test_*`。瀏覽器驗證見 `e2e/blackjack-mocked.spec.ts`、viewport 與大廳輪播測試。

部署與停止新局見 [migration runbook](../deploy/database-migrations.md)。不得回退至不計 Blackjack 曝險的舊 server，或清除 ACTIVE 局、ledger、idempotency 以恢復啟動。
