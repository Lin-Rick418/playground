import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import type { PlinkoMutationResponse } from "@baccarat/contracts";

test("Plinko real WebSocket settles once, persists history and keeps exact wallet cents", async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    !/^baccarat_e2e(?:_[a-z0-9_]+)?$/.test(new URL(databaseUrl).pathname.slice(1))
  )
    throw new Error("Plinko E2E requires an isolated baccarat_e2e database");
  const results: PlinkoMutationResponse[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "plinko_result" && message.result.ok) results.push(message.result.data);
    }),
  );
  page.on("request", (request) =>
    expect(request.method() === "POST" && request.url().includes("/plinko/rounds")).toBe(false),
  );
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await page.setViewportSize({ width: 1360, height: 960 });
    await page.goto("/login");
    await page.getByLabel("帳號").fill("player1");
    await page.getByLabel("密碼").fill("LuckyShoes!2026");
    await page.getByRole("button", { name: "登入", exact: true }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await page.getByRole("button", { name: "進入Plinko", exact: true }).click();
    await expect(page).toHaveURL(/\/plinko$/);
    await expect(page.getByRole("button", { name: "投球", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: /投注設定/ }).click();
    await page.getByRole("button", { name: "高風險", exact: true }).click();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    const controlBox = await page.locator(".plinko-toolbar").boundingBox();
    const boardBox = await page.locator(".plinko-board-panel").boundingBox();
    expect(controlBox!.y).toBeLessThan(boardBox!.y);
    expect(boardBox!.width).toBeGreaterThan(430);
    await page.getByRole("button", { name: "投球", exact: true }).click();
    await expect.poll(() => results.length).toBe(1);
    const result = results[0]!;
    expect(result.round.path).toHaveLength(16);
    expect(result.round.path.reduce<number>((sum, direction) => sum + direction, 0)).toBe(
      result.round.slotIndex,
    );
    await expect(page.locator(".plinko-ball.settled")).toHaveCount(1);
    await page.getByRole("button", { name: /投注設定/ }).click();
    await expect(page.getByLabel("排數", { exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    const expectedX = 9 + (result.round.slotIndex * 82) / 16;
    const ballTransform = await page.locator(".plinko-ball").getAttribute("transform");
    expect(ballTransform).toContain(`translate(${expectedX} `);
    const saved = (await pool.query("SELECT * FROM plinko_rounds WHERE id=$1", [result.round.id]))
      .rows[0];
    expect(saved.path).toEqual(result.round.path);
    expect(Number(saved.payout)).toBe(result.round.payout);
    expect(Number(saved.multiplier_units) / 10000).toBe(result.round.multiplier);
    const ledger = (
      await pool.query(
        "SELECT source FROM financial_ledger_entries WHERE reference_id=$1 ORDER BY entry_sequence",
        [result.round.id],
      )
    ).rows;
    expect(ledger.map((row) => row.source)).toEqual([
      "PLINKO_BET_DEBIT",
      "PLINKO_SETTLEMENT_CREDIT",
    ]);
    const beforeReload = result.balance;
    await page.screenshot({ path: test.info().outputPath("plinko-desktop.png"), fullPage: true });
    await page.reload();
    await expect(page.locator(".plinko-wallet strong")).toHaveText(
      `$${Math.trunc(beforeReload).toLocaleString("zh-TW")}`,
    );
    await expect(page.getByRole("button", { name: "紀錄", exact: true })).toHaveCount(0);
    await expect(page.locator(".recent-results li").first()).toHaveText(
      result.round.multiplier.toFixed(2) + "×",
    );
    const reconciliation = (
      await pool.query("SELECT * FROM financial_balance_reconciliation WHERE user_id=$1", [
        saved.user_id,
      ])
    ).rows[0];
    expect(reconciliation.is_reconciled).toBe(true);
    expect(Number(reconciliation.current_balance)).toBe(beforeReload);
    await page.goto("/plinko");
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("button", { name: "投球", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("plinko-mobile.png"), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await pool.end();
  }
});

test("Plinko recovers a committed but lost response with the same key after reload", async ({
  page,
}) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    !/^baccarat_e2e(?:_[a-z0-9_]+)?$/.test(new URL(databaseUrl).pathname.slice(1))
  )
    throw new Error("Plinko E2E requires an isolated baccarat_e2e database");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    let committed: PlinkoMutationResponse | undefined;
    const keys: string[] = [];
    let requests = 0;
    await page.routeWebSocket("**/api/ws", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "plinko_command") {
          keys.push(message.idempotencyKey);
          requests++;
        }
        server.send(raw);
      });
      server.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "plinko_result" && message.result.ok && !committed) {
          committed = message.result.data;
          // Simulate a lost response without a close notification. Reload before
          // the response timeout to exercise persisted recovery on the next page.
          return;
        }
        socket.send(raw);
      });
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/login");
    await page.getByLabel("帳號").fill("player1");
    await page.getByLabel("密碼").fill("LuckyShoes!2026");
    await page.getByRole("button", { name: "登入", exact: true }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await page.goto("/plinko");
    await expect(page.getByRole("button", { name: "投球", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: /投注設定/ }).click();
    await page.getByLabel("排數", { exact: true }).selectOption("8");
    await page.getByRole("button", { name: "低風險", exact: true }).click();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "投球", exact: true }).click();
    await expect.poll(() => Boolean(committed)).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "確認上一筆投注", exact: true })).toBeEnabled();
    expect(requests).toBe(1); // Reload must not automatically transmit a new wager.
    await expect(page.getByRole("button", { name: "投球", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "確認上一筆投注", exact: true }).click();
    await expect(page.getByRole("button", { name: "確認上一筆投注", exact: true })).toHaveCount(0);
    expect(keys).toEqual([keys[0], keys[0]]);
    await page.getByRole("button", { name: /投注設定/ }).click();
    await expect(page.getByLabel("排數", { exact: true })).toHaveValue("8");
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator(".plinko-wallet strong")).toHaveText(
      `$${Math.trunc(committed!.balance).toLocaleString("zh-TW")}`,
    );
    const entries = (
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM financial_ledger_entries WHERE reference_id=$1",
        [committed!.round.id],
      )
    ).rows[0];
    expect(entries.count).toBe(2);
    const reconciliation = (
      await pool.query(
        "SELECT r.* FROM financial_balance_reconciliation r JOIN users u ON u.id=r.user_id WHERE u.username='player1'",
      )
    ).rows[0];
    expect(reconciliation.is_reconciled).toBe(true);
    expect(Number(reconciliation.current_balance)).toBe(committed!.balance);
  } finally {
    await pool.end();
  }
});
