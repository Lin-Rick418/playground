import { ensureSeedData } from "./lib/db.js";
import { startRoundManager } from "./lib/round-manager.js";

await ensureSeedData();
await startRoundManager();

console.log("Round worker started");
