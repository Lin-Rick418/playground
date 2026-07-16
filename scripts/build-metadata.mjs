import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitRunner } from "./release-preflight.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), "..");
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const relativeTargets = [
  "apps/server/dist/build-metadata.json",
  "apps/web/dist/build-metadata.json",
];

function requireExactCommitSha(commitSha) {
  if (!commitPattern.test(commitSha)) {
    throw new Error("Build metadata requires an exact 40- or 64-character commit SHA");
  }

  return commitSha;
}

export function createBuildMetadata({ branch, builtAt, commitSha, dirty }) {
  requireExactCommitSha(commitSha);

  if (typeof branch !== "string" || branch === "") {
    throw new Error("Build metadata requires a branch name");
  }

  if (typeof dirty !== "boolean") {
    throw new Error("Build metadata dirty state must be a boolean");
  }

  if (!Number.isFinite(Date.parse(builtAt))) {
    throw new Error("Build metadata requires a valid build timestamp");
  }

  return {
    schemaVersion: 1,
    commitSha,
    branch,
    dirty,
    builtAt,
  };
}

export async function writeBuildMetadata({
  repositoryRoot = defaultRepositoryRoot,
  runGit = createGitRunner(repositoryRoot),
  now = () => Date.now(),
} = {}) {
  const metadata = createBuildMetadata({
    commitSha: runGit(["rev-parse", "HEAD"]),
    branch: runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    dirty: runGit(["status", "--porcelain=v1", "--untracked-files=all"]) !== "",
    builtAt: new Date(now()).toISOString(),
  });
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;

  await Promise.all(
    relativeTargets.map(async (relativeTarget) => {
      const target = resolve(repositoryRoot, relativeTarget);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serialized, "utf8");
    }),
  );

  return metadata;
}

function parseMetadata(raw, source) {
  let metadata;

  try {
    metadata = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }

  try {
    return createBuildMetadata(metadata);
  } catch (error) {
    throw new Error(`${source} is invalid: ${error.message}`);
  }
}

export async function verifyBuildMetadata({
  repositoryRoot = defaultRepositoryRoot,
  expectedCommitSha,
  requireClean = true,
  runGit = createGitRunner(repositoryRoot),
} = {}) {
  const expectedSha = requireExactCommitSha(expectedCommitSha ?? runGit(["rev-parse", "HEAD"]));
  const expectedBranch = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (requireClean && runGit(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("Cannot verify release metadata from a dirty worktree");
  }

  const metadataEntries = await Promise.all(
    relativeTargets.map(async (relativeTarget) => {
      const target = resolve(repositoryRoot, relativeTarget);
      return parseMetadata(await readFile(target, "utf8"), relativeTarget);
    }),
  );

  for (const metadata of metadataEntries) {
    if (metadata.commitSha !== expectedSha) {
      throw new Error(
        `Build metadata commit ${metadata.commitSha} does not match expected ${expectedSha}`,
      );
    }

    if (metadata.branch !== expectedBranch) {
      throw new Error(
        `Build metadata branch ${metadata.branch} does not match expected ${expectedBranch}`,
      );
    }

    if (requireClean && metadata.dirty) {
      throw new Error(`Build metadata for ${expectedSha} records a dirty worktree`);
    }
  }

  if (new Set(metadataEntries.map((metadata) => JSON.stringify(metadata))).size !== 1) {
    throw new Error("Server and web build metadata do not match exactly");
  }

  return metadataEntries[0];
}

async function main() {
  const command = process.argv[2];

  if (command === "write") {
    const metadata = await writeBuildMetadata();
    console.log(
      `Build metadata written for ${metadata.commitSha}${metadata.dirty ? " (dirty)" : ""}`,
    );
    return;
  }

  if (command === "verify") {
    const metadata = await verifyBuildMetadata();
    console.log(`Build metadata verified for ${metadata.commitSha}`);
    return;
  }

  throw new Error("Usage: node scripts/build-metadata.mjs <write|verify>");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
