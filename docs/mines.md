# Mines

登入後 `/lobby` 選擇遊戲，百家樂經 `/baccarat` 選桌，Mines 直接進 `/mines`。兩款遊戲使用同一個測試幣帳戶，沒有充值／提領金流。

Mines 已移除「紀錄」入口與內頁，舊網址 `/history?game=mines` 返回遊戲。投注額與地雷數使用原生選單操作，外觀高度與同列按鈕一致。

## 玩法與金額

- 5×5、新局雷數 3–24，預設 3；投注 100–5,000 幣且必須為 100 的倍數，預設 100。
- 開局扣款並用 crypto.randomInt 的 partial Fisher–Yates 建立均勻、固定且不重複的雷區。後端不會根據玩家選擇移動地雷。
- 翻到安全格後可以收款，踩雷輸掉本局本金，翻完安全格自動收款。至少翻一個安全格才可收款。
- 每人最多一局 ACTIVE，關頁、斷線及登出均保留；回來繼續遊玩，不自動沒收或退還本金。
- 雷數 m、翻開 k 個安全格時，存活率 `P = C(25-m,k) / C(25,k)`；含本金倍率 `0.95/P`。
- 最終派彩使用 BigInt 有理數計算，僅在入帳時 ROUND_HALF_UP 到 0.01 幣。例如 123.455 → 123.46；以 100 幣、3 顆雷翻一格收款為 107.95 幣。
- 公式 RTP 為 95%；取整到 0.01 幣會造成微小的期望值差異，且不保證個別玩家返還率。1 顆雷翻一格的倍率低於 1，100 幣派彩為 98.96。
- 前端金額朝零截斷顯示整數（123.99 → 123，-123.99 → -123），小數仍在帳戶中累積。倍率可顯示小數，顯示值不參與派彩計算。
- 帳戶上限為 20 億幣。開局檢查剩餘餘額加上兩款遊戲全部未結算投注的最大可能派彩，超限即拒絕；因此部分雷數／餘額組合實際可下注上限低於 5,000。

## API

所有路徑在對外 `/api` 之下，必須用 PLAYER session。身份只取自伺服器驗證結果，玩家只能讀寫自己的局。

| Method / path | Payload 或結果 |
| --- | --- |
| GET `/mines/config` | boardSize、minMines、maxMines、minBet、maxBet、betStep、rtp、enabled |
| GET `/mines/active` | `{ round: MinesRound \| null }` |
| POST `/mines/rounds` | `{ amount: 100, mineCount: 3 }` → `{ round, balance, walletVersion }` |
| GET `/mines/rounds/:id` | `{ round }` |
| POST `/mines/rounds/:id/reveal` | `{ cellIndex: 0 }` → `{ round, balance, walletVersion }` |
| POST `/mines/rounds/:id/cashout` | `{}` → `{ round, balance, walletVersion }` |
| GET `/mines/history?limit=20&cursor=…` | `{ items, nextCursor }`，limit 1–50，終局時間倒序 |

所有 POST 要求 8–128 字元的 `Idempotency-Key`。同 key 同 payload 回放原結果，同 key 不同 payload 為 409；回放結果中的餘額可能已過時，client 必須使用最新 user snapshot 或 `/auth/me`。前端保存不確定的請求並使用原 key 重試，不能換 key 猜測前次是否成功。

狀態為 ACTIVE、LOST、CASHED_OUT。局況含投注、雷數、已翻格、倍率、派彩及 version；ACTIVE 的 mineCells 為 null，終局才揭露完整雷區。安全翻格不改錢包，但局況 version 遞增。

錯誤沿用 `{ code, message, requestId }`：400 驗證或餘額／派彩限制、401 未登入、403 無權限、404 無此自己的局、409 狀態或重試衝突、503 停止新局。`MINES_ENABLED=false` 只停止新局，已接受的局仍可結算。

## 交易與同步

Mines transaction 先鎖 user，再鎖該使用者的 Mines round；最大派彩查詢不鎖百家樂 round，避免與百家樂既有 round → user 鎖順序形成循環。扣款／派彩、append-only ledger、局況、通知及 idempotency 結果一起提交。唯一索引限制一個 ACTIVE 局，ledger 唯一約束防止重複派彩。

HTTP／WebSocket 傳輸仍用幣的 JSON number，金額最多兩位小數；資料庫 NUMERIC 字串經工具精確轉成整數分計算。`walletVersion` 為最新 ledger sequence；同一帳號只接受不小於已知版本的餘額。WebSocket `subscribe_user` 訂閱共用 user_snapshot，不需訂閱百家樂牌桌。

部署與停用流程見 [database migration runbook](../deploy/database-migrations.md)。
