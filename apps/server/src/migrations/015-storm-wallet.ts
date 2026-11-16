import type { MigrationDefinition } from "./types.js";
export const stormMigration: MigrationDefinition = {
  version: 15, name: "storm_wallet", up: `
    CREATE TABLE storm_sessions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      amount NUMERIC(20,2) NOT NULL CHECK(amount IN (10,20,50,100)),
      progress JSONB NOT NULL,
      version INTEGER NOT NULL CHECK(version >= 0),
      rule_version INTEGER NOT NULL DEFAULT 1 CHECK(rule_version=1),
      maximum_payout NUMERIC(20,2) NOT NULL,
      CONSTRAINT storm_session_progress CHECK(
        jsonb_typeof(progress)='object' AND progress ?& ARRAY['freeLeft','freeGranted','feature','multiplier','featureWin'] AND
        jsonb_typeof(progress->'freeLeft')='number' AND jsonb_typeof(progress->'freeGranted')='number' AND
        jsonb_typeof(progress->'feature')='string' AND jsonb_typeof(progress->'multiplier')='number' AND jsonb_typeof(progress->'featureWin')='number' AND
        (progress->>'freeLeft')::integer BETWEEN 0 AND (progress->>'freeGranted')::integer AND
        (progress->>'freeGranted')::integer BETWEEN 0 AND 100 AND progress->>'feature' IN ('normal','super') AND
        (progress->>'multiplier')::integer BETWEEN 0 AND 3000000 AND (progress->>'featureWin')::numeric BETWEEN 0 AND 250000000),
      CONSTRAINT storm_session_exposure CHECK(maximum_payout = CASE WHEN (progress->>'freeLeft')::integer > 0
        THEN ((progress->>'freeLeft')::integer + 100 - (progress->>'freeGranted')::integer) * amount * 25000 ELSE 0 END)
    );
    CREATE TABLE storm_rounds (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      stake NUMERIC(20,2) NOT NULL CHECK(stake IN (10,20,50,100)),
      amount NUMERIC(20,2) NOT NULL, payout NUMERIC(20,2) NOT NULL,
      result JSONB NOT NULL, version INTEGER NOT NULL CHECK(version>0),
      rule_version INTEGER NOT NULL DEFAULT 1 CHECK(rule_version=1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
      settled_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
      CONSTRAINT storm_round_money CHECK(amount IN (0,stake) AND payout BETWEEN 0 AND stake*25000),
      CONSTRAINT storm_round_result CHECK(jsonb_typeof(result)='object' AND result ?& ARRAY['state','frames','board','payout','cost','wasFree'] AND
        jsonb_typeof(result->'board')='array' AND jsonb_array_length(result->'board')=30 AND
        jsonb_typeof(result->'frames')='array' AND jsonb_array_length(result->'frames') BETWEEN 1 AND 13 AND
        jsonb_typeof(result->'payout')='number' AND jsonb_typeof(result->'cost')='number' AND jsonb_typeof(result->'wasFree')='boolean' AND
        (result->>'payout')::numeric=payout AND (result->>'cost')::numeric=amount AND
        (result->>'wasFree')::boolean=(amount=0)),
      CONSTRAINT storm_round_version UNIQUE(user_id,version)
    );
    CREATE OR REPLACE FUNCTION reject_storm_round_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Settled Storm rounds are immutable'; END; $$;
    CREATE TRIGGER storm_rounds_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON storm_rounds
      FOR EACH STATEMENT EXECUTE FUNCTION reject_storm_round_mutation();
    CREATE INDEX idx_storm_history ON storm_rounds(user_id,version DESC);
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
      (source = 'PLINKO_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'PLINKO_ROUND') OR
      (source = 'HILO_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'HILO_ROUND') OR
      (source = 'HILO_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'HILO_ROUND') OR
      (source = 'BLACKJACK_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BLACKJACK_ACTION') OR
      (source = 'BLACKJACK_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'BLACKJACK_ROUND') OR
      (source = 'STORM_BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'STORM_ROUND') OR
      (source = 'STORM_SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'STORM_ROUND')
    );
  `,
};
