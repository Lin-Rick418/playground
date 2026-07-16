import { ensureSeedData, pool } from "../lib/db.js";

try {
  await ensureSeedData({ seedDemoUsers: true });
  console.log("Seed completed");
} finally {
  await pool.end();
}
