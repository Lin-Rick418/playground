import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  type BlackjackCommand,
  type BlackjackMutationResponse,
  type BlackjackRound,
} from "@baccarat/contracts";
import type { BlackjackState } from "../apps/server/src/modules/blackjack/math";

const user = {
  id: "blackjack-player",
  username: "player",
  role: "PLAYER",
  isActive: true,
  balance: 10000,
  walletVersion: 1,
};
const config = {
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  decks: 6,
  maxHands: 4,
  ruleVersion: 1,
  enabled: true,
  rtp: null,
};
const now = "2026-09-16T10:00:00.000Z";
function shoe(ranks: number[]) {
  const remaining = Array.from({ length: 312 }, (_, i) => i);
  return [
    ...ranks.map(
      (rank) =>
        remaining.splice(
          remaining.findIndex((card) => Math.floor((card % 52) / 4) + 1 === rank),
          1,
        )[0],
    ),
    ...remaining,
  ];
}
async function mockGame(
  page: Page,
  options: { ranks?: number[]; dropStart?: boolean; delay?: boolean; balance?: number } = {},
) {
  const { blackjackCommandSchema } = await import("@baccarat/contracts");
  const { activeHand, additionalStake, allowedActions, payout, play, startRound, total, totalBet } =
    await import("../apps/server/src/modules/blackjack/math.ts");
  let state: BlackjackState | null = null,
    id = randomUUID(),
    version = 0;
  let balance = options.balance ?? 10000,
    walletVersion = 1,
    acceptedStarts = 0;
  let release: (() => void) | undefined;
  const commands: BlackjackCommand[] = [],
    replays = new Map<string, BlackjackMutationResponse>();
  function snapshot(): BlackjackRound | null {
    if (!state) return null;
    const hidden = state.phase !== "SETTLED";
    return {
      id,
      amount: 100,
      totalBet: totalBet(state),
      payout: payout(state),
      status: hidden ? "ACTIVE" : "SETTLED",
      phase: state.phase,
      dealerCards: hidden ? state.dealer.slice(0, 1) : [...state.dealer],
      dealerTotal: hidden ? null : total(state.dealer).total,
      dealerSoft: hidden ? null : total(state.dealer).soft,
      dealerHidden: hidden,
      hands: structuredClone(state.hands),
      activeHandId: activeHand(state)?.id ?? null,
      insurance: { ...state.insurance },
      allowedActions: allowedActions(state),
      version,
      ruleVersion: 1,
      createdAt: now,
      settledAt: hidden ? null : now,
    };
  }
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const currentUser = { ...user, balance, walletVersion };
    if (path === "/api/auth/refresh")
      return route.fulfill({
        json: {
          token: "token",
          user: currentUser,
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === "/api/auth/me") return route.fulfill({ json: currentUser });
    if (path === "/api/blackjack/config") return route.fulfill({ json: config });
    if (path === "/api/blackjack/state")
      return route.fulfill({ json: { round: state?.phase === "SETTLED" ? null : snapshot() } });
    if (path.startsWith("/api/blackjack/rounds/"))
      return route.fulfill({ json: { round: snapshot() } });
    if (path === "/api/blackjack/history")
      return route.fulfill({
        json: { items: state?.phase === "SETTLED" ? [snapshot()] : [], nextCursor: null },
      });
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Missing mock", requestId: randomUUID() },
    });
  });
  await page.routeWebSocket("**/api/ws", (socket) =>
    socket.onMessage((raw) => {
      const input = JSON.parse(String(raw));
      if (input.type !== "blackjack_command") return;
      const command = blackjackCommandSchema.parse(input);
      commands.push(command);
      let data = replays.get(command.idempotencyKey);
      if (!data) {
        const action = command.action;
        if (action.kind !== "start") {
          expect(action.roundId).toBe(id);
          expect(action.expectedVersion).toBe(version);
          if ("handId" in action) expect(action.handId).toBe(activeHand(state!)?.id);
        }
        const debit = action.kind === "start" ? action.amount : additionalStake(state!, action);
        if (debit > balance) {
          socket.send(
            JSON.stringify({
              type: "blackjack_result",
              requestId: command.requestId,
              result: {
                ok: false,
                status: 400,
                error: {
                  code: "VALIDATION_ERROR",
                  message: "餘額不足。",
                  requestId: command.requestId,
                },
              },
            }),
          );
          return;
        }
        if (action.kind === "start") {
          id = randomUUID();
          version = 1;
          acceptedStarts++;
          state = startRound(action.amount, shoe(options.ranks ?? [8, 6, 8, 10, 3, 2, 10, 10, 5]));
        } else {
          play(state!, action);
          version++;
        }
        balance -= debit;
        if (debit) walletVersion++;
        if (state!.phase === "SETTLED") {
          balance += payout(state!);
          walletVersion++;
        }
        data = { round: snapshot()!, balance, walletVersion };
        replays.set(command.idempotencyKey, structuredClone(data));
        if (options.dropStart && action.kind === "start") {
          socket.close({ code: 4000, reason: "Lost response" });
          return;
        }
      }
      const send = () =>
        socket.send(
          JSON.stringify({
            type: "blackjack_result",
            requestId: command.requestId,
            result: { ok: true, data },
          }),
        );
      if (options.delay) release = send;
      else send();
    }),
  );
  return {
    commands,
    snapshot,
    get acceptedStarts() {
      return acceptedStarts;
    },
    release: () => release?.(),
  };
}

test("Blackjack plays insurance, four split hands, double and settlement within phone viewports", async ({
  page,
}) => {
  const mock = await mockGame(page, { ranks: [8, 1, 8, 6, 8, 8, 8, 8, 3, 2, 10] });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect(page.getByText(/是否購買保險？投注 50/)).toBeVisible();
  await expect(page.getByLabel("已開牌點數")).toHaveText("11");
  await page.getByRole("button", { name: "不購買", exact: true }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "分牌", exact: true }).click();
  expect(mock.snapshot()!.hands).toHaveLength(4);
  await expect(page.locator('.player-hand[aria-hidden="false"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "分牌", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "加倍", exact: true }).click();
  await expect(page.locator('.player-hand[aria-hidden="false"]')).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 483, height: 771 },
  ]) {
    await page.setViewportSize(viewport);
    const active = page.locator('.player-hand.active[aria-hidden="false"]');
    await expect(active).toBeVisible();
    await expect(active.locator("header")).toHaveText(String(mock.snapshot()!.hands[1].total));
    await expect(active.locator("footer")).toHaveCount(0);
    const handBox = await active.boundingBox();
    const pointsBox = await active.locator("header strong").boundingBox();
    expect(
      Math.abs(pointsBox!.x + pointsBox!.width / 2 - (handBox!.x + handBox!.width / 2)),
    ).toBeLessThan(2);
    expect(
      await page.locator(".blackjack-controls, .ui-balance").evaluateAll((nodes) =>
        nodes.every((node) => {
          const box = node.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight + 1;
        }),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`blackjack-four-hands-${viewport.width}x${viewport.height}.png`),
    });
  }
  for (let i = 1; i < 4; i++) {
    const state = mock.snapshot()!;
    expect(state.activeHandId).toBe(state.hands[i].id);
    await expect(page.locator('.player-hand[aria-hidden="false"]')).toHaveCount(1);
    await expect(page.locator('.player-hand[aria-hidden="false"]')).toHaveAttribute(
      "aria-label",
      `玩家牌組 ${i + 1}`,
    );
    await expect(page.locator('.player-hand[aria-hidden="false"] header')).toHaveText(
      String(state.hands[i].total),
    );
    await page.getByRole("button", { name: "停牌", exact: true }).click();
  }
  await expect(page.getByText("本局派彩 400 · 總投注 500")).toBeVisible();
  await expect(page.locator(".ui-balance")).toContainText("9,900");
  await expect(page.getByLabel("莊家暗牌", { exact: true })).toHaveCount(0);
  expect(mock.commands.map((c) => c.action.kind)).toEqual([
    "start",
    "insurance",
    "split",
    "split",
    "split",
    "double",
    "stand",
    "stand",
    "stand",
  ]);
  await expect(page.getByRole("button", { name: /歷史/ })).toHaveCount(0);
  await page.getByRole("button", { name: "遊戲規則", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("遊戲規則");
  await expect(page.getByRole("dialog")).toContainText("原始兩張 Blackjack 賠 3:2");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /下一局/ }).click();
  await expect(page.getByText(/是否購買保險？投注 50/)).toBeVisible();
});

test("Blackjack keeps old cards and legal controls stable during delayed replies and supports reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await mockGame(page, { delay: true });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  await expect(page.locator(".playing-card")).toHaveCount(0);
  mock.release();
  await expect(page.getByRole("button", { name: "要牌", exact: true })).toBeEnabled();
  const cards = await page.locator(".playing-card").count();
  const bounds = await page.locator(".blackjack-controls").boundingBox();
  await page.getByRole("button", { name: "要牌", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(2);
  await expect(page.getByRole("button", { name: "要牌中…", exact: true })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toHaveCSS("opacity", "1");
  expect(await page.locator(".playing-card").count()).toBe(cards);
  expect(await page.locator(".blackjack-controls").boundingBox()).toEqual(bounds);
  mock.release();
  await expect(page.locator(".playing-card")).toHaveCount(cards + 1);
  await expect(page.locator(".playing-card").first()).toHaveCSS("animation-name", "none");
});

test("Blackjack reconnects and replays a lost start reply using the same key and a new requestId", async ({
  page,
}) => {
  const mock = await mockGame(page, { dropStart: true });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect(page.getByRole("button", { name: "要牌", exact: true })).toBeEnabled();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[0].idempotencyKey).toBe(mock.commands[1].idempotencyKey);
  expect(mock.commands[0].requestId).not.toBe(mock.commands[1].requestId);
  expect(mock.commands[0].action).toEqual(mock.commands[1].action);
  expect(mock.acceptedStarts).toBe(1);
  await expect(page.locator(".ui-balance")).toContainText("9,900");
  await expect(page.locator(".playing-card.reveal")).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("blackjack.pending.blackjack-player")),
  ).toBeNull();
  await page.reload();
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  expect(mock.commands.length).toBe(2);
});

test("Blackjack rejects unaffordable additional bets and lets the existing hand continue", async ({
  page,
}) => {
  const mock = await mockGame(page, { balance: 100 });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await page.getByRole("button", { name: "分牌", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("餘額不足。");
  expect(mock.snapshot()?.version).toBe(1);
  expect(mock.snapshot()?.totalBet).toBe(100);
  await expect(page.locator('.player-hand[aria-hidden="false"]')).toHaveCount(1);
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
});

test("Blackjack centers the dealer and reveals each draw only after the server reply", async ({
  page,
}) => {
  const mock = await mockGame(page, { ranks: [10, 2, 8, 3, 4, 5, 6], delay: true });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  mock.release();
  const stand = page.getByRole("button", { name: "停牌", exact: true });
  await expect(stand).toBeEnabled();
  const dealer = page.getByRole("region", { name: "莊家手牌" });
  await expect(page.getByText("BLACKJACK · 21", { exact: true })).toHaveCount(0);
  await expect(dealer.getByText("莊家", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("已開牌點數")).toHaveText("2");
  async function expectCentered() {
    // CSS transitions use the browser animation clock, independently of mocked JS timers.
    await expect
      .poll(() =>
        dealer.locator(".cards").evaluate((row) => {
          const slots = row.querySelectorAll(".dealer-slot");
          const first = slots[0]!.getBoundingClientRect();
          const last = slots[slots.length - 1]!.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return Math.abs((first.left + last.right) / 2 - (bounds.left + bounds.width / 2));
        }),
      )
      .toBeLessThan(1);
    const bounds = await dealer.locator(".cards").boundingBox();
    const cards = dealer.locator(".playing-card:visible");
    const first = await cards.first().boundingBox();
    const last = await cards.last().boundingBox();
    const points = await page.getByLabel("已開牌點數").boundingBox();
    expect(Math.abs(points!.x + points!.width / 2 - (bounds!.x + bounds!.width / 2))).toBeLessThan(
      2,
    );
    expect(points!.y).toBeGreaterThan(first!.y + first!.height);
    expect(first!.width).toBeGreaterThanOrEqual(52);
    expect(first!.height).toBeGreaterThan(72);
    expect(
      Math.abs((first!.x + last!.x + last!.width) / 2 - (bounds!.x + bounds!.width / 2)),
    ).toBeLessThan(2);
    const hand = page.locator('.player-hand[aria-hidden="false"]');
    await expect(hand.locator("header")).toHaveText("18");
    await expect(hand.locator("footer")).toHaveCount(0);
    const playerPoints = await hand.locator("header strong").boundingBox();
    const playerFirst = await hand.locator(".playing-card").first().boundingBox();
    const playerLast = await hand.locator(".playing-card").last().boundingBox();
    const tableCenter = bounds!.x + bounds!.width / 2;
    expect(Math.abs(playerPoints!.x + playerPoints!.width / 2 - tableCenter)).toBeLessThan(2);
    expect(
      Math.abs((playerFirst!.x + playerLast!.x + playerLast!.width) / 2 - tableCenter),
    ).toBeLessThan(2);
    expect(playerPoints!.y + playerPoints!.height).toBeLessThan(playerFirst!.y);
    expect(playerPoints!.y).toBeGreaterThan(points!.y + points!.height);
    expect(playerFirst!.width).toBe(first!.width);
    expect(playerFirst!.height).toBe(first!.height);
  }
  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 483, height: 771 },
  ]) {
    await page.setViewportSize(size);
    await expectCentered();
  }
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const controls = await page.locator(".blackjack-controls").boundingBox();
  const spread = () =>
    dealer.locator(".dealer-slot").evaluateAll((nodes) => {
      const first = nodes[0] as HTMLElement;
      const last = nodes[nodes.length - 1] as HTMLElement;
      return {
        left: first.offsetLeft,
        width: last.offsetLeft + last.offsetWidth - first.offsetLeft,
      };
    });
  let previousSpread = await spread();
  await stand.click();
  await expect.poll(() => mock.commands.length).toBe(2);
  await expect(dealer.locator(".playing-card:visible")).toHaveCount(2);
  await expect(page.getByLabel("莊家暗牌", { exact: true })).toBeVisible();
  await expect(dealer.locator(".hole-flip")).toHaveCount(0);
  await expect(page.getByLabel("已開牌點數")).toHaveText("2");
  mock.release();
  await expect(dealer.locator(".hole-flip")).toHaveCSS("animation-name", /^hole-flip/);
  await expect(dealer.locator(".playing-card:visible")).toHaveCount(2);
  await expect(page.locator(".settlement")).toHaveCount(0);
  await expect(page.getByLabel("已開牌點數")).toHaveText("5");
  await expect(dealer.locator(".dealer-slot")).toHaveCount(2);
  expect(await spread()).toEqual(previousSpread);
  for (let count = 3; count <= 5; count++) {
    await page.clock.runFor(480);
    await expect(dealer.locator(".dealer-slot")).toHaveCount(count);
    const currentSpread = await spread();
    expect(currentSpread.width).toBeGreaterThan(previousSpread.width);
    expect(currentSpread.left).toBeLessThan(previousSpread.left);
    expect(
      Math.abs(
        currentSpread.left +
          currentSpread.width / 2 -
          (previousSpread.left + previousSpread.width / 2),
      ),
    ).toBeLessThan(2);
    previousSpread = currentSpread;
    await expect(dealer.locator(".playing-card:visible")).toHaveCount(count);
    await expect(page.getByLabel("已開牌點數")).toHaveText(String([9, 14, 20][count - 3]));
    await expect(dealer.locator(".playing-card").nth(count - 1)).toHaveCSS(
      "animation-name",
      /^deal/,
    );
    await expect(stand).toBeDisabled();
    await expect(page.locator(".settlement")).toHaveCount(0);
    expect(await page.locator(".blackjack-controls").boundingBox()).toEqual(controls);
  }
  await page.clock.runFor(480);
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
  await expectCentered();
  await expect(dealer.locator(".seat-label strong")).toHaveText("20");
  await expect(page.locator(".settlement")).toBeVisible();
  await expect(dealer.locator(".reveal, .hole-flip")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("blackjack-dealer-centered.png") });
});

for (const dealerCard of [6, 9]) {
  test(`Blackjack displays only the dealer's chosen total for A plus ${dealerCard}`, async ({
    page,
  }) => {
    const mock = await mockGame(page, { ranks: [1, 1, 9, dealerCard] });
    await page.goto("/blackjack");
    await page.getByRole("button", { name: /開始下注/ }).click();
    const dealer = page.getByLabel("已開牌點數");
    const player = page.locator('.player-hand[aria-hidden="false"] header');
    await expect(dealer).toHaveText("11");
    await expect(player).toHaveText("10/20");
    await page.getByRole("button", { name: "不購買", exact: true }).click();
    await expect(dealer).toHaveText("11");
    await expect(page.getByLabel("莊家暗牌", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "停牌", exact: true }).click();
    await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
    await expect(dealer).toHaveText(String(11 + dealerCard));
    await expect(player).toHaveText("10/20");
    expect(mock.snapshot()!.dealerTotal).toBe(11 + dealerCard);
    expect(mock.snapshot()!.dealerCards).toHaveLength(2);
  });
}

test("Blackjack finishes dealer animation when reduced motion is enabled mid-deal", async ({
  page,
}) => {
  await mockGame(page, { ranks: [10, 1, 8, 1, 12, 5] });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect(page.getByLabel("已開牌點數")).toHaveText("11");
  await page.getByRole("button", { name: "不購買", exact: true }).click();
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect(page.locator(".hole-flip")).toHaveCount(1);
  await expect(page.getByLabel("已開牌點數")).toHaveText("12");
  await page.clock.runFor(480);
  await expect(page.getByLabel("已開牌點數")).toHaveText("12");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".dealer-cards .playing-card:visible")).toHaveCount(4);
  await expect(page.getByLabel("已開牌點數")).toHaveText("17");
  await expect(page.locator(".ui-balance strong")).toHaveText("$10,100");
  await expect(page.locator(".ui-balance strong")).not.toHaveClass(/rolling/);
  await expect(page.locator(".reveal, .hole-flip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
  await page.clock.runFor(2500);
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
});

for (const scenario of [
  { name: "one ace", ranks: [1, 10, 6, 7, 10], scores: ["7/17", "17"], dealer: "17" },
  {
    name: "multiple aces",
    ranks: [1, 6, 1, 10, 4, 10, 5],
    scores: ["2/12", "6/16", "16"],
    dealer: "21",
  },
  {
    name: "aces after several draws",
    ranks: [4, 8, 1, 3, 3, 6, 3, 1, 2, 4],
    scores: ["5/15", "8/18", "14", "17"],
    dealer: "18",
  },
]) {
  test(`Blackjack lists playable point options for ${scenario.name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 568 });
    const mock = await mockGame(page, { ranks: scenario.ranks });
    await page.goto("/blackjack");
    await page.getByRole("button", { name: /開始下注/ }).click();
    const points = page.locator('.player-hand[aria-hidden="false"] header');
    await expect(points).toHaveText(scenario.scores[0]);
    for (const score of scenario.scores.slice(1)) {
      await page.getByRole("button", { name: "要牌", exact: true }).click();
      await expect(points).toHaveText(score);
    }
    // The displayed alternatives never replace the server's actual playable total.
    expect(mock.snapshot()!.status).toBe("ACTIVE");
    await page.getByRole("button", { name: "停牌", exact: true }).click();
    await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
    await expect(points).toHaveText(scenario.scores.at(-1)!);
    await expect(page.getByLabel("已開牌點數")).toHaveText(scenario.dealer);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("Blackjack still shows the actual total when an ace hand busts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockGame(page, { ranks: [1, 10, 8, 7, 10, 3] });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  const points = page.locator('.player-hand[aria-hidden="false"] header');
  await expect(points).toHaveText("9/19");
  await page.getByRole("button", { name: "要牌", exact: true }).click();
  await expect(points).toHaveText("19");
  await page.getByRole("button", { name: "要牌", exact: true }).click();
  await expect(points).toHaveText("22");
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
});

for (const scenario of [
  { name: "both natural Blackjacks", ranks: [1, 1, 10, 10], insurance: true },
  { name: "both ordinary 21s", ranks: [10, 10, 5, 6, 6, 5], insurance: false },
]) {
  test(`Blackjack labels the returned stake as PUSH for ${scenario.name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const mock = await mockGame(page, { ranks: scenario.ranks });
    await page.goto("/blackjack");
    await page.getByRole("button", { name: /開始下注/ }).click();
    if (scenario.insurance) await page.getByRole("button", { name: "不購買", exact: true }).click();
    else await page.getByRole("button", { name: "要牌", exact: true }).click();
    await expect(page.locator(".push-result")).toHaveText("PUSH · 和局");
    await expect(page.locator(".settlement")).toContainText("本局派彩 100 · 總投注 100");
    await expect(page.locator(".ui-balance strong")).toHaveText("$10,000");
    expect(mock.snapshot()!.hands[0].outcome).toBe("PUSH");
    expect(mock.snapshot()!.dealerTotal).toBe(21);
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 483, height: 771 },
    ]) {
      await page.setViewportSize(viewport);
      const result = (await page.locator(".settlement").boundingBox())!;
      const wallet = (await page.locator(".ui-balance").boundingBox())!;
      expect(result.y + result.height).toBeLessThan(wallet.y);
      expect(wallet.y + wallet.height).toBeLessThanOrEqual(viewport.height);
    }
  });
}

test("Blackjack shows PUSH only for the selected split hand that actually tied", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockGame(page, { ranks: [10, 10, 13, 8, 8, 7] });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await page.getByRole("button", { name: "分牌", exact: true }).click();
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect(page.locator('.player-hand[aria-hidden="false"] header')).toHaveText("17");
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
  await expect(page.locator(".push-result")).toHaveCount(0);
  const controls = await page.locator(".blackjack-controls").boundingBox();
  await page.getByRole("button", { name: "上一副牌" }).click();
  await expect(page.locator(".push-result")).toHaveText("本手 PUSH · 和局");
  await expect(page.locator(".settlement")).toContainText("本局派彩 100 · 總投注 200");
  expect(await page.locator(".blackjack-controls").boundingBox()).toEqual(controls);
  await page.getByRole("button", { name: "下一副牌" }).click();
  await expect(page.locator(".push-result")).toHaveCount(0);
});

test("Blackjack rolls every credited balance after the cards finish and applies debits immediately", async ({
  page,
}) => {
  await mockGame(page, { ranks: [10, 6, 8, 10, 10] });
  await page.goto("/blackjack");
  const wallet = page.locator(".ui-balance strong");
  await expect(wallet).toHaveText("$10,000");
  await expect(wallet).not.toHaveClass(/rolling/);
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect(wallet).toHaveText("$9,900");
  await expect(wallet).not.toHaveClass(/rolling/);
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect(page.locator(".hole-flip")).toHaveCount(1);
  await expect(wallet).toHaveText("$9,900");
  await expect(wallet).not.toHaveClass(/rolling/);
  await page.clock.runFor(960);
  await expect(page.locator(".settlement")).toBeVisible();
  await expect(wallet).toHaveClass(/rolling/);
  await page.clock.runFor(200);
  const intermediate = Number((await wallet.innerText()).replace(/[^\d.]/g, ""));
  expect(intermediate).toBeGreaterThan(9900);
  expect(intermediate).toBeLessThan(10100);
  await page.clock.runFor(650);
  await expect(wallet).toHaveText("$10,100");
  await expect(wallet).not.toHaveClass(/rolling/);
  await page.getByRole("button", { name: /下一局/ }).click();
  await expect(wallet).toHaveText("$10,000");
  await expect(wallet).not.toHaveClass(/rolling/);
  await page.clock.runFor(480);
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect(page.locator(".hole-flip")).toHaveCount(1);
  await page.clock.runFor(960);
  await expect(wallet).toHaveClass(/rolling/);
  await page.clock.runFor(850);
  await expect(wallet).toHaveText("$10,200");
  await expect(wallet).not.toHaveClass(/rolling/);
  await page.reload();
  await expect(wallet).toHaveText("$10,200");
  await expect(wallet).not.toHaveClass(/rolling/);
});

for (const scenario of [
  { action: "停牌", ranks: [10, 7, 11, 10, 7, 1], firstTotal: "17" },
  { action: "加倍", ranks: [10, 6, 13, 10, 6, 1, 5, 10], firstTotal: "16" },
]) {
  test(`Blackjack waits for the first split hand's ${scenario.action} before celebrating the second 21`, async ({
    page,
  }) => {
    const mock = await mockGame(page, { ranks: scenario.ranks, delay: true });
    await page.goto("/blackjack");
    await page.getByRole("button", { name: /開始下注/ }).click();
    await expect.poll(() => mock.commands.length).toBe(1);
    mock.release();
    const split = page.getByRole("button", { name: "分牌", exact: true });
    await expect(split).toBeEnabled();
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await split.click();
    await expect.poll(() => mock.commands.length).toBe(2);
    mock.release();
    const hand = page.locator('.player-hand[aria-hidden="false"]');
    await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
    await expect(hand.locator("header")).toHaveText(scenario.firstTotal);
    await page.clock.runFor(3000);
    await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
    await expect(page.locator(".hand-celebration")).toHaveCount(0);
    if (scenario.action === "停牌") {
      await page.reload();
      await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
      await expect(page.locator(".hand-celebration")).toHaveCount(0);
    }
    await page.getByRole("button", { name: scenario.action, exact: true }).click();
    await expect.poll(() => mock.commands.length).toBe(3);
    await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
    mock.release();
    if (scenario.action === "加倍") {
      await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
      await expect(hand.locator("header")).toHaveText("21");
      await expect(hand.locator(".playing-card")).toHaveCount(3);
    } else {
      await expect(hand).toHaveAttribute("aria-label", "玩家牌組 2");
    }
    await page.clock.runFor(900);
    await expect(hand).toHaveAttribute("aria-label", "玩家牌組 2");
    await expect(hand.locator(".celebration-title")).toHaveText("21");
    await expect(page.locator(".hole-flip")).toHaveCount(0);
    await page.clock.runFor(900);
    await expect(hand).toHaveClass(/twenty-one/);
    await expect(page.locator(".hole-flip")).toHaveCount(0);
    await page.clock.runFor(3000);
    await expect(page.locator(".hand-celebration")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
  });
}

test("Blackjack presents a skipped middle 21 before the next playable hand", async ({ page }) => {
  await mockGame(page, { ranks: [10, 6, 13, 10, 10, 7, 7, 1] });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  const split = page.getByRole("button", { name: "分牌", exact: true });
  await split.click();
  await split.click();
  const stand = page.getByRole("button", { name: "停牌", exact: true });
  await expect(stand).toBeEnabled();
  const hand = page.locator('.player-hand[aria-hidden="false"]');
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
  await expect(hand.locator("header")).toHaveText("17");
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await stand.click();
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 2");
  await page.clock.runFor(900);
  await expect(hand.locator(".celebration-title")).toHaveText("21");
  await expect(stand).toBeDisabled();
  await page.clock.runFor(2100);
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 3");
  await expect(hand.locator("header")).toHaveText("17");
  await expect(stand).toBeEnabled();
  await expect(page.locator(".hand-celebration")).toHaveCount(0);
});

test("Blackjack pauses on a split two-card 21 before advancing without replaying on restore", async ({
  page,
}) => {
  const mock = await mockGame(page, { ranks: [10, 6, 13, 10, 1, 7], delay: true });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  mock.release();
  const split = page.getByRole("button", { name: "分牌", exact: true });
  await expect(split).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await split.click();
  await expect.poll(() => mock.commands.length).toBe(2);
  await expect(page.locator(".twenty-one")).toHaveCount(0);
  mock.release();
  const hand = page.locator('.player-hand[aria-hidden="false"]');
  await expect(hand.locator("header")).toHaveText("21");
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeDisabled();
  const table = await page.locator(".blackjack-table").boundingBox();
  await page.clock.runFor(700);
  await expect(hand.locator(".playing-card").first()).toHaveCSS(
    "animation-name",
    /^twenty-one-bounce/,
  );
  await expect(hand.locator(".celebration-title")).toHaveText("21");
  await expect(hand.locator(".hand-celebration")).toHaveCSS("animation-name", /^celebration-glow/);
  await page.clock.runFor(650);
  await expect(hand.locator("header")).toHaveText("21");
  expect(await page.locator(".blackjack-table").boundingBox()).toEqual(table);
  await page.clock.runFor(1600);
  await expect(hand.locator("header")).toHaveText("17");
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  await page.reload();
  await expect(hand.locator("header")).toHaveText("17");
  await expect(page.locator(".twenty-one")).toHaveCount(0);
});

test("Blackjack presents both split 21s before dealer reveal and unlocks on reduced motion", async ({
  page,
}) => {
  await mockGame(page, { ranks: [10, 6, 13, 10, 1, 1, 5] });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  const split = page.getByRole("button", { name: "分牌", exact: true });
  await expect(split).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await split.click();
  const hand = page.locator('.player-hand[aria-hidden="false"]');
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
  await page.clock.runFor(700);
  await expect(hand).toHaveClass(/twenty-one/);
  await expect(page.locator(".hole-flip")).toHaveCount(0);
  await page.clock.runFor(2100);
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 2");
  await expect(hand).toHaveClass(/twenty-one/);
  await expect(page.locator(".hole-flip")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".twenty-one")).toHaveCount(0);
  await expect(page.locator(".hand-celebration")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
  await page.clock.runFor(3000);
  await expect(page.locator(".hole-flip")).toHaveCount(0);
});

test("Blackjack celebrates a natural 21 with a gold frame and title within mobile viewports", async ({
  page,
}) => {
  await mockGame(page, { ranks: [1, 6, 10, 10, 5] });
  await page.goto("/blackjack");
  const start = page.getByRole("button", { name: /開始下注/ });
  await expect(start).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await start.click();
  await expect(page.locator('.player-hand[aria-hidden="false"] header')).toHaveText("21");
  await page.clock.runFor(900);
  const title = page.locator(".celebration-title");
  await expect(title).toHaveText("BLACKJACK");
  await expect(title).toHaveCSS("animation-name", /^celebration-shine/);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 483, height: 771 },
  ]) {
    await page.setViewportSize(viewport);
    const banner = (await page.locator(".celebration-banner").boundingBox())!;
    const table = (await page.locator(".blackjack-table").boundingBox())!;
    expect(banner.x).toBeGreaterThanOrEqual(table.x);
    expect(banner.x + banner.width).toBeLessThanOrEqual(table.x + table.width);
    expect(banner.y).toBeGreaterThanOrEqual(table.y);
    expect(banner.y + banner.height).toBeLessThanOrEqual(table.y + table.height);
    const wallet = (await page.locator(".ui-balance").boundingBox())!;
    expect(wallet.y + wallet.height).toBeLessThanOrEqual(viewport.height);
  }
  await page.clock.runFor(2000);
  await expect(page.locator(".hand-celebration")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
});

test("Blackjack keeps controls stable when browsing split hands", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockGame(page, { ranks: [10, 10, 13, 8, 10, 7] });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await page.getByRole("button", { name: "分牌", exact: true }).click();
  const status = page.locator(".turn-copy");
  const layout = () =>
    page
      .locator(".turn-copy, .blackjack-table, .blackjack-controls, .action-grid, .ui-balance")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 483, height: 771 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(status).toHaveText("請選擇操作");
    const before = await layout();
    const typography = await status.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        "font-size": style.fontSize,
        "font-weight": style.fontWeight,
        "line-height": style.lineHeight,
      };
    });
    await page.getByRole("button", { name: "下一副牌" }).click();
    const returnButton = page.getByRole("button", { name: "返回操作牌組" });
    await expect(returnButton).toBeVisible();
    for (const [property, value] of Object.entries(typography)) {
      await expect(returnButton).toHaveCSS(property, value);
    }
    expect(await layout()).toEqual(before);
    await returnButton.click();
    await expect(status).toHaveText("請選擇操作");
    expect(await layout()).toEqual(before);
  }
});

test("Blackjack displays one centered split hand and advances after stand is confirmed", async ({
  page,
  browserName,
}) => {
  const mock = await mockGame(page, { ranks: [10, 10, 13, 8, 10, 7], delay: true });
  await page.goto("/blackjack");
  await page.getByRole("button", { name: /開始下注/ }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  mock.release();
  await page.getByRole("button", { name: "分牌", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(2);
  mock.release();
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  expect(mock.snapshot()!.hands).toHaveLength(2);
  const hand = page.locator('.player-hand[aria-hidden="false"]');
  await expect(hand).toHaveCount(1);
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 1");
  await expect(hand.locator("header")).toHaveText("20");
  await expect(hand.locator(".playing-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "上一副牌" })).toBeHidden();
  await page.getByRole("button", { name: "下一副牌" }).click();
  await expect(hand.locator("header")).toHaveText("17");
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下一副牌" })).toBeHidden();
  expect(mock.commands).toHaveLength(2);
  await page.locator(".hand-viewport").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(hand.locator("header")).toHaveText("20");
  const viewport = page.locator(".hand-viewport");
  const viewportBox = (await viewport.boundingBox())!;
  if (browserName === "chromium") {
    await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + 8);
    await page.mouse.wheel(viewportBox.width, 0);
    await expect(hand.locator("header")).toHaveText("17");
    await page.getByRole("button", { name: "返回操作牌組" }).click();
    await expect(hand.locator("header")).toHaveText("20");
  }
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeLessThan(1);
  await page.mouse.move(viewportBox.x + viewportBox.width * 0.7, viewportBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + viewportBox.width * 0.25, viewportBox.y + 8, { steps: 12 });
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(40);
  await page.mouse.up();
  await expect(hand.locator("header")).toHaveText("17");
  await expect
    .poll(() => viewport.evaluate((element) => Math.abs(element.scrollLeft - element.clientWidth)))
    .toBeLessThan(1);
  await page.getByRole("button", { name: "返回操作牌組" }).click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeLessThan(1);
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    try {
      const y = viewportBox.y + viewportBox.height / 2;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: viewportBox.x + viewportBox.width * 0.8, y }],
      });
      for (let step = 1; step <= 6; step++) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: viewportBox.x + viewportBox.width * (0.8 - step * 0.1), y }],
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(hand.locator("header")).toHaveText("17");
      await expect
        .poll(() =>
          viewport.evaluate((element) => Math.abs(element.scrollLeft - element.clientWidth)),
        )
        .toBeLessThan(1);
    } finally {
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await session.detach();
    }
    await page.getByRole("button", { name: "返回操作牌組" }).click();
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeLessThan(1);
  }
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(3);
  await expect(hand.locator("header")).toHaveText("20");
  mock.release();
  await expect(hand).toHaveCount(1);
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 2");
  await expect(hand.locator("header")).toHaveText("17");
  await expect(hand.locator(".playing-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "停牌", exact: true })).toBeEnabled();
  await page.reload();
  await expect(hand).toHaveCount(1);
  await expect(hand).toHaveAttribute("aria-label", "玩家牌組 2");
  await expect(hand.locator("header")).toHaveText("17");
  await expect(hand.locator(".reveal")).toHaveCount(0);
  await page.getByRole("button", { name: "停牌", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(4);
  mock.release();
  await expect(page.getByRole("button", { name: /下一局/ })).toBeEnabled();
  await page.getByRole("button", { name: "上一副牌" }).click();
  await expect(hand.locator("header")).toHaveText("20");
  await page.getByRole("button", { name: "下一副牌" }).click();
  await expect(hand.locator("header")).toHaveText("17");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".hand-arrow-left svg")).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: test.info().outputPath("blackjack-split-navigation.png") });
});
