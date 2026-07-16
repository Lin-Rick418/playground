import { pool } from "./lib/database.js";
import { assertDatabaseSchemaCurrent } from "./lib/migration-runner.js";
import { startRoundManager } from "./lib/round-manager.js";

await assertDatabaseSchemaCurrent(pool);
await startRoundManager();

console.log("Round worker started");
