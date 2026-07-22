import { expect, test } from "@playwright/test";

test("player can place and directly repeat a bet, receive settlement, and find it in history", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("帳號").fill("player1");
  await page.getByLabel("密碼").fill("LuckyShoes!2026");
  await page.getByRole("button", { name: "登入", exact: true }).click();

  await expect(page).toHaveURL(/\/lobby$/);
  await expect(page.getByRole("heading", { name: "遊戲大廳" })).toBeVisible();
  await page.locator(".table-card", { hasText: "A01" }).click();

  await expect(page).toHaveURL(/\/game\//);
  await expect(page.getByRole("heading", { name: "極速廳 A01" })).toBeVisible();
  await expect
    .poll(async () => Number(await page.locator(".alarm-count").textContent()), {
      timeout: 40_000,
      message: "wait for an open round with enough time to submit a bet",
    })
    .toBeGreaterThan(5);

  await page.getByRole("button", { name: "選擇 100 籌碼" }).click();
  const playerBetButton = page.getByRole("button", { name: /^閒，賠率/ });
  const playerBetAmount = playerBetButton.locator(".bet-cell-amount");
  const betRowHeightsBefore = await page
    .locator(".bet-row")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  await playerBetButton.click();
  const betRowHeightsAfter = await page
    .locator(".bet-row")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(betRowHeightsAfter).toEqual(betRowHeightsBefore);
  const betResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /\/game\/tables\/[^/]+\/bet$/.test(response.url()),
  );
  await page.getByRole("button", { name: "確認下注" }).click();
  const betResponse = await betResponsePromise;
  expect(betResponse.status()).toBe(200);
  const betPayload = (await betResponse.json()) as { round: { id: string } };

  await playerBetButton.click();
  await expect(playerBetAmount).toHaveText("200");
  await expect(page.getByRole("button", { name: "確認下注" })).toBeVisible();

  await expect(page.locator(".felt-cards")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "確認下注" })).toHaveCount(0);
  await expect(playerBetAmount).toHaveText("100");

  const settlement = page.getByRole("dialog", { name: "本局結算" });
  await expect(settlement).toBeVisible({ timeout: 45_000 });
  await expect(playerBetAmount).toHaveText("");
  await settlement.getByRole("button", { name: "關閉本局結算" }).click();

  const rebetButton = page.getByRole("button", { name: "重複上次投注" });
  await expect(rebetButton).toBeEnabled({ timeout: 30_000 });
  const repeatedBetResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /\/game\/tables\/[^/]+\/bet$/.test(response.url()),
  );
  await rebetButton.click();
  const repeatedBetResponse = await repeatedBetResponsePromise;
  expect(repeatedBetResponse.status()).toBe(200);
  expect(repeatedBetResponse.request().postDataJSON()).toEqual({
    bets: [{ betType: "PLAYER", amount: 100 }],
  });
  await expect(page.getByRole("button", { name: "確認下注" })).toHaveCount(0);

  await page.getByRole("button", { name: /^玩家餘額 .+，點擊查看下注紀錄$/ }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole("heading", { name: "投注紀錄" })).toBeVisible();
  const historyCard = page.locator(".history-card", {
    hasText: betPayload.round.id.slice(0, 8).toUpperCase(),
  });
  await expect(historyCard).toBeVisible();
  await expect(
    historyCard.locator(".stake-chip", { hasText: "閒" }).getByText("100", { exact: true }),
  ).toBeVisible();
});
