import { expect, test, type Page } from "@playwright/test";
import { mockStorm } from "./storm-fixtures";
const sizes = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 483, height: 771 },
  { width: 549, height: 761 },
  { width: 1440, height: 900 },
];
async function geometry(page: Page) {
  const view = page.viewportSize()!,
    main = (await page.locator(".storm-demo").boundingBox())!;
  expect(main.width).toBeLessThanOrEqual(430);
  expect(Math.abs(main.x + main.width / 2 - view.width / 2)).toBeLessThan(1);
  const board = (await page.locator(".reel-grid").boundingBox())!;
  expect(Math.abs(board.width / 6 - board.height / 5)).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const selector of [
    ".game-title h1",
    ".reel-grid",
    ".console",
    ".ui-page-header",
    ".page-header-actions",
    ".spin-button",
    ".auto-button",
  ]) {
    const item = page.locator(selector);
    if (!(await item.isVisible())) continue;
    const b = (await item.boundingBox())!;
    expect(b.x, selector).toBeGreaterThanOrEqual(main.x - 1);
    expect(b.x + b.width, selector).toBeLessThanOrEqual(main.x + main.width + 1);
    expect(b.y + b.height, selector).toBeLessThanOrEqual(view.height + 1);
    if (selector.includes("h1")) expect(b.y + b.height).toBeLessThanOrEqual(board.y);
  }
  const header = page.locator(".ui-page-header");
  const title = (await header.getByRole("heading", { name: "沙海神殿" }).boundingBox())!;
  const actions = (await header.locator(".page-header-actions").boundingBox())!;
  expect(Math.abs(title.x + title.width / 2 - main.x - main.width / 2)).toBeLessThan(1);
  expect(title.x + title.width).toBeLessThan(actions.x);
  expect(actions.x + actions.width).toBeLessThanOrEqual(main.x + main.width - 16);
  await expect(page.getByText("共用錢包 · 每局自動結算", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("本回合消除紀錄")).toHaveCount(0);
  await expect(page.locator(".stake-step")).toHaveCount(2);
  await expect(page.locator(".spin-controls button")).toHaveCount(5);
  await expect(page.getByLabel("每次探索", { exact: true })).toHaveCSS("appearance", "none");
  const buttons = await page.locator(".spin-controls button").all(),
    centers = [];
  for (const button of buttons) {
    const b = (await button.boundingBox())!,
      icon = (await button.locator(".app-icon").boundingBox())!;
    centers.push(b.y + b.height / 2);
    expect(Math.abs(icon.x + icon.width / 2 - b.x - b.width / 2)).toBeLessThan(1);
    expect(icon.y).toBeGreaterThan(b.y);
    expect(icon.y + icon.height).toBeLessThan(b.y + b.height);
    expect(
      await button.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === el || el.contains(hit);
      }),
    ).toBe(true);
  }
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
}
for (const freeLeft of [0, 15])
  test(`fills exactly one viewport through resizing (${freeLeft ? "free" : "normal"} mode)`, async ({
    page,
    browserName,
    isMobile,
  }) => {
    await mockStorm(page, { fixture: "lose", freeLeft });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/storm-demo");
    await expect(
      page.getByRole("button", { name: freeLeft ? "開始免費回合" : "開始探索", exact: true }),
    ).toBeEnabled();
    for (const size of [
      { width: 390, height: 844 },
      { width: 430, height: 1024 },
      { width: 1024, height: 1366 },
      { width: 393, height: 600 },
      { width: 393, height: 780 },
    ]) {
      await page.setViewportSize(size);
      for (const selector of ["html", "body", "#app", ".storm-demo"]) {
        const box = (await page.locator(selector).boundingBox())!;
        expect(
          Math.abs(box.height - size.height),
          `${selector} at ${size.width}x${size.height}`,
        ).toBeLessThan(1);
        expect(box.y, selector).toBe(0);
      }
      await geometry(page);
      for (const selector of [
        ".balance",
        ".win-meter",
        ".stake",
        ...(freeLeft ? [".multiplier-badge", ".free-counter"] : []),
      ])
        await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
      if (browserName !== "webkit" || !isMobile) {
        await page.mouse.move(size.width / 2, 100);
        await page.mouse.wheel(0, 500);
      }
      await page.keyboard.press("PageDown");
      expect(
        await page.evaluate(() => {
          window.scrollTo(0, 500);
          return { x: scrollX, y: scrollY };
        }),
      ).toEqual({ x: 0, y: 0 });
      await page.screenshot({
        path: test.info().outputPath(`viewport-${freeLeft}-${size.width}x${size.height}.png`),
      });
    }
    await page.goto("/history");
    await expect(page.getByRole("heading", { name: "投注紀錄" })).toBeVisible();
    expect(await page.locator("html").evaluate((el) => getComputedStyle(el).overflowY)).not.toBe(
      "hidden",
    );
  });
for (const size of sizes)
  test(`title, font icons and controls align at ${size.width}x${size.height}`, async ({ page }) => {
    await mockStorm(page, { fixture: "win" });
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/storm-demo");
    if (size.width > size.height && test.info().project.name === "webkit-mobile") {
      await expect(page.getByRole("dialog", { name: "請將裝置轉為直向遊玩" })).toBeVisible();
      return;
    }
    await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await geometry(page);
    await expect(page.getByRole("button", { name: "切換音效" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`temple-${size.width}-aligned.png`) });
    await page.getByRole("button", { name: "開始探索", exact: true }).click();
    await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
    await geometry(page);
    await page.getByRole("button", { name: "開啟遊戲規則" }).click();
    const rules = page.getByRole("dialog", { name: "探索指南" });
    await expect(rules).toBeVisible();
    expect((await rules.boundingBox())!.height).toBeLessThan(size.height);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "設定自動模式", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "自動模式", exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("button", { name: "20", exact: true })).toHaveCount(0);
    const unlimited = settings.getByRole("button", { name: "無限", exact: true });
    await expect(settings.locator(".auto-counts button").nth(0)).toHaveText("10");
    await expect(settings.locator(".auto-counts button").nth(1)).toHaveText("50");
    await expect(settings.locator(".auto-counts button").nth(2)).toHaveText("100");
    await expect(settings.locator(".auto-counts button").nth(3)).toHaveAccessibleName("無限");
    await unlimited.focus();
    await page.keyboard.press("Enter");
    await expect(unlimited).toHaveAttribute("aria-pressed", "true");
    expect((await settings.boundingBox())!.height).toBeLessThan(size.height);
    await page.screenshot({ path: test.info().outputPath(`auto-unlimited-${size.width}.png`) });
  });
test("server frames animate in order and preserve saved free rounds after refresh", async ({
  page,
}) => {
  await mockStorm(page, { fixture: "win", freeLeft: 15 });
  await page.setViewportSize({ width: 549, height: 761 });
  await page.clock.install({ time: new Date("2026-10-24T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-24T00:00:01Z"));
  await page.goto("/storm-demo");
  await page.getByRole("button", { name: "開始免費回合", exact: true }).click();
  await page.getByRole("button", { name: "停止自動", exact: true }).click();
  for (const phase of [
    "exiting",
    "falling",
    "winning",
    "clearing",
    "falling",
    "upgrading",
    "collecting",
  ]) {
    const frame = page.locator(".reel-frame");
    for (
      let i = 0;
      i < 230 && !(await frame.getAttribute("class"))?.split(" ").includes(phase);
      i++
    )
      await page.clock.runFor(50);
    await expect(frame).toHaveClass(new RegExp(`\\b${phase}\\b`));
    await page.screenshot({ path: test.info().outputPath(`server-${phase}.png`) });
  }
  await page.clock.resume();
  await expect(page.getByRole("button", { name: "開始免費回合", exact: true })).toBeEnabled();
  await expect(page.getByTestId("free-left")).toContainText("14");
  await geometry(page);
  const balance = await page.getByTestId("demo-balance").innerText();
  await page.reload();
  await expect(page.getByTestId("free-left")).toContainText("14");
  await expect(page.getByTestId("demo-balance")).toHaveText(balance);
  await expect(page.getByLabel("每次探索", { exact: true })).toBeDisabled();
});
