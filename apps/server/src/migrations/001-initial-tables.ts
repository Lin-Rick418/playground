import type { MigrationDefinition } from "./types.js";

export const initialTablesMigration: MigrationDefinition = {
  version: 1,
  name: "initial_tables",
  up: `
    CREATE TABLE IF NOT EXISTS game_tables (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      round_duration_ms INTEGER NOT NULL DEFAULT 30000,
      min_bet INTEGER NOT NULL DEFAULT 100,
      max_bet INTEGER NOT NULL DEFAULT 10000,
      current_shoe_id TEXT NOT NULL DEFAULT '',
      shoe_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_rounds (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      shoe_id TEXT NOT NULL DEFAULT '',
      player_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
      banker_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
      player_total INTEGER NOT NULL,
      banker_total INTEGER NOT NULL,
      winner TEXT NOT NULL,
      player_pair BOOLEAN NOT NULL DEFAULT FALSE,
      banker_pair BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'SETTLED',
      betting_opens_at TIMESTAMPTZ NOT NULL,
      betting_closes_at TIMESTAMPTZ NOT NULL,
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      bet_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      payout INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS balance_adjustments (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
  `,
};
