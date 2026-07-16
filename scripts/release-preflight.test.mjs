import assert from "node:assert/strict";
import test from "node:test";
import { ReleasePreflightError, runReleasePreflight } from "./release-preflight.mjs";

const commitSha = "1234567890abcdef1234567890abcdef12345678";
const config = { authoritativeBranch: "main", remote: "origin" };

function createGitOutput(overrides = {}) {
  const output = new Map([
    ["status --porcelain=v1 --untracked-files=all", ""],
    ["symbolic-ref --quiet --short HEAD", "main"],
    ["rev-parse --abbrev-ref --symbolic-full-name @{upstream}", "origin/main"],
    ["fetch --quiet --prune origin", ""],
    ["rev-list --left-right --count HEAD...@{upstream}", "0 0"],
    ["rev-parse HEAD", commitSha],
  ]);

  for (const [command, value] of Object.entries(overrides)) {
    output.set(command, value);
  }

  const calls = [];
  const runGit = (args) => {
    const command = args.join(" ");
    calls.push(command);

    if (!output.has(command)) {
      throw new Error(`Unexpected Git command: ${command}`);
    }

    const value = output.get(command);
    if (value instanceof Error) {
      throw value;
    }

    return value;
  };

  return { calls, runGit };
}

function assertBlocked(overrides, message) {
  const { runGit } = createGitOutput(overrides);

  assert.throws(
    () => runReleasePreflight({ config, runGit }),
    (error) => error instanceof ReleasePreflightError && message.test(error.message),
  );
}

test("passes only when the clean authoritative branch exactly matches its fetched upstream", () => {
  const { calls, runGit } = createGitOutput();

  assert.deepEqual(runReleasePreflight({ config, runGit }), {
    branch: "main",
    commitSha,
    upstream: "origin/main",
  });
  assert.ok(calls.includes("fetch --quiet --prune origin"));
});

test("uses a reviewed configuration instead of hard-coding the release branch", () => {
  const releaseConfig = { authoritativeBranch: "release/stable", remote: "upstream" };
  const { runGit } = createGitOutput({
    "symbolic-ref --quiet --short HEAD": "release/stable",
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "upstream/release/stable",
    "fetch --quiet --prune upstream": "",
  });

  assert.equal(runReleasePreflight({ config: releaseConfig, runGit }).branch, "release/stable");
});

test("rejects tracked or untracked worktree changes", () => {
  assertBlocked({ "status --porcelain=v1 --untracked-files=all": "?? local.env" }, /worktree/);
});

test("rejects a branch other than the configured authoritative branch", () => {
  assertBlocked({ "symbolic-ref --quiet --short HEAD": "feature/release" }, /expected main/);
});

test("rejects an unpushed branch", () => {
  assertBlocked(
    { "rev-list --left-right --count HEAD...@{upstream}": "2 0" },
    /2 unpushed commit/,
  );
});

test("rejects a branch behind its fetched upstream", () => {
  assertBlocked(
    { "rev-list --left-right --count HEAD...@{upstream}": "0 3" },
    /3 commit\(s\) behind/,
  );
});

test("rejects a diverged branch", () => {
  assertBlocked(
    { "rev-list --left-right --count HEAD...@{upstream}": "2 3" },
    /diverged.*2 ahead, 3 behind/,
  );
});

test("rejects a missing or unexpected upstream", () => {
  assertBlocked(
    { "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": new Error("missing") },
    /no configured upstream/,
  );
  assertBlocked(
    { "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "fork/main" },
    /expected origin\/main/,
  );
});
