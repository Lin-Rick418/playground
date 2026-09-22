import { expect, test, type Locator } from "@playwright/test";

test("lobby centers game covers, switches horizontally and opens the selected game", async ({
  page,
}) => {
  const user = {
    id: "lobby-preview",
    username: "player",
    role: "PLAYER",
    isActive: true,
    balance: 97072,
    walletVersion: 1,
  };
  await page.routeWebSocket("**/api/ws", (socket) => socket.close());
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/refresh")
      return route.fulfill({
        json: {
          token: "preview",
          user,
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
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
          rtp: null,
          ruleVersion: 2,
          maxMultiplier: 1000,
          enabled: true,
        },
      });
    if (path === "/api/mines/active") return route.fulfill({ json: { round: null } });
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "preview", requestId: "preview" },
    });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/lobby");
  const baccarat = page.getByRole("button", { name: "進入百家樂", exact: true });
  const mines = page.getByRole("button", { name: "進入Mines", exact: true });
  await expect(baccarat).toHaveClass(/active/);
  await expect(page.getByText(/餘額|97,072/)).toHaveCount(0);
  for (const width of [320, 375, 430, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    await expect
      .poll(async () => {
        const track = await page.locator(".game-carousel").boundingBox();
        const card = await baccarat.boundingBox();
        return Math.abs(card!.x + card!.width / 2 - track!.x - track!.width / 2);
      })
      .toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const images = page.locator(".game-poster img");
  await expect(images).toHaveCount(5);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute("src", /\.(webp|svg)$/);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
  }
  await page.getByRole("button", { name: "下一個遊戲" }).click();
  await expect(mines).toHaveClass(/active/);
  await page.getByRole("button", { name: "上一個遊戲" }).click();
  await expect(baccarat).toHaveClass(/active/);
  await page.locator(".game-carousel").hover();
  await page.mouse.wheel(450, 0);
  await expect(mines).toHaveClass(/active/);
  await mines.focus();
  await mines.press("ArrowLeft");
  await expect(baccarat).toBeFocused();
  await expect(baccarat).toHaveClass(/active/);
  await baccarat.press("ArrowRight");
  await expect(mines).toBeFocused();
  await expect(mines).toHaveClass(/active/);
  const waitForCenteredCover = async (cover: Locator) => {
    await expect
      .poll(async () => {
        const track = await page.locator(".game-carousel").boundingBox();
        const card = await cover.boundingBox();
        return Math.abs(card!.x + card!.width / 2 - track!.x - track!.width / 2);
      })
      .toBeLessThan(2);
  };
  await page.setViewportSize({ width: 483, height: 771 });
  await page.getByRole("button", { name: "下一個遊戲" }).click();
  const plinko = page.getByRole("button", { name: "進入Plinko", exact: true });
  await expect(plinko).toHaveClass(/active/);
  await expect(plinko.locator(".poster-copy")).toHaveText("PLINKO落球進入遊戲 ↗");
  for (const selector of [".poster-eyebrow", ".poster-title"]) {
    const reference = await baccarat.locator(selector).evaluate((el) => ({
      fontSize: getComputedStyle(el).fontSize,
      margin: getComputedStyle(el).margin,
    }));
    await expect(plinko.locator(selector)).toHaveCSS("font-size", reference.fontSize);
    await expect(plinko.locator(selector)).toHaveCSS("margin", reference.margin);
  }
  await expect(plinko.locator("img")).toHaveAttribute("src", "/images/games/plinko-simple.webp");
  await waitForCenteredCover(plinko);
  await page.screenshot({ path: test.info().outputPath("plinko-lobby.png") });
  await page.getByRole("button", { name: "上一個遊戲" }).click();
  await expect(mines).toHaveClass(/active/);
  await expect(mines.locator(".poster-eyebrow")).toHaveText("MINES");
  await expect(mines.locator(".poster-title")).toHaveText("掃雷");
  await waitForCenteredCover(mines);
  await page.screenshot({ path: test.info().outputPath("mines-lobby.png") });
  await page.getByRole("button", { name: "第 4 張遊戲圖片" }).click();
  const hilo = page.getByRole("button", { name: "進入Hi-Lo", exact: true });
  await expect(hilo).toHaveClass(/active/);
  await expect(hilo.locator("img")).toHaveAttribute("src", "/images/games/hilo-simple.webp");
  await expect(hilo.locator(".poster-eyebrow")).toHaveText("HI-LO");
  await expect(hilo.locator(".poster-title")).toHaveText("高低起伏");
  await waitForCenteredCover(hilo);
  await page.screenshot({ path: test.info().outputPath("hilo-lobby.png") });
  await page.getByRole("button", { name: "第 5 張遊戲圖片" }).click();
  const blackjack = page.getByRole("button", { name: "進入Blackjack", exact: true });
  await expect(blackjack).toHaveClass(/active/);
  await expect(blackjack.locator("img")).toHaveAttribute(
    "src",
    "/images/games/blackjack-simple.webp",
  );
  await expect(blackjack.locator(".poster-title")).toHaveText("21 點");
  await waitForCenteredCover(blackjack);
  await expect(blackjack.locator("img")).toHaveJSProperty("naturalWidth", 800);
  await page.screenshot({ path: test.info().outputPath("blackjack-lobby.png") });
  await page.getByRole("button", { name: "第 2 張遊戲圖片" }).click();
  await expect(mines).toHaveClass(/active/);
  await mines.press("Enter");
  await expect(page).toHaveURL(/\/mines$/);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgba(128, 128, 128, 0.35)");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(23, 27, 35)");
  await page.screenshot({ path: test.info().outputPath("mines-background.png") });
  await page.getByRole("button", { name: "返回遊戲選擇" }).click();
  await baccarat.click();
  await expect(page).toHaveURL(/\/baccarat$/);
});
