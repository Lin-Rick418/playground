import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type {
  StormCommand,
  StormMutationResponse,
  StormSession,
  StormRound,
} from "@baccarat/contracts";
import type { DemoState, Tile } from "../apps/server/src/modules/storm/math";

export async function mockStorm(
  page: Page,
  options: {
    balance?: number;
    freeLeft?: number;
    freeGranted?: number;
    multiplier?: number;
    featureWin?: number;
    fixture?: "win" | "bonus" | "cap" | "lose";
    bonusCount?: number;
    dropFirst?: boolean;
    delay?: boolean;
    enabled?: boolean;
    amount?: StormSession["amount"];
  } = {},
) {
  const { initialStormProgress, stormCommandSchema, stormMutationResponseSchema, STORM_STAKES } =
    await import("@baccarat/contracts");
  const { spin, tile, showcaseBoard, bonusShowcase } =
    await import("../apps/server/src/modules/storm/math.ts");
  const balanced = (): Tile[] =>
    Array.from({ length: 30 }, (_, i) =>
      tile((["ruby", "emerald", "sapphire", "amber", "lotus", "scarab"] as const)[i % 6]!),
    );
  let state: DemoState = {
    ...initialStormProgress(),
    balance: options.balance ?? 10000,
    freeLeft: options.freeLeft ?? 0,
    freeGranted: options.freeGranted ?? (options.freeLeft ? 15 : 0),
    multiplier: options.multiplier ?? 0,
    featureWin: options.featureWin ?? 0,
  };
  let version = 0,
    walletVersion = 1,
    accepted = 0,
    stake: StormSession["amount"] = options.amount ?? 10;
  let lastRound: StormRound | null = null,
    release: (() => void) | undefined;
  const commands: StormCommand[] = [],
    replays = new Map<string, StormMutationResponse>();
  const sockets: WebSocketRoute[] = [];
  const user = () => ({
    id: "storm-player",
    username: "player",
    role: "PLAYER",
    isActive: true,
    balance: state.balance,
    walletVersion,
  });
  const session = (): StormSession => {
    const { balance: _balance, ...progress } = state;
    return { progress, amount: stake, version, ruleVersion: 1 };
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/refresh")
      return route.fulfill({
        json: {
          token: "test-token",
          user: user(),
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === "/api/auth/me") return route.fulfill({ json: user() });
    if (path === "/api/storm/config")
      return route.fulfill({
        json: {
          stakes: STORM_STAKES,
          enabled: options.enabled ?? true,
          ruleVersion: 1,
          maxWinFactor: 25000,
          rtp: null,
        },
      });
    if (path === "/api/storm/state")
      return route.fulfill({
        json: {
          session: session(),
          lastRound,
          recent: lastRound
            ? [
                {
                  id: lastRound.id,
                  amount: lastRound.result.cost,
                  stake: lastRound.amount,
                  payout: lastRound.result.payout,
                  wasFree: lastRound.result.wasFree,
                  createdAt: lastRound.createdAt,
                },
              ]
            : [],
          balance: state.balance,
          walletVersion,
        },
      });
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "Missing fixture", requestId: randomUUID() },
    });
  });
  await page.routeWebSocket("**/api/ws", (socket) => {
    sockets.push(socket);
    socket.onMessage(async (raw) => {
      const input = JSON.parse(String(raw));
      if (input.type !== "storm_command") return;
      const command = stormCommandSchema.parse(input);
      commands.push(command);
      let data = replays.get(command.idempotencyKey);
      if (!data) {
        expect(command.action.expectedVersion).toBe(version);
        if (state.freeLeft) expect(command.action.amount).toBe(stake);
        stake = command.action.amount;
        const picks = [0.15, 0.3, 0.45, 0.65, 0.8, 0.89, 0.92, 0.95, 0.1];
        const fixture =
          options.fixture === "bonus"
            ? bonusShowcase(options.bonusCount ?? 1)
            : options.fixture === "cap"
              ? showcaseBoard(1000)
              : options.fixture === "win"
                ? showcaseBoard(5)
                : balanced();
        const result = spin(state, stake, () => picks.shift() ?? 0.99, fixture);
        state = result.state;
        version++;
        walletVersion += 2;
        accepted++;
        lastRound = {
          id: randomUUID(),
          amount: stake,
          version,
          ruleVersion: 1,
          result,
          createdAt: new Date().toISOString(),
        };
        data = stormMutationResponseSchema.parse({
          session: session(),
          round: lastRound,
          balance: state.balance,
          walletVersion,
        });
        replays.set(command.idempotencyKey, data);
        if (options.dropFirst && accepted === 1) {
          socket.close({ code: 4000, reason: "lost response fixture" });
          return;
        }
        if (options.delay)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      }
      socket.send(
        JSON.stringify({
          type: "storm_result",
          requestId: command.requestId,
          result: { ok: true, data },
        }),
      );
    });
  });
  return {
    commands,
    accepted: () => accepted,
    balance: () => state.balance,
    version: () => version,
    release: () => release?.(),
    disconnect: () => sockets.at(-1)?.close({ code: 4000, reason: "connection fixture" }),
  };
}
