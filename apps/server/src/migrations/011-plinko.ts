import type { MigrationDefinition } from "./types.js";

export const plinkoMigration: MigrationDefinition = {
  version: 11,
  name: "plinko",
  up: `
    CREATE TABLE plinko_rounds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount NUMERIC(20,2) NOT NULL CHECK (amount BETWEEN 100 AND 5000 AND amount % 100 = 0),
      rows INTEGER NOT NULL CHECK (rows BETWEEN 8 AND 16),
      risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
      path INTEGER[] NOT NULL,
      slot_index INTEGER NOT NULL,
      multiplier_units INTEGER NOT NULL CHECK (multiplier_units BETWEEN 1 AND 10000000),
      payout NUMERIC(20,2) NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      -- Cursor timestamps use JavaScript ISO milliseconds; persist that same precision.
      created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      settled_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      CONSTRAINT plinko_rounds_path CHECK (
        array_ndims(path) = 1 AND array_lower(path, 1) = 1 AND cardinality(path) = rows AND
        array_position(path, NULL) IS NULL AND 0 <= ALL(path) AND 1 >= ALL(path) AND
        slot_index BETWEEN 0 AND rows AND slot_index = cardinality(array_positions(path, 1))
      ),
      CONSTRAINT plinko_rounds_payout CHECK (
        payout > 0 AND payout <= 2000000000 AND payout = amount * multiplier_units / 10000
      ),
      CONSTRAINT plinko_rounds_settled CHECK (settled_at >= created_at)
    );
    CREATE INDEX idx_plinko_history ON plinko_rounds(user_id, settled_at DESC, created_at DESC, id DESC);
    ALTER TABLE financial_ledger_entries DROP CONSTRAINT financial_ledger_source_reference;
    ALTER TABLE financial_ledger_entries ADD CONSTRAINT financial_ledger_source_reference CHECK (
      (source = 'LEGACY_OPENING_BALANCE' AND actor_type = 'SYSTEM' AND reference_type = 'USER') OR
      (source = 'INITIAL_FUNDING' AND actor_type IN ('SYSTEM','ADMIN') AND reference_type = 'USER') OR
      (source = 'ADMIN_ADJUSTMENT' AND actor_type = 'ADMIN' AND reference_type = 'BALANCE_ADJUSTMENT') OR
      (source = 'BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BET') OR
      (source = 'SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'ROUND') OR
      (source = 'MINES_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'MINES_ROUND') OR
      (source = 'MINES_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'MINES_ROUND') OR
      (source = 'PLINKO_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'PLINKO_ROUND') OR
      (source = 'PLINKO_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'PLINKO_ROUND')
    );
    -- Existing UNIQUE(source, reference_type, reference_id) enforces one debit and credit per round.
    ALTER TABLE login_rate_limits DROP CONSTRAINT login_rate_limits_scope_check;
    ALTER TABLE login_rate_limits ADD CONSTRAINT login_rate_limits_scope_check
      CHECK (scope IN ('ACCOUNT_IP','ACCOUNT','IP','ENDPOINT_IP','ENDPOINT_USER'));
  `,
};
