import { expect, test, type Page } from "@playwright/test";

const now = "2026-09-14T10:00:00.000Z";
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const user = {
  id: "user-1",
  username: "player",
  role: "PLAYER",
  isActive: true,
  balance: 1000,
  walletVersion: 1,
};
const round = {
  id: "11111111-1111-4111-8111-111111111111",
  amount: 100,
  mineCount: 24,
  revealedCells: [],
  status: "ACTIVE",
  payout: 0,
  cashoutAmount: 0,
  multiplier: 0,
  nextMultiplier: 23.75,
  mineCells: null,
  createdAt: now,
  settledAt: null,
  version: 1,
  ruleVersion: 1,
};

async function expectControlHeights(page: Page) {
  for (const [select, buttons] of [
    [".stake-field select", ".stake-shortcuts button"],
    ["#mine-count", ".mine-presets button"],
  ]) {
    const field = await page.locator(select!).boundingBox();
    for (const button of await page.locator(buttons!).all()) {
      if (!(await button.isVisible())) continue;
      const box = await button.boundingBox();
      expect(Math.abs(field!.height - box!.height)).toBeLessThan(1);
      expect(Math.abs(field!.y - box!.y)).toBeLessThan(1);
    }
  }
}

test("Mines reconnects and confirms a lost reveal reply with the same key", async ({ page }) => {
  let current = { ...round, mineCount: 3, revealedCells: [] as number[] };
  let writes = 0;
  const keys: string[] = [];
  await page.routeWebSocket("**/api/ws", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "mines_command") return;
      expect(message.action.kind).toBe("reveal");
      keys.push(message.idempotencyKey);
      if (keys.length === 1) {
        writes++;
        current = {
          ...current,
          revealedCells: [0],
          version: 2,
          cashoutAmount: 107.95,
          multiplier: 1.079545,
        };
        socket.close({ code: 1011, reason: "Simulated lost reply after commit" });
        return;
      }
      socket.send(
        JSON.stringify({
          type: "mines_result",
          requestId: message.requestId,
          result: { ok: true, data: { round: current, balance: 1000, walletVersion: 1 } },
        }),
      );
    });
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method() === "POST" && path.includes("/mines/")).toBe(false);
    if (path === "/api/auth/refresh")
      return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
    if (path === "/api/auth/me") return route.fulfill({ json: user });
    if (path === "/api/mines/config")
      return route.fulfill({
        json: {
          boardSize: 25,
          minMines: 3,
          maxMines: 24,
          minBet: 100,
          maxBet: 5000,
          betStep: 100,
          rtp: 0.95,
          enabled: true,
        },
      });
    if (path === "/api/mines/active" || path === `/api/mines/rounds/${round.id}`)
      return route.fulfill({ json: { round: current } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/mines");
  await page.getByRole("button", { name: "翻開第 1 格", exact: true }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  expect(writes).toBe(1);
  await expect(page.getByRole("button", { name: "安全格", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "翻開第 2 格", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "收款 107", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "重試上一個操作" })).toHaveCount(0);
});

test("Mines restores an active round and renders a deterministic full-clear settlement", async ({
  page,
}) => {
  let releaseReveal!: () => void;
  let revealReceived = false;
  const revealGate = new Promise<void>((resolve) => {
    releaseReveal = resolve;
  });
  await page.routeWebSocket("**/api/ws", (socket) => {
    socket.onMessage(async (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== "mines_command") return;
      expect(message.action.kind).toBe("reveal");
      revealReceived = true;
      await revealGate;
      socket.send(
        JSON.stringify({
          type: "mines_result",
          requestId: message.requestId,
          result: {
            ok: true,
            data: {
              round: {
                ...round,
                revealedCells: [0],
                status: "CASHED_OUT",
                payout: 2375,
                cashoutAmount: 2375,
                multiplier: 23.75,
                nextMultiplier: null,
                version: 2,
                mineCells: Array.from({ length: 24 }, (_, index) => index + 1),
                settledAt: now,
              },
              balance: 3275,
              walletVersion: 2,
            },
          },
        }),
      );
    });
  });
  await page.route("**/api/**", async (route) => {
    expect(route.request().method() === "POST" && route.request().url().includes("/mines/")).toBe(
      false,
    );
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/auth/refresh" && method === "POST")
      return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
    if (url.pathname === "/api/mines/config")
      return route.fulfill({
        json: {
          boardSize: 25,
          minMines: 3,
          maxMines: 24,
          minBet: 100,
          maxBet: 5000,
          betStep: 100,
          rtp: 0.95,
          enabled: true,
        },
      });
    if (url.pathname === "/api/mines/active") return route.fulfill({ json: { round } });
    if (url.pathname === "/api/auth/me")
      return route.fulfill({ json: { ...user, balance: 3275, walletVersion: 2 } });
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "unexpected route", requestId: "mock" },
    });
  });

  await page.goto("/mines");
  await expect(page.getByRole("heading", { name: "Mines" })).toBeVisible();
  await expect(page.getByRole("button", { name: "紀錄", exact: true })).toHaveCount(0);
  await expect(page.locator("details")).toHaveCount(0);
  await expect(page.getByLabel("地雷數").locator("option")).toHaveCount(22);
  await expect(page.getByRole("button", { name: "翻開第 1 格" })).toHaveCount(1);
  for (const [width, height] of [
    [320, 568],
    [375, 667],
    [390, 844],
    [430, 932],
    [483, 771],
    [768, 1024],
    [803, 771],
    [1440, 900],
    [844, 390],
    [667, 375],
    [568, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await expectControlHeights(page);
    const board = await page.locator(".mines-board").boundingBox();
    const cell = await page.getByRole("button", { name: "翻開第 1 格", exact: true }).boundingBox();
    const controls = await page.getByRole("region", { name: "投注設定" }).boundingBox();
    const landscape = height! <= 520 && width! >= 520;
    expect(board!.width).toBeGreaterThan(landscape ? 100 : 180);
    const screen = await page.locator(".mines-page").boundingBox();
    expect(Math.abs(screen!.height - height!)).toBeLessThan(1);
    expect(screen!.y).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    expect(Math.abs(cell!.width - cell!.height)).toBeLessThan(1);
    if (landscape) expect(controls!.x).toBeGreaterThan(board!.x + board!.width);
    else expect(controls!.y).toBeGreaterThan(board!.y + board!.height);
    const summary = await page.locator(".game-summary").boundingBox();
    expect(controls!.y).toBeGreaterThanOrEqual(summary!.y + summary!.height);
    expect(controls!.y + controls!.height).toBeLessThan(height!);
    const wallet = await page.locator(".mines-wallet").boundingBox();
    expect(wallet!.y).toBeGreaterThan(controls!.y + controls!.height);
    expect(wallet!.y + wallet!.height).toBeLessThanOrEqual(height!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 375, height: 667 });
  const beforeBoard = await page.locator(".mines-board").boundingBox();
  const beforeWallet = await page.locator(".mines-wallet").boundingBox();
  await page.getByRole("button", { name: "翻開第 1 格" }).click();
  try {
    await expect.poll(() => revealReceived).toBe(true);
    await expect(page.getByRole("button", { name: "處理中…", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "重試上一個操作" })).toHaveCount(0);
    expect(await page.locator(".mines-board").boundingBox()).toEqual(beforeBoard);
    expect(await page.locator(".mines-wallet").boundingBox()).toEqual(beforeWallet);
  } finally {
    releaseReveal();
  }
  await expect(page.locator(".mines-board")).toHaveAttribute("aria-label", "Mines 棋盤，已收款");
  await expect(page.getByRole("button", { name: "地雷", exact: true })).toHaveCount(24);
  await expect(page.getByText("$3,275")).toBeVisible();
  await expectControlHeights(page);
  await page.screenshot({ path: test.info().outputPath("mines-controls.png"), fullPage: true });
  await page.getByLabel("地雷數").selectOption("5");
  await page.getByLabel("投注額", { exact: true }).selectOption("200");
  await expect(page.getByLabel("地雷數")).toHaveValue("5");
  await expect(page.getByLabel("投注額", { exact: true })).toHaveValue("200");
  await page.goto("/history?game=mines");
  await expect(page).toHaveURL(/\/mines$/);
  await expect(page.getByRole("heading", { name: "投注紀錄" })).toHaveCount(0);
});

for (const motion of ["reduce", "no-preference"] as const) {
  test(`Mines warns in the wallet without moving the board (${motion})`, async ({ page }) => {
    let balance = 67;
    let starts = 0;
    await page.setViewportSize({ width: 483, height: 771 });
    await page.emulateMedia({ reducedMotion: motion });
    await page.routeWebSocket("**/api/ws", (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "mines_command") return;
        starts++;
        socket.send(
          JSON.stringify({
            type: "mines_result",
            requestId: message.requestId,
            result: {
              ok: false,
              status: 400,
              error: {
                code: "VALIDATION_ERROR",
                message: "餘額不足。",
                requestId: message.requestId,
              },
            },
          }),
        );
      });
    });
    await page.route("**/api/**", (route) => {
      expect(route.request().method() === "POST" && route.request().url().includes("/mines/")).toBe(
        false,
      );
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/refresh")
        return route.fulfill({
          json: { token: "token", accessTokenExpiresAt: expiresAt, user: { ...user, balance } },
        });
      if (path === "/api/auth/me") return route.fulfill({ json: { ...user, balance } });
      if (path === "/api/mines/config")
        return route.fulfill({
          json: {
            boardSize: 25,
            minMines: 3,
            maxMines: 24,
            minBet: 100,
            maxBet: 5000,
            betStep: 100,
            rtp: 0.95,
            enabled: true,
          },
        });
      if (path === "/api/mines/active") return route.fulfill({ json: { round: null } });
      return route.fulfill({ status: 404 });
    });
    await page.goto("/mines");
    const play = page.getByRole("button", { name: "開始遊戲", exact: true });
    const wallet = page.locator(".mines-wallet");
    await expect(play).toBeEnabled();
    for (const serverRejection of [false, true]) {
      if (serverRejection) {
        balance = 1000;
        await page.reload();
        await expect(play).toBeEnabled();
      }
      const boardBefore = await page.locator(".mines-board").boundingBox();
      const controlsBefore = await page.locator(".mines-controls").boundingBox();
      await play.click();
      await expect(wallet).toHaveClass(/insufficient/);
      expect(await wallet.evaluate((element) => element.getAnimations().length)).toBe(
        motion === "reduce" ? 0 : 1,
      );
      expect(await page.locator(".mines-board").boundingBox()).toEqual(boardBefore);
      expect(await page.locator(".mines-controls").boundingBox()).toEqual(controlsBefore);
      await expect(page.locator(".mines-feedback")).toHaveCount(0);
      await expect(play).toBeEnabled();
      await play.click();
      await expect(wallet).toHaveClass(/insufficient/);
      await expect(play).toBeEnabled();
      expect(starts).toBe(serverRejection ? 2 : 0);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await expect(wallet).not.toHaveClass(/insufficient/);
      await expect(wallet.locator("strong")).toHaveText(serverRejection ? "$1,000" : "$67");
    }
  });
}
