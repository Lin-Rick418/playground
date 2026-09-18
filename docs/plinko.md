# Plinko

登入玩家從遊戲大廳進入 `/plinko`，與百家樂、Mines、Hi-Lo 共用測試幣錢包；沒有充值／提領金流。

## 玩法與 RTP

- 8–16 排、低／中／高風險，預設 16 排、中風險。
- 每球 100–5,000 幣，以 100 遞增，預設 100。倍率包含本金；100 幣落入 0.1763× 派彩 17.63、淨損益 −82.37。
- 目前 `ruleVersion=2`：全部 8–16 排、低／中／高風險都把「最左兩格＋最右兩格」各格機率提高到 v1 的恰好 2 倍。中間格按原有相對比例分配剩餘機率，左右保持對稱。
- 後端使用 `crypto.randomInt` 依整數權重抽落點，再從通往該落點的合法路徑等機率抽選一條。右轉次數仍等於左起零基落點索引。v2 **不是逐排獨立左右各 50%**；前端依 server 路徑播放動畫，不另抽結果。關頁、斷線或跳過動畫不影響已提交結算。
- v1 的原始倍率參考 Stake 經典三種風險表，以二項分布算出 RTP 後等比例縮放至約 95.5%；`plinkoV1Tables` 保留不變供稽核。v2 以新的落點權重重新計算整張表的共同縮放係數，使取整前期望回報等於各表原有 RTP，再用 BigInt ROUND_HALF_UP 把倍率取到四位小數。
- 27 組設定的實際 RTP 為 **95.4967764946%–95.5044767926%**，仍在原有 95.495%–95.505% 界限內；與對應 v1 表最大差異為 **0.003887183 個百分點**，來自倍率取整。config 的 `rtp` 為各表實際值，不保證單人或短期返還率。機率與倍率在啟動時建立，不按玩家、近期輸贏或實測 RTP 調整。
- 16 排兩側四格合計機率由 **0.0518798828125%** 提高至 **0.103759765625%**（平均約每 964 球一次，不是保證間隔）。16 排最高倍率：低 **15.3666×**、中 **103.7266×**、高 **881.5729×**；RTP 分別約 **95.501286%、95.500622%、95.499923%**。
- [v2 精確驗算結果](plinko-v2-math-result.json) 保存全部 27 組的前後倍率、RTP 與機率分子／分母；這是逐槽精確計算，不是 Monte Carlo 樣本。
- 遊戲畫面與近 10 顆結果的倍率固定顯示兩位小數；後端依完整四位小數倍率派彩，RTP 不受顯示取整影響。金額以整數分結算；100 的整數倍乘以四位小數倍率恰可精確入帳到分。畫面沿用整數截斷，小數仍在錢包累積。

## API

以下為對外 `/api` 路徑，均要求 PLAYER session。user ID 只取自驗證結果，單局與歷史僅能查詢自己的資料。

### WebSocket 投球

前端投球與不確定結果重試使用既有 `/api/ws`，共用 MINES 的 request ID、逾時及重連處理。設定、歷史與錢包恢復仍使用 HTTP GET；下方 POST 保留給舊 client，兩種傳輸共用同一個 idempotency scope 與交易，不會因換協定重複扣款。

```json
{
  "type": "plinko_command",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "idempotencyKey": "22222222-2222-4222-8222-222222222222",
  "payload": { "amount": 100, "rows": 16, "risk": "medium", "ruleVersion": 2 }
}
```

- 回覆為 `{ type: "plinko_result", requestId, result: { ok: true, data: { round, balance, walletVersion } } }`。失敗為 `result: { ok: false, status, error: { code, message, requestId } }`；使用既有 API status/code，WS 不傳 HTTP headers。
- 連線以 bearer subprotocol 驗證，token 不放 URL；每次指令重新確認 session 和 PLAYER 權限。strict schema 不接受 client 提供落點、路徑、派彩或身份。
- 每個 socket 同時最多處理一個遊戲指令，MINES／Plinko 共用每 10 秒 60 個訊息的上限；Plinko 原有每帳號每分鐘 240 筆新投注的資料庫限流仍生效。已提交結果的原 key 回放不再消耗投注 quota。
- 每顆球保存獨立 idempotency key；每次傳送使用新的 request ID，拒收舊 attempt 的回覆。10 秒未收到結果就關閉並重連，保留未確認操作。
- 斷線立即停止自動投球。同頁重連自動確認當時尚未收到結果的球，確認完成後由玩家自行再次啟動自動投球；不繼續剩餘球數。重新整理或重新開頁仍顯示「確認上一筆投注」，由玩家手動恢復既有 pending key。
- 每球仍等待後端確認後播放前端動畫，成功回覆直接按 walletVersion 更新餘額。結果回放不再觸發大獎動畫。投球間隔與原本 350ms 排程不變。

部署先更新 server 再更新 web，不需新增 migration。回退 web 可使用保留的 HTTP 介面。server 記錄 `plinko_command_completed` 的 requestId、operation、statusCode、durationMs；錯誤記錄 `plinko_command_failed`，不記錄 token。

### HTTP 相容介面

| Method / path                           | Request / response                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET `/plinko/config`                    | minRows、maxRows、risks、minBet、maxBet、betStep、ruleVersion、enabled、tables（rows、risk、multipliers、rtp） |
| POST `/plinko/rounds`                   | `{ amount: 100, rows: 16, risk: "medium", ruleVersion: 2 }` → `{ round, balance, walletVersion }`              |
| GET `/plinko/rounds/:id`                | `{ round }`                                                                                                    |
| GET `/plinko/history?limit=20&cursor=…` | `{ items, nextCursor }`，limit 1–50，結算時間倒序                                                              |

round 包含 id、amount、rows、risk、path（0 左／1 右）、slotIndex、multiplier、payout、ruleVersion、createdAt、settledAt。每個成功的 POST 已結算，不需要 client 再呼叫結算 API。

POST 必須帶 8–128 字元 `Idempotency-Key`。同 key／payload 永久回放同一結果；不同 payload 回傳 409。回放中的餘額可能過期，client 用 walletVersion 保護錢包，必要時以 `/auth/me` 重新同步。Plinko keys 排除例行 retention，不能在日常清理中刪除，否則舊請求可能再次扣款。

錯誤沿用 `{ code, message, requestId }`：400 輸入／餘額／最大派彩超限、401 session 無效、403 無權限、404 不存在或不屬於自己的局、409 key 衝突或規則版本過期、429 超過每帳號每分鐘 240 次新投注、503 停止新投注。429 帶 `Retry-After: 60`；明確拒絕後下一筆新投注用新 key，回應不確定則必須保留原 key。已完成的 key 回放不再消耗投注 quota，停用後仍可回放。

## 一致性與畫面

交易順序為 idempotency claim → user lock → 開放／版本／quota／餘額／最大派彩檢查 → 隨機路徑 → round → 扣款 ledger → 派彩 ledger → 通知 → 保存回應 → commit。任一步失敗全部 rollback。

鎖順序與 Mines 相同，最大派彩查詢不鎖百家樂 round。抽選前須滿足「扣款後餘額＋既有未結算最大派彩＋本球最大派彩 ≤ 20 億」，不因抽中大獎改抽或拒付。Plinko 即刻結算，沒有留待後續處理的未結算 exposure。

資料庫保存 multiplier_units、rule_version 與實際 payout，保留歷史規則。`financial_ledger_source_reference_unique` 保證每局各一筆 `PLINKO_BET_DEBIT`／`PLINKO_SETTLEMENT_CREDIT`。本日收益包含 Plinko 淨損益，WebSocket 共用 user_snapshot。

主畫面右上方提供圓形投注設定圖示按鈕，開啟彈出面板後調整投注額、排數與風險，投球按鈕保留在主畫面。設定按鈕左側以金色顯示最近 10 顆已落槽球的倍率，由新到舊排列，重新進入遊戲時由伺服器載入。已移除「紀錄」入口與內頁；舊網址 `/history?game=plinko` 返回遊戲。

投球左側提供自動球數選單：關閉（單球）、30、50、100、300、500、1000 球，以及 ∞（無限）。選擇後按投球啟動；自動期間顯示「停止投球（剩餘球數）」，無限模式顯示「停止投球（∞）」且不倒數。再次點擊取消後續投球，已送出的請求仍正常顯示結果。每筆成功回覆後等待 350ms 再送下一球，沿用原有單球 API 與獨立 idempotency key，最多保留 12 顆下落動畫。自動期間鎖定投注設定；達到指定球數、餘額不足、請求失敗、切換帳號或離開頁面即停止，無限模式同樣適用這些停止條件。斷線後只確認原本尚未收到結果的投注，不會自動重新啟動投球。

每分頁最多一個下注 HTTP request，最多同時演示 12 顆球，不預排投注。未確認請求保存在使用者專屬 sessionStorage；重新整理後先明確確認上一筆。排數／風險在請求或動畫進行時鎖定；reduced motion 直接顯示結果。

畫面餘額與後端結算分開：投球時先顯示預扣投注額，已確認派彩等該球落槽後以 800ms 數字動畫加回。多球分別保留尚未呈現的派彩；HTTP 回應前收到的 WebSocket 餘額暫緩顯示，避免提早揭露派彩。拒絕投注時恢復顯示，結果未確認時保留預扣直到原 key 確認；重新載入、確認既有結果及 reduced motion 直接同步已結算餘額。

## 部署與驗證

落槽倍率達 10× 顯示金色 NICE WIN，30× 顯示 BIG WIN，100× 顯示 MEGA WIN。演出包含旋轉放射光、擴散光環、倍率彈入，以及 Canvas 繪製的翻轉金幣、彩帶與星光；金額在 950ms 內累加至伺服器派彩。效果只在新球落槽後觸發，單次顯示 3.6 秒，限制於釘板內且不攔截點擊。Canvas 像素比最多 2、粒子同時最多 180 個，卸載時取消動畫與 ResizeObserver。期間其他達標球落槽時，更新同一張提示的最高倍率與累計金額，並重新計時。動畫畫面僅呈現中獎標題、倍率與金額，不顯示「含本金」、「派彩」或其他說明標籤。自動投球繼續運作，停止按鈕維持可用；歷史載入與既有投注結果回放不觸發。Reduced motion 只顯示靜態提示，不播放粒子、光環或縮放。

停止 API／worker 後執行 migration 11，再啟動新版程序。`PLINKO_ENABLED=false` 停止新投注，歷史／已提交 key 回放不受影響。保留 schema、round、ledger 與 idempotency 資料；不以回退資料庫刪除已結算投注。詳見 [migration runbook](../deploy/database-migrations.md)。

測試包含 27 組 RTP 與所有合法投注額的逐槽精確派彩、v1 完整二項路徑分布、v2 兩側機率精確加倍、各槽抽選邊界與相符路徑、HTTP contracts、並發重試、跨遊戲錢包鎖、quota、停用、rollback、資料約束及 client 復原。Integration tests 僅能使用 `baccarat_core_api_test_*` 專用空資料庫。

### v2 機率與倍率公式

令排數為 n、舊格權重 `wₖ = C(n,k)`、`D = 2ⁿ`、兩側四格舊權重合計 `E = 2(n+1)`。新版使用分母 `T = D(D−E)`：

- 邊緣四格的權重為 `2wₖ(D−E)`，故機率正好是舊版的 2 倍。
- 中間格權重為 `wₖ(D−2E)`，所有權重加總仍為 T，且 8–16 排全部為正。
- 用舊倍率整數 `uₖ` 算出舊期望 `A = Σuₖwₖ / D` 與套入新機率後的期望 `B = ΣuₖWₖ / T`，新倍率整數為 `ROUND_HALF_UP(uₖ × A / B)`。所有風險與排數同樣處理，不只改最高獎。
- 選好落點 k 後，若剩餘 m 排、需 r 次右轉，下一步往右的機率為 r/m。這使通往 k 的每條路徑等機率，並確保動畫落在已抽中的格子。

### v2 更新相容性

此版本不需新增 migration。新投注必須帶目前 config 的 ruleVersion（2）；新版 server 對尚未接受的 v1 投注回傳 409，不抽球、不扣款。client 停止自動投注並更新 config，不能自動重下注。已接受的 v1 投注先按原 idempotency key 重播，再進行版本檢查；歷史仍使用保存的路徑、倍率與派彩，絕不按 v2 重算。

上線先部署能讀取 config v1／v2 的 web，再切換 server v2（或短暫關閉新投注，完成部署後重開）。舊 web 的 config schema 只接受 v1，因此需要更新／重新載入頁面。回退時保留 v1／v2 的紀錄與永久 idempotency 資料；若回退成 v1 server，新 v2 指令會 409，client 需重新取得 config，不可改寫已結算資料。

驗證：8 項 math／contract tests、29 項 Plinko store／view tests、10 項專用 PostgreSQL integration tests，以及 Chromium／WebKit 共 18 項 mocked E2E 通過。數學測試逐一驗算 27 組表、100–5,000 所有合法投注額的逐槽派彩與 RTP；integration 包含 v1 重播、v2 新下注、WS、並發、rollback、ledger 與跨遊戲曝險。
