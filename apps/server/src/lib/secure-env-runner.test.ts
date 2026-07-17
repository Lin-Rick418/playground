import assert from "node:assert/strict";
import { spawn, spawnSync, execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const runnerPath = fileURLToPath(
  new URL("../../../../deploy/bin/run-with-env-file.mjs", import.meta.url),
);
const runnerModuleUrl = pathToFileURL(runnerPath).href;
const { parseEnvFile, validateEnvFileMetadata } = await import(runnerModuleUrl);

async function processCommandLine(pid: number) {
  if (process.platform === "linux") {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  }

  const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
  return stdout;
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("secure env-file command runner", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "baccarat-secure-env-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("loads special characters through the child environment without argv or output exposure", async () => {
    const injectionMarker = join(temporaryDirectory, "shell-injection-marker");
    const secretSentinel = "argv-leak-sentinel-734c8d";
    const secret =
      `${secretSentinel} space # equals= dollar$ subshell$(touch ${injectionMarker}) ` +
      `backtick\`touch ${injectionMarker}\` double" backslash\\`;
    const envFile = join(temporaryDirectory, "service.env");
    await writeFile(envFile, `SPECIAL_SECRET='${secret}'\nSAFE_MARKER=loaded\n`, { mode: 0o600 });

    assert.equal(parseEnvFile(`SPECIAL_SECRET='${secret}'\n`).SPECIAL_SECRET, secret);

    const childProgram = `
      const secret = process.env.SPECIAL_SECRET ?? "";
      console.log(JSON.stringify({
        pid: process.pid,
        argv: process.argv,
        marker: process.env.SAFE_MARKER,
        secretLength: secret.length
      }));
      process.stdin.resume();
      process.stdin.once("data", () => process.exit(0));
      setTimeout(() => process.exit(2), 10000).unref();
    `;
    const runner = spawn(
      process.execPath,
      [runnerPath, envFile, "--", process.execPath, "-e", childProgram],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    runner.stdout.setEncoding("utf8");
    runner.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    const exitPromise = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      runner.once("exit", (code, signal) => resolve([code, signal]));
    });
    runner.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const childDetails = await new Promise<{
      pid: number;
      argv: string[];
      marker: string;
      secretLength: number;
    }>((resolve, reject) => {
      runner.once("error", reject);
      runner.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");

        if (newline >= 0) {
          resolve(JSON.parse(stdout.slice(0, newline)));
        }
      });
      void exitPromise.then(([code]) => {
        if (!stdout.includes("\n")) {
          reject(new Error(`Runner exited before child details were available (code ${code})`));
        }
      });
    });

    assert.equal(childDetails.marker, "loaded");
    assert.equal(childDetails.secretLength, secret.length);
    assert.ok(!childDetails.argv.some((argument) => argument.includes(secret)));
    assert.ok(!childDetails.argv.some((argument) => argument.includes(secretSentinel)));

    for (const pid of [runner.pid, childDetails.pid]) {
      assert.ok(pid);
      const commandLine = await processCommandLine(pid);
      assert.ok(!commandLine.includes(secret), `secret appeared in argv for pid ${pid}`);
      assert.ok(!commandLine.includes(secretSentinel), `secret fragment appeared in argv for pid ${pid}`);
    }

    runner.stdin.end("release\n");
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0);
    assert.ok(!(stdout + stderr).includes(secret));
    assert.ok(!(stdout + stderr).includes(secretSentinel));
    assert.equal(await pathExists(injectionMarker), false);
  });

  it("rejects unsafe metadata before reading values and keeps errors redacted", async () => {
    const secret = "never-print-this-secret-9ab3";
    const envFile = join(temporaryDirectory, "world-readable.env");
    await writeFile(envFile, `JWT_SECRET=${secret}\n`, { mode: 0o600 });
    await chmod(envFile, 0o644);

    const result = spawnSync(
      process.execPath,
      [runnerPath, envFile, "--", process.execPath, "-e", "process.exit(0)"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /mode must be 0400, 0440, 0600, or 0640/);
    assert.ok(!(result.stdout + result.stderr).includes(secret));

    await writeFile(envFile, `invalid assignment containing ${secret}\n`, { mode: 0o600 });
    await chmod(envFile, 0o600);
    const parseFailure = spawnSync(
      process.execPath,
      [runnerPath, envFile, "--", process.execPath, "-e", "process.exit(0)"],
      { encoding: "utf8" },
    );

    assert.equal(parseFailure.status, 1);
    assert.match(parseFailure.stderr, /Invalid environment assignment at line 1/);
    assert.ok(!(parseFailure.stdout + parseFailure.stderr).includes(secret));
  });

  it("validates regular-file ownership and refuses symlink paths", async () => {
    const safeMetadata = {
      isFile: () => true,
      uid: 1000,
      gid: 1000,
      mode: 0o100600,
      size: 100,
    };

    assert.doesNotThrow(() => validateEnvFileMetadata(safeMetadata, 1000));
    assert.throws(
      () => validateEnvFileMetadata({ ...safeMetadata, isFile: () => false }, 1000),
      /regular file/,
    );
    assert.throws(
      () => validateEnvFileMetadata({ ...safeMetadata, uid: 1001 }, 1000),
      /owned by the command user or its readable config group/,
    );

    assert.doesNotThrow(() =>
      validateEnvFileMetadata(
        { ...safeMetadata, uid: 0, gid: 2000, mode: 0o100640 },
        1000,
        [2000],
      ),
    );
    assert.throws(
      () =>
        validateEnvFileMetadata(
          { ...safeMetadata, uid: 0, gid: 2000, mode: 0o100640 },
          1000,
          [3000],
        ),
      /readable config group/,
    );

    const realFile = join(temporaryDirectory, "real.env");
    const linkedFile = join(temporaryDirectory, "linked.env");
    await writeFile(realFile, "SAFE_MARKER=loaded\n", { mode: 0o600 });
    await symlink(realFile, linkedFile);

    const result = spawnSync(
      process.execPath,
      [runnerPath, linkedFile, "--", process.execPath, "-e", "process.exit(0)"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to securely read environment file/);
  });
});
