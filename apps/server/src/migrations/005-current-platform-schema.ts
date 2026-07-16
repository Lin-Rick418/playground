import { MAX_ACCOUNT_BALANCE, MONEY_DENOMINATION } from "../lib/account-policy.js";
import { coreDatabaseIntegritySql } from "../lib/database-integrity.js";
import type { MigrationDefinition } from "./types.js";

export const currentPlatformSchemaMigration: MigrationDefinition = {
  version: 5,
  name: "current_platform_schema",
  up: `
    ALTER TABLE game_rounds ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

    CREATE TABLE IF NOT EXISTS login_rate_limits (
      scope TEXT NOT NULL CHECK (scope IN ('ACCOUNT_IP', 'ACCOUNT', 'IP')),
      key_hash TEXT NOT NULL,
      failures INTEGER NOT NULL CHECK (failures > 0),
      window_started_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope, key_hash)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      actor_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER,
      response_json JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (actor_id, scope, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS financial_ledger_entries (
      id TEXT PRIMARY KEY,
      entry_sequence BIGSERIAL NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      source TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_before INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT financial_ledger_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
      CONSTRAINT financial_ledger_balance_transition
        CHECK (balance_before >= 0 AND balance_after >= 0 AND balance_after = balance_before + delta),
      CONSTRAINT financial_ledger_actor
        CHECK (
          (actor_type = 'SYSTEM' AND actor_id IS NULL) OR
          (actor_type IN ('ADMIN', 'PLAYER') AND actor_id IS NOT NULL)
        ),
      CONSTRAINT financial_ledger_source_reference
        CHECK (
          (source = 'LEGACY_OPENING_BALANCE' AND actor_type = 'SYSTEM' AND reference_type = 'USER') OR
          (source = 'INITIAL_FUNDING' AND actor_type IN ('SYSTEM', 'ADMIN') AND reference_type = 'USER') OR
          (source = 'ADMIN_ADJUSTMENT' AND actor_type = 'ADMIN' AND reference_type = 'BALANCE_ADJUSTMENT') OR
          (source = 'BET_DEBIT' AND actor_type = 'PLAYER' AND reference_type = 'BET') OR
          (source = 'SETTLEMENT_CREDIT' AND actor_type = 'SYSTEM' AND reference_type = 'ROUND')
        ),
      CONSTRAINT financial_ledger_source_reference_unique
        UNIQUE (user_id, source, reference_type, reference_id)
    );

    CREATE TABLE IF NOT EXISTS service_heartbeats (
      service_name TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      last_seen_at TIMESTAMPTZ NOT NULL,
      last_healthy_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_commitments (
      shoe_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES game_tables(id),
      audit_version INTEGER NOT NULL,
      shuffle_algorithm TEXT NOT NULL,
      deal_algorithm TEXT NOT NULL,
      deck_count INTEGER NOT NULL CHECK (deck_count > 0),
      commitment TEXT NOT NULL CHECK (commitment ~ '^[0-9a-f]{64}$'),
      cut_card_remaining INTEGER NOT NULL CHECK (cut_card_remaining >= 0),
      committed_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_secrets (
      shoe_id TEXT PRIMARY KEY REFERENCES shoe_commitments(shoe_id),
      seed_hex TEXT NOT NULL CHECK (seed_hex ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_reveals (
      shoe_id TEXT PRIMARY KEY REFERENCES shoe_commitments(shoe_id),
      seed_hex TEXT NOT NULL CHECK (seed_hex ~ '^[0-9a-f]{64}$'),
      reveal_reason TEXT NOT NULL,
      revealed_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shoe_deal_audits (
      round_id TEXT PRIMARY KEY,
      shoe_id TEXT NOT NULL REFERENCES shoe_commitments(shoe_id),
      deal_index INTEGER NOT NULL CHECK (deal_index >= 0),
      dealt_cards JSONB NOT NULL,
      round_result JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL,
      UNIQUE (shoe_id, deal_index)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized ON users ((lower(username)));
    CREATE INDEX IF NOT EXISTS idx_login_rate_limits_expires ON login_rate_limits (expires_at ASC);
    CREATE INDEX IF NOT EXISTS idx_financial_ledger_user_sequence
      ON financial_ledger_entries (user_id, entry_sequence ASC);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
      ON auth_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_shoe_commitments_table_created
      ON shoe_commitments (table_id, committed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shoe_deal_audits_shoe_index
      ON shoe_deal_audits (shoe_id, deal_index ASC);

    UPDATE game_tables
    SET shoe_state = jsonb_build_object(
      'cards', shoe_state,
      'cutCardRemaining', LEAST(14, jsonb_array_length(shoe_state)),
      'cutCardReached', jsonb_array_length(shoe_state) <= 14,
      'lastHandPending', jsonb_array_length(shoe_state) <= 14
    )
    WHERE jsonb_typeof(shoe_state) = 'array';

    ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_status_ck;
    ALTER TABLE game_rounds DROP CONSTRAINT IF EXISTS game_rounds_settlement_ck;

    DO $money_constraints$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_ledger_user_fk') THEN
        ALTER TABLE financial_ledger_entries ADD CONSTRAINT financial_ledger_user_fk
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_sessions_user_fk') THEN
        ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_user_fk
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_heartbeats_status_ck') THEN
        ALTER TABLE service_heartbeats ADD CONSTRAINT service_heartbeats_status_ck
          CHECK (status IN ('healthy', 'degraded')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_balance_policy') THEN
        ALTER TABLE users ADD CONSTRAINT users_balance_policy
          CHECK (balance BETWEEN 0 AND ${MAX_ACCOUNT_BALANCE}) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_tables_bet_policy') THEN
        ALTER TABLE game_tables ADD CONSTRAINT game_tables_bet_policy CHECK (
          min_bet > 0 AND min_bet <= max_bet AND
          min_bet % ${MONEY_DENOMINATION} = 0 AND max_bet % ${MONEY_DENOMINATION} = 0 AND
          max_bet <= ${MAX_ACCOUNT_BALANCE}
        ) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bets_amount_policy') THEN
        ALTER TABLE bets ADD CONSTRAINT bets_amount_policy CHECK (
          amount > 0 AND amount <= ${MAX_ACCOUNT_BALANCE} AND amount % ${MONEY_DENOMINATION} = 0 AND
          payout BETWEEN 0 AND ${MAX_ACCOUNT_BALANCE} AND
          bet_type IN ('PLAYER', 'BANKER', 'TIE', 'PLAYER_PAIR', 'BANKER_PAIR')
        ) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balance_adjustments_amount_policy') THEN
        ALTER TABLE balance_adjustments ADD CONSTRAINT balance_adjustments_amount_policy CHECK (
          amount <> 0 AND amount BETWEEN -${MAX_ACCOUNT_BALANCE} AND ${MAX_ACCOUNT_BALANCE} AND
          amount % ${MONEY_DENOMINATION} = 0
        ) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_rounds_cancellation_reason_ck') THEN
        ALTER TABLE game_rounds ADD CONSTRAINT game_rounds_cancellation_reason_ck
          CHECK ((status = 'CANCELLED') = (cancellation_reason IS NOT NULL)) NOT VALID;
      END IF;
    END;
    $money_constraints$;

    ${coreDatabaseIntegritySql}

    ALTER TABLE users VALIDATE CONSTRAINT users_balance_policy;
    ALTER TABLE financial_ledger_entries VALIDATE CONSTRAINT financial_ledger_user_fk;
    ALTER TABLE auth_sessions VALIDATE CONSTRAINT auth_sessions_user_fk;
    ALTER TABLE service_heartbeats VALIDATE CONSTRAINT service_heartbeats_status_ck;
    ALTER TABLE game_tables VALIDATE CONSTRAINT game_tables_bet_policy;
    ALTER TABLE bets VALIDATE CONSTRAINT bets_amount_policy;
    ALTER TABLE balance_adjustments VALIDATE CONSTRAINT balance_adjustments_amount_policy;
    ALTER TABLE game_rounds VALIDATE CONSTRAINT game_rounds_cancellation_reason_ck;

    INSERT INTO financial_ledger_entries (
      id, user_id, actor_type, actor_id, source, reference_type, reference_id,
      delta, balance_before, balance_after, metadata, created_at
    )
    SELECT
      'legacy-opening:' || users.id,
      users.id,
      'SYSTEM',
      NULL,
      'LEGACY_OPENING_BALANCE',
      'USER',
      users.id,
      users.balance,
      0,
      users.balance,
      '{"backfilled":true}'::jsonb,
      NOW()
    FROM users
    WHERE NOT EXISTS (
      SELECT 1 FROM financial_ledger_entries
      WHERE financial_ledger_entries.user_id = users.id
    )
    ON CONFLICT (user_id, source, reference_type, reference_id) DO NOTHING;

    DO $active_round_guard$
    DECLARE duplicate_summary TEXT;
    BEGIN
      SELECT string_agg(table_id || ' (' || active_count || ')', '; ' ORDER BY table_id)
      INTO duplicate_summary
      FROM (
        SELECT table_id, COUNT(*) AS active_count
        FROM game_rounds
        WHERE status IN ('OPEN', 'LOCKED')
        GROUP BY table_id
        HAVING COUNT(*) > 1
      ) duplicates;
      IF duplicate_summary IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot enforce one active round per table: %', duplicate_summary;
      END IF;
    END;
    $active_round_guard$;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_game_rounds_one_active_per_table
      ON game_rounds (table_id) WHERE status IN ('OPEN', 'LOCKED');

    CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation()
    RETURNS trigger AS $financial_ledger_guard$
    BEGIN
      RAISE EXCEPTION 'financial_ledger_entries is append-only' USING ERRCODE = '55000';
    END;
    $financial_ledger_guard$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION reject_unjournaled_user_balance_update()
    RETURNS trigger AS $user_balance_guard$
    BEGIN
      IF NEW.balance IS DISTINCT FROM OLD.balance
         AND current_setting('baccarat.ledger_mutation', TRUE) IS DISTINCT FROM 'allowed' THEN
        RAISE EXCEPTION 'user balance updates must be journaled' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $user_balance_guard$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION reject_shoe_audit_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $shoe_audit_guard$
    BEGIN
      RAISE EXCEPTION 'shoe audit records are append-only';
    END;
    $shoe_audit_guard$;

    CREATE OR REPLACE FUNCTION reject_deal_after_shoe_reveal()
    RETURNS trigger LANGUAGE plpgsql AS $deal_after_reveal_guard$
    BEGIN
      PERFORM 1 FROM shoe_commitments WHERE shoe_id = NEW.shoe_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'shoe commitment does not exist'; END IF;
      IF EXISTS (SELECT 1 FROM shoe_reveals WHERE shoe_id = NEW.shoe_id) THEN
        RAISE EXCEPTION 'cannot append deals after shoe reveal';
      END IF;
      RETURN NEW;
    END;
    $deal_after_reveal_guard$;

    CREATE OR REPLACE FUNCTION serialize_shoe_reveal()
    RETURNS trigger LANGUAGE plpgsql AS $serialize_shoe_reveal_guard$
    BEGIN
      PERFORM 1 FROM shoe_commitments WHERE shoe_id = NEW.shoe_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'shoe commitment does not exist'; END IF;
      RETURN NEW;
    END;
    $serialize_shoe_reveal_guard$;

    DO $immutable_triggers$
    DECLARE audit_table TEXT; trigger_name TEXT;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'financial_ledger_no_update_delete') THEN
        CREATE TRIGGER financial_ledger_no_update_delete
          BEFORE UPDATE OR DELETE ON financial_ledger_entries
          FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'financial_ledger_no_truncate') THEN
        CREATE TRIGGER financial_ledger_no_truncate
          BEFORE TRUNCATE ON financial_ledger_entries
          FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_ledger_mutation();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_balance_requires_ledger') THEN
        CREATE TRIGGER users_balance_requires_ledger
          BEFORE UPDATE OF balance ON users
          FOR EACH ROW EXECUTE FUNCTION reject_unjournaled_user_balance_update();
      END IF;

      FOREACH audit_table IN ARRAY ARRAY['shoe_commitments', 'shoe_reveals', 'shoe_deal_audits']
      LOOP
        trigger_name := 'prevent_mutation_' || audit_table;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trigger_name) THEN
          EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_shoe_audit_mutation()',
            trigger_name,
            audit_table
          );
        END IF;
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_update_shoe_secrets') THEN
        CREATE TRIGGER prevent_update_shoe_secrets
          BEFORE UPDATE ON shoe_secrets
          FOR EACH STATEMENT EXECUTE FUNCTION reject_shoe_audit_mutation();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_deal_after_shoe_reveal') THEN
        CREATE TRIGGER prevent_deal_after_shoe_reveal
          BEFORE INSERT ON shoe_deal_audits
          FOR EACH ROW EXECUTE FUNCTION reject_deal_after_shoe_reveal();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'serialize_shoe_reveal_insert') THEN
        CREATE TRIGGER serialize_shoe_reveal_insert
          BEFORE INSERT ON shoe_reveals
          FOR EACH ROW EXECUTE FUNCTION serialize_shoe_reveal();
      END IF;
    END;
    $immutable_triggers$;

    CREATE OR REPLACE VIEW financial_balance_reconciliation AS
    WITH ordered_entries AS (
      SELECT user_id, entry_sequence, delta, balance_before, balance_after,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY entry_sequence) AS entry_number,
        LAG(balance_after) OVER (PARTITION BY user_id ORDER BY entry_sequence) AS previous_balance_after
      FROM financial_ledger_entries
    ), ledger_rollup AS (
      SELECT user_id, COUNT(*)::bigint AS entry_count, SUM(delta)::bigint AS total_delta,
        (ARRAY_AGG(balance_after ORDER BY entry_sequence DESC))[1] AS ledger_balance,
        BOOL_AND(
          balance_after = balance_before + delta AND
          CASE WHEN entry_number = 1 THEN balance_before = 0 ELSE balance_before = previous_balance_after END
        ) AS chain_consistent
      FROM ordered_entries GROUP BY user_id
    )
    SELECT users.id AS user_id, users.balance AS current_balance,
      COALESCE(ledger_rollup.ledger_balance, 0) AS ledger_balance,
      COALESCE(ledger_rollup.total_delta, 0)::bigint AS total_delta,
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
