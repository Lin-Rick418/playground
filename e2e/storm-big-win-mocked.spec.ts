import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockStorm } from "./storm-fixtures";

async function expectOverlayFits(page: Page, overlay: Locator) {
  const bounds = (await overlay.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  for (const container of [
    page.locator("html"),
    page.locator("body"),
    page.locator("#app"),
    page.locator(".storm-demo"),
    overlay,
  ]) {
    const overflow = await container.evaluate((el) => ({
      name: el.className || el.tagName,
      x: el.scrollWidth - el.clientWidth,
      y: el.scrollHeight - el.clientHeight,
    }));
    expect(overflow.x, `${overflow.name} horizontal overflow`).toBeLessThanOrEqual(1);
    expect(overflow.y, `${overflow.name} vertical overflow`).toBeLessThanOrEqual(1);
  }
  const scrollbars = await overlay.evaluate((el) =>
    [el, ...el.querySelectorAll("*")]
      .filter((node) => {
        const style = getComputedStyle(node);
        return (
          (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) ||
          (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1)
        );
      })
      .map((node) => node.className),
  );
  expect(scrollbars, "celebration must not contain scrollbars").toEqual([]);
  for (const node of await overlay
    .locator(
      ".win-title, .win-multiplier, .win-payout, .feature-kicker, .feature-card h2, .feature-number, .feature-card p, .big-win-actions, button",
    )
    .all()) {
    const box = (await node.boundingBox())!;
    expect(box.x, (await node.getAttribute("class")) ?? "overlay content").toBeGreaterThanOrEqual(
      bounds.x - 1,
    );
    expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  }
  if (await overlay.locator(".win-payout").count()) {
    const payout = (await overlay.locator(".win-payout").boundingBox())!;
    const actions = (await overlay.locator(".big-win-actions").boundingBox())!;
    expect(payout.y + payout.height, "prize must not overlap continue controls").toBeLessThan(
      actions.y,
    );
  }
}

async function sampleAnimations(overlay: Locator, time: number) {
  await overlay.evaluate((el, currentTime) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      if (!(animation instanceof CSSAnimation)) continue;
      animation.pause();
      animation.currentTime = currentTime;
    }
  }, time);
}

for (const scenario of [
  { width: 320, height: 568, mode: "normal" },
  { width: 549, height: 761, mode: "normal" },
  { width: 390, height: 844, mode: "fast" },
  { width: 320, height: 568, mode: "reduced" },
]) {
  test(`BIG WIN animates and fits at ${scenario.width} in ${scenario.mode} mode`, async ({
    page,
  }) => {
    const game = await mockStorm(page, { fixture: "bonus", bonusCount: 4 });
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.emulateMedia({
      reducedMotion: scenario.mode === "reduced" ? "reduce" : "no-preference",
    });
    await page.clock.install({ time: new Date("2026-10-25T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-25T00:00:01Z"));
    await page.goto("/storm-demo");
    await page.evaluate(() => document.fonts.ready);
    if (scenario.mode === "fast") await page.getByRole("button", { name: "快速動畫" }).click();
    await page.getByRole("button", { name: "開始探索", exact: true }).click();
    const win = page.getByRole("dialog", { name: "BIG WIN", exact: true });
    for (let i = 0; i < 200 && !(await win.isVisible()); i++) await page.clock.runFor(50);
    await expect(win).toBeVisible();
    await expect(win.locator(".win-title")).toHaveText("BIG WIN");
    await expect(win.getByRole("button", { name: "繼續", exact: true })).toBeFocused();
    const prize = win.locator(".win-payout");
    const before = await prize.innerText();
    await page.clock.runFor(1000);
    await expect(prize).toHaveText("250,000");
    await expect(win.locator(".win-copy")).toHaveCSS("opacity", "1");
    await expectOverlayFits(page, win);
    if (scenario.mode === "reduced") {
      expect(before).toBe("250,000");
      await expect(win.locator(".win-particles")).toBeHidden();
      await expect(win.locator(".win-copy")).toHaveCSS("animation-name", "none");
    } else {
      expect(before).not.toBe("250,000");
      await expect(win.locator(".win-particles")).toBeVisible();
      await expect(win.locator(".win-copy")).not.toHaveCSS("animation-name", "none");
    }
    for (const selector of [".win-title", ".win-payout", ".big-win-actions"]) {
      const box = (await win.locator(selector).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(scenario.width);
      expect(box.y + box.height).toBeLessThanOrEqual(scenario.height);
    }
    await page.screenshot({ path: test.info().outputPath("big-win.png") });
    await page.clock.runFor(scenario.mode === "fast" ? 300 : 1500);
    await expect(win).toBeVisible();
    await page.clock.runFor(600);
    await expect(win).toHaveCount(0);
    await page.clock.runFor(1500);
    await expect(page.getByRole("button", { name: "開始探索", exact: true })).toBeEnabled();
    await expect(page.getByTestId("demo-balance")).toHaveText("259,990");
    expect(game.accepted()).toBe(1);
  });
}

test("skipping BIG WIN continues into the awarded free-round intro", async ({ page }) => {
  const game = await mockStorm(page, { fixture: "bonus", bonusCount: 1 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-25T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-25T00:00:01Z"));
  await page.goto("/storm-demo");
  await page.getByRole("button", { name: "開始探索", exact: true }).click();
  const win = page.getByRole("dialog", { name: "BIG WIN", exact: true });
  for (let i = 0; i < 100 && !(await win.isVisible()); i++) await page.clock.runFor(50);
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "繼續", exact: true }).click();
  await expect(win).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "免費回合開始", exact: true })).toBeVisible();
  await expectOverlayFits(page, page.getByRole("dialog", { name: "免費回合開始", exact: true }));
  expect(
    await page
      .locator(".feature-rays")
      .evaluate((el) => getComputedStyle(el, "::before").animationName),
  ).toBe("none");
  expect(game.accepted()).toBe(1);
  await page.keyboard.press("Escape");
  await page.clock.runFor(5000);
  expect(game.accepted()).toBe(1);
});

for (const ending of ["intro", "outro"] as const) {
  test(`maximum stake BIG WIN and ${ending} never scroll through animation or resizing`, async ({
    page,
  }) => {
    const game = await mockStorm(page, {
      balance: 1000000000,
      amount: 5000,
      fixture: ending === "intro" ? "bonus" : "cap",
      bonusCount: 1,
      multiplier: ending === "outro" ? 25000 : 0,
      freeLeft: ending === "outro" ? 1 : 0,
    });
    await page.setViewportSize({ width: 320, height: 480 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.clock.install({ time: new Date("2026-10-26T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-26T00:00:01Z"));
    await page.goto("/storm-demo");
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByRole("button", { name: ending === "outro" ? "開始免費回合" : "開始探索", exact: true })
      .click();
    const win = page.getByRole("dialog", { name: "BIG WIN", exact: true });
    for (let i = 0; i < 200 && !(await win.isVisible()); i++) await page.clock.runFor(50);
    await expect(win).toBeVisible();
    await page.clock.runFor(1000);
    await expect(win.locator(".win-payout")).toHaveText(
      ending === "intro" ? "500,000" : "125,000,000",
    );
    for (const size of [
      { width: 320, height: 480 },
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 549, height: 761 },
    ]) {
      await page.setViewportSize(size);
      // Include the initial scale, overshoot and settled pose; timers remain frozen.
      for (const time of [0, 30, 120, 338, 510, 750, 1000]) {
        await sampleAnimations(win, time);
        await expectOverlayFits(page, win);
      }
      await page.screenshot({
        path: test.info().outputPath(`big-${ending}-${size.width}x${size.height}.png`),
      });
    }
    await win.getByRole("button", { name: "繼續", exact: true }).click();
    const feature = page.getByRole("dialog", {
      name: ending === "intro" ? "免費回合開始" : "免費回合完成",
      exact: true,
    });
    await expect(feature).toBeVisible();
    for (const size of [
      { width: 320, height: 480 },
      { width: 549, height: 761 },
    ]) {
      await page.setViewportSize(size);
      for (const time of [0, 4375, 8750]) {
        await sampleAnimations(feature, time);
        await expectOverlayFits(page, feature);
      }
      const scroll = await feature.evaluate((el) => {
        el.scrollTo(500, 500);
        return { x: el.scrollLeft, y: el.scrollTop };
      });
      expect(scroll).toEqual({ x: 0, y: 0 });
      await page.screenshot({
        path: test.info().outputPath(`${ending}-${size.width}x${size.height}.png`),
      });
    }
    await page.keyboard.press("Escape");
    await expect(feature).toHaveCount(0);
    expect(game.accepted()).toBe(1);
  });
}
