import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  type HiloCommand,
  type HiloMutationResponse,
  type HiloPreview,
  type HiloRound,
  type HiloChoice,
} from "@baccarat/contracts";
// A lightweight fake server exercises browser interactions; exact money/RTP is tested on the server.
type Ratio = number;
const INITIAL_RATIO = 0.94;
const rank = (card: number) => Math.floor(card / 4) + 1;
const choices = (card: number): HiloChoice[] =>
  rank(card) === 1
    ? ["higher", "same"]
    : rank(card) === 13
      ? ["lower", "same"]
      : ["higher_or_equal", "lower_or_equal"];
const winningRanks = (card: number, choice: HiloChoice) =>
  choice === "same"
    ? 1
    : choice === "higher" || choice === "lower"
      ? 12
      : choice === "higher_or_equal"
        ? 14 - rank(card)
        : rank(card);
const nextRatio = (value: number, count: number) => (value * 13) / count;
const multiplier = (value: number) => value;
const payout = (amount: number, value: number) => Math.round(amount * value * 100) / 100;
const wins = (a: number, b: number, choice: HiloChoice) =>
  choice === "same"
    ? rank(a) === rank(b)
    : choice === "higher"
      ? rank(b) > rank(a)
      : choice === "lower"
        ? rank(b) < rank(a)
        : choice === "higher_or_equal"
          ? rank(b) >= rank(a)
          : rank(b) <= rank(a);
function options(card: number, amount: number, value: number, active = true): HiloRound["options"] {
  return choices(card).map((choice) => {
    const count = winningRanks(card, choice),
      next = nextRatio(value, count);
    return {
      choice,
      winningRanks: count,
      totalRanks: 13,
      multiplier: next,
      payout: payout(amount, next),
      enabled: active && next <= 10000,
      reason: !active ? "ROUND_ENDED" : next > 10000 ? "MULTIPLIER_LIMIT" : null,
    };
  });
}

const now = "2026-09-16T10:00:00.000Z";
const config = {
  minBet: 100,
  maxBet: 5000,
  betStep: 100,
  rtp: 0.94,
  maxMultiplier: 10000,
  maxSkips: 52,
  ruleVersion: 1,
  enabled: true,
};
const user = {
  id: "hilo-player",
  username: "player",
  role: "PLAYER",
  isActive: true,
  balance: 10000,
  walletVersion: 1,
};
async function mockGame(page: Page, drawCards: number[] = [], dropGuess = false, enabled = true) {
  let preview: HiloPreview | null = { id: randomUUID(), card: 0, version: 1 };
  let round: HiloRound | null = null,
    ratio: Ratio = INITIAL_RATIO;
  let balance = user.balance,
    walletVersion = 1,
    writes = 0;
  let holdReplies = false;
  const heldReplies: (() => void)[] = [];
  const commands: HiloCommand[] = [],
    replays = new Map<string, HiloMutationResponse>();
  function update() {
    if (!round) return;
    round.options = options(round.card, round.amount, ratio, round.status === "ACTIVE");
    round.multiplier = round.successCount ? multiplier(ratio) : 0;
    round.cashoutAmount =
      round.status === "ACTIVE" && round.successCount ? payout(round.amount, ratio) : 0;
  }
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().method() === "POST" && path.startsWith("/api/hilo")).toBe(false);
    if (path === "/api/auth/refresh")
      return route.fulfill({
        json: {
          token: "token",
          user: { ...user, balance, walletVersion },
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === "/api/auth/me")
      return route.fulfill({ json: { ...user, balance, walletVersion } });
    if (path === "/api/hilo/config") return route.fulfill({ json: { ...config, enabled } });
    if (path === "/api/hilo/state")
      return route.fulfill({ json: { preview, round: round?.status === "ACTIVE" ? round : null } });
    if (path.startsWith("/api/hilo/rounds/")) return route.fulfill({ json: { round } });
    return route.fulfill({ status: 404 });
  });
  await page.routeWebSocket("**/api/ws", (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type !== "hilo_command") return;
      const input = command as HiloCommand;
      commands.push(input);
      let data = replays.get(input.idempotencyKey);
      if (!data) {
        const a = input.action;
        if (a.kind === "prepare") {
          preview ??= { id: randomUUID(), card: 0, version: 1 };
          round = null;
        } else if (a.kind === "refresh_preview") {
          expect(a.expectedVersion).toBe(preview!.version);
          preview = { ...preview!, card: drawCards.shift() ?? 0, version: preview!.version + 1 };
        } else if (a.kind === "start") {
          expect(a.previewId).toBe(preview!.id);
          expect(a.expectedVersion).toBe(preview!.version);
          ratio = INITIAL_RATIO;
          round = {
            id: randomUUID(),
            amount: a.amount,
            initialCard: preview!.card,
            card: preview!.card,
            status: "ACTIVE",
            successCount: 0,
            skipCount: 0,
            multiplier: 0,
            payout: 0,
            cashoutAmount: 0,
            options: options(preview!.card, a.amount, ratio),
            steps: [],
            version: 1,
            ruleVersion: 1,
            createdAt: now,
            settledAt: null,
          };
          preview = null;
          balance -= a.amount;
          walletVersion++;
        } else {
          expect(a.expectedVersion).toBe(round!.version);
          if (a.kind === "cashout") {
            round!.status = "CASHED_OUT";
            round!.payout = payout(round!.amount, ratio);
            balance += round!.payout;
            walletVersion++;
            round!.settledAt = now;
          } else {
            const card = drawCards.shift() ?? 0,
              fromCard = round!.card;
            const won = a.kind === "guess" ? wins(fromCard, card, a.choice) : null;
            if (won) {
              ratio = nextRatio(
                ratio,
                winningRanks(fromCard, a.kind === "guess" ? a.choice : "same"),
              );
              round!.successCount++;
            }
            if (won === false) {
              round!.status = "LOST";
              round!.settledAt = now;
            }
            if (a.kind === "skip") round!.skipCount++;
            if (a.kind === "guess") writes++;
            round!.steps.push({
              sequence: round!.version,
              kind: a.kind,
              fromCard,
              card,
              choice: a.kind === "guess" ? a.choice : null,
              won,
              multiplier: multiplier(ratio),
            });
            round!.card = card;
          }
          round!.version++;
          update();
        }
        data = structuredClone({ preview, round, balance, walletVersion });
        replays.set(input.idempotencyKey, data);
        if (dropGuess && a.kind === "guess") {
          dropGuess = false;
          socket.close({ code: 1011, reason: "lost reply after commit" });
          return;
        }
      }
      const reply = JSON.stringify({
        type: "hilo_result",
        requestId: input.requestId,
        result: { ok: true, data },
      });
      const sendReply = () => socket.send(reply);
      if (holdReplies) heldReplies.push(sendReply);
      else sendReply();
    });
  });
  return {
    commands,
    holdResponses: () => {
      holdReplies = true;
    },
    releaseResponses: () => {
      holdReplies = false;
      heldReplies.splice(0).forEach((send) => send());
    },
    writes: () => writes,
    setLimit: (skipCount: number, value: number) => {
      round!.successCount = 1;
      round!.skipCount = skipCount;
      round!.card = 24;
      ratio = value;
      update();
    },
  };
}

test("Hi-Lo preview, ties, A/K options, cashout and responsive card table", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockGame(page, [24, 24, 0, 48]);
  await page.goto("/hilo");
  await expect(page.getByRole("button", { name: "免費換牌", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "免費換牌", exact: true }).click();
  await expect(page.getByRole("img", { name: "黑桃 7", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下注", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "投注額" })).toBeDisabled();
  await page.getByRole("button", { name: "大於或等於", exact: true }).click();
  await expect(page.getByRole("list", { name: "本局牌序" })).toContainText("猜對");
  await page.getByRole("button", { name: "跳牌（52）", exact: true }).click();
  await expect(page.getByRole("button", { name: "更高", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "更高", exact: true }).click();
  await expect(page.getByRole("button", { name: "更低", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "相同", exact: true })).toBeEnabled();
  async function expectFits() {
    const geometry = await page.evaluate(() => {
      const selectors = [".hilo-card", ".hilo-trail", ".hilo-controls", ".ui-balance"];
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        boxes: selectors.flatMap((selector) => {
          const element = document.querySelector(selector);
          if (!element) return [];
          const box = element.getBoundingClientRect();
          return [
            {
              selector,
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              right: box.right,
              height: box.height,
            },
          ];
        }),
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1);
    for (const box of geometry.boxes) {
      expect(box.top, box.selector).toBeGreaterThanOrEqual(0);
      expect(box.bottom, box.selector).toBeLessThanOrEqual(geometry.height + 1);
      expect(box.height, box.selector).toBeGreaterThan(0);
    }
    for (let i = 1; i < geometry.boxes.length; i++) {
      expect(geometry.boxes[i]!.top).toBeGreaterThanOrEqual(geometry.boxes[i - 1]!.bottom - 1);
    }
  }
  for (const [width, height] of [
    [320, 568],
    [375, 667],
    [483, 771],
    [1360, 900],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expectFits();
  }
  await page.setViewportSize({ width: 483, height: 771 });
  await page.screenshot({ path: test.info().outputPath("hilo-playing.png"), fullPage: true });
  await page.getByRole("button", { name: /^收款 / }).click();
  await expect(page.getByRole("button", { name: "下一局", exact: true })).toBeEnabled();
  await expect(page.locator(".hilo-summary")).toContainText("本局派彩");
  await expectFits();
  await page.getByRole("button", { name: "下一局", exact: true }).click();
  await expect(page.getByRole("button", { name: "下注", exact: true })).toBeEnabled();
  await expect(page.getByRole("list", { name: "本局牌序" })).toHaveCount(0);
  await expectFits();
});

test("Hi-Lo loses on A-to-A higher and forbids cashout before success", async ({ page }) => {
  await mockGame(page, [0]);
  await page.goto("/hilo");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  await expect(page.getByRole("button", { name: /^收款 / })).toBeDisabled();
  await page.getByRole("button", { name: "更高", exact: true }).click();
  await expect(page.getByRole("list", { name: "本局牌序" })).toContainText("猜錯");
  await expect(page.getByRole("button", { name: "下一局", exact: true })).toBeEnabled();
  await expect(page.locator(".hilo-summary")).toContainText("-100");
});

test("Hi-Lo lost guess response reconnects with the original key and one draw", async ({
  page,
}) => {
  const game = await mockGame(page, [48], true);
  await page.goto("/hilo");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  await page.getByRole("button", { name: "更高", exact: true }).click();
  await expect(page.getByRole("button", { name: "更低", exact: true })).toBeEnabled();
  const attempts = game.commands.filter((c) => c.action.kind === "guess");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.idempotencyKey).toBe(attempts[0]!.idempotencyKey);
  expect(attempts[1]!.requestId).not.toBe(attempts[0]!.requestId);
  expect(game.writes()).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "更低", exact: true })).toBeEnabled();
  expect(game.commands.filter((c) => c.action.kind === "start")).toHaveLength(1);
});

test("Hi-Lo disables exhausted skips and over-limit choices while preserving cashout", async ({
  page,
}) => {
  const game = await mockGame(page);
  await page.goto("/hilo");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  game.setLimit(52, 1);
  await page.reload();
  await expect(page.getByRole("button", { name: "跳牌（0）", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "大於或等於", exact: true })).toBeEnabled();
  game.setLimit(51, 9000);
  await page.reload();
  await expect(page.getByRole("button", { name: "跳牌（1）", exact: true })).toBeEnabled();
  for (const choice of choices(24))
    await expect(
      page.getByRole("button", {
        name: choice === "higher_or_equal" ? "大於或等於" : "小於或等於",
        exact: true,
      }),
    ).toBeDisabled();
  await expect(page.getByRole("button", { name: /^收款 / })).toBeEnabled();
});

test("Hi-Lo disabled configuration blocks new betting without preparing another card", async ({
  page,
}) => {
  const game = await mockGame(page, [], false, false);
  await page.goto("/hilo");
  await expect(
    page.getByText("暫停接受新投注，已開局仍可繼續與收款。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "下注", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "免費換牌", exact: true })).toBeDisabled();
  expect(game.commands).toHaveLength(0);
});

test("Hi-Lo trail arrows navigate overflow and multipliers use two decimals", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 483, height: 771 });
  await mockGame(page, Array(12).fill(24));
  await page.goto("/hilo");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  const earlier = page.getByRole("button", { name: "查看較早的牌" });
  const newer = page.getByRole("button", { name: "查看較新的牌" });
  const trail = page.getByRole("list", { name: "本局牌序" });
  await expect(earlier).toBeHidden();
  await expect(newer).toBeHidden();
  for (let i = 0; i < 10; i++) {
    await page.getByRole("button", { name: `跳牌（${52 - i}）`, exact: true }).click();
  }
  await expect(newer).toBeVisible();
  await expect(earlier).toBeHidden();
  await newer.click();
  await expect.poll(() => trail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expect(earlier).toBeVisible();
  await expect(newer).toBeHidden();
  await earlier.click();
  await expect.poll(() => trail.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(earlier).toBeHidden();
  await expect(newer).toBeVisible();
  await expect(trail).toHaveCSS("scrollbar-width", "none");
  for (const value of await page.locator(".choice-metrics strong").allTextContents()) {
    expect(value).toMatch(/^\d+\.\d{2}×$/);
  }
  await page.getByRole("button", { name: "大於或等於", exact: true }).click();
  await expect(page.locator(".hilo-summary strong").first()).toHaveText(/^\d+\.\d{2}×$/);
  await page.screenshot({ path: test.info().outputPath("hilo-trail-arrows.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(earlier).toBeHidden();
  await expect(newer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(568);
});

test("Hi-Lo free preview changes stay stationary with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 483, height: 771 });
  await mockGame(page, [24, 48]);
  await page.goto("/hilo");
  await expect(page.getByRole("button", { name: "免費換牌", exact: true })).toBeEnabled();
  for (const [button, label] of [
    ["免費換牌", "黑桃 7"],
    ["免費換牌", "黑桃 K"],
  ]) {
    const samples = await page.evaluateHandle(() => {
      const state = { running: true, boxes: [] as number[][] };
      const sample = () => {
        if (!state.running) return;
        const box = document.querySelector(".hilo-card")!.getBoundingClientRect();
        state.boxes.push([box.x, box.y, box.width, box.height]);
        requestAnimationFrame(sample);
      };
      sample();
      return state;
    });
    await page.getByRole("button", { name: button!, exact: true }).click();
    await expect(page.getByRole("img", { name: label!, exact: true })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          function tick() {
            if (++frames >= 20) resolve();
            else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }),
    );
    const boxes = await samples.evaluate((state) => {
      state.running = false;
      return state.boxes;
    });
    await samples.dispose();
    expect(boxes.length).toBeGreaterThan(1);
    for (const box of boxes) {
      box.forEach((value, index) => expect(value).toBeCloseTo(boxes[0]![index]!, 1));
    }
  }
});

test("Hi-Lo waiting for a preview reply preserves layout and offers recovery only after timeout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 483, height: 771 });
  const game = await mockGame(page, [24, 48]);
  await page.goto("/hilo");
  const refresh = page.getByRole("button", { name: /^(免費換牌|換牌中…)$/ });
  const recovery = page.getByRole("button", { name: "確認上一個操作", exact: true });
  await expect(refresh).toBeEnabled();
  const bounds = () =>
    page.locator(".hilo-card, .hilo-controls, .ui-balance").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      }),
    );
  const appearance = () =>
    page
      .locator(
        ".hilo-card, .hilo-summary, .hilo-actions button, .ui-stake .ui-button, .ui-stake select, .ui-balance",
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return [style.opacity, style.backgroundColor, style.color, style.transform];
        }),
      );
  const before = await bounds();
  const appearanceBefore = await appearance();
  game.holdResponses();
  await refresh.click();
  await expect
    .poll(() => game.commands.filter((c) => c.action.kind === "refresh_preview").length)
    .toBe(1);
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveText("換牌中…");
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "下注", exact: true })).toBeDisabled();
  expect(await bounds()).toEqual(before);
  expect(await appearance()).toEqual(appearanceBefore);
  await expect(page.locator(".ui-stake")).toHaveAttribute("inert", "");
  await expect(recovery).toBeHidden();
  await expect(page.getByRole("img", { name: "黑桃 A", exact: true })).toBeVisible();
  game.releaseResponses();
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveText("免費換牌");
  await expect(refresh).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("img", { name: "黑桃 7", exact: true })).toBeVisible();
  expect(await bounds()).toEqual(before);
  expect(await appearance()).toEqual(appearanceBefore);
  await expect(page.locator(".ui-stake")).not.toHaveAttribute("inert", "");
  await page.clock.install();
  game.holdResponses();
  await refresh.click();
  await expect
    .poll(() => game.commands.filter((c) => c.action.kind === "refresh_preview").length)
    .toBe(2);
  await expect(recovery).toBeHidden();
  await page.clock.runFor(10_100);
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeDisabled();
  await expect(refresh).toBeDisabled();
});

test("Hi-Lo active requests keep controls stable and reuse both choice buttons across A/K", async ({
  page,
}) => {
  await page.setViewportSize({ width: 483, height: 771 });
  const game = await mockGame(page, [24, 0, 48, 24]);
  await page.goto("/hilo");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  await expect(page.getByRole("button", { name: "更高", exact: true })).toBeEnabled();
  const choiceNodes = await page
    .locator(".hilo-choices button")
    .evaluateAll((elements) => elements.length);
  expect(choiceNodes).toBe(2);
  const originalNodes = await page.evaluateHandle(() => [
    ...document.querySelectorAll(".hilo-choices button"),
  ]);
  const presentation = () =>
    page
      .locator(".hilo-choices button, .hilo-actions button, .ui-stake .ui-button, .ui-stake select")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return [
            style.opacity,
            style.backgroundImage,
            style.borderColor,
            style.transform,
            box.x,
            box.y,
            box.width,
            box.height,
          ];
        }),
      );
  for (const [name, nextCard, pendingText] of [
    ["跳牌（52）", "黑桃 7", "跳牌中…"],
    ["跳牌（51）", "黑桃 A", "跳牌中…"],
    ["更高", "黑桃 K", "確認中…"],
    ["更低", "黑桃 7", "確認中…"],
  ]) {
    const control = page.getByRole("button", { name: name!, exact: true });
    await control.hover();
    const before = await presentation();
    const count = game.commands.length;
    game.holdResponses();
    await control.click();
    await expect.poll(() => game.commands.length).toBe(count + 1);
    await expect(page.getByText(pendingText!, { exact: true })).toBeVisible();
    await expect(page.locator(".hilo-controls button:enabled")).toHaveCount(0);
    expect(await presentation()).toEqual(before);
    await expect(page.getByRole("button", { name: "確認上一個操作", exact: true })).toBeHidden();
    game.releaseResponses();
    await expect(page.getByRole("img", { name: nextCard!, exact: true })).toBeVisible();
    await expect(page.locator(".hilo-choices button").first()).toBeEnabled();
    expect(
      await originalNodes.evaluate((elements) =>
        elements.every(
          (element, index) => element === document.querySelectorAll(".hilo-choices button")[index],
        ),
      ),
    ).toBe(true);
  }
  await originalNodes.dispose();
});

test("Hi-Lo guesses reveal the Baccarat card back in place, including a lost guess", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 483, height: 771 });
  await mockGame(page, [24, 0, 0]);
  await page.goto("/hilo");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  const card = page.locator(".hilo-card");
  const flipper = page.locator(".card-flipper");
  const originalCard = await card.elementHandle();
  for (const [index, choice] of ["更高", "小於或等於", "更高"].entries()) {
    const control = page.getByRole("button", { name: choice, exact: true });
    await expect(control).toBeEnabled();
    await control.click();
    await expect(flipper).toHaveClass(/is-revealing/);
    const animation = await flipper.evaluateHandle((element) => {
      const animation = element.getAnimations()[0]!;
      animation.pause();
      animation.currentTime = 0;
      return animation;
    });
    expect(
      await animation.evaluate((animation) =>
        (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame.transform),
      ),
    ).toEqual(["rotateY(180deg)", "rotateY(0deg)"]);
    expect(await animation.evaluate((animation) => animation.effect!.getTiming().duration)).toBe(
      1000,
    );
    const backBox = await card.boundingBox();
    await expect(page.locator(".hilo-controls button:enabled")).toHaveCount(0);
    expect(await card.evaluate((element, original) => element === original, originalCard)).toBe(
      true,
    );
    if (index === 0)
      await page.screenshot({ path: test.info().outputPath("hilo-card-back.png"), fullPage: true });
    await animation.evaluate((animation) => animation.finish());
    await expect(flipper).not.toHaveClass(/is-revealing/);
    expect(await card.boundingBox()).toEqual(backBox);
    await animation.dispose();
  }
  await expect(page.getByRole("button", { name: "下一局", exact: true })).toBeEnabled();
  await expect(page.getByRole("list", { name: "本局牌序" })).toContainText("猜錯");
  await originalCard?.dispose();
});

for (const kind of ["skip", "refresh_preview"] as const) {
  test(`Hi-Lo ${kind} slides the previous card offscreen before revealing the next card`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 483, height: 771 });
    await mockGame(page, [24, 24]);
    await page.goto("/hilo");
    if (kind === "skip") await page.getByRole("button", { name: "下注", exact: true }).click();
    const readyLabel = (remaining: number) =>
      kind === "skip" ? `跳牌（${remaining}）` : "免費換牌";
    const waitingLabel = kind === "skip" ? "跳牌中…" : "換牌中…";
    const card = page.locator(".hilo-card");
    const flipper = page.locator(".card-flipper");
    const layout = () =>
      page.locator(".hilo-card-slot, .hilo-controls, .ui-balance").evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        }),
      );
    const before = await layout();
    for (let index = 0; index < 2; index++) {
      await page.getByRole("button", { name: readyLabel(52 - index), exact: true }).click();
      await expect(card).toHaveClass(/is-leaving/);
      const exit = await card.evaluateHandle((element) => {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = 259;
        return animation;
      });
      await expect(card).toHaveAttribute("aria-label", index === 0 ? "黑桃 A" : "黑桃 7");
      expect((await card.boundingBox())!.x + (await card.boundingBox())!.width).toBeLessThan(0);
      expect(await layout()).toEqual(before);
      await expect(page.getByRole("button", { name: waitingLabel, exact: true })).toBeDisabled();
      await exit.evaluate((animation) => animation.finish());
      await expect(flipper).toHaveClass(/is-revealing/);
      const reveal = await flipper.evaluateHandle((element) => {
        const animation = element.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = 0;
        return animation;
      });
      expect(await reveal.evaluate((animation) => animation.effect!.getTiming().duration)).toBe(
        1000,
      );
      await expect(card).not.toHaveClass(/is-leaving/);
      await expect(card).toHaveAttribute("aria-label", "黑桃 7");
      expect(await layout()).toEqual(before);
      await expect(
        page.locator(".hilo-actions button:enabled, .hilo-choices button:enabled"),
      ).toHaveCount(0);
      if (kind === "refresh_preview")
        await expect(page.locator(".ui-stake")).toHaveAttribute("inert", "");
      await reveal.evaluate((animation) => animation.finish());
      await expect(
        page.getByRole("button", { name: readyLabel(51 - index), exact: true }),
      ).toBeEnabled();
      expect(await layout()).toEqual(before);
      await exit.dispose();
      await reveal.dispose();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: readyLabel(50), exact: true }).click();
    await expect(card).toHaveAttribute("aria-label", "黑桃 A");
    expect(await card.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(
      0,
    );
    await expect(page.getByRole("button", { name: readyLabel(49), exact: true })).toBeEnabled();
  });
}

for (const prize of [
  { multiplier: 12.22, title: "BIG WIN", tier: "big", width: 320, height: 568 },
  { multiplier: 24.44, title: "MEGA WIN", tier: "mega", width: 390, height: 844 },
  { multiplier: 158.86, title: "SUPER WIN", tier: "super", width: 483, height: 771 },
]) {
  test(`Hi-Lo ${prize.title} celebrates confirmed cashout without moving the controls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: prize.width, height: prize.height });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const game = await mockGame(page);
    await page.goto("/hilo");
    await page.getByRole("button", { name: "下注", exact: true }).click();
    await expect(page.getByRole("button", { name: "相同", exact: true })).toBeEnabled();
    game.setLimit(0, prize.multiplier);
    await page.reload();
    const cashout = page.getByRole("button", { name: /^收款 / });
    await expect(cashout).toBeEnabled();
    await expect(page.locator(".hilo-win")).toHaveCount(0);
    const table = await page.locator(".hilo-table").boundingBox();
    game.holdResponses();
    await cashout.click();
    await expect(cashout).toBeDisabled();
    await expect(page.locator(".hilo-win")).toHaveCount(0);
    await page.clock.install();
    game.releaseResponses();
    await expect(page.locator(".win-title")).toHaveText(prize.title);
    await page.clock.runFor(1150);
    await expect(page.locator(".win-payout")).toHaveText(
      `$${Math.trunc(prize.multiplier * 100).toLocaleString("en-US")}`,
    );
    const next = page.getByRole("button", { name: "下一局", exact: true });
    await expect(next).toBeEnabled();
    await expect(page.locator(".win-particles")).toBeVisible();
    const winBox = await page.locator(".hilo-win").boundingBox();
    expect(winBox!.x).toBeCloseTo(table!.x, 0);
    expect(winBox!.width).toBeCloseTo(table!.width, 0);
    for (const selector of [".win-title", ".win-multiplier", ".win-payout"]) {
      const box = await page.locator(selector).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(winBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(winBox!.x + winBox!.width + 1);
      expect(box!.y).toBeGreaterThanOrEqual(winBox!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(winBox!.y + winBox!.height + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`hilo-${prize.tier}-win.png`),
      fullPage: true,
    });
    const nextBox = await next.boundingBox();
    await page.clock.runFor(5500);
    await expect(page.locator(".hilo-win")).toHaveCount(0);
    expect(await next.boundingBox()).toEqual(nextBox);
    await next.click();
    await expect(page.getByRole("button", { name: "下注", exact: true })).toBeEnabled();
  });
}

test("Hi-Lo reduced motion shows the maximum prize statically on a small phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const game = await mockGame(page);
  await page.goto("/hilo");
  await page.getByRole("combobox", { name: "投注額" }).selectOption("5000");
  await page.getByRole("button", { name: "下注", exact: true }).click();
  await expect(page.getByRole("button", { name: "相同", exact: true })).toBeEnabled();
  game.setLimit(0, 10000);
  await page.reload();
  await page.getByRole("button", { name: /^收款 / }).click();
  await expect(page.locator(".win-title")).toHaveText("SUPER WIN");
  await expect(page.locator(".win-payout")).toHaveText("$50,000,000");
  await expect(page.locator(".win-particles")).toBeHidden();
  const overflow = await page
    .locator(".win-copy")
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "下一局", exact: true }).click();
  await expect(page.locator(".hilo-win")).toHaveCount(0);
});
