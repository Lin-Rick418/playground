# Core Database Integrity Rollout

這次 schema upgrade 不會改寫或刪除業務資料。`initializeDatabase()` 會先以 `NOT VALID` 加入具名 CHECK/FK，再在同一個 PostgreSQL implicit transaction 內執行 `VALIDATE CONSTRAINT`；任一既有資料違規時，整批 DDL 會 rollback，API/worker startup 會失敗並顯示 constraint name。

## Forward / preflight

上線前先備份資料庫，並在維護窗口停止 API 與 worker，避免 preflight 後又寫入不合法資料。以下查詢每一列都應為 `0`：

```sql
SELECT 'duplicate_display_order' AS rule, count(*) AS violations
FROM (
  SELECT display_order FROM game_tables GROUP BY display_order HAVING count(*) > 1
) duplicate_orders
UNION ALL
SELECT 'invalid_tables', count(*) FROM game_tables
WHERE btrim(id) = '' OR btrim(code) = '' OR btrim(name) = ''
   OR display_order < 0 OR round_duration_ms <= 0
   OR round_phase_offset_ms < 0 OR round_phase_offset_ms >= round_duration_ms
   OR round_schedule_version < 0 OR min_bet <= 0 OR max_bet < min_bet
   OR jsonb_typeof(shoe_state) <> 'object'
UNION ALL
SELECT 'invalid_users', count(*) FROM users
WHERE btrim(id) = '' OR username !~ '^[A-Za-z0-9_]{3,24}$'
   OR btrim(password_hash) = '' OR role NOT IN ('ADMIN', 'PLAYER')
   OR balance < 0 OR updated_at < created_at
UNION ALL
SELECT 'invalid_rounds', count(*) FROM game_rounds
WHERE btrim(id) = '' OR jsonb_typeof(player_cards) <> 'array'
   OR jsonb_typeof(banker_cards) <> 'array'
   OR player_total NOT BETWEEN 0 AND 9 OR banker_total NOT BETWEEN 0 AND 9
   OR winner NOT IN ('PLAYER', 'BANKER', 'TIE')
   OR status NOT IN ('OPEN', 'LOCKED', 'SETTLED')
   OR betting_opens_at >= betting_closes_at
   OR ((status = 'SETTLED') <> (settled_at IS NOT NULL))
   OR (settled_at IS NOT NULL AND (settled_at < betting_closes_at OR settled_at < created_at))
UNION ALL
SELECT 'invalid_bets', count(*) FROM bets
WHERE btrim(id) = '' OR bet_type NOT IN ('PLAYER', 'BANKER', 'TIE', 'PLAYER_PAIR', 'BANKER_PAIR')
   OR amount <= 0 OR payout < 0 OR payout::bigint > amount::bigint * 12
UNION ALL
SELECT 'invalid_adjustments', count(*) FROM balance_adjustments
WHERE btrim(id) = '' OR amount = 0 OR length(note) > 200
UNION ALL
SELECT 'orphan_round_table', count(*) FROM game_rounds r
LEFT JOIN game_tables t ON t.id = r.table_id WHERE t.id IS NULL
UNION ALL
SELECT 'orphan_bet_user', count(*) FROM bets b
LEFT JOIN users u ON u.id = b.user_id WHERE u.id IS NULL
UNION ALL
SELECT 'orphan_bet_round', count(*) FROM bets b
LEFT JOIN game_rounds r ON r.id = b.round_id WHERE r.id IS NULL
UNION ALL
SELECT 'orphan_adjustment_admin', count(*) FROM balance_adjustments a
LEFT JOIN users u ON u.id = a.admin_id WHERE u.id IS NULL
UNION ALL
SELECT 'orphan_adjustment_user', count(*) FROM balance_adjustments a
LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL;
```

若有違規，先由 operator 依業務紀錄修正，不要用自動刪除或猜測值。所有結果為零後，先啟動 API 並確認 startup 成功，再啟動 worker。重跑 `initializeDatabase()` 是安全且可重入的；既有 constraint 會略過新增並再次確認為 validated。

## Integration test

測試會拒絕 database name 沒有 `baccarat_integrity_test_` prefix，且要求 database 起始為空：

```bash
createdb baccarat_integrity_test_local
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/baccarat_integrity_test_local \
  npm run test:db-integrity --workspace server
dropdb baccarat_integrity_test_local
```

## Rollback

Rollback 只移除本次 protections，不會恢復或修改任何資料。僅在新 constraint 判定與既有合法業務不相容、且 application rollback 已完成時使用：

```sql
BEGIN;
ALTER TABLE game_tables DROP CONSTRAINT IF EXISTS game_tables_id_not_blank_ck;
ALTER TABLE game_tables DROP CONSTRAINT IF EXISTS game_tables_code_not_blank_ck;
ALTER TABLE game_tables DROP CONSTRAINT IF EXISTS game_tables_name_not_blank_ck;
ALTER TABLE game_tables DROP CONSTRAINT IF EXISTS game_tables_schedule_values_ck;
ALTER TABLE game_tables DROP CONSTRAINT IF EXISTS game_tables_bet_limits_ck;
ALTER TABLE game_tables DROP CONSTRAINT IF EXISTS game_tables_shoe_state_object_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_id_not_blank_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_format_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_hash_not_blank_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_balance_nonnegative_ck;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_timestamps_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_id_not_blank_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_table_fk;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_cards_array_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_totals_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_winner_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_status_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_time_window_ck;
ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_settlement_ck;
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_id_not_blank_ck;
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_user_fk;
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_round_fk;
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_type_ck;
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_amounts_ck;
ALTER TABLE balance_adjustments DROP CONSTRAINT IF EXISTS balance_adjustments_id_not_blank_ck;
ALTER TABLE balance_adjustments DROP CONSTRAINT IF EXISTS balance_adjustments_admin_fk;
ALTER TABLE balance_adjustments DROP CONSTRAINT IF EXISTS balance_adjustments_user_fk;
ALTER TABLE balance_adjustments DROP CONSTRAINT IF EXISTS balance_adjustments_amount_nonzero_ck;
ALTER TABLE balance_adjustments DROP CONSTRAINT IF EXISTS balance_adjustments_note_length_ck;
DROP INDEX IF EXISTS uq_game_tables_display_order;
DROP INDEX IF EXISTS idx_balance_adjustments_admin_id;
DROP INDEX IF EXISTS idx_balance_adjustments_user_id;
COMMIT;
```
