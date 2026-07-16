import { ensureSeedData, pool } from "../lib/db.js";

try {
  await ensureSeedData({ seedDemoUsers: false });
  console.log("Bootstrap completed");
} finally {
  await pool.end();
}
