# Mines

登入後 `/lobby` 選擇遊戲，百家樂經 `/baccarat` 選桌，Mines 直接進 `/mines`。百家樂、Mines、Plinko、Hi-Lo 使用同一個測試幣帳戶，沒有充值／提領金流。

Mines 已移除「紀錄」入口與內頁，舊網址 `/history?game=mines` 返回遊戲。投注額與地雷數使用原生選單操作，外觀高度與同列按鈕一致。

## 玩法與金額

- 5×5、新局雷數 3–24，預設 3；投注 100–5,000 幣且必須為 100 的倍數，預設 100。
- 新局使用 ruleVersion=2。開局扣款並用 crypto.randomInt 的 partial Fisher–Yates 建立不重複的雷區；下一格的成功倍率未超過 1,000× 時沿用此雷區。
- 若下一格的成功倍率 **大於 1,000×**，後端會強制讓玩家選中的格子成為地雷，當次翻格直接 LOST、派彩為 0。如果該格原本安全，將一顆尚未揭露的地雷移到該格，保持雷數不變；已揭露的安全格不改變。這不是均勻固定雷盤玩法。遊戲頁不顯示倍率上限提示，終局畫面使用一般踩雷狀態。
- ruleVersion=1 的既有局繼續使用原本固定雷盤及倍率，不追溯套用新上限。
- 翻到安全格後可以收款，踩雷輸掉本局本金，翻完安全格自動收款。至少翻一個安全格才可收款。
- 每人最多一局 ACTIVE，關頁、斷線及登出均保留；回來繼續遊玩，不自動沒收或退還本金。
- 雷數 m、翻開 k 個安全格時，存活率 `P = C(25-m,k) / C(25,k)`；含本金倍率 `0.95/P`。
- 最終派彩使用 BigInt 有理數計算，僅在入帳時 ROUND_HALF_UP 到 0.01 幣。例如 123.455 → 123.46；以 100 幣、3 顆雷翻一格收款為 107.95 幣。
- 基礎倍率公式保留 0.95，但 v2 超限後必輸，不能將整體玩法標為固定 RTP 95%；config 的 rtp 為 null。在未觸發上限且按固定格數收款的策略下，仍可沿用原公式分析；試圖越過上限的策略則派彩為 0。1 顆雷的 v1 舊局翻一格倍率低於 1，100 幣派彩為 98.96。
- 前端金額朝零截斷顯示整數（123.99 → 123，-123.99 → -123），小數仍在帳戶中累積。倍率可顯示小數，顯示值不參與派彩計算。
- 投注額仍為 100–5,000。v2 開局只檢查餘額是否足夠，不再以翻完所有安全格的理論派彩拒絕投注。
- 帳戶仍有 20 億幣上限。v2 開局的 maximum_payout 先保留可退款本金，每次安全翻格後改成已贏得的可收款金額；其他遊戲仍將這個額度計入共用曝險。
- 每次未超過倍率上限的翻格，在讀取該格結果之前，先檢查「餘額 + 其他未結算派彩 + 下一格成功派彩」。若會超過 20 億，不接受這次翻格風險，直接按目前倍率收款；若尚未翻格則退回本金，結果為 CASHED_OUT / ACCOUNT_LIMIT。此檢查與更新在同一個 user lock 交易內，確保已贏得的派彩保留入帳空間。

## API

所有路徑在對外 `/api` 之下，必須用 PLAYER session。身份只取自伺服器驗證結果，玩家只能讀寫自己的局。

### WebSocket 遊戲操作

前端的開局、翻格、收款與不確定操作重試使用既有 `/api/ws` 連線；不另外建立遊戲 socket，也不自動退回 HTTP POST。設定、讀取局面與重連後確認局況仍使用 HTTP GET。下面的 POST endpoints 保留供舊 client 使用，兩種傳輸共用交易及 idempotency 範圍。

連線使用 `Sec-WebSocket-Protocol: bearer, <token>` 驗證，token 不放 URL。每次指令重新檢查 session 與玩家權限，局的擁有者由後端確認。

```json
{
  "type": "mines_command",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "idempotencyKey": "22222222-2222-4222-8222-222222222222",
  "action": { "kind": "start", "amount": 100, "mineCount": 3 }
}
```

- `action` 另可為 `{ kind: "reveal", roundId, cellIndex }` 或 `{ kind: "cashout", roundId }`，strict schema 拒絕額外身份或結果欄位。
- 成功回應：`{ type: "mines_result", requestId, result: { ok: true, data: { round, balance, walletVersion } } }`。
- 失敗回應：`{ type: "mines_result", requestId, result: { ok: false, status, error: { code, message, requestId } } }`；status/code 與 HTTP 共用。無法解析的訊息使用既有 `error` 回應。
- 每個 socket 同時最多處理一個遊戲指令，Mines／Plinko／Hi-Lo 共用每 10 秒最多 60 個的上限；既有連線數、payload 上限及心跳仍生效。
- 前端每個操作最多等待 10 秒。斷線或逾時保留原操作與 idempotency key，停止其他操作，重連後先讀取局況，再視需要用原 key 重送；每次送出的 request ID 都不同，忽略遲到的舊回覆。離頁會清理等待計時器並關閉連線。
- 正常回覆直接按 `round.version` / `walletVersion` 更新棋盤及餘額，不再串接 `/auth/me` 才解除操作鎖定。重連與不確定結果恢復仍讀取最新狀態，防止 idempotency 的歷史回應蓋掉較新的局面。
- 地雷與派彩仍由後端確認，ACTIVE 局不傳完整地雷位置。WS 改變傳輸方式，不改玩法、資料庫 schema 或 ledger。

部署先更新 server，再更新 web；回退 web 可以使用保留的 HTTP endpoints。觀察 server 的 `mines_command_completed`（operation、statusCode、durationMs、requestId）及 `mines_command_failed`，不記錄地雷位置或 token。

### HTTP 相容介面

| Method / path                          | Payload 或結果                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET `/mines/config`                    | boardSize、minMines、maxMines、minBet、maxBet、betStep、rtp（v2 為 null）、enabled、ruleVersion、maxMultiplier（1,000） |
| GET `/mines/active`                    | `{ round: MinesRound \| null }`                                                                                         |
| POST `/mines/rounds`                   | `{ amount: 100, mineCount: 3 }` → `{ round, balance, walletVersion }`                                                   |
| GET `/mines/rounds/:id`                | `{ round }`                                                                                                             |
| POST `/mines/rounds/:id/reveal`        | `{ cellIndex: 0 }` → `{ round, balance, walletVersion }`                                                                |
| POST `/mines/rounds/:id/cashout`       | `{}` → `{ round, balance, walletVersion }`                                                                              |
| GET `/mines/history?limit=20&cursor=…` | `{ items, nextCursor }`，limit 1–50，終局時間倒序                                                                       |

所有 POST 要求 8–128 字元的 `Idempotency-Key`。同 key 同 payload 回放原結果，同 key 不同 payload 為 409；回放結果中的餘額可能已過時，client 必須使用最新 user snapshot 或 `/auth/me`。前端保存不確定的請求並使用原 key 重試，不能換 key 猜測前次是否成功。

狀態為 ACTIVE、LOST、CASHED_OUT。局況含投注、雷數、已翻格、倍率、派彩及 version；ACTIVE 的 mineCells 為 null，終局才揭露完整雷區。安全翻格不改錢包，但局況 version 遞增。

v2 局況額外回傳 settlementReason：一般踩雷／收款為 null，倍率超限強制踩雷為 MULTIPLIER_LIMIT，帳戶額度不足而收款／退款為 ACCOUNT_LIMIT。舊 idempotency 回放可能沒有此欄位；client 必須容許缺省。終局倍率只計算成功安全格，不包含強制踩雷的那一格。

錯誤沿用 `{ code, message, requestId }`：400 驗證或餘額／派彩限制、401 未登入、403 無權限、404 無此自己的局、409 狀態或重試衝突、503 停止新局。`MINES_ENABLED=false` 只停止新局，已接受的局仍可結算。

## 交易與同步

Mines transaction 先鎖 user，再鎖該使用者的 Mines round；最大派彩查詢不鎖百家樂 round，避免與百家樂既有 round → user 鎖順序形成循環。扣款／派彩、append-only ledger、局況、通知及 idempotency 結果一起提交。唯一索引限制一個 ACTIVE 局，ledger 唯一約束防止重複派彩。

HTTP／WebSocket 傳輸仍用幣的 JSON number，金額最多兩位小數；資料庫 NUMERIC 字串經工具精確轉成整數分計算。`walletVersion` 為最新 ledger sequence；同一帳號只接受不小於已知版本的餘額。WebSocket `subscribe_user` 訂閱共用 user_snapshot，不需訂閱百家樂牌桌。

部署與停用流程見 [database migration runbook](../deploy/database-migrations.md)。

## v2 升級與回退

- 需新增 migration 013，保留所有既有局的 rule_version=1，不修改既有 migration。先停收新局，再按 runbook 套用 migration、部署支援 v1/v2 的 server 與 web，確認後才開放新局。
- 有 v2 ACTIVE 局時不可回退到只理解 v1 的 server：v2 的 maximum_payout 是目前保留的收款額，不是整局理論最高派彩。發生問題時先關閉 MINES_ENABLED，保留新版的結算、ledger 與 idempotency 處理。
