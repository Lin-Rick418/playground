import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const deployDirectory = resolve(scriptDirectory, "..");
const unitDirectory = join(deployDirectory, "systemd");
const applicationUnitPaths = [
  join(unitDirectory, "baccarat-api.service"),
  join(unitDirectory, "baccarat-worker.service"),
];
const backupUnitPath = join(unitDirectory, "baccarat-backup.service");
const maintenanceUnitPath = join(unitDirectory, "baccarat-maintenance.service");
const unitPaths = [...applicationUnitPaths, backupUnitPath, maintenanceUnitPath];
const permissionValidatorPath = join(scriptDirectory, "validate-install-permissions.sh");
const commandEnvironment = { ...process.env, LC_ALL: "C" };

function readService(path) {
  const entries = new Map();
  let section = "";

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }

    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `${path}: invalid directive: ${line}`);
    const key = `${section}.${line.slice(0, separator)}`;
    const value = line.slice(separator + 1);
    const previous = entries.get(key) ?? [];
    entries.set(key, [...previous, value]);
  }

  return entries;
}

function expectSingle(entries, unit, directive, expected) {
  assert.deepEqual(entries.get(`Service.${directive}`), [expected], `${unit}: ${directive}`);
}

function validateStaticHardening(path) {
  const unit = basename(path);
  const entries = readService(path);
  const isApi = unit === "baccarat-api.service";
  const runtimeName = isApi ? "baccarat-api" : "baccarat-worker";

  const common = {
    Group: "baccarat",
    NoNewPrivileges: "true",
    CapabilityBoundingSet: "",
    AmbientCapabilities: "",
    UMask: "0077",
    ProtectSystem: "strict",
    ProtectHome: "true",
    PrivateTmp: "true",
    PrivateDevices: "true",
    PrivateMounts: "true",
    ProtectClock: "true",
    ProtectControlGroups: "true",
    ProtectHostname: "true",
    ProtectKernelLogs: "true",
    ProtectKernelModules: "true",
    ProtectKernelTunables: "true",
    ProtectProc: "invisible",
    ProcSubset: "pid",
    RestrictNamespaces: "true",
    RestrictRealtime: "true",
    RestrictSUIDSGID: "true",
    LockPersonality: "true",
    RemoveIPC: "true",
    KeyringMode: "private",
    MemoryDenyWriteExecute: "false",
    RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
    SystemCallArchitectures: "native",
    SystemCallFilter: "@system-service",
    SystemCallErrorNumber: "EPERM",
    LimitCORE: "0",
  };

  for (const [directive, expected] of Object.entries(common)) {
    expectSingle(entries, unit, directive, expected);
  }

  expectSingle(entries, unit, "User", runtimeName);
  expectSingle(entries, unit, "RuntimeDirectory", runtimeName);
  expectSingle(entries, unit, "RuntimeDirectoryMode", "0700");
  expectSingle(entries, unit, "RuntimeDirectoryPreserve", "no");
  expectSingle(entries, unit, "ReadWritePaths", `/run/${runtimeName}`);
  expectSingle(entries, unit, "ReadOnlyPaths", "/opt/baccarat/current /etc/baccarat/baccarat.env");
  expectSingle(entries, unit, "EnvironmentFile", "/etc/baccarat/baccarat.env");
  expectSingle(entries, unit, "TasksMax", isApi ? "256" : "128");
  expectSingle(entries, unit, "LimitNOFILE", isApi ? "65536" : "4096");

  const writablePaths = entries.get("Service.ReadWritePaths") ?? [];
  assert.ok(
    writablePaths.every((pathEntry) => pathEntry.startsWith(`/run/${runtimeName}`)),
    `${unit}: writable paths must remain inside its private runtime directory`,
  );

  const execStart = entries.get("Service.ExecStart")?.[0] ?? "";
  assert.match(execStart, /^\/usr\/bin\/node \/opt\/baccarat\/current\//, `${unit}: pinned Node ExecStart`);

  console.log(`PASS static hardening: ${unit}`);
}

function validateBackupHardening(path) {
  const unit = basename(path);
  const entries = readService(path);
  const expected = {
    User: "baccarat-backup",
    Group: "baccarat",
    NoNewPrivileges: "true",
    CapabilityBoundingSet: "",
    AmbientCapabilities: "",
    UMask: "0077",
    ProtectSystem: "strict",
    ProtectHome: "true",
    PrivateTmp: "true",
    PrivateDevices: "true",
    RestrictNamespaces: "true",
    ReadOnlyPaths: "/opt/baccarat/current /etc/baccarat/baccarat.env",
    ReadWritePaths: "/var/backups/baccarat",
    RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
    SystemCallFilter: "@system-service",
    LimitCORE: "0",
  };

  for (const [directive, value] of Object.entries(expected)) {
    expectSingle(entries, unit, directive, value);
  }

  const writablePaths = entries.get("Service.ReadWritePaths") ?? [];
  assert.deepEqual(writablePaths, ["/var/backups/baccarat"], `${unit}: isolated writable path`);
  console.log(`PASS static hardening: ${unit}`);
}

function validateMaintenanceHardening(path) {
  const unit = basename(path);
  const entries = readService(path);
  const expected = {
    Type: "oneshot",
    User: "baccarat-worker",
    Group: "baccarat",
    NoNewPrivileges: "true",
    CapabilityBoundingSet: "",
    AmbientCapabilities: "",
    UMask: "0077",
    ProtectSystem: "strict",
    ProtectHome: "true",
    PrivateTmp: "true",
    PrivateDevices: "true",
    RestrictNamespaces: "true",
    ReadOnlyPaths: "/opt/baccarat/current /etc/baccarat/baccarat.env",
    EnvironmentFile: "/etc/baccarat/baccarat.env",
    RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
    SystemCallFilter: "@system-service",
    LimitCORE: "0",
  };

  for (const [directive, value] of Object.entries(expected)) {
    expectSingle(entries, unit, directive, value);
  }

  assert.equal(entries.has("Service.ReadWritePaths"), false, `${unit}: no writable filesystem path`);
  assert.match(
    entries.get("Service.ExecStart")?.[0] ?? "",
    /^\/usr\/bin\/node \/opt\/baccarat\/current\/apps\/server\/dist\/scripts\/maintenance\.js$/,
    `${unit}: pinned maintenance command`,
  );
  console.log(`PASS static hardening: ${unit}`);
}

function commandExists(command) {
  return spawnSync(command, ["--version"], { encoding: "utf8", env: commandEnvironment }).status === 0;
}

function validatePermissionValidator() {
  const syntax = spawnSync("bash", ["-n", permissionValidatorPath], {
    encoding: "utf8",
    env: commandEnvironment,
  });
  assert.equal(syntax.status, 0, `permission validator syntax failed:\n${syntax.stdout}${syntax.stderr}`);

  const source = readFileSync(permissionValidatorPath, "utf8");
  for (const requiredCheck of [
    "readlink -f",
    "find -L",
    "! -user root",
    "runuser -u",
    "stat -c",
    "test -w",
    "test -r",
    "is a symlink",
  ]) {
    assert.ok(source.includes(requiredCheck), `permission validator must include ${requiredCheck}`);
  }
  console.log("PASS install permission validator static checks");
}

function runSystemdAnalyze() {
  if (!commandExists("systemd-analyze")) {
    console.log("SKIP systemd-analyze: command is unavailable on this host");
    return;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "baccarat-systemd-"));
  const temporaryUnits = [];

  try {
    for (const sourcePath of unitPaths) {
      const targetPath = join(temporaryDirectory, basename(sourcePath));
      const sanitized = readFileSync(sourcePath, "utf8")
        .replace(/^WorkingDirectory=.*$/m, "WorkingDirectory=/")
        .replace(/^EnvironmentFile=.*$/m, "EnvironmentFile=-/dev/null")
        .replace(/^(ExecStart(?:Post)?)=.*$/gm, "$1=/usr/bin/true");
      writeFileSync(targetPath, sanitized);
      temporaryUnits.push(targetPath);
    }

    const verify = spawnSync("systemd-analyze", ["verify", ...temporaryUnits], {
      encoding: "utf8",
      env: commandEnvironment,
    });
    assert.equal(verify.status, 0, `systemd-analyze verify failed:\n${verify.stdout}${verify.stderr}`);
    console.log("PASS systemd-analyze verify");

    const help = spawnSync("systemd-analyze", ["security", "--help"], {
      encoding: "utf8",
      env: commandEnvironment,
    });
    const supportsOffline = `${help.stdout}${help.stderr}`.includes("--offline");
    if (!supportsOffline) {
      console.log("SKIP systemd-analyze security: installed systemd lacks offline analysis");
      return;
    }

    for (const unitPath of temporaryUnits) {
      const security = spawnSync(
        "systemd-analyze",
        ["security", "--offline=yes", "--no-pager", unitPath],
        { encoding: "utf8", env: commandEnvironment },
      );
      const output = `${security.stdout}${security.stderr}`;
      assert.equal(security.status, 0, `systemd-analyze security failed for ${basename(unitPath)}:\n${output}`);

      const exposureMatch = output.match(/Overall exposure level[^:]*:\s*([0-9]+(?:\.[0-9]+)?)/i);
      assert.ok(exposureMatch, `could not parse exposure score for ${basename(unitPath)}:\n${output}`);
      const exposure = Number(exposureMatch[1]);
      assert.ok(exposure <= 4.5, `${basename(unitPath)} exposure ${exposure} exceeds 4.5`);
      console.log(`PASS systemd-analyze security: ${basename(unitPath)} exposure ${exposure}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const unitPath of applicationUnitPaths) validateStaticHardening(unitPath);
validateBackupHardening(backupUnitPath);
validateMaintenanceHardening(maintenanceUnitPath);
validatePermissionValidator();
runSystemdAnalyze();
