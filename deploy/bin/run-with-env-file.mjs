#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const MAX_ENV_FILE_BYTES = 64 * 1024;
const ALLOWED_MODES = new Set([0o400, 0o600]);

class SafeEnvError extends Error {}

function decodeDoubleQuotedValue(value, lineNumber) {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character !== "\\") {
      decoded += character;
      continue;
    }

    index += 1;
    const escaped = value[index];

    if (escaped === undefined) {
      throw new SafeEnvError(`Invalid escape at line ${lineNumber}`);
    }

    decoded +=
      escaped === "n"
        ? "\n"
        : escaped === "r"
          ? "\r"
          : escaped === "t"
            ? "\t"
            : escaped;
  }

  return decoded;
}

function parseValue(rawValue, lineNumber) {
  const value = rawValue.trim();

  if (!value.startsWith("\"") && !value.startsWith("'")) {
    return value;
  }

  const quote = value[0];

  if (value.length < 2 || value.at(-1) !== quote) {
    throw new SafeEnvError(`Unterminated quoted value at line ${lineNumber}`);
  }

  const unquoted = value.slice(1, -1);
  return quote === "\"" ? decodeDoubleQuotedValue(unquoted, lineNumber) : unquoted;
}

export function parseEnvFile(contents) {
  const variables = Object.create(null);
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator < 1) {
      throw new SafeEnvError(`Invalid environment assignment at line ${lineNumber}`);
    }

    const key = line.slice(0, separator).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SafeEnvError(`Invalid environment key at line ${lineNumber}`);
    }

    if (Object.hasOwn(variables, key)) {
      throw new SafeEnvError(`Duplicate environment key ${key} at line ${lineNumber}`);
    }

    const value = parseValue(line.slice(separator + 1), lineNumber);

    if (value.includes("\0")) {
      throw new SafeEnvError(`NUL byte is not allowed in environment value at line ${lineNumber}`);
    }

    variables[key] = value;
  }

  return variables;
}

export function validateEnvFileMetadata(metadata, effectiveUid) {
  if (!metadata.isFile()) {
    throw new SafeEnvError("Environment file must be a regular file");
  }

  if (metadata.uid !== effectiveUid) {
    throw new SafeEnvError("Environment file owner must match the command user");
  }

  const mode = metadata.mode & 0o7777;

  if (!ALLOWED_MODES.has(mode)) {
    throw new SafeEnvError("Environment file mode must be 0400 or 0600");
  }

  if (metadata.size > MAX_ENV_FILE_BYTES) {
    throw new SafeEnvError("Environment file is too large");
  }
}

export async function loadEnvFile(filePath, effectiveUid = process.geteuid?.()) {
  if (effectiveUid === undefined) {
    throw new SafeEnvError("Cannot verify environment file ownership on this platform");
  }

  if (fsConstants.O_NOFOLLOW === undefined) {
    throw new SafeEnvError("Cannot prevent environment file symlink traversal on this platform");
  }

  const noFollow = fsConstants.O_NOFOLLOW;
  const closeOnExec = fsConstants.O_CLOEXEC ?? 0;
  const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
  let fileHandle;

  try {
    fileHandle = await open(filePath, fsConstants.O_RDONLY | noFollow | closeOnExec | nonBlocking);
    const metadata = await fileHandle.stat();
    validateEnvFileMetadata(metadata, effectiveUid);
    return parseEnvFile(await fileHandle.readFile("utf8"));
  } catch (error) {
    if (error instanceof SafeEnvError) {
      throw error;
    }

    throw new SafeEnvError("Unable to securely read environment file");
  } finally {
    await fileHandle?.close();
  }
}

export async function run(argv = process.argv.slice(2)) {
  const separator = argv.indexOf("--");

  if (separator !== 1 || !argv[separator + 1]) {
    throw new SafeEnvError("Usage: run-with-env-file <env-file> -- <command> [args...]");
  }

  const [filePath] = argv;
  const command = argv[separator + 1];
  const commandArguments = argv.slice(separator + 2);
  const loadedEnvironment = await loadEnvFile(filePath);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, commandArguments, {
      env: { ...process.env, ...loadedEnvironment },
      shell: false,
      stdio: "inherit",
    });

    child.once("error", () => reject(new SafeEnvError("Unable to start command")));
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new SafeEnvError(`Command terminated by signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exitCode = await run();
  } catch (error) {
    const message = error instanceof SafeEnvError ? error.message : "Unexpected secure environment loader failure";
    console.error(`run-with-env-file: ${message}`);
    process.exitCode = 1;
  }
}
