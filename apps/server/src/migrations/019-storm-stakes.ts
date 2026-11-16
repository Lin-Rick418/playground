import type { MigrationDefinition } from "./types.js";

export const stormStakesMigration: MigrationDefinition = {
  version: 19,
  name: "storm_stake_options",
  up: `
    ALTER TABLE storm_sessions DROP CONSTRAINT storm_sessions_amount_check;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_sessions_amount_check
      CHECK(amount IN (10,20,50,100,200,500,1000,2000,5000));
    ALTER TABLE storm_rounds DROP CONSTRAINT storm_rounds_stake_check;
    ALTER TABLE storm_rounds ADD CONSTRAINT storm_rounds_stake_check
      CHECK(stake IN (10,20,50,100,200,500,1000,2000,5000));

    -- Match the existing money contract for larger stakes; keep exposure/cap checks intact.
    ALTER TABLE storm_sessions DROP CONSTRAINT storm_session_progress;
    ALTER TABLE storm_sessions ADD CONSTRAINT storm_session_progress CHECK(
      jsonb_typeof(progress)='object' AND progress ?& ARRAY['freeLeft','freeGranted','feature','multiplier','featureWin'] AND
      jsonb_typeof(progress->'freeLeft')='number' AND jsonb_typeof(progress->'freeGranted')='number' AND
      jsonb_typeof(progress->'feature')='string' AND jsonb_typeof(progress->'multiplier')='number' AND jsonb_typeof(progress->'featureWin')='number' AND
      (progress->>'freeLeft')::integer BETWEEN 0 AND (progress->>'freeGranted')::integer AND
      (progress->>'freeGranted')::integer BETWEEN 0 AND 100 AND progress->>'feature' IN ('normal','super') AND
      (progress->>'multiplier')::integer BETWEEN 0 AND 3000000 AND (progress->>'featureWin')::numeric BETWEEN 0 AND 2000000000);
  `,
};
