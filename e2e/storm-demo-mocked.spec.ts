import { expect, test } from "@playwright/test";
import { mockStorm } from "./storm-fixtures";
test("stake menu and step buttons stay in sync, settle 5000 once and survive reload", async ({
  page,
}) => {
  const game = await mockStorm(page, { fixture: "lose", delay: true, amount: 20 });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/storm-demo");
  const stake = page.getByLabel("每次探索", { exact: true });
  await expect(stake).toHaveValue("10");
  await expect(stake.locator("option")).toHaveText([
    "10",
    "50",
    "100",
    "200",
    "500",
    "1000",
    "2000",
    "5000",
  ]);
  await expect(page.locator(".spin-controls button")).toHaveCount(5);
  await expect(stake).toHaveCSS("appearance", "none");
  await expect(stake).toHaveCSS("background-image", "none");
  const decrease = page.getByRole("button", { name: "減少投注金額", exact: true });
  const increase = page.getByRole("button", { name: "增加投注金額", exact: true });
  await expect(decrease).toBeDisabled();
  await increase.click();
  await expect(stake).toHaveValue("50");
  await increase.click();
  await expect(stake).toHaveValue("100");
  await stake.selectOption("2000");
  await decrease.focus();
  await page.keyboard.press("Enter");
  await expect(stake).toHaveValue("1000");
  await increase.click();
  await expect(stake).toHaveValue("2000");
  expect(game.accepted()).toBe(0);
  await expect(page.getByLabel("本回合消除紀錄")).toHaveCount(0);
  await stake.selectOption("5000");
  await expect(increase).toBeDisabled();
  await expect(decrease).toBeEnabled();
  await page.getByRole("button", { name: "開始探索", exact: true }).click();
  await expect.poll(() => game.accepted()).toBe(1);
  await expect(stake).toBeDisabled();
  await expect(increase).toBeDisabled();
  await expect(decrease).toBeDisabled();
  expect(game.commands[0]!.action.amount).toBe(5000);
  game.release();
  await expect(stake).toBeEnabled();
  await expect(decrease).toBeEnabled();
  await expect(increase).toBeDisabled();
  await expect(page.getByTestId("demo-balance")).toHaveText("5,000");
  await page.reload();
  await expect(stake).toHaveValue("5000");
  await page.screenshot({ path: test.info().outputPath("stake-controls-5000.png") });
  expect(game.accepted()).toBe(1);
});
test("free completion closes automatically and returns focus without a paid wager", async ({
  page,
}) => {
  const game = await mockStorm(page, {
    freeLeft: 1,
    freeGranted: 15,
    multiplier: 515,
    featureWin: 244440,
    fixture: "lose",
  });
  await page.setViewportSize({ width: 549, height: 761 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-24T10:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-24T10:00:01Z"));
  await page.goto("/storm-demo");
  await page.getByRole("button", { name: "開始免費回合", exact: true }).click();
  const outro = page.getByRole("dialog", { name: "免費回合完成", exact: true });
  for (let i = 0; i < 100 && !(await outro.isVisible()); i++) await page.clock.runFor(50);
  await expect(outro).toBeVisible();
  await expect(outro.locator(".feature-number")).toHaveText("244,440");
  await expect(outro.getByRole("button", { name: "返回神殿" })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("free-completion-before.png") });
  await page.clock.runFor(2500);
  await expect(outro).toBeVisible();
  await page.clock.runFor(600);
  await expect(outro).toHaveCount(0);
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeFocused();
  await expect(page.getByTestId("free-left")).toHaveCount(0);
  await expect(page.getByTestId("demo-balance")).toHaveText("10,000");
  await page.clock.runFor(10000);
  expect(game.accepted()).toBe(1);
  await page.screenshot({ path: test.info().outputPath("free-completion-dismissed.png") });
});
test("newly awarded free rounds start automatically after the intro reading delay", async ({
  page,
}) => {
  const game = await mockStorm(page, { fixture: "bonus", bonusCount: 1, delay: true });
  await page.setViewportSize({ width: 549, height: 761 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-24T10:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-24T10:00:01Z"));
  await page.goto("/storm-demo");
  await page.getByRole("button", { name: "開始探索", exact: true }).click();
  await expect.poll(() => game.accepted()).toBe(1);
  game.release();
  const intro = page.getByRole("dialog", { name: "免費回合開始", exact: true });
  for (let i = 0; i < 100 && !(await intro.isVisible()); i++) await page.clock.runFor(50);
  await expect(intro).toBeVisible();
  await expect(intro).toContainText("3 秒後自動開始");
  await page.screenshot({ path: test.info().outputPath("free-intro-autostart.png") });
  await page.clock.runFor(2500);
  await expect(intro).toBeVisible();
  expect(game.accepted()).toBe(1);
  await page.clock.runFor(600);
  await expect.poll(() => game.accepted()).toBe(2);
  await expect(intro).toHaveCount(0);
  await page.getByRole("button", { name: "停止自動", exact: true }).click();
  game.release();
  await page.clock.resume();
  await expect(page.getByRole("button", { name: "開始免費回合", exact: true })).toBeEnabled();
  expect(game.accepted()).toBe(2);
});
test("wallet comes from the server, waits for WS and persists after refresh", async ({ page }) => {
  const game = await mockStorm(page, { balance: 12345.01, fixture: "win", delay: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/storm-demo");
  const spin = page.getByRole("button", { name: "開始探索", exact: true });
  await expect(spin).toBeEnabled();
  await expect(page.getByTestId("demo-balance")).toHaveText("12,345");
  const board = await page
    .locator(".symbol-cell")
    .evaluateAll((cells) => cells.map((c) => c.getAttribute("aria-label")));
  const controls = page.locator(".spin-controls button");
  const opacity = await controls.evaluateAll((items) =>
    items.map((el) => getComputedStyle(el).opacity),
  );
  await spin.click();
  await expect(spin).toBeDisabled();
  expect(
    await controls.evaluateAll((items) => items.map((el) => getComputedStyle(el).opacity)),
  ).toEqual(opacity);
  await expect.poll(() => game.accepted()).toBe(1);
  expect(
    await page
      .locator(".symbol-cell")
      .evaluateAll((cells) => cells.map((c) => c.getAttribute("aria-label"))),
  ).toEqual(board);
  await expect(page.locator(".reel-frame")).toHaveClass("reel-frame idle");
  await expect(page.getByLabel("每次探索", { exact: true })).toBeDisabled();
  game.release();
  await expect(spin).toBeEnabled();
  const balance = new Intl.NumberFormat("zh-TW").format(Math.round(game.balance()));
  await expect(page.getByTestId("demo-balance")).toHaveText(balance);
  await page.reload();
  await expect(spin).toBeEnabled();
  await expect(page.getByTestId("demo-balance")).toHaveText(balance);
  expect(game.accepted()).toBe(1);
  await expect(page.getByRole("button", { name: "重設點數" })).toHaveCount(0);
});
test("lost WS reply reconnects with a new requestId and the same wager key", async ({ page }) => {
  const game = await mockStorm(page, { dropFirst: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/storm-demo");
  await page.getByRole("button", { name: "開始探索", exact: true }).click();
  await expect.poll(() => game.commands.length).toBe(2);
  expect(game.commands[1]!.idempotencyKey).toBe(game.commands[0]!.idempotencyKey);
  expect(game.commands[1]!.requestId).not.toBe(game.commands[0]!.requestId);
  expect(game.accepted()).toBe(1);
  await expect(page.getByTestId("demo-balance")).toHaveText("9,990");
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
});
test("unlimited automatic play stops after its submitted wager and respects loss threshold", async ({
  page,
}) => {
  const game = await mockStorm(page, { delay: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/storm-demo");
  await page.getByRole("button", { name: "設定自動模式", exact: true }).click();
  await page.getByRole("button", { name: "無限", exact: true }).click();
  await page.getByRole("button", { name: "開始自動", exact: true }).click();
  await expect.poll(() => game.accepted()).toBe(1);
  await page.getByRole("button", { name: "停止自動模式", exact: true }).click();
  game.release();
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
  expect(game.accepted()).toBe(1);
  await page.getByRole("button", { name: "設定自動模式", exact: true }).click();
  await page.getByLabel("累計淨損達到").fill("10");
  await page.getByRole("button", { name: "開始自動", exact: true }).click();
  await expect.poll(() => game.accepted()).toBe(2);
  game.release();
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
  expect(game.accepted()).toBe(2);
});
test("requires login and cannot manufacture demo money", async ({ page }) => {
  await page.route("**/api/auth/refresh", (r) =>
    r.fulfill({
      status: 401,
      json: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Login required",
        requestId: "test-request",
      },
    }),
  );
  await page.goto("/storm-demo");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator(".storm-demo")).toHaveCount(0);
});
