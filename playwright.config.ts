import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch:
    process.env.E2E_MOCKED_ONLY === "true"
      ? ["*-mocked.spec.ts", "lobby-carousel.spec.ts", "viewport.spec.ts"]
      : undefined,
  testIgnore: "pwa.spec.ts", // Uses its own production builds and preview server.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit-mobile",
      testMatch: [
        "hilo-mocked.spec.ts",
        "blackjack-mocked.spec.ts",
        "plinko-mocked.spec.ts",
        "mines-mocked.spec.ts",
        "viewport.spec.ts",
      ],
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: [
    ...(process.env.E2E_MOCKED_ONLY === "true"
      ? []
      : [
          {
            command: 'npx concurrently -k -n api,worker "npm:dev:server" "npm:dev:worker"',
            url: "http://127.0.0.1:4000/health/live",
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
          },
        ]),
    {
      // Call the workspace script directly: routing through the root dev:web
      // alias drops the "--host" flag at the inner "npm run" boundary, so
      // Vite would treat 127.0.0.1 as its root directory and serve 404s.
      command: "npm run dev --workspace web -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173/login",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
