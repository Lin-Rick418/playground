import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REQUIRED_NODE_VERSION, REQUIRED_NPM_VERSION } from "./verify-runtime.mjs";

function resolveCommitSha() {
  const candidate =
    process.env.BUILD_COMMIT_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/i.test(candidate)) {
    throw new Error("BUILD_COMMIT_SHA must be a full 40-character Git SHA");
  }
  return candidate.toLowerCase();
}

const metadata = {
  application: "baccarat-platform",
  version: "1.0.0",
  commitSha: resolveCommitSha(),
  nodeVersion: REQUIRED_NODE_VERSION,
  npmVersion: REQUIRED_NPM_VERSION,
};
const serialized = `${JSON.stringify(metadata, null, 2)}\n`;

for (const directory of ["apps/server/dist", "apps/web/dist"]) {
  const outputDirectory = resolve(directory);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "build-metadata.json"), serialized, "utf8");
}

console.log(`Build metadata written for ${metadata.commitSha}`);
