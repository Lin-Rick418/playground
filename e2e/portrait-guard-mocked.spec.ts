import { expect, test } from "@playwright/test";
import { mockStorm } from "./storm-fixtures";
import { emulateMobileOrientation } from "./portrait-fixtures";

test("rotation covers an existing modal, cannot be dismissed, and preserves the mounted game", async ({
  page,
}) => {
  await emulateMobileOrientation(page);
  await mockStorm(page, { fixture: "lose" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/storm-demo");
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
  await page.locator(".reel-grid").evaluate((el) => {
    el.setAttribute("data-preserved", "yes");
  });
  await page.getByRole("button", { name: "開啟遊戲規則" }).click();
  const rules = page.getByRole("dialog", { name: "探索指南" });
  await expect(rules).toBeVisible();
  await page.setViewportSize({ width: 568, height: 320 });
  const guard = page.getByRole("dialog", { name: "請將裝置轉為直向遊玩" });
  await expect(guard).toBeVisible();
  const bounds = (await guard.boundingBox())!;
  expect(bounds.x).toBe(0);
  expect(bounds.y).toBe(0);
  expect(bounds.width).toBe(568);
  expect(bounds.height).toBe(320);
  await expect(guard.getByRole("button", { name: "返回遊戲大廳" })).toBeInViewport();
  expect(
    await page.evaluate(() => !!document.elementFromPoint(100, 100)?.closest(".portrait-guard")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(guard).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".portrait-guard"))).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("portrait-reminder.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guard).not.toBeVisible();
  await expect(rules).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rules).not.toBeVisible();
  await expect(page.locator(".reel-grid")).toHaveAttribute("data-preserved", "yes");
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
});

test("landscape loading and return to the lobby retain the reminder without sending a wager", async ({
  page,
}) => {
  await emulateMobileOrientation(page);
  const state = await mockStorm(page, { fixture: "lose" });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/storm-demo");
  const guard = page.getByRole("dialog", { name: "請將裝置轉為直向遊玩" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "返回遊戲大廳" }).click();
  await expect(page).toHaveURL(/\/lobby$/);
  await expect(guard).toBeVisible();
  await expect(guard.getByRole("button")).toHaveCount(0);
  expect(state.accepted()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guard).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "遊戲大廳" })).toBeVisible();
});

test("wide desktops and non-game pages remain accessible", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () => "Mozilla/5.0 (Windows NT 10.0)",
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
  });
  await mockStorm(page, { fixture: "lose" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/storm-demo");
  await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
  await expect(page.locator(".portrait-guard")).not.toBeVisible();
  await emulateMobileOrientation(page);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator(".portrait-guard")).not.toBeVisible();
});
