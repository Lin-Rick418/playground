import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_NODE_VERSION = "22.19.0";
export const REQUIRED_NPM_VERSION = "10.9.3";

export function assertRuntimeVersions(input) {
  const mismatches = [];
  if (input.node !== REQUIRED_NODE_VERSION) {
    mismatches.push(`Node ${REQUIRED_NODE_VERSION} required; received ${input.node}`);
  }
  if (input.npm !== REQUIRED_NPM_VERSION) {
    mismatches.push(`npm ${REQUIRED_NPM_VERSION} required; received ${input.npm}`);
  }
  if (mismatches.length) {
    throw new Error(mismatches.join("\n"));
  }
}

function detectNpmVersion() {
  const userAgentMatch = process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/);
  return userAgentMatch?.[1] ?? execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
}

export function verifyCurrentRuntime() {
  const versions = { node: process.versions.node, npm: detectNpmVersion() };
  assertRuntimeVersions(versions);
  return versions;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const versions = verifyCurrentRuntime();
  console.log(`Runtime verified: Node ${versions.node}, npm ${versions.npm}`);
}
