import type { MigrationDefinition } from "./types.js";

export const minesAndDecimalMoneyMigration: MigrationDefinition = {
  version: 10,
  name: "mines_and_decimal_money",
  up: `
    DROP VIEW financial_balance_reconciliation;
    DROP TRIGGER users_balance_requires_ledger ON users;
    ALTER TABLE game_tables ALTER COLUMN min_bet TYPE NUMERIC(20,2) USING min_bet::numeric(20,2);
    ALTER TABLE game_tables ALTER COLUMN max_bet TYPE NUMERIC(20,2) USING max_bet::numeric(20,2);
    ALTER TABLE users ALTER COLUMN balance TYPE NUMERIC(20,2) USING balance::numeric(20,2);
    ALTER TABLE bets ALTER COLUMN amount TYPE NUMERIC(20,2) USING amount::numeric(20,2);
    ALTER TABLE bets ALTER COLUMN payout TYPE NUMERIC(20,2) USING payout::numeric(20,2);
    ALTER TABLE balance_adjustments ALTER COLUMN amount TYPE NUMERIC(20,2) USING amount::numeric(20,2);
    ALTER TABLE financial_ledger_entries ALTER COLUMN delta TYPE NUMERIC(20,2) USING delta::numeric(20,2);
    ALTER TABLE financial_ledger_entries ALTER COLUMN balance_before TYPE NUMERIC(20,2) USING balance_before::numeric(20,2);
    ALTER TABLE financial_ledger_entries ALTER COLUMN balance_after TYPE NUMERIC(20,2) USING balance_after::numeric(20,2);
    ALTER TABLE users ADD COLUMN balance_version BIGINT NOT NULL DEFAULT 0;
    UPDATE users SET balance_version = COALESCE((SELECT MAX(entry_sequence) FROM financial_ledger_entries WHERE user_id = users.id), 0);
    CREATE TRIGGER users_balance_requires_ledger BEFORE UPDATE OF balance ON users
      FOR EACH ROW EXECUTE FUNCTION reject_unjournaled_user_balance_update();
    ALTER TABLE financial_ledger_entries DROP CONSTRAINT financial_ledger_source_reference;
    ALTER TABLE financial_ledger_entries ADD CONSTRAINT financial_ledger_source_reference CHECK (
      (source = 'LEGACY_OPENING_BALANCE' AND actor_type = 'SYSTEM' AND reference_type = 'USER') OR
      (source = 'INITIAL_FUNDING' AND actor_type IN ('SYSTEM', 'ADMIN') AND reference_type = 'USER') OR
      (source = 'ADMIN_ADJUSTMENT' AND actor_type = 'ADMIN' AND reference_type = 'BALANCE_ADJUSTMENT') OR
      (source = 'BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BET') OR
      (source = 'SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'ROUND') OR
      (source = 'MINES_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'MINES_ROUND') OR
      (source = 'MINES_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'MINES_ROUND')
    );
    ALTER TABLE bets DROP CONSTRAINT bets_amounts_ck;
    ALTER TABLE bets ADD CONSTRAINT bets_amounts_ck CHECK (amount > 0 AND payout >= 0 AND payout <= amount * 12);
    CREATE TABLE mines_rounds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount NUMERIC(20,2) NOT NULL CHECK (amount BETWEEN 100 AND 5000 AND amount % 100 = 0),
      mine_count INTEGER NOT NULL CHECK (mine_count BETWEEN 1 AND 24),
      mine_cells INTEGER[] NOT NULL,
      revealed_cells INTEGER[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOST','CASHED_OUT')),
      payout NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (payout BETWEEN 0 AND 2000000000),
      maximum_payout NUMERIC(20,2) NOT NULL CHECK (maximum_payout > 0),
      rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version = 1),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ,
      CONSTRAINT mines_rounds_lifecycle CHECK (
        (status = 'ACTIVE' AND settled_at IS NULL AND payout = 0) OR
        (status = 'LOST' AND settled_at IS NOT NULL AND payout = 0) OR
        (status = 'CASHED_OUT' AND settled_at IS NOT NULL AND payout > 0)
      ),
      CONSTRAINT mines_rounds_board CHECK (
        cardinality(mine_cells) = mine_count AND 0 <= ALL(mine_cells) AND 24 >= ALL(mine_cells) AND
        cardinality(revealed_cells) <= 25 AND 0 <= ALL(revealed_cells) AND 24 >= ALL(revealed_cells)
      )
    );
    CREATE UNIQUE INDEX idx_mines_one_active_per_user ON mines_rounds(user_id) WHERE status = 'ACTIVE';
    CREATE INDEX idx_mines_history ON mines_rounds(user_id, settled_at DESC, created_at DESC, id DESC) WHERE status <> 'ACTIVE';
    CREATE OR REPLACE VIEW financial_balance_reconciliation AS
    WITH ordered_entries AS (
      SELECT user_id, entry_sequence, delta, balance_before, balance_after,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY entry_sequence) AS entry_number,
        LAG(balance_after) OVER (PARTITION BY user_id ORDER BY entry_sequence) AS previous_balance_after
      FROM financial_ledger_entries
    ), ledger_rollup AS (
      SELECT user_id, COUNT(*)::bigint AS entry_count, SUM(delta) AS total_delta,
        (ARRAY_AGG(balance_after ORDER BY entry_sequence DESC))[1] AS ledger_balance,
        BOOL_AND(
          balance_after = balance_before + delta AND
          CASE WHEN entry_number = 1 THEN balance_before = 0 ELSE balance_before = previous_balance_after END
        ) AS chain_consistent
      FROM ordered_entries GROUP BY user_id
    )
    SELECT users.id AS user_id, users.balance AS current_balance,
      COALESCE(ledger_rollup.ledger_balance, 0) AS ledger_balance,
      COALESCE(ledger_rollup.total_delta, 0) AS total_delta,
      COALESCE(ledger_rollup.entry_count, 0)::bigint AS entry_count,
      COALESCE(ledger_rollup.chain_consistent, FALSE) AS chain_consistent,
      (
        COALESCE(ledger_rollup.entry_count, 0) > 0 AND
        COALESCE(ledger_rollup.chain_consistent, FALSE) AND
        users.balance = COALESCE(ledger_rollup.ledger_balance, 0) AND
        COALESCE(ledger_rollup.total_delta, 0) = COALESCE(ledger_rollup.ledger_balance, 0)
      ) AS is_reconciled
    FROM users LEFT JOIN ledger_rollup ON ledger_rollup.user_id = users.id;
  `,
};
