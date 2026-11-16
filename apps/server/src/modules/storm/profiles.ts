import { stormMathProfileSchema, type StormMathProfile } from "@baccarat/contracts";
import { queryRow, type DbExecutor, type DbRow } from "../../lib/repositories/client.js";

export function profileFromRow(row: DbRow | null): StormMathProfile | null {
  return row
    ? stormMathProfileSchema.parse({
        id: row.id,
        modelRevision: row.model_revision,
        targetRtp: Number(row.target_rtp),
        maxWinFactor: Number(row.max_win_factor),
        payoutScale: Number(row.payout_scale),
        ...(row.settings ? { settings: row.settings } : {}),
      })
    : null;
}
export async function activeStormProfile(client: DbExecutor, lock = false) {
  const settings = await queryRow(
    client,
    `SELECT * FROM storm_math_settings WHERE id=1${lock ? " FOR SHARE" : ""}`,
  );
  if (!settings) throw new Error("Storm math settings missing");
  return settings.active_profile_id
    ? savedStormProfile(client, String(settings.active_profile_id))
    : null;
}
export async function savedStormProfile(client: DbExecutor, id: string) {
  const profile = profileFromRow(
    await queryRow(client, "SELECT * FROM storm_math_profiles WHERE id=$1", [id]),
  );
  if (!profile) throw new Error("Storm math profile missing");
  return profile;
}
