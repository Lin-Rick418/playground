import { ensureSeedData } from "../lib/db.js";

await ensureSeedData();
console.log("Seed completed");
