import { ensureApplicationData } from "./lib/db.js";
import { startRoundManager } from "./lib/round-manager.js";

await ensureApplicationData();
await startRoundManager();

console.log("Round worker started");
