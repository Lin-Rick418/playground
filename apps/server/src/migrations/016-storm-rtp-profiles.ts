import type { MigrationDefinition } from "./types.js";
export const stormRtpProfilesMigration: MigrationDefinition = {
  version: 16, name: "storm_rtp_profiles", up: `
    CREATE TABLE storm_math_profiles (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE,
      model_revision TEXT NOT NULL CHECK(model_revision='balanced-2.0'),
      target_rtp NUMERIC(5,2) NOT NULL CHECK(target_rtp BETWEEN 80 AND 99),
      max_win_factor INTEGER NOT NULL CHECK(max_win_factor BETWEEN 100 AND 25000),
      payout_scale INTEGER NOT NULL CHECK(payout_scale BETWEEN 1 AND 10000000),
      fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
      report JSONB NOT NULL CHECK(report->>'passed'='true'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT storm_profile_cap_identity UNIQUE(id,max_win_factor)
    );
    CREATE TABLE storm_math_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      active_profile_id TEXT REFERENCES storm_math_profiles(id),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
    );
    INSERT INTO storm_math_settings(id) VALUES(1);
    CREATE TABLE storm_math_publications (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL REFERENCES storm_math_profiles(id),
      previous_profile_id TEXT REFERENCES storm_math_profiles(id),
      revision INTEGER NOT NULL UNIQUE, actor TEXT NOT NULL, note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE FUNCTION reject_storm_profile_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Storm math profiles and publications are immutable'; END; $$;
    CREATE TRIGGER storm_profiles_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON storm_math_profiles
      FOR EACH STATEMENT EXECUTE FUNCTION reject_storm_profile_mutation();
    CREATE TRIGGER storm_publications_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON storm_math_publications
      FOR EACH STATEMENT EXECUTE FUNCTION reject_storm_profile_mutation();
    ALTER TABLE storm_sessions ADD COLUMN math_profile_id TEXT;
    ALTER TABLE storm_sessions ADD COLUMN max_win_factor INTEGER;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_profile_fk FOREIGN KEY(math_profile_id,max_win_factor)
      REFERENCES storm_math_profiles(id,max_win_factor);
    ALTER TABLE storm_rounds ADD COLUMN math_profile_id TEXT REFERENCES storm_math_profiles(id);
    ALTER TABLE storm_sessions DROP CONSTRAINT storm_sessions_rule_version_check;
    ALTER TABLE storm_rounds DROP CONSTRAINT storm_rounds_rule_version_check;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_profile_version CHECK(
      (rule_version=1 AND math_profile_id IS NULL AND max_win_factor IS NULL) OR
      (rule_version=2 AND math_profile_id IS NOT NULL AND max_win_factor IS NOT NULL AND
       progress ? 'cycleWin' AND jsonb_typeof(progress->'cycleWin')='number' AND
       (progress->>'cycleWin')::numeric BETWEEN 0 AND amount*max_win_factor AND
       (progress->>'freeGranted')::integer<=30 AND (progress->>'multiplier')::integer<=10));
    ALTER TABLE storm_rounds ADD CONSTRAINT storm_round_profile_version CHECK(
      (rule_version=1 AND math_profile_id IS NULL) OR (rule_version=2 AND math_profile_id IS NOT NULL));
    ALTER TABLE storm_sessions DROP CONSTRAINT storm_session_exposure;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_exposure CHECK(maximum_payout =
      CASE WHEN (progress->>'freeLeft')::integer=0 THEN 0
        WHEN rule_version=1 THEN ((progress->>'freeLeft')::integer + 100 - (progress->>'freeGranted')::integer)*amount*25000
        ELSE amount*max_win_factor-(progress->>'cycleWin')::numeric END);
  `,
};
