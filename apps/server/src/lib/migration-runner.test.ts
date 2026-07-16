import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMigrationCatalog, validateMigrationDefinitions } from "./migration-runner.js";

describe("migration catalog validation", () => {
  const migration = (version: number, name: string, up = "SELECT 1") => ({ version, name, up });

  it("requires definitions to be strictly ordered", () => {
    assert.throws(
      () => validateMigrationDefinitions([migration(2, "second"), migration(1, "first")]),
      /strictly ordered/,
    );
    assert.throws(
      () => validateMigrationDefinitions([migration(1, "first"), migration(1, "duplicate")]),
      /strictly ordered/,
    );
  });

  it("rejects invalid version, name, and empty SQL", () => {
    assert.throws(() => validateMigrationDefinitions([migration(0, "zero")]), /positive safe integer/);
    assert.throws(() => validateMigrationDefinitions([migration(1, "Invalid-Name")]), /invalid name/);
    assert.throws(() => validateMigrationDefinitions([migration(1, "empty", "  ")]), /empty SQL/);
  });

  it("produces stable checksums that change with immutable migration content", () => {
    const original = buildMigrationCatalog([migration(1, "first", "SELECT 1")])[0];
    const same = buildMigrationCatalog([migration(1, "first", "SELECT 1")])[0];
    const changed = buildMigrationCatalog([migration(1, "first", "SELECT 2")])[0];

    assert.equal(original.checksum, same.checksum);
    assert.notEqual(original.checksum, changed.checksum);
    assert.match(original.checksum, /^[a-f0-9]{64}$/);
  });
});
