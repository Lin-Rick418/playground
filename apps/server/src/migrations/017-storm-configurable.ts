import type { MigrationDefinition } from "./types.js";
export const stormConfigurableMigration: MigrationDefinition = {
  version: 17,
  name: "storm_configurable_profiles",
  up: `
    ALTER TABLE storm_math_profiles ADD COLUMN settings JSONB;
    ALTER TABLE storm_math_profiles ADD COLUMN cap_scope TEXT NOT NULL DEFAULT 'cycle' CHECK(cap_scope IN ('spin','cycle'));
    ALTER TABLE storm_math_profiles ADD COLUMN free_max INTEGER NOT NULL DEFAULT 30 CHECK(free_max BETWEEN 1 AND 100);
    ALTER TABLE storm_math_profiles DROP CONSTRAINT storm_math_profiles_model_revision_check;
    ALTER TABLE storm_math_profiles ADD CONSTRAINT storm_profile_model CHECK(
      (model_revision='balanced-2.0' AND settings IS NULL AND cap_scope='cycle' AND free_max=30) OR
      (model_revision='configurable-3.0' AND settings IS NOT NULL AND jsonb_typeof(settings)='object'
       AND settings ?& ARRAY['freeMax','capScope'] AND (settings->>'freeMax')::integer=free_max AND settings->>'capScope'=cap_scope));
    ALTER TABLE storm_math_profiles ADD CONSTRAINT storm_profile_settings_identity UNIQUE(id,max_win_factor,cap_scope,free_max);
    ALTER TABLE storm_sessions ADD COLUMN cap_scope TEXT;
    ALTER TABLE storm_sessions ADD COLUMN free_max INTEGER;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_settings_fk FOREIGN KEY(math_profile_id,max_win_factor,cap_scope,free_max)
      REFERENCES storm_math_profiles(id,max_win_factor,cap_scope,free_max);
    ALTER TABLE storm_sessions DROP CONSTRAINT storm_session_profile_version;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_profile_version CHECK(
      (rule_version=1 AND math_profile_id IS NULL AND max_win_factor IS NULL AND cap_scope IS NULL AND free_max IS NULL) OR
      (rule_version=2 AND math_profile_id IS NOT NULL AND max_win_factor IS NOT NULL AND cap_scope IS NULL AND free_max IS NULL AND
       progress ? 'cycleWin' AND jsonb_typeof(progress->'cycleWin')='number' AND
       (progress->>'cycleWin')::numeric BETWEEN 0 AND amount*max_win_factor AND
       (progress->>'freeGranted')::integer<=30 AND (progress->>'multiplier')::integer<=10) OR
      (rule_version=3 AND math_profile_id IS NOT NULL AND max_win_factor IS NOT NULL AND cap_scope IS NOT NULL AND free_max IS NOT NULL AND
       progress ? 'cycleWin' AND jsonb_typeof(progress->'cycleWin')='number' AND
       (progress->>'cycleWin')::numeric BETWEEN 0 AND amount*max_win_factor*(CASE WHEN cap_scope='cycle' THEN 1 ELSE free_max+1 END) AND
       (progress->>'freeGranted')::integer<=free_max));
    ALTER TABLE storm_rounds DROP CONSTRAINT storm_round_profile_version;
    ALTER TABLE storm_rounds ADD CONSTRAINT storm_round_profile_version CHECK(
      (rule_version=1 AND math_profile_id IS NULL) OR (rule_version IN (2,3) AND math_profile_id IS NOT NULL));
    ALTER TABLE storm_sessions DROP CONSTRAINT storm_session_exposure;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_exposure CHECK(maximum_payout =
      CASE WHEN (progress->>'freeLeft')::integer=0 THEN 0
        WHEN rule_version=1 THEN ((progress->>'freeLeft')::integer+100-(progress->>'freeGranted')::integer)*amount*25000
        WHEN rule_version=3 AND cap_scope='spin' THEN ((progress->>'freeLeft')::integer+free_max-(progress->>'freeGranted')::integer)*amount*max_win_factor
        ELSE amount*max_win_factor-(progress->>'cycleWin')::numeric END);
  `,
};
