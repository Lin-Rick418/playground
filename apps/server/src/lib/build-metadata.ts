import { readFileSync } from "node:fs";

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type BuildMetadata = {
  schemaVersion: 1;
  commitSha: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
};

export function parseBuildMetadata(value: unknown): BuildMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Build metadata must be an object");
  }

  const metadata = value as Record<string, unknown>;

  if (
    metadata.schemaVersion !== 1 ||
    typeof metadata.commitSha !== "string" ||
    !commitPattern.test(metadata.commitSha) ||
    typeof metadata.branch !== "string" ||
    metadata.branch === "" ||
    typeof metadata.dirty !== "boolean" ||
    typeof metadata.builtAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.builtAt))
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
