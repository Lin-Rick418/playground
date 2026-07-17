import { expect, test } from "@playwright/test";

test("player can log in, place a bet, receive settlement, and find it in history", async ({ page }) => {
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
    .poll(
      async () => Number(await page.locator(".alarm-count").textContent()),
      { timeout: 40_000, message: "wait for an open round with enough time to submit a bet" },
    )
    .toBeGreaterThan(5);

  await page.getByRole("button", { name: "選擇 100 籌碼" }).click();
  await page.getByRole("button", { name: /^閒，賠率/ }).click();
  const betResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && /\/game\/tables\/[^/]+\/bet$/.test(response.url()),
  );
  await page.getByRole("button", { name: "確認下注" }).click();
  const betResponse = await betResponsePromise;
  expect(betResponse.status()).toBe(200);
  const betPayload = (await betResponse.json()) as { round: { id: string } };

  const settlement = page.getByRole("dialog", { name: "本局結算" });
  await expect(settlement).toBeVisible({ timeout: 45_000 });
  await settlement.getByRole("button", { name: "關閉本局結算" }).click();
  await page.getByRole("button", { name: "返回大廳" }).click();

  await expect(page).toHaveURL(/\/lobby$/);
  await page.getByRole("button", { name: "下注紀錄" }).click();
  const history = page.getByRole("dialog", { name: "下注紀錄" });
  await expect(history).toBeVisible();
  await expect(history.getByText(betPayload.round.id.slice(0, 8))).toBeVisible();
  await expect(history.getByText(/閒 100/)).toBeVisible();
});
