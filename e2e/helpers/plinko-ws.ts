import { expect, type Page } from "@playwright/test";
import type { PlinkoCommand } from "@baccarat/contracts";

type Reply = { status?: number; json?: unknown };
type Handler = (command: PlinkoCommand) => Reply | Promise<Reply>;

export async function mockPlinkoSocket(page: Page, handler: Handler) {
  let reply = handler;
  // A transport regression must fail rather than silently using HTTP mocks.
  page.on("request", (request) => {
    expect(request.method() === "POST" && request.url().includes("/plinko/rounds")).toBe(false);
  });
  await page.routeWebSocket("**/api/ws", (socket) => {
    socket.onMessage(async (raw) => {
      const value = JSON.parse(String(raw));
      if (value.type !== "plinko_command") return;
      const command = value as PlinkoCommand;
      expect(command.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
      expect(command.requestId).toMatch(/^[a-f0-9-]{36}$/);
      const response = await reply(command);
      socket.send(
        JSON.stringify({
          type: "plinko_result",
          requestId: command.requestId,
          result:
            (response.status ?? 200) < 400
              ? { ok: true, data: response.json }
              : { ok: false, status: response.status, error: response.json },
        }),
      );
    });
  });
  return (next: Handler) => {
    reply = next;
  };
}
