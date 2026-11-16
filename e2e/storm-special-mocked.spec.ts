import { expect, test } from "@playwright/test";
import { mockStorm } from "./storm-fixtures";
for (const width of [320, 390, 549])
  test(`natural bonus and capped server settlement render at ${width}`, async ({ page }) => {
    const game = await mockStorm(page, { fixture: "bonus", bonusCount: 4 });
    await page.setViewportSize({ width, height: 761 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/storm-demo");
    await page.getByRole("button", { name: "開始探索", exact: true }).click();
    await expect(page.getByTestId("last-win")).toHaveText("250,000");
    await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
    await expect(page.getByTestId("demo-balance")).toHaveText("259,990");
    expect(game.accepted()).toBe(1);
    await expect(page.getByTestId("free-left")).toHaveCount(0);
    expect(
      await page.getByTestId("demo-balance").evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`cap-${width}.png`) });
  });
test("large persisted balances, 1000x balls and free completion stay within the phone", async ({
  page,
}) => {
  await mockStorm(page, {
    balance: 1700000000,
    amount: 20,
    freeLeft: 1,
    freeGranted: 100,
    multiplier: 25000,
    featureWin: 249000000,
    fixture: "cap",
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/storm-demo");
  await expect(page.getByLabel("每次探索", { exact: true })).toHaveValue("20");
  await expect(page.getByLabel("每次探索", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "開始免費回合", exact: true }).click();
  const outro = page.getByRole("dialog", { name: "免費回合完成" });
  await expect(outro).toBeVisible();
  await expect(outro.locator(".feature-number")).toHaveText("249,500,000");
  expect(
    await outro.locator(".feature-number").evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("saved-free-outro.png") });
  await outro.getByRole("button", { name: "返回神殿" }).click();
  await expect(page.getByTestId("demo-balance")).toHaveText("1,700,500,000");
  await expect(page.getByLabel("每次探索", { exact: true })).toHaveValue("10");
});
