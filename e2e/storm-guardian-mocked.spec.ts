import { expect, test } from "@playwright/test";
import { mockStorm } from "./storm-fixtures";
import { emulateMobileOrientation } from "./portrait-fixtures";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 549, height: 761 },
])
  test(`free guardian moves independently of the board at ${size.width}`, async ({ page }) => {
    const game = await mockStorm(page, { freeLeft: 15 });
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/storm-demo");
    const guardian = page.locator(".guardian-scene");
    await expect(guardian).toHaveCSS("opacity", "1");
    await expect(guardian).toHaveAttribute("aria-hidden", "true");
    await expect(guardian.locator(".guardian-motion")).toHaveCSS("animation-play-state", "running");
    const board = await page.locator(".reel-grid").boundingBox();
    const controls = await page.locator(".console").boundingBox();
    const backdrop = await guardian.locator(".guardian-backdrop").boundingBox();
    const motion = await guardian.locator(".guardian-motion").evaluate((el) => {
      const animation = el.getAnimations()[0]!;
      animation.pause();
      animation.currentTime = 0;
      const start = getComputedStyle(el).transform;
      animation.currentTime = 2400;
      return { start, end: getComputedStyle(el).transform };
    });
    expect(motion.start).not.toBe(motion.end);
    for (const selector of [
      ".guardian-head",
      ".guardian-cape",
      ".guardian-light",
      ".guardian-staff",
      ".guardian-stance",
    ])
      expect(await guardian.locator(selector).evaluate((el) => el.getAnimations().length)).toBe(1);
    const poseAt = async (time: number) =>
      guardian.evaluate((el, time) => {
        for (const animation of el.getAnimations({ subtree: true })) {
          if (!(animation instanceof CSSAnimation)) continue;
          animation.pause();
          animation.currentTime = time;
        }
        const tip = el.querySelector<SVGCircleElement>(".guardian-light circle")!;
        const point = new DOMPoint(tip.cx.baseVal.value, tip.cy.baseVal.value).matrixTransform(
          tip.getScreenCTM()!,
        );
        return {
          x: point.x,
          y: point.y,
          arm: getComputedStyle(el.querySelector(".guardian-staff")!).transform,
        };
      }, time);
    const idle = await poseAt(0);
    await page.screenshot({ path: test.info().outputPath(`guardian-idle-${size.width}.png`) });
    const windup = await poseAt(1040);
    expect(windup.x).toBeGreaterThan(idle.x);
    await page.screenshot({ path: test.info().outputPath(`guardian-windup-${size.width}.png`) });
    const strike = await poseAt(1508);
    expect(idle.x - strike.x).toBeGreaterThan(50);
    expect(strike.y).toBeGreaterThan(idle.y);
    expect(strike.arm).not.toBe(idle.arm);
    await page.screenshot({ path: test.info().outputPath(`guardian-strike-${size.width}.png`) });
    expect((await poseAt(2912)).arm).toBe(idle.arm);
    await expect(page.getByTestId("multiplier")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("free-left")).toBeInViewport({ ratio: 1 });
    expect(await page.locator(".reel-grid").boundingBox()).toEqual(board);
    expect(await page.locator(".console").boundingBox()).toEqual(controls);
    expect(await guardian.locator(".guardian-backdrop").boundingBox()).toEqual(backdrop);
    expect(await page.evaluate(() => document.documentElement.scrollHeight === innerHeight)).toBe(
      true,
    );
    expect(game.accepted()).toBe(0);
    await page.screenshot({ path: test.info().outputPath(`guardian-free-${size.width}.png`) });
  });

test("guardian wakes for a newly awarded series and rests after its completion", async ({
  page,
}) => {
  await mockStorm(page, { fixture: "bonus", bonusCount: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await page.goto("/storm-demo");
  const guardian = page.locator(".guardian-scene");
  await expect(guardian).toHaveClass(/is-ready/);
  await expect(guardian).toHaveCSS("opacity", "0");
  await expect(guardian.locator(".guardian-motion")).toHaveCSS("animation-name", "none");
  await expect(guardian.locator(".guardian-staff")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "開始探索", exact: true }).click();
  for (let i = 0; i < 250 && !(await guardian.getAttribute("class"))!.includes("is-awake"); i++)
    await page.clock.runFor(50);
  await expect(guardian).toHaveClass(/is-awake/);

  await mockStorm(page, { freeLeft: 1, fixture: "lose" });
  await page.goto("/storm-demo");
  await expect(guardian).toHaveClass(/is-awake/);
  await page.getByRole("button", { name: "開始免費回合", exact: true }).click();
  const outro = page.getByRole("dialog", { name: "免費回合完成", exact: true });
  for (let i = 0; i < 160 && !(await outro.isVisible()); i++) await page.clock.runFor(50);
  await expect(outro).toBeVisible();
  await expect(guardian).toHaveClass(/is-awake/);
  await outro.getByRole("button", { name: "返回神殿" }).click();
  await expect(guardian).not.toHaveClass(/is-awake/);
  await expect(guardian.locator(".guardian-motion")).toHaveCSS("animation-name", "none");
  await expect(guardian.locator(".guardian-staff")).toHaveCSS("animation-name", "none");
});

test("reduced motion and mobile landscape pause the decorative animation", async ({ page }) => {
  await emulateMobileOrientation(page);
  await mockStorm(page, { freeLeft: 15 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/storm-demo");
  const guardian = page.locator(".guardian-scene");
  await expect(guardian).toHaveCSS("opacity", "1");
  expect(await guardian.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(guardian.locator(".guardian-motion")).toHaveCSS("animation-play-state", "running");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("dialog", { name: "請將裝置轉為直向遊玩" })).toBeVisible();
  await expect(guardian.locator(".guardian-motion")).toHaveCSS("animation-play-state", "paused");
  await expect(guardian.locator(".guardian-staff")).toHaveCSS("animation-play-state", "paused");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guardian.locator(".guardian-motion")).toHaveCSS("animation-play-state", "running");
});

for (const asset of ["storm-guardian.webp", "storm-guardian-body.webp"])
  test(`missing ${asset} retains the original guardian and playable free controls`, async ({
    page,
  }) => {
    await mockStorm(page, { freeLeft: 15 });
    await page.route(`**/${asset}`, (route) => route.abort());
    await page.goto("/storm-demo");
    await expect(page.locator(".guardian-scene")).toHaveCSS("opacity", "0");
    await expect(page.locator(".portrait-guardian")).toBeVisible();
    await expect(page.getByRole("button", { name: "開始免費回合", exact: true })).toBeEnabled();
  });
