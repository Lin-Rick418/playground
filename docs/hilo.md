# Hi-Lo

`/hilo` 與大廳入口共用 PLAYER session、測試幣錢包和 `/api/ws`。沿用綠金介面；不含自動投注、獨立歷史頁或金流。`HILO_ENABLED` 預設 false，僅明確設定 true 接受新局。

## 規則與 RTP

- 投注 100–5,000 幣，每次遞增 100。每人最多一局 ACTIVE；登出、斷線、離頁均保留。
- `crypto.randomInt(52)` 獨立、有放回抽牌。card ID 0–51，點數 `floor(card/4)+1`，花色依序黑桃／紅心／方塊／梅花。A 最小、K 最大，花色不影響輸贏。
- 2–Q 可猜大於或等於／小於或等於，成功機率 `(14-r)/13`、`r/13`；A 可猜嚴格更高／相同，K 可猜嚴格更低／相同，機率分別為 `12/13`、`1/13`。
- 下注前可免費看牌、換牌。server 保存 preview ID/version，開局採用同一張牌，消耗 preview 並扣款。
- 猜對至少一次才能收款；猜錯派彩為零。局中可跳牌 52 次，換牌不計入成功機率、不增加倍率、不收費；下注前換牌僅受速率限制。
- 含本金倍率 `M = 0.94 / ∏pᵢ`，6% 只套用一次。後續每次猜對僅除以該次成功機率，不再乘 0.94。不同策略在合法且完成結算的條件下，未取整理論 RTP 為 94%，不保證短期或個別回報。
- BigInt 有理數運算，分子分母約分並以 NUMERIC 整數保存；僅最終入帳 HALF_UP 至 0.01 幣。100 幣猜中 12/13 的首猜派彩 101.83，連猜兩次 12/13 派彩 110.32；猜中 1/13 首猜派彩 1222。
- 畫面金額朝零截斷至整數，小數保留在帳戶。倍率顯示兩位小數，不作計算依據。分幣取整引入最多半分幣的單次派彩差異。
- 最高 10,000×。猜牌前檢查成功後精確倍率，超限選項停用，不截斷已承諾派彩。如果任何牌都不能繼續，或跳牌用盡且目前無合法選項，自動依目前倍率收款。

## 介面

所有 GET 需 PLAYER 身份且只回傳自己的資料，`Cache-Control: no-store`。

| 路徑                                      | 回應                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| GET `/api/hilo/config`                    | minBet、maxBet、betStep、rtp、maxMultiplier、maxSkips、ruleVersion、enabled |
| GET `/api/hilo/state`                     | `{ preview, round }`；round 為 ACTIVE 局或 null                             |
| GET `/api/hilo/rounds/:id`                | `{ round }`，含已公開 steps                                                 |
| GET `/api/hilo/history?limit=20&cursor=…` | `{ items, nextCursor }`；limit 1–50，終局時間倒序                           |

WebSocket 使用原 `/api/ws`，bearer subprotocol 驗證；不另開 socket，也不退回 HTTP POST。

```json
{
  "type": "hilo_command",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "idempotencyKey": "22222222-2222-4222-8222-222222222222",
  "action": {
    "kind": "guess",
    "roundId": "33333333-3333-4333-8333-333333333333",
    "expectedVersion": 3,
    "choice": "higher_or_equal"
  }
}
```

- `prepare` 無額外欄位；`refresh_preview` 需 previewId/expectedVersion；`start` 再帶 amount。
- `guess`、`skip`、`cashout` 需 roundId/expectedVersion；guess 再帶 choice。choice 為 higher_or_equal、lower_or_equal、higher、lower、same。
- 成功：`{ type: "hilo_result", requestId, result: { ok: true, data: { preview, round, balance, walletVersion } } }`。
- 失敗：`{ type: "hilo_result", requestId, result: { ok: false, status, error: { code, message, requestId } } }`。
- round 含點數牌面、初始牌、已公開步驟、倍率、可收款額、選項機率（winningRanks/totalRanks）、成功後倍率與派彩、enabled/reason、version/ruleVersion。
- 400 驗證／餘額／額度、401 未登入、403 非 PLAYER、404 非自己的牌局、409 版本／狀態／key 衝突、503 停止新局。strict schema 拒絕 client 注入牌面、身份或派彩。
- 每個 socket 同時最多一個遊戲指令，與 Mines／Plinko 共用每 10 秒 60 次限制。

## 交易與恢復

先鎖 user，再處理 idempotency，最後鎖 preview／round。同 key 同內容重播（先於版本檢查），同 scope/key 不同內容回 409。所有扣款、派彩、步驟、局況、ledger、通知與 idempotency 一起提交。唯一索引防止重複 ACTIVE 局，ledger 唯一鍵防止重扣／重付。

`hilo.mutation` 的投注與牌局 idempotency 永久保留。`hilo-preview` 的免費操作沿用一般 retention；preview ID 不重用，換牌版本只遞增，開局消耗 preview。

開局預留 `amount × 10000`，餘額扣本金後加所有未結算遊戲最大派彩不得超過 20 億幣。百家樂、Mines、Plinko 的共用曝險檢查也包含 Hi-Lo。終局納入每日損益；walletVersion 沿用 ledger sequence。

逾時 10 秒或斷線後，client 保存原 action/key 至使用者專屬 sessionStorage、鎖住操作。重連先 GET 最新狀態，以原 key 確認，再 GET 最新局況；每次 attempt 使用新 requestId。idempotency 回覆可能過時，不直接覆蓋當前牌局。切換帳號隔離 pending，舊使用者回覆不能更新畫面或錢包。

## 畫面與互動

- 共用 `AppPageHeader`、`StakeControl` 與 `BalanceBar`；左右留白沿用 `--ui-page-gutter`，與大廳、Mines、Plinko 的返回箭頭對齊。
- 整頁 `100dvh`，牌序可觸控滑動或用左右箭頭操作，隱藏 scrollbar。已移除頂部宣傳／RTP 橫列、規則展開區及牌桌狀態文字。
- 正常等待 WS 只鎖定操作，於原按鈕內顯示「換牌中…／跳牌中…／確認中…」；不插入恢復區塊、不讓整組控制項同時變淡。逾時／失聯才進入恢復流程。
- 中央牌與左右兩個選項保持元件／DOM 穩定；A／K 切換更新內容與選項語意，不以 choice 或 version 重建按鈕。
- 猜牌結果到達後以百家樂酒紅斜紋牌背原地翻正（420ms）；免費換牌與局中跳牌共用同一動畫：確認 server 回覆後，先讓舊牌向左滑出（260ms），再翻開新牌（420ms）。即使連續抽到相同牌面也依 version／step 播放，恢復狀態不重播。動畫期間鎖定操作，其他區塊不位移。
- 成功收款後（含自動收款）播放勝利特效：Big Win 為 `8 ≤ M < 16`、Mega Win 為 `16 ≤ M < 101`、Super Win 為 `M ≥ 101`，以 server 回傳的倍率判斷，未收款／猜錯不播放。共用 Plinko 金幣、光芒與派彩跳數；Mega 增加粒子與光環，Super 加入雙層光芒、紫金光暈及三波金幣。停留時間分別為 3.6／4.4／5.2 秒，下一局可立即操作。自動收款若伴隨新牌，等翻牌完成再播放；恢復／重播不重複慶祝。
- Reduced motion 直接顯示結果與靜態獎項金額；卸載、換帳號或動畫中斷需清理及解除暫時動畫狀態。動畫不決定遊戲結果、不更動錢包計算。

## 驗證與操作

- 數學／contracts：`NODE_ENV=test npx tsx --test apps/server/src/lib/hilo.test.ts`。
- 前端：`npm test --workspace web`，含 pending、版本與帳號隔離測試。
- 真實 PostgreSQL／WS：在全新 `baccarat_core_api_test_*` 隔離資料庫執行 `npm run test:integration`。涵蓋 migration 升級、並發、rollback、冪等、曝險與每日損益。
- Browser：`E2E_MOCKED_ONLY=true npm run test:e2e -- e2e/hilo-mocked.spec.ts e2e/viewport.spec.ts e2e/lobby-carousel.spec.ts`；不啟動 API／worker，Chromium 與 WebKit 手機驗證手動流程和失聯重播。
- 上線／停用見 [migration runbook](../deploy/database-migrations.md)。日誌沿用 `hilo_command_completed`／`hilo_command_failed`，提供 requestId、operation、statusCode、durationMs；不記錄 token 或未公開的亂數。

結算後的觀察值可查詢（僅供監測，不用來動態修改出牌）：

```sql
SELECT count(*) AS settled_rounds, sum(amount) AS stakes, sum(payout) AS payouts,
       sum(payout) / NULLIF(sum(amount), 0) AS observed_rtp
FROM hilo_rounds
WHERE status <> 'ACTIVE' AND settled_at >= NOW() - INTERVAL '1 day';
```
