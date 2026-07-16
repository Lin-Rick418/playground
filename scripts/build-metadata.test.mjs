import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createBuildMetadata,
  verifyBuildMetadata,
  writeBuildMetadata,
} from "./build-metadata.mjs";

const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
const builtAt = "2026-07-16T04:00:00.000Z";

function createGitOutput({ dirty = false } = {}) {
  return (args) => {
    const command = args.join(" ");

    if (command === "rev-parse HEAD") return commitSha;
    if (command === "symbolic-ref --quiet --short HEAD") return "master";
    if (command === "status --porcelain=v1 --untracked-files=all") {
      return dirty ? " M tracked-file" : "";
    }

    throw new Error(`Unexpected Git command: ${command}`);
  };
}

async function withTemporaryRepository(callback) {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), "baccarat-build-metadata-"));

  try {
    return await callback(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test("requires an exact commit SHA", () => {
  assert.throws(
    () => createBuildMetadata({ branch: "master", builtAt, commitSha: "abcdef", dirty: false }),
    /exact 40- or 64-character commit SHA/,
  );
});

test("writes identical server and web metadata from injectable Git output", async () => {
  await withTemporaryRepository(async (repositoryRoot) => {
    const metadata = await writeBuildMetadata({
      repositoryRoot,
      runGit: createGitOutput(),
      now: () => Date.parse(builtAt),
    });
    const serverMetadata = await readFile(
      resolve(repositoryRoot, "apps/server/dist/build-metadata.json"),
      "utf8",
    );
    const webMetadata = await readFile(
      resolve(repositoryRoot, "apps/web/dist/build-metadata.json"),
      "utf8",
    );

    assert.deepEqual(metadata, {
      schemaVersion: 1,
      commitSha,
      branch: "master",
      dirty: false,
      builtAt,
    });
    assert.equal(serverMetadata, webMetadata);
  });
});

test("verifies matching clean artifacts and rejects dirty build metadata", async () => {
  await withTemporaryRepository(async (repositoryRoot) => {
    await writeBuildMetadata({
      repositoryRoot,
      runGit: createGitOutput(),
      now: () => Date.parse(builtAt),
    });

    assert.equal(
      (
        await verifyBuildMetadata({
          repositoryRoot,
          expectedCommitSha: commitSha,
          runGit: createGitOutput(),
        })
      ).commitSha,
      commitSha,
    );

    const dirtyMetadata = `${JSON.stringify(
      createBuildMetadata({ branch: "master", builtAt, commitSha, dirty: true }),
      null,
      2,
    )}\n`;
    await writeFile(
      resolve(repositoryRoot, "apps/web/dist/build-metadata.json"),
      dirtyMetadata,
      "utf8",
    );

    await assert.rejects(
      verifyBuildMetadata({
        repositoryRoot,
        expectedCommitSha: commitSha,
        runGit: createGitOutput(),
      }),
      /records a dirty worktree/,
    );
  });
});
