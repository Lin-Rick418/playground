const CORE_API_TEST_DATABASE_PATTERN = /^baccarat_core_api_test_[a-z0-9_]+$/;

export function assertCoreApiIntegrationDatabaseUrl(databaseUrl: string | undefined) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the core API integration test");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL URL for the core API integration test",
    );
  }

  if (!CORE_API_TEST_DATABASE_PATTERN.test(databaseName)) {
    throw new Error(
      "Refusing to run against a database without the baccarat_core_api_test_ prefix",
    );
  }

  return databaseName;
}
