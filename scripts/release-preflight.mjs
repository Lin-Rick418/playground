import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), "..");
const defaultConfigPath = resolve(defaultRepositoryRoot, "release.config.json");
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class ReleasePreflightError extends Error {
  constructor(message) {
    super(`Release blocked: ${message}`);
    this.name = "ReleasePreflightError";
  }
}

function isSafeGitName(value, allowSlash) {
  const pattern = allowSlash
    ? /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/
    : /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

  return (
    typeof value === "string" &&
    pattern.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/")
  );
}

export function validateReleaseConfig(config) {
  if (!config || typeof config !== "object") {
    throw new ReleasePreflightError("release.config.json must contain an object");
  }

  if (!isSafeGitName(config.authoritativeBranch, true)) {
    throw new ReleasePreflightError("authoritativeBranch is not a safe Git branch name");
  }

  if (!isSafeGitName(config.remote, false)) {
    throw new ReleasePreflightError("remote is not a safe Git remote name");
  }

  return {
    authoritativeBranch: config.authoritativeBranch,
    remote: config.remote,
  };
}

export function loadReleaseConfig(configPath = defaultConfigPath) {
  try {
    return validateReleaseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    if (error instanceof ReleasePreflightError) {
      throw error;
    }

    throw new ReleasePreflightError(`cannot read ${configPath}: ${error.message}`);
  }
}

export function createGitRunner(repositoryRoot = defaultRepositoryRoot) {
  return (args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function runRequiredGit(runGit, args, failureMessage) {
  try {
    return runGit(args);
  } catch {
    throw new ReleasePreflightError(failureMessage);
  }
}

function parseAheadBehind(output) {
  const match = output.trim().match(/^(\d+)\s+(\d+)$/);

  if (!match) {
    throw new ReleasePreflightError("Git returned an invalid ahead/behind comparison");
  }

  return {
    ahead: Number(match[1]),
    behind: Number(match[2]),
  };
}

export function runReleasePreflight({
  config,
  runGit = createGitRunner(),
  fetchRemote = true,
} = {}) {
  const releaseConfig = validateReleaseConfig(config ?? loadReleaseConfig());
  const expectedUpstream = `${releaseConfig.remote}/${releaseConfig.authoritativeBranch}`;
  const worktreeStatus = runRequiredGit(
    runGit,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "cannot inspect the worktree",
  );

  if (worktreeStatus !== "") {
    throw new ReleasePreflightError("worktree has tracked or untracked changes");
  }

  const branch = runRequiredGit(
    runGit,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "HEAD must be attached to the authoritative release branch",
  );

  if (branch !== releaseConfig.authoritativeBranch) {
    throw new ReleasePreflightError(
      `current branch is ${branch}; expected ${releaseConfig.authoritativeBranch}`,
    );
  }

  const upstream = runRequiredGit(
    runGit,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    `branch ${branch} has no configured upstream`,
  );

  if (upstream !== expectedUpstream) {
    throw new ReleasePreflightError(`upstream is ${upstream}; expected ${expectedUpstream}`);
  }

  if (fetchRemote) {
    runRequiredGit(
      runGit,
      ["fetch", "--quiet", "--prune", releaseConfig.remote],
      `cannot fetch ${expectedUpstream}`,
    );
  }

  const comparison = parseAheadBehind(
    runRequiredGit(
      runGit,
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      `cannot compare HEAD with ${expectedUpstream}`,
    ),
  );

  if (comparison.ahead > 0 && comparison.behind > 0) {
    throw new ReleasePreflightError(
      `branch has diverged from ${expectedUpstream} (${comparison.ahead} ahead, ${comparison.behind} behind)`,
    );
  }

  if (comparison.ahead > 0) {
    throw new ReleasePreflightError(
      `branch has ${comparison.ahead} unpushed commit(s) ahead of ${expectedUpstream}`,
    );
  }

  if (comparison.behind > 0) {
    throw new ReleasePreflightError(
      `branch is ${comparison.behind} commit(s) behind ${expectedUpstream}`,
    );
  }

  const commitSha = runRequiredGit(runGit, ["rev-parse", "HEAD"], "cannot resolve the release commit");

  if (!commitPattern.test(commitSha)) {
    throw new ReleasePreflightError("HEAD did not resolve to an exact commit SHA");
  }

  return {
    branch,
    commitSha,
    upstream,
  };
}

function main() {
  const result = runReleasePreflight();
  console.log(`Release preflight passed: ${result.branch} ${result.commitSha}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
