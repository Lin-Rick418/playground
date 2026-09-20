import { expect, test } from "@playwright/test";

const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const user = {
  id: "user-1",
  username: "player",
  role: "PLAYER",
  isActive: true,
  balance: 1000,
  walletVersion: 1,
};
const roundConfig = {
  revealWindowMs: 1000,
  dealAnimationBufferMs: 600,
  cutCardMinRemaining: 10,
  cutCardMaxRemaining: 20,
  reshuffleRule: "test",
};
const table = {
  id: "table-1",
  code: "A01",
  name: "極速廳 A01",
  displayOrder: 1,
  roundDurationMs: 30000,
  roundPhaseOffsetMs: 0,
  roundScheduleVersion: 1,
  minBet: 100,
  maxBet: 10000,
  createdAt: now,
};

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket("**/api/ws", (socket) => socket.close());
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/refresh")
      return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
    if (path === "/api/auth/me") return route.fulfill({ json: user });
    if (path.endsWith("/history")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/game/lobby")
      return route.fulfill({ json: { tables: [], config: roundConfig, serverTime: now } });
    if (path === "/api/mines/active") return route.fulfill({ json: { round: null } });
    if (path === "/api/mines/config")
      return route.fulfill({
        json: {
          boardSize: 25,
          minMines: 3,
          maxMines: 24,
          minBet: 100,
          maxBet: 5000,
          betStep: 100,
          rtp: null,
          ruleVersion: 2,
          maxMultiplier: 1000,
          enabled: true,
        },
      });
    if (path === "/api/plinko/config")
      return route.fulfill({
        json: {
          minRows: 8,
          maxRows: 16,
          risks: ["low", "medium", "high"],
          minBet: 100,
          maxBet: 5000,
          betStep: 100,
          ruleVersion: 1,
          enabled: true,
          tables: [{ rows: 16, risk: "medium", multipliers: Array(17).fill(0.95), rtp: 0.95 }],
        },
      });
    if (path === "/api/game/tables/table-1/state")
      return route.fulfill({
        json: {
          table,
          round: {
            id: "round-1",
            tableId: table.id,
            shoeId: "shoe-1",
            status: "OPEN",
            cancellationReason: null,
            bettingOpensAt: now,
            bettingClosesAt: expiresAt,
            settledAt: null,
            playerCards: [],
            bankerCards: [],
            playerTotal: 0,
            bankerTotal: 0,
            winner: "TIE",
            playerPair: false,
            bankerPair: false,
            createdAt: now,
          },
          previousRound: null,
          presentation: null,
          shoeStatus: { isLastHand: false, cutCardReached: false },
          shoeAudit: null,
          recentRounds: [],
          roadRounds: [],
          serverTime: now,
          myBets: [],
          balance: 1000,
          walletVersion: 1,
          config: roundConfig,
        },
      });
    return route.fulfill({ status: 404 });
  });
});

for (const [path, heading, controls] of [
  ["/lobby", "遊戲大廳", ".game-poster.active, .carousel-controls"],
  ["/game/table-1", "極速廳 A01", ".bet-zone, .chip-rack, .wallet-bar"],
  ["/mines", "Mines", ".mines-controls, .mines-wallet"],
  ["/plinko", "PLINKO", ".plinko-play, .plinko-wallet"],
]) {
  test(`${heading} fills the viewport and cannot scroll the document`, async ({
    page,
    browserName,
    isMobile,
  }) => {
    await page.goto(path!);
    await expect(page.getByRole("heading", { name: heading!, exact: true })).toBeVisible();
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 393, height: 600 },
      { width: 393, height: 780 },
      { width: 483, height: 771 },
      { width: 1360, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      for (const selector of ["html", "body", "#app", "main"]) {
        const box = await page.locator(selector).boundingBox();
        expect(Math.abs(box!.height - viewport.height)).toBeLessThan(1);
      }
      for (const control of await page.locator(controls!).all()) {
        const box = await control.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      if (path === "/lobby") {
        const poster = await page.locator(".game-poster.active").boundingBox();
        expect(Math.abs(poster!.height - poster!.width * 1.5)).toBeLessThan(1);
        await page.screenshot({
          path: test.info().outputPath(`lobby-${viewport.width}x${viewport.height}.png`),
        });
      }
      // Playwright's mobile WebKit has no mouse-wheel input support.
      if (browserName !== "webkit" || !isMobile) {
        await page.mouse.move(viewport.width / 2, 100);
        await page.mouse.wheel(0, 500);
      }
      await page.keyboard.press("PageDown");
      expect(
        await page.evaluate(() => {
          window.scrollTo(0, 500);
          return { x: scrollX, y: scrollY, scale: visualViewport?.scale };
        }),
      ).toEqual({ x: 0, y: 0, scale: 1 });
    }
    // Leaving a game releases the document lock for content pages.
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "投注紀錄" })).toBeVisible();
    expect(
      await page.locator("html").evaluate((element) => getComputedStyle(element).overflowY),
    ).not.toBe("hidden");
  });
}

test("game backgrounds match on mobile and outer gutters stay translucent gray on wide screens", async ({
  page,
}) => {
  const pages = [
    ["/lobby", "rgb(9, 22, 18)"],
    ["/hilo", "rgb(9, 22, 18)"],
    ["/baccarat", "rgb(55, 153, 106)"],
    ["/game/table-1", "rgb(55, 153, 106)"],
    ["/mines", "rgb(23, 27, 35)"],
    ["/plinko", "rgb(27, 40, 61)"],
  ];
  await page.goto("/lobby");
  for (const width of [390, 430, 483, 1360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [path, background] of pages) {
      // Follow SPA navigation so stale colors from the previous game are also detected.
      await page.evaluate((nextPath) => {
        history.pushState({}, "", nextPath);
        dispatchEvent(new PopStateEvent("popstate"));
      }, path!);
      await expect(page.locator(".ui-page-header")).toBeVisible();
      for (const selector of ["html", "body"]) {
        await expect(page.locator(selector)).toHaveCSS(
          "background-color",
          width > 430 ? "rgba(128, 128, 128, 0.35)" : background!,
        );
        await expect(page.locator(selector)).toHaveCSS("background-image", "none");
      }
    }
  }
});

test("zoom is locked globally while normal keyboard and scrolling events remain available", async ({
  page,
}) => {
  await page.goto("/lobby");
  await expect(page.getByRole("heading", { name: "遊戲大廳" })).toBeVisible();
  const policy = await page.evaluate(() => {
    const events = [
      new Event("gesturestart", { cancelable: true }),
      new Event("gesturechange", { cancelable: true }),
      new MouseEvent("dblclick", { cancelable: true }),
      new WheelEvent("wheel", { ctrlKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "+", metaKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "0", cancelable: true }),
      new WheelEvent("wheel", { cancelable: true }),
      new MouseEvent("click", { cancelable: true }),
    ];
    return {
      cancelled: events.map((event) => {
        document.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      touchAction: getComputedStyle(document.documentElement).touchAction,
    };
  });
  expect(policy).toEqual({
    cancelled: [true, true, true, true, true, false, false, false],
    touchAction: "pan-x pan-y",
  });
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /user-scalable=no/,
  );
});

test("login stays inside the visual viewport through keyboard resize, pan and dismissal", async ({
  page,
}) => {
  await page.route("**/api/auth/refresh", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  const login = page.locator(".login-layout");
  const username = page.getByRole("textbox", { name: "帳號", exact: true });
  const password = page.getByLabel("密碼", { exact: true });
  await expect(login).toHaveCSS("height", "844px");
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 483, height: 771 },
    { width: 844, height: 390 },
    { width: 1466, height: 736 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(login).toHaveCSS("height", `${viewport.height}px`);
    const bounds = await login.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(Math.min(430, viewport.width));
    const bodyBounds = await page.locator("body").boundingBox();
    const appBounds = await page.locator("#app").boundingBox();
    expect(Math.abs(bodyBounds!.width - viewport.width)).toBeLessThan(1);
    expect(Math.abs(bodyBounds!.x)).toBeLessThan(1);
    expect(Math.abs(appBounds!.x - (viewport.width - appBounds!.width) / 2)).toBeLessThan(1);
    expect(Math.abs(bounds!.x - appBounds!.x)).toBeLessThan(1);
    if (viewport.width > 430) {
      const outsideApp = await page.evaluate(() => {
        const app = document.querySelector("#app")!.getBoundingClientRect();
        return [app.left / 2, (app.right + innerWidth) / 2].map(
          (x) => document.elementFromPoint(x, innerHeight / 2)?.closest("#app") === null,
        );
      });
      expect(outsideApp).toEqual([true, true]);
    }
    for (const selector of ["html", "body"]) {
      await expect(page.locator(selector)).toHaveCSS(
        "background-color",
        viewport.width > 430 ? "rgba(128, 128, 128, 0.35)" : "rgb(55, 153, 106)",
      );
    }
    await expect(login).not.toHaveCSS("background-image", "none");
    await page.getByRole("button", { name: "登入", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "登入", exact: true })).toBeInViewport();
    if (viewport.width === 1466) {
      await page.screenshot({ path: test.info().outputPath("login-wide-background.png") });
    }
  }
  await username.fill("player");

  // Desktop WebKit has no OS keyboard. Keep layout viewport at 844px while
  // simulating the visual viewport changes reported by iOS keyboard/panning.
  for (const [height, offsetTop] of [
    [360, 0],
    [300, 90],
    [280, 50],
    [844, 0],
  ]) {
    await page.evaluate(
      ({ height, offsetTop }) => {
        const viewport = window.visualViewport!;
        Object.defineProperties(viewport, {
          height: { configurable: true, value: height },
          offsetTop: { configurable: true, value: offsetTop },
        });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      },
      { height: height!, offsetTop: offsetTop! },
    );
    await expect(login).toHaveCSS("height", `${height}px`);
    await expect(login).toHaveCSS("top", `${offsetTop}px`);
    for (const input of [password, username]) {
      await input.focus();
      await expect
        .poll(async () => {
          const field = await input.boundingBox();
          const bounds = await login.boundingBox();
          return field!.y >= bounds!.y && field!.y + field!.height <= bounds!.y + bounds!.height;
        })
        .toBe(true);
    }
    await page.evaluate(() => window.scrollTo(0, 500));
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(55, 153, 106)");
    if (height === 360) {
      await login.screenshot({ path: test.info().outputPath("login-keyboard-open.png") });
    }
  }
  await password.fill("test-password");
  const submit = page.getByRole("button", { name: "登入", exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await page.unroute("**/api/auth/refresh");
  await submit.click();
  await expect(page).toHaveURL(/\/lobby$/);
  await expect(page.locator("body")).toHaveCSS("position", "static");
  const lobby = await page.locator("main").boundingBox();
  expect(Math.abs(lobby!.height - 844)).toBeLessThan(1);
});

test("lobby to Plinko keeps the back button stationary during loading and after navigation", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 483, height: 771 },
  ]) {
    await page.setViewportSize(viewport);
    let releaseConfig!: () => void;
    const configReady = new Promise<void>((resolve) => (releaseConfig = resolve));
    await page.route("**/api/plinko/config", async (route) => {
      await configReady;
      await route.fallback();
    });
    await page.goto("/lobby");
    const button = page.locator(".ui-page-header .page-header-back");
    await expect(button).toBeVisible();
    const before = await button.boundingBox();
    await page.getByRole("button", { name: "進入Plinko", exact: true }).click();
    await expect(page.getByText("載入遊戲中…", { exact: true })).toBeVisible();
    expect(await button.boundingBox()).toEqual(before);
    releaseConfig();
    await expect(page.getByText("載入遊戲中…", { exact: true })).toHaveCount(0);
    expect(await button.boundingBox()).toEqual(before);
    await button.click();
    await expect(page).toHaveURL(/\/lobby$/);
    expect(await button.boundingBox()).toEqual(before);
    await page.unroute("**/api/plinko/config");
  }
});

test("shared headers keep return buttons aligned and shared dialog buttons preserve focus", async ({
  page,
}) => {
  for (const path of [
    "/lobby",
    "/baccarat",
    "/mines",
    "/plinko",
    "/hilo",
    "/game/table-1",
    "/history",
    "/game/table-1/rules",
  ]) {
    await page.goto(path);
    const header = page.locator(".ui-page-header");
    await expect(header.getByRole("heading")).toBeVisible();
    for (const [width, height] of [
      [320, 568],
      [483, 771],
    ]) {
      await page.setViewportSize({ width, height });
      const title = await header.locator("h1").boundingBox();
      const arrow = await header.locator(".page-header-back svg").boundingBox();
      const button = await header.locator(".page-header-back").boundingBox();
      expect(Math.abs(title!.y + title!.height / 2 - arrow!.y - arrow!.height / 2)).toBeLessThan(1);
      expect(button!.height).toBe(height <= 650 ? 36 : 44);
    }
  }
  await page.goto("/game/table-1");
  const trigger = page.getByRole("button", { name: "開啟路單", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: "關閉路圖", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Baccarat, Hi-Lo, Plinko and Mines share the lobby return-button position", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 483, height: 771 },
  ]) {
    await page.setViewportSize(viewport);
    const positions = [];
    for (const path of ["/lobby", "/baccarat", "/game/table-1", "/hilo", "/plinko", "/mines"]) {
      await page.goto(path);
      const header = page.locator(".ui-page-header");
      await expect(header.getByRole("heading")).toBeVisible();
      if (path === "/game/table-1") {
        await expect(header.locator(".page-header-subtitle")).toHaveCount(0);
        await expect(header).not.toContainText("限紅");
        await expect(header.getByRole("button", { name: "遊戲規則", exact: true })).toBeVisible();
      }
      positions.push({
        path,
        button: await header.locator(".page-header-back").boundingBox(),
        arrow: await header.locator(".page-header-back svg").boundingBox(),
        title: await header.locator("h1").boundingBox(),
      });
    }
    for (const position of positions.slice(1)) {
      expect(position.button, position.path).toEqual(positions[0]!.button);
      expect(position.arrow, position.path).toEqual(positions[0]!.arrow);
      expect(
        Math.abs(
          position.title!.y +
            position.title!.height / 2 -
            position.arrow!.y -
            position.arrow!.height / 2,
        ),
      ).toBeLessThan(1);
    }
  }
});
