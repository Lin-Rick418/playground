import { expect, test } from "@playwright/test";
import { Pool } from "pg";

test("Mines persists fractional cashout and restores the real board across reload", async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    !/^baccarat_e2e(?:_[a-z0-9_]+)?$/.test(new URL(databaseUrl).pathname.slice(1))
  ) {
    throw new Error("Mines E2E requires an isolated baccarat_e2e database");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await page.goto("/login");
    await page.getByLabel("帳號").fill("player1");
    await page.getByLabel("密碼").fill("LuckyShoes!2026");
    await page.getByRole("button", { name: "登入", exact: true }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await page.getByRole("button", { name: /Mines/ }).click();
    await expect(page.getByRole("heading", { name: "Mines", exact: true })).toBeVisible();
    await page.getByLabel("投注額").selectOption("100");
    await page.getByLabel("地雷數").selectOption("3");
    const startedResponse = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/mines/rounds"),
    );
    await page.getByRole("button", { name: "開始遊戲", exact: true }).click();
    const started = (await (await startedResponse).json()) as {
      round: { id: string; mineCells: null };
      balance: number;
    };
    expect(started.round.mineCells).toBeNull();
    // The test harness reads only its isolated database; the production API never exposes active mines.
    const board = (
      await pool.query<{ mine_cells: number[] }>(
        "SELECT mine_cells FROM mines_rounds WHERE id=$1",
        [started.round.id],
      )
    ).rows[0].mine_cells;
    const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !board.includes(i))!;
    await page.getByRole("button", { name: `翻開第 ${safe + 1} 格`, exact: true }).click();
    await expect(page.getByRole("button", { name: "安全格", exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "安全格", exact: true })).toHaveCount(1);
    const paidResponse = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/cashout"),
    );
    await page.getByRole("button", { name: "收款 107", exact: true }).click();
    const paid = (await (await paidResponse).json()) as {
      round: { payout: number };
      balance: number;
    };
    expect(paid.round.payout).toBe(107.95);
    const balance = (Math.round(started.balance * 100) + 10795) / 100;
    expect(paid.balance).toBe(balance);
    await expect(page.locator(".mines-wallet strong")).toHaveText(
      `$${Math.trunc(balance).toLocaleString("zh-TW")}`,
    );
    await page.screenshot({ path: test.info().outputPath("mines-settled.png"), fullPage: true });
    await page.getByRole("button", { name: "返回遊戲選擇" }).click();
    await expect(page.locator(".wallet strong")).toHaveText(
      `$${Math.trunc(balance).toLocaleString("zh-TW")}`,
    );
    await page.getByRole("button", { name: /百家樂/ }).click();
    await expect(page).toHaveURL(/\/baccarat$/);
    const reconciliation = await pool.query<{ is_reconciled: boolean; current_balance: string }>(
      "SELECT r.* FROM financial_balance_reconciliation r JOIN users u ON u.id=r.user_id WHERE u.username='player1'",
    );
    expect(reconciliation.rows[0].is_reconciled).toBe(true);
    expect(Number(reconciliation.rows[0].current_balance)).toBe(balance);
  } finally {
    await pool.end();
  }
});
