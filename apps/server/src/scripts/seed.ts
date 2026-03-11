import { ensureSeedData } from "../lib/db.js";

await ensureSeedData({ seedDemoUsers: true });
console.log("Seed completed");
