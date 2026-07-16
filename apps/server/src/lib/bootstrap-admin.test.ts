import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBootstrapAdminCredentials } from "./bootstrap-admin.js";

describe("parseBootstrapAdminCredentials", () => {
  it("accepts an explicit strong first-run credential", () => {
    assert.deepEqual(
      parseBootstrapAdminCredentials({
        BOOTSTRAP_ADMIN_USERNAME: "operator_1",
        BOOTSTRAP_ADMIN_PASSWORD: "Violet-River-Quartz-947!",
      }),
      {
        username: "operator_1",
        password: "Violet-River-Quartz-947!",
      },
    );
  });

  it("rejects missing bootstrap credentials", () => {
    assert.throws(
      () => parseBootstrapAdminCredentials({}),
      /BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are required/,
    );
  });

  it("rejects short and previously predictable passwords", () => {
    for (const password of ["admin123", "player123"]) {
      assert.throws(() =>
        parseBootstrapAdminCredentials({
          BOOTSTRAP_ADMIN_USERNAME: "operator",
          BOOTSTRAP_ADMIN_PASSWORD: password,
        }),
      );
    }
  });

  it("rejects a password containing the admin username", () => {
    assert.throws(() =>
      parseBootstrapAdminCredentials({
        BOOTSTRAP_ADMIN_USERNAME: "operator",
        BOOTSTRAP_ADMIN_PASSWORD: "Long-operator-passphrase-947!",
      }),
    );
  });

  it("rejects passwords that bcrypt would silently truncate", () => {
    assert.throws(() =>
      parseBootstrapAdminCredentials({
        BOOTSTRAP_ADMIN_USERNAME: "operator",
        BOOTSTRAP_ADMIN_PASSWORD: "界".repeat(25),
      }),
    );
  });
});
