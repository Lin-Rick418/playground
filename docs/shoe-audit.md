# Verifiable Shoe Audit

每個新 shoe 在任何牌被發出前建立 256-bit random seed、deterministic shoe 與 SHA-256 commitment。玩家在 lobby/table HTTP response 與對應 WebSocket snapshot 會看到相同 commitment，但 active shoe 的 seed、cut-card position 與未來牌序不會出現在一般 API 或 WS。

## Lifecycle

1. 在鎖住 table row 的 transaction 內，以 `crypto.randomBytes(32)` 建立 seed。
2. 使用 `hmac-sha256-fisher-yates-v1` 重建八副牌、cut card 與 burn cards。
3. 同一 transaction 先 append `shoe_commitments`、保存 active `shoe_secrets`，再把 shoe 指派給 table；新建的可下注 round 不會先於 commitment 存在。舊版既有 round 的例外見 migration 說明。
4. 每次 settlement 先鎖住 round、table shoe 與 commitment lifecycle，確認 round 綁定的 shoe、active seed 與 commitment 都有效；再於更新 round、balance 與剩餘 shoe 的同一 transaction append `shoe_deal_audits`。記錄包含實際 draw order 與 round result；round retention cleanup 不會刪除 audit。
5. cut-card final hand 或其他 rotate 原因發生時，同一 transaction 先把 seed append 到 `shoe_reveals`、刪除 active secret，再建立下一個 commitment。revealed shoe 不能再 append deal。

若 LOCKED round 的 shoe ID mismatch、可用牌不足或 commitment/secret 無效，settlement 會 fail closed：round 標成 `CANCELLED`、所有 bet 原額退款，且不會在封盤後建立新 shoe 或改綁 round。下一個 round 只能在另一個 transaction 先取得有效 committed shoe 後才可建立。

`shoe_commitments`、`shoe_reveals`、`shoe_deal_audits` 有 database triggers 拒絕 `UPDATE`、`DELETE`、`TRUNCATE`；active secret 也不可 `UPDATE`。API/worker crash 時，remaining cards 與 seed 都在 PostgreSQL，restart 後會繼續同一 commitment。每個 table 以自己的 row lock 與 shoe ID 隔離，並行 table 不共用 PRNG state。

## Commitment format

seed 必須是 32 bytes lowercase hex。commitment 是下列 UTF-8 JSON array 的 SHA-256 lowercase hex：

```text
SHA256(JSON.stringify([
  "baccarat-shoe-audit",
  1,
  "hmac-sha256-fisher-yates-v1",
  "baccarat-round-v1",
  shoeId,
  tableId,
  8,
  seedHex
]))
```

deterministic random stream 的每個 32-byte block 為：

```text
HMAC-SHA256(seed, UTF8("baccarat-shoe-audit/random/v1\0") || uint64be(counter))
```

counter 從 0 開始。所有 bounded integer 使用 32-bit rejection sampling 避免 modulo bias；同一 stream 先執行 Fisher-Yates，再選 Massachusetts cut-card position。初始牌序固定依 deck、`S/H/D/C`、`A..K` 建立，發牌方向是 shuffled array 的尾端。第一張 burn card 決定額外 burn 數量。

`baccarat-round-v1` verifier 會從 committed shoe 依該版本完整重播 Player/Banker opening assignment、natural、Player third card、Banker third-card table、totals、winner 與 pair flags，再 deep-compare draw-order cards 和完整 result。任何 shuffle、cut、burn 或 dealing rule 變更都必須 bump audit version/algorithm，並在部署時 rotate active shoes；不可用新程式默默重新解釋舊 proof。

## API contract

已登入 PLAYER 可查詢：

```http
GET /api/game/shoes/:shoeId/audit
Authorization: Bearer <token>
```

已登入 ADMIN 可用相同 response contract 查詢：

```http
GET /api/admin/shoes/:shoeId/audit
Authorization: Bearer <token>
```

找不到時回 `404 { "message": "Shoe audit not found" }`。

active shoe 回傳 commitment、已完成的 deals、`reveal: null`、`verification: null`，且 `cutCardRemaining` 為 `null`。不得在 active response 新增 `seed` 或 remaining cards。

rotate 後同一路徑會回傳：

- `reveal.seed`、`reveal.reason`、`reveal.revealedAt`
- committed `cutCardRemaining`
- append-only deals（`dealIndex`、`roundId`、draw-order cards、result）
- server-side `verification`

`verification.status` 只有完整走到 cut card、再完成唯一 final hand，且 reveal reason 是 `CUT_CARD_LAST_HAND` 時才可能是 `VALID`。正常終止前的空 audit 或任意 prefix 都是 `INVALID`；manual、legacy、insufficient-card 等非正常 rotation 是 `CANCELLED`，即使其已記錄 prefix 與 commitment 本身一致也不會標為 fairness-valid。

lobby/table snapshot 的 `shoeAudit` 永遠只包含 safe commitment metadata：version、shoe ID、algorithm、deck count、commitment 與 timestamp。

## Independent verification

把 revealed API JSON 存成檔案後執行：

```bash
npm run audit:verify --workspace server -- /path/to/shoe-audit.json
```

production build 也可直接執行：

```bash
node apps/server/dist/scripts/verify-shoe-audit.js /path/to/shoe-audit.json
```

沒有檔案參數時從 stdin 讀取。exit code `0` 表示 commitment、連續 deal indexes、逐局完整 dealing-rule replay，以及 cut-card terminal lifecycle 全部通過；`1` 表示 proof invalid/cancelled/unrevealed；`2` 表示輸入無法解析。

## Migration and retention

- 舊版 plaintext shoe 沒有 seed，不能偽造為可驗證歷史。startup migration 會對每個 table 使用獨立 transaction 鎖住 active round 與 table；既有 OPEN/LOCKED round 會 `CANCELLED` 並原額退款、保留原 legacy shoe ID，絕不 retrofit 成新 proof。取消後才建立新的 committed shoe 供下一局使用。
- 已 settlement 的 legacy rounds 保持原樣，查詢其 shoe ID 會得到 404。
- 一般 round/bet retention 不會 cascade 到 audit tables。capacity planning 與 backup 必須把三個 append-only audit tables 納入長期保存；`shoe_secrets` 也必須進入受控加密 backup，否則 active shoe 在 database loss 後無法 reveal。
- rollback 到不認識 audit schema 的舊版 code 不會刪除 proof，但舊 worker 會產生沒有 audit 的新 deals；production rollback 應停止 worker，或回到仍支援 audit 的版本。

## Threat model and limits

這套 proof 能偵測 commitment 發布後的 seed/牌序替換、deal reorder、result tampering、deal deletion/update 與 reveal 後追加。它也讓 client 或 auditor 在不信任 verifier server 的情況下獨立重建。

它不解決以下威脅：

- 有 DB/host read access 的攻擊者仍可讀到 active `shoe_secrets`，而既有 `shoe_state` 本來就保存 remaining plaintext cards；保護 production DB credential、backup 與 host 才能防止預知牌序。
- DB owner/superuser 或 host root 可以 disable trigger、改 code 或整庫重寫。若要抵抗營運方改寫歷史，client/第三方必須即時保存 commitment，並把 reveal/audit export 到外部 WORM storage、transparency log 或簽章服務。
- server 可以在 publication 前反覆丟棄 seed（selective seeding）。commitment 證明 publication 後沒有換牌，不證明 seed 來源由多方共同產生。更強模型需要 client seed、beacon 或 multi-party ceremony。
- 攻擊者可刪除 active secret造成無法 reveal；rotation 會 fail closed，但 availability 仍依賴 database backup。
- verifier 依 `dealAlgorithm` 重播 Player/Banker assignment 與完整 third-card rule；若 implementation 或規則版本變更，必須保留舊 replay 並 bump `dealAlgorithm`，否則舊 proof 會被錯誤重解釋。
- proof 驗證軟體規則與記錄資料，不證明實體 casino shoe、影像或真人荷官行為。

deal append 與 reveal insert 在 application 及 database trigger 兩層都會鎖同一 commitment row，因此兩個 connection 的 race 只有「deal 先完成後 reveal」或「reveal 先完成後拒絕 deal」兩種結果，不會出現 reveal 後追加。

監控應告警：commitment 缺失、active secret 缺失、verification failure、`CANCELLED` round、非預期 rotate reason，以及 rotate transaction 持續失敗。
