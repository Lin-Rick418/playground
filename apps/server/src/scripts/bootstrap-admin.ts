import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { readFile, stat } from "node:fs/promises";
import { parseBootstrapAdminCredentials } from "../lib/bootstrap-admin.js";
import { createInitialAdmin, pool } from "../lib/db.js";

async function loadBootstrapEnvironment() {
  const credentialsFile = process.env.BOOTSTRAP_ADMIN_CREDENTIALS_FILE;

  if (!credentialsFile) {
    return process.env;
  }

  const fileStat = await stat(credentialsFile);

  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
    throw new Error("BOOTSTRAP_ADMIN_CREDENTIALS_FILE must be a regular file with mode 0600 or stricter");
  }

  return dotenv.parse(await readFile(credentialsFile));
}

const credentials = parseBootstrapAdminCredentials(await loadBootstrapEnvironment());

try {
  const admin = await createInitialAdmin({
    username: credentials.username,
    passwordHash: await bcrypt.hash(credentials.password, 12),
  });

  console.log(`Initial Admin ${admin.username} created. Remove the bootstrap credentials before starting services.`);
} finally {
  await pool.end();
}
