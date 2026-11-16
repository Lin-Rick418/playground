import type { MigrationDefinition } from "./types.js";

export const stormOpenRtpMigration: MigrationDefinition = {
  version: 18,
  name: "storm_open_rtp",
  up: `
    ALTER TABLE storm_math_profiles DROP CONSTRAINT storm_math_profiles_target_rtp_check;
    ALTER TABLE storm_math_profiles DROP CONSTRAINT storm_math_profiles_payout_scale_check;
    ALTER TABLE storm_math_profiles ALTER COLUMN target_rtp TYPE NUMERIC(16,2);
    ALTER TABLE storm_math_profiles ADD CONSTRAINT storm_profile_rtp_range CHECK(target_rtp BETWEEN 0 AND 90000000000000);
    ALTER TABLE storm_math_profiles ADD CONSTRAINT storm_profile_scale_range CHECK(
      (model_revision='balanced-2.0' AND target_rtp BETWEEN 80 AND 99 AND payout_scale BETWEEN 1 AND 10000000) OR
      (model_revision='configurable-3.0' AND ((target_rtp=0 AND payout_scale=0) OR (target_rtp>0 AND payout_scale BETWEEN 1 AND 2147483647))));
  `,
};
