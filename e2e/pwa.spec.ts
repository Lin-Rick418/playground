import { test, expect, type Page } from "@playwright/test";

async function controlled(page: Page) {
  await page.goto("/login");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // First installation does not claim the already open tab.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
test.beforeEach(async ({ request }) => {
  await request.post("/__test__/version?v=a");
});

test("manifest, icons and strict resource responses", async ({ page, request }) => {
  await controlled(page);
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  const data = await manifest.json();
  expect(data).toMatchObject({
    name: "Casino",
    short_name: "Casino",
    id: "/",
    scope: "/",
    start_url: "/login",
    display: "standalone",
    lang: "zh-Hant",
  });
  await expect(page).toHaveTitle("Casino");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  for (const [url, size] of [
    ["/icons/casino-192.png", 192],
    ["/icons/casino-512.png", 512],
    ["/icons/casino-maskable-512.png", 512],
    ["/icons/apple-touch-icon.png", 180],
  ] as const) {
    const bytes = await (await request.get(url)).body();
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
  for (const url of ["/sw.js", "/manifest.webmanifest", "/pwa/offline.html"]) {
    const response = await request.get(url);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-cache");
  }
  expect((await request.get("/pwa/missing.html")).status()).toBe(404);
  expect((await request.get("/icons/missing.png")).status()).toBe(404);
});

test("offline navigation, retry, network status and no account cache", async ({
  page,
  context,
}) => {
  await controlled(page);
  await page.evaluate(async () => {
    await fetch("/api/pwa-probe");
    await fetch("/api/auth/login", { method: "POST", body: "test-only" });
  });
  await context.setOffline(true);
  await expect(page.getByRole("status")).toContainText("目前已離線");
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) errors.push(message.text());
  });
  for (const route of ["/login", "/game/table-1?from=pwa"]) {
    await page.goto(route);
    await expect(
      page.getByRole("heading", { name: "目前無法連線，請確認網路後重試" }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(route.split("?")[0]));
  }
  expect(
    await page.evaluate(() =>
      fetch("/api/pwa-probe").then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true);
  const urls = await page.evaluate(async () => {
    const cache = await caches.open("casino-pwa-offline");
    return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
  });
  expect(urls).toEqual(["/pwa/offline.css", "/pwa/offline.html", "/pwa/offline.js"]);
  expect(errors).toEqual([]);
  await context.setOffline(false);
  await page.getByRole("button", { name: "重新載入" }).click();
  // An unauthenticated deep link resumes the normal router guard.
  await expect(page.getByRole("heading", { name: "會員登入" })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("status")).toHaveCount(0);
  const response = await page.goto("/__test__/http-error");
  expect(response?.status()).toBe(503);
  await expect(page.locator("body")).toContainText("Maintenance");
});

test("new build waits for all controlled tabs to close", async ({ page, context, request }) => {
  await controlled(page);
  const second = await context.newPage();
  await second.goto("/login");
  await expect.poll(() => second.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const oldScript = await (await request.get("/sw.js")).text();
  await page.evaluate(async () => {
    sessionStorage.setItem("pwa-loaded", "original");
    (window as unknown as { pwaSentinel: string }).pwaSentinel = "still-open";
    await (await caches.open("unrelated-app")).put("/unrelated", new Response("keep"));
  });
  await request.post("/__test__/version?v=b");
  expect(await (await request.get("/sw.js")).text()).not.toBe(oldScript);
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state),
    )
    .toBe("installed");
  expect(
    await page.evaluate(() => (window as unknown as { pwaSentinel: string }).pwaSentinel),
  ).toBe("still-open");
  await page.close();
  expect(
    await second.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state,
    ),
  ).toBe("installed");
  // Keep an uncontrolled page alive to observe activation after BOTH controlled tabs close.
  const observer = await context.newPage();
  await second.close();
  await observer.goto("/login");
  await expect
    .poll(() =>
      observer.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return !!registration?.active && !registration.waiting;
      }),
    )
    .toBe(true);
  const offline = await observer.evaluate(async () => {
    const cache = await caches.open("casino-pwa-offline");
    const requests = await cache.keys();
    const pages = requests.filter((r) => new URL(r.url).pathname === "/pwa/offline.html");
    return {
      count: pages.length,
      text: await (await cache.match(pages[0]))?.text(),
      unrelated: await caches.has("unrelated-app"),
    };
  });
  expect(offline.count).toBe(1);
  expect(offline.text).toContain("release b");
  expect(offline.unrelated).toBe(true);
});

test("mobile login fills the viewport without installation instructions", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    baseURL: "http://127.0.0.1:4175",
  });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "會員登入" })).toBeVisible();
  await expect(page.locator("summary, details")).toHaveCount(0);
  await expect(page.getByText("請使用 Safari 開啟本站", { exact: false })).toHaveCount(0);
  for (const height of [844, 568, 360]) {
    await page.setViewportSize({ width: 390, height });
    const bounds = await page.locator(".login-layout").boundingBox();
    expect(bounds?.height).toBe(height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    await page.getByRole("button", { name: "登入", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "登入", exact: true })).toBeInViewport();
  }
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await context.close();
});

test("development serves the same install manifest without registering a worker", async ({
  page,
  request,
}) => {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: `${process.cwd()}/apps/web`,
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No development port");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"message":"test-only"}',
      }),
    );
    await page.goto(`${origin}/login`);
    await expect(page.getByRole("heading", { name: "會員登入" })).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    const manifest = await request.get(`${origin}/manifest.webmanifest`);
    expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
    expect(await manifest.json()).toEqual(
      await (await request.get("/manifest.webmanifest")).json(),
    );
    expect(
      await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
    ).toBe(0);
  } finally {
    await server.close();
  }
});
