import { readFileSync } from "node:fs";
import { verifyShoeAudit, type ShoeAuditBundle } from "../lib/shoe-audit.js";

function readInput() {
  const path = process.argv[2];
  return path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
}

try {
  const bundle = JSON.parse(readInput()) as ShoeAuditBundle;
  const verification = verifyShoeAudit(bundle);
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  process.exitCode = verification.valid ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid shoe audit input"}\n`);
  process.exitCode = 2;
}
