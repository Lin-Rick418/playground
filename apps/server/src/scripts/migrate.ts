import { pool } from "../lib/database.js";
import { runMigrations } from "../lib/migration-runner.js";

try {
  const result = await runMigrations(pool);

  if (!result.applied.length) {
    console.log(`Database schema is current at version ${result.currentVersion}`);
  } else {
    for (const migration of result.applied) {
      console.log(`Applied ${migration.version}_${migration.name}`);
    }
    console.log(`Database schema upgraded to version ${result.currentVersion}`);
  }
} finally {
  await pool.end();
}
