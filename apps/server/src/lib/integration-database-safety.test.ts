import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertCoreApiIntegrationDatabaseUrl } from "./integration-database-safety.js";

describe("core API integration database safety", () => {
  it("accepts an explicitly named disposable test database", () => {
    assert.equal(
      assertCoreApiIntegrationDatabaseUrl(
        "postgres://postgres:postgres@127.0.0.1:5432/baccarat_core_api_test_local",
      ),
      "baccarat_core_api_test_local",
    );
  });

  it("rejects missing, development, and lookalike database names", () => {
    assert.throws(() => assertCoreApiIntegrationDatabaseUrl(undefined), /DATABASE_URL is required/);
    assert.throws(
      () =>
        assertCoreApiIntegrationDatabaseUrl("postgres://postgres:postgres@127.0.0.1:5432/baccarat"),
      /Refusing to run/,
    );
    assert.throws(
      () =>
        assertCoreApiIntegrationDatabaseUrl(
          "postgres://postgres:postgres@127.0.0.1:5432/baccarat_core_api_test",
        ),
      /Refusing to run/,
    );
  });
});
