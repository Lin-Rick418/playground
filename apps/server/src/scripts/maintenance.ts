import { env } from "../config/env.js";
import { pool } from "../lib/db.js";
import { logger, toLogError } from "../lib/logger.js";
import { assertDatabaseSchemaCurrent } from "../lib/migration-runner.js";
import { runRetentionCleanup } from "../lib/retention.js";

try {
  await assertDatabaseSchemaCurrent(pool);
  const result = await runRetentionCleanup({
    idempotencyRetentionDays: env.idempotencyRetentionDays,
    authSessionRetentionDays: env.authSessionRetentionDays,
  });
  logger.info({
    event: "retention_cleanup_completed",
    ...result,
  }, "Retention cleanup completed");
} catch (error) {
  process.exitCode = 1;
  logger.error({
    event: "retention_cleanup_failed",
    err: toLogError(error),
  }, "Retention cleanup failed");
} finally {
  await pool.end();
}
