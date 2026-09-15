import { mockPlinkoSocket } from "./helpers/plinko-ws";
import { expect, test, type Page } from "@playwright/test";

const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const user = {
  id: "user-1",
  username: "player",
  role: "PLAYER",
  isActive: true,
  balance: 1000,
  walletVersion: 1,
};
const now = "2026-09-14T10:00:00.000Z";
const config = {
  minRows: 8,
  maxRows: 16,
  risks: ["low", "medium", "high"],
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  ruleVersion: 1,
  enabled: true,
  tables: ["low", "medium", "high"].flatMap((risk) =>
    Array.from({ length: 9 }, (_, i) => ({
      rows: i + 8,
      risk,
      multipliers: Array.from({ length: i + 9 }, (_, slot) =>
        slot === 0 || slot === i + 8 ? 2.5 : 0.9,
      ),
      rtp: 0.955,
    })),
  ),
};

for (const failure of ["disconnect", "timeout"] as const) {
  test(`Plinko stops auto on disconnect and confirms only the original ball after reconnect (${failure})`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const keys: string[] = [];
    let writes = 0;
    const result = {
      round: {
        id: "11111111-1111-4111-8111-111111111111",
        amount: 100,
        rows: 16,
        risk: "medium",
        path: Array(16).fill(1),
        slotIndex: 16,
        multiplier: 106.1236,
        payout: 10612.36,
        ruleVersion: 1,
        createdAt: now,
        settledAt: now,
      },
      balance: 11512.36,
      walletVersion: 2,
    };
    await page.routeWebSocket("**/api/ws", (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "plinko_command") return;
        keys.push(message.idempotencyKey);
        if (keys.length === 1) {
          writes++;
          if (failure === "disconnect")
            socket.close({ code: 1011, reason: "Lost reply after commit" });
        } else
          socket.send(
            JSON.stringify({
              type: "plinko_result",
              requestId: message.requestId,
              result: { ok: true, data: result },
            }),
          );
      });
    });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      expect(route.request().method() === "POST" && path.includes("/plinko/rounds")).toBe(false);
      const currentUser = writes ? { ...user, balance: result.balance, walletVersion: 2 } : user;
      if (path === "/api/auth/refresh")
        return route.fulfill({
          json: { token: "token", accessTokenExpiresAt: expiresAt, user: currentUser },
        });
      if (path === "/api/auth/me") return route.fulfill({ json: currentUser });
      if (path === "/api/plinko/config") return route.fulfill({ json: config });
      if (path === "/api/plinko/history")
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ status: 404 });
    });
    await page.goto("/plinko");
    await page.getByRole("combobox", { name: "自動投球" }).selectOption("30");
    await page.getByRole("button", { name: "投球", exact: true }).click();
    await expect.poll(() => keys.length).toBe(1);
    if (failure === "timeout") await page.clock.runFor(10_001);
    await expect(page.getByRole("button", { name: /停止投球/ })).toHaveCount(0);
    await page.clock.runFor(2000);
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    expect(writes).toBe(1);
    await expect(page.getByRole("button", { name: "投球", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "確認上一筆投注", exact: true })).toHaveCount(0);
    await expect(page.locator(".plinko-win")).toHaveCount(0);
    await expect(page.locator(".recent-results li")).toHaveCount(1);
    await page.clock.runFor(5000);
    expect(keys).toHaveLength(2);
  });
}

async function expectBoardLayout(page: Page) {
  const board = await page.locator(".plinko-board").boundingBox();
  const slots = await page.locator(".slots").boundingBox();
  const heading = await page.locator(".legend-heading").boundingBox();
  const legend = await page.locator(".slot-legend").boundingBox();
  const panel = await page.getByRole("region", { name: "Plinko 釘板", exact: true }).boundingBox();
  expect(board!.height).toBeGreaterThan(0);
  // Check the content boundaries: page overflow alone misses SVGs painting over the legend.
  expect(board!.y + board!.height).toBeLessThanOrEqual(heading!.y + 1);
  expect(slots!.y + slots!.height).toBeLessThanOrEqual(heading!.y);
  expect(slots!.x).toBeGreaterThanOrEqual(board!.x);
  expect(slots!.x + slots!.width).toBeLessThanOrEqual(board!.x + board!.width);
  expect(heading!.y + heading!.height).toBeLessThanOrEqual(legend!.y + 1);
  expect(legend!.y + legend!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
  expect(legend!.x + legend!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`Plinko uses the server round path and displays the settled result (${motion})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 483, height: 771 });
    await page.emulateMedia({ reducedMotion: motion });
    await page.routeWebSocket("**/api/ws", () => {});
    let releaseRound!: () => void;
    const roundGate = new Promise<void>((resolve) => {
      releaseRound = resolve;
    });
    const setBetReply = await mockPlinkoSocket(page, async () => {
      await roundGate;
      return {
        json: {
          round: {
            id: "11111111-1111-4111-8111-111111111111",
            amount: 100,
            rows: 16,
            risk: "medium",
            path: Array(16).fill(1),
            slotIndex: 16,
            multiplier: 2.5,
            payout: 250,
            ruleVersion: 1,
            createdAt: now,
            settledAt: now,
          },
          balance: 1150,
          walletVersion: 2,
        },
      };
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.pathname === "/api/auth/refresh")
        return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
      if (url.pathname === "/api/plinko/config") return route.fulfill({ json: config });
      if (url.pathname === "/api/plinko/history")
        return route.fulfill({ json: { items: [], nextCursor: null } });
      if (url.pathname === "/api/auth/me") return route.fulfill({ json: user });

      return route.fulfill({
        status: 404,
        json: { code: "NOT_FOUND", message: "unexpected route", requestId: "mock" },
      });
    });
    await page.goto("/plinko");
    await expect(page.getByRole("heading", { name: "PLINKO" })).toBeVisible();
    const trigger = page.getByRole("button", { name: /投注設定/ });
    const dialog = page.getByRole("dialog", { name: "投注設定" });
    await expect(dialog).not.toBeVisible();
    const recent = page.getByRole("region", { name: "最近 10 顆倍率（最新在前）" });
    await expect(recent).toHaveText("尚無落槽結果");
    await expect(page.getByRole("button", { name: "紀錄", exact: true })).toHaveCount(0);
    await expect(page.locator(".slot-legend strong").first()).toHaveText("2.50×");
    await expect(page.locator(".slot-legend strong").nth(1)).toHaveText("0.90×");
    await expectBoardLayout(page);
    const toolbarBox = await trigger.boundingBox();
    expect(toolbarBox!.width).toBe(44);
    expect(toolbarBox!.height).toBe(44);
    const boardBox = await page.locator(".plinko-board").boundingBox();
    expect(toolbarBox!.y).toBeLessThan(boardBox!.y);
    // Safari does not focus buttons on pointer clicks; exercise keyboard focus restoration.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "關閉投注設定" })).toBeFocused();
    await page.getByLabel("投注額", { exact: true }).selectOption("200");
    await page.getByRole("button", { name: "完成", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "關閉投注設定" })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("plinko-settings-mobile.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveText("");
    await expect(trigger).toHaveAttribute("title", "投注設定：200 幣 · 16 排 · 中風險");
    await trigger.click();
    await page.getByLabel("投注額", { exact: true }).selectOption("100");
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const labelBox = await page.locator(".plinko-wallet > span").boundingBox();
    const valueBox = await page.locator(".plinko-wallet strong").boundingBox();
    expect(
      Math.abs(labelBox!.y + labelBox!.height / 2 - valueBox!.y - valueBox!.height / 2),
    ).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const beforeBet = await page.locator(".plinko-board").boundingBox();
    const beforePlay = await page.locator(".plinko-play").boundingBox();
    await page.getByRole("button", { name: "投球" }).click();
    await expect(page.locator(".plinko-play")).toBeDisabled();
    const duringBet = await page.locator(".plinko-board").boundingBox();
    expect(duringBet).toEqual(beforeBet);
    expect(await page.locator(".plinko-play").boundingBox()).toEqual(beforePlay);
    await expect(page.getByRole("button", { name: "確認上一筆投注" })).toHaveCount(0);
    await expect(page.locator(".plinko-wallet strong")).toHaveText("$900");
    releaseRound();
    if (motion === "no-preference") {
      await expect(page.locator(".plinko-ball")).toHaveCount(1);
      await expect(page.locator(".plinko-ball.settled")).toHaveCount(0);
      await expect(recent.locator("li")).toHaveCount(0);
      await expect(page.locator(".plinko-wallet strong")).toHaveText("$900");
      await expect(page.locator(".pin-ripples circle").first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("plinko-before-payout.png") });
      await expect(page.locator(".plinko-ball.settled")).toHaveCount(1);
      await expect(page.locator(".plinko-wallet strong")).toHaveClass("rolling");
      await expect(page.locator(".plinko-slot.impacting")).toHaveCount(1);
      await page.screenshot({ path: test.info().outputPath("plinko-slot-impact.png") });
    }
    await expect(page.locator(".plinko-bet-action .result-summary")).toHaveCount(0);
    await expect(page.getByText("$1,150")).toBeVisible();
    await expect(recent.locator("li")).toHaveText(["2.50×"]);
    expect(await page.locator(".plinko-board").boundingBox()).toEqual(beforeBet);
    expect(await page.locator(".plinko-play").boundingBox()).toEqual(beforePlay);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(page.locator(".plinko-ball.settled")).toHaveCount(1);
    await expect(page.locator(".plinko-ball.settled")).toHaveAttribute(
      "transform",
      "translate(91 89.5)",
    );
    await expect(page.locator(".plinko-wallet > span")).toHaveText("餘額");
    for (const viewport of [
      { width: 483, height: 771 },
      { width: 393, height: 695 },
      { width: 393, height: 600 },
      { width: 393, height: 780 },
      { width: 375, height: 667 },
      { width: 320, height: 568 },
      { width: 1360, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      for (const rows of ["8", "16"]) {
        await trigger.click();
        await page.getByLabel("排數", { exact: true }).selectOption(rows);
        await page.getByRole("button", { name: "完成", exact: true }).click();
        await expect(page.locator(".plinko-board")).toHaveAttribute(
          "aria-label",
          `Plinko ${rows} 排 中風險釘板`,
        );
        await expectBoardLayout(page);
        const wallet = await page.locator(".plinko-wallet").boundingBox();
        const play = await page.getByRole("button", { name: "投球" }).boundingBox();
        expect(wallet!.y + wallet!.height).toBeLessThanOrEqual(viewport.height);
        expect(play!.y + play!.height).toBeLessThanOrEqual(wallet!.y);
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight),
        ).toBeLessThanOrEqual(viewport.height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
      }
    }
    await page.setViewportSize({ width: 483, height: 771 });
    const legend = page.getByLabel("落槽倍率", { exact: true });
    const leftHint = page.locator(".legend-hint-left");
    const rightHint = page.locator(".legend-hint-right");
    await expect(leftHint).toBeHidden();
    await expect(rightHint).toBeVisible();
    await legend.evaluate((element) => {
      element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    });
    await expect(leftHint).toBeVisible();
    await expect(rightHint).toBeVisible();
    await legend.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(legend.locator("strong").last()).toBeInViewport();
    await expect(leftHint).toBeVisible();
    await expect(rightHint).toBeHidden();
    await legend.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect(leftHint).toBeHidden();
    await expect(rightHint).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("plinko-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 960 });
    await page.screenshot({ path: test.info().outputPath("plinko-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 483, height: 771 });
    setBetReply(() => ({
      status: 400,
      json: {
        code: "VALIDATION_ERROR",
        message: "餘額不足。",
        requestId: "low-balance",
      },
    }));
    const boardBeforeError = await page.locator(".plinko-board").boundingBox();
    await page.getByRole("button", { name: "投球", exact: true }).click();
    await expect(page.locator(".plinko-wallet")).toHaveClass(/insufficient/);
    await expect(page.locator(".plinko-feedback")).toHaveCount(0);
    expect(await page.locator(".plinko-board").boundingBox()).toEqual(boardBeforeError);
    expect(await page.locator(".plinko-wallet").evaluate((el) => el.getAnimations().length)).toBe(
      motion === "reduce" ? 0 : 1,
    );
    await page.getByRole("button", { name: "投球", exact: true }).click();
    await expect(page.locator(".plinko-play")).toBeEnabled();
    await expect(page.locator(".plinko-wallet")).toHaveClass(/insufficient/);
    await page.screenshot({ path: test.info().outputPath("plinko-low-balance.png") });
    await expect(page.locator(".plinko-wallet")).not.toHaveClass(/insufficient/);
    await page.goto("/history?game=plinko");
    await expect(page).toHaveURL(/\/plinko$/);
    await expect(page.getByRole("heading", { name: "投注紀錄" })).toHaveCount(0);
  });
}

test("Plinko displays only the latest ten multipliers beside settings", async ({ page }) => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    amount: 100,
    rows: 16,
    risk: "medium",
    path: Array(16).fill(1),
    slotIndex: 16,
    multiplier: 106.1236 + index,
    payout: 10612.36 + index * 100,
    ruleVersion: 1,
    createdAt: now,
    settledAt: now,
  }));
  await page.routeWebSocket("**/api/ws", () => {});
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/refresh")
      return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
    if (path === "/api/plinko/config") return route.fulfill({ json: config });
    if (path === "/api/plinko/history") return route.fulfill({ json: { items, nextCursor: null } });
    if (path === "/api/auth/me") return route.fulfill({ json: user });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/plinko");
  const recent = page.getByRole("region", { name: "最近 10 顆倍率（最新在前）" });
  await expect(recent.locator("li")).toHaveText(
    items.slice(0, 10).map((round) => `${round.multiplier.toFixed(2)}×`),
  );
  for (const width of [320, 375, 483, 1360]) {
    await page.setViewportSize({ width, height: 771 });
    const settings = await page.getByRole("button", { name: "投注設定" }).boundingBox();
    const board = await page.locator(".plinko-board").boundingBox();
    expect(settings!.width).toBe(44);
    for (const item of await recent.locator("li").all()) {
      const bounds = await item.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThan(settings!.x);
      expect(bounds!.y + bounds!.height).toBeLessThan(board!.y);
      expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }
  }
  await page.setViewportSize({ width: 483, height: 771 });
  await page.screenshot({
    path: test.info().outputPath("plinko-recent-multipliers.png"),
    fullPage: true,
  });
});

test("Plinko auto selector starts a batch and the play button stops it while a request is pending", async ({
  page,
}) => {
  let posts = 0;
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.routeWebSocket("**/api/ws", () => {});
  const setBetReply = await mockPlinkoSocket(page, async () => {
    const sequence = ++posts;
    if (sequence === 2) await secondGate;
    return {
      json: {
        round: {
          id: `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`,
          amount: 100,
          rows: 16,
          risk: "medium",
          path: Array(16).fill(1),
          slotIndex: 16,
          multiplier: 2.5,
          payout: 250,
          ruleVersion: 1,
          createdAt: now,
          settledAt: now,
        },
        balance: 1000 + sequence * 150,
        walletVersion: sequence + 1,
      },
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/refresh")
      return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
    if (path === "/api/auth/me") return route.fulfill({ json: user });
    if (path === "/api/plinko/config") return route.fulfill({ json: config });
    if (path === "/api/plinko/history")
      return route.fulfill({ json: { items: [], nextCursor: null } });

    return route.fulfill({ status: 404 });
  });
  await page.goto("/plinko");
  const auto = page.getByRole("combobox", { name: "自動投球" });
  const play = page.locator(".plinko-play");
  await expect(auto).toBeEnabled();
  await expect(auto.locator("option")).toHaveText([
    "自動：關閉",
    "30 球",
    "50 球",
    "100 球",
    "300 球",
    "500 球",
    "1000 球",
  ]);
  for (const width of [320, 375, 483, 1360]) {
    await page.setViewportSize({ width, height: 771 });
    const selectBox = await auto.boundingBox();
    const playBox = await play.boundingBox();
    expect(selectBox!.x + selectBox!.width).toBeLessThan(playBox!.x);
    expect(selectBox!.height).toBe(playBox!.height);
    expect(selectBox!.y).toBe(playBox!.y);
  }
  await page.setViewportSize({ width: 483, height: 771 });
  await auto.selectOption("30");
  const boardBefore = await page.locator(".plinko-board").boundingBox();
  await play.click();
  await expect(play).toHaveText("停止投球（29）");
  await expect(auto).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("plinko-auto-playing.png"),
    fullPage: true,
  });
  await page.clock.runFor(350);
  await expect.poll(() => posts).toBe(2);
  await expect(play).toBeEnabled();
  await play.click();
  releaseSecond();
  await expect(play).toHaveText("投球");
  await expect(play).toBeEnabled();
  await expect(auto).toBeEnabled();
  await page.clock.runFor(5000);
  expect(posts).toBe(2);
  expect(await page.locator(".plinko-board").boundingBox()).toEqual(boardBefore);
  await expect(page.locator(".recent-results li")).toHaveCount(2);
});

for (const motion of ["reduce", "no-preference"] as const) {
  test(`Plinko celebrates landed wins without blocking auto stop (${motion})`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 695 });
    await page.emulateMedia({ reducedMotion: motion });
    await page.routeWebSocket("**/api/ws", () => {});
    let sequence = 0;
    const setBetReply = await mockPlinkoSocket(page, async () => {
      sequence++;
      return {
        json: {
          round: {
            id: `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`,
            amount: 100,
            rows: 16,
            risk: "medium",
            path: Array(16).fill(1),
            slotIndex: 16,
            multiplier: 106.1236,
            payout: 10612.36,
            ruleVersion: 1,
            createdAt: now,
            settledAt: now,
          },
          balance: 1000 + sequence * 10512.36,
          walletVersion: sequence + 1,
        },
      };
    });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/refresh")
        return route.fulfill({ json: { token: "token", accessTokenExpiresAt: expiresAt, user } });
      if (path === "/api/auth/me") return route.fulfill({ json: user });
      if (path === "/api/plinko/config") return route.fulfill({ json: config });
      if (path === "/api/plinko/history")
        return route.fulfill({ json: { items: [], nextCursor: null } });

      return route.fulfill({ status: 404 });
    });
    await page.goto("/plinko");
    await page.getByLabel("自動投球", { exact: true }).selectOption("30");
    await page.getByRole("button", { name: "投球", exact: true }).click();
    const win = page.locator(".plinko-win");
    if (motion === "no-preference") await expect(win).toHaveCount(0);
    await expect(win).toContainText("MEGA WIN");
    await expect(win).toContainText("106.12×");
    const box = await win.boundingBox();
    const board = await page.locator(".plinko-board-viewport").boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(board!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(board!.y + board!.height);
    expect(await win.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    if (motion === "reduce")
      expect(
        await win.locator(".win-copy").evaluate((el) => getComputedStyle(el).animationName),
      ).toBe("none");
    await page.getByRole("button", { name: /停止投球/ }).click();
    const stoppedAt = sequence;
    await expect(page.getByRole("button", { name: "投球", exact: true })).toBeEnabled();
    if (motion === "no-preference") {
      await expect
        .poll(() =>
          win.locator("canvas").evaluate((el: HTMLCanvasElement) => {
            const pixels = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
            return pixels.some((value, index) => index % 4 === 3 && value > 0);
          }),
        )
        .toBe(true);
    }
    await expect(win.locator(".win-payout")).toHaveText(
      `$${Math.trunc(stoppedAt * 10612.36).toLocaleString("zh-TW")}`,
      { timeout: 5000 },
    );
    await expect(win).toHaveCount(0, { timeout: 7000 });
    expect(sequence).toBe(stoppedAt);
    await expectBoardLayout(page);
  });
}
