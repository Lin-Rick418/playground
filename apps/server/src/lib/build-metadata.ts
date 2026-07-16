import { readFile } from "node:fs/promises";

export async function readBuildMetadata() {
  const content = await readFile(new URL("../build-metadata.json", import.meta.url), "utf8");
  return JSON.parse(content) as {
    application: string;
    version: string;
    commitSha: string;
    nodeVersion: string;
    npmVersion: string;
  };
}
