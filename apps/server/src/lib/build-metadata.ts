import { readFile, readFileSync } from "node:fs";
import { promisify } from "node:util";

const readFileAsync = promisify(readFile);
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type BuildMetadata = {
  schemaVersion: 1;
  application: "baccarat-platform";
  version: string;
  commitSha: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
  nodeVersion: string;
  npmVersion: string;
};

export function parseBuildMetadata(value: unknown): BuildMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Build metadata must be an object");
  }

  const metadata = value as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 1 ||
    metadata.application !== "baccarat-platform" ||
    typeof metadata.version !== "string" || metadata.version === "" ||
    typeof metadata.commitSha !== "string" || !commitPattern.test(metadata.commitSha) ||
    typeof metadata.branch !== "string" || metadata.branch === "" ||
    typeof metadata.dirty !== "boolean" ||
    typeof metadata.builtAt !== "string" || !Number.isFinite(Date.parse(metadata.builtAt)) ||
    typeof metadata.nodeVersion !== "string" || metadata.nodeVersion === "" ||
    typeof metadata.npmVersion !== "string" || metadata.npmVersion === ""
  ) {
    throw new Error("Build metadata is incomplete or invalid");
  }

  return metadata as BuildMetadata;
}

export function loadBuildMetadata(
  metadataUrl: URL = new URL("../build-metadata.json", import.meta.url),
): BuildMetadata | null {
  try {
    return parseBuildMetadata(JSON.parse(readFileSync(metadataUrl, "utf8")));
  } catch {
    return null;
  }
}

export async function readBuildMetadata(
  metadataUrl: URL = new URL("../build-metadata.json", import.meta.url),
) {
  return parseBuildMetadata(JSON.parse(await readFileAsync(metadataUrl, "utf8")));
}
