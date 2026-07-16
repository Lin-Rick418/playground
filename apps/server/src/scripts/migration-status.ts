import { pool } from "../lib/database.js";
import { getMigrationStatus } from "../lib/migration-runner.js";

try {
  const status = await getMigrationStatus(pool);

  console.log(`Database schema: ${status.currentVersion}/${status.latestVersion}`);
  console.log(`Migration history initialized: ${status.initialized ? "yes" : "no"}`);

  if (status.pending.length) {
    console.log(`Pending: ${status.pending.map(({ version, name }) => `${version}_${name}`).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Pending: none");
  }
} finally {
  await pool.end();
}
