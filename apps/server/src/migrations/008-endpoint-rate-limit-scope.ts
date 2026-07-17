import type { MigrationDefinition } from "./types.js";

// Widen the shared login_rate_limits scope check so the fixed-window endpoint
// limiter (auth refresh/logout) can persist its buckets in the same table.
export const endpointRateLimitScopeMigration: MigrationDefinition = {
  version: 8,
  name: "endpoint_rate_limit_scope",
  up: `
    ALTER TABLE login_rate_limits DROP CONSTRAINT IF EXISTS login_rate_limits_scope_check;
    ALTER TABLE login_rate_limits ADD CONSTRAINT login_rate_limits_scope_check
      CHECK (scope IN ('ACCOUNT_IP', 'ACCOUNT', 'IP', 'ENDPOINT_IP'));
  `,
};
