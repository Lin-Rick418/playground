import { afterEach, expect, it, vi } from "vitest";
import { plinkoCommandSchema, plinkoCommandResultSchema } from "@baccarat/contracts";
import { createPlinkoRpc } from "./plinko-rpc";

afterEach(() => vi.useRealTimers());
const command = {
  idempotencyKey: "plinko-key-123",
  payload: { amount: 100, rows: 16, risk: "medium" as const, ruleVersion: 1 },
};
it("sends a validated Plinko command and ignores a lost attempt's late reply", async () => {
  const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
  const rpc = createPlinkoRpc(() => socket as unknown as WebSocket);
  const first = rpc.request(command);
  const rejected = expect(first).rejects.toThrow("連線中斷");
  const original = plinkoCommandSchema.parse(JSON.parse(socket.send.mock.calls[0]![0]));
  rpc.disconnect();
  await rejected;
  const retry = rpc.request(command);
  const next = JSON.parse(socket.send.mock.calls[1]![0]);
  expect(next.idempotencyKey).toBe(original.idempotencyKey);
  expect(next.requestId).not.toBe(original.requestId);
  const failure = (id: string) =>
    plinkoCommandResultSchema.parse({
      type: "plinko_result",
      requestId: id,
      result: {
        ok: false,
        status: 429,
        error: { code: "RATE_LIMITED", message: "Too many bets", requestId: id },
      },
    });
  const result = expect(retry).rejects.toMatchObject({ response: { status: 429 } });
  rpc.receive(failure(original.requestId));
  rpc.receive(failure(next.requestId));
  await result;
});

it("times out uncertain Plinko bets and rejects client-supplied outcomes before sending", async () => {
  vi.useFakeTimers();
  const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
  const rpc = createPlinkoRpc(() => socket as unknown as WebSocket);
  const pending = rpc.request(command);
  const rejected = expect(pending).rejects.toThrow("連線中斷");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(socket.close).toHaveBeenCalledWith(4000, "Plinko response timeout");
  expect(vi.getTimerCount()).toBe(0);
  expect(
    plinkoCommandSchema.safeParse({
      ...command,
      type: "plinko_command",
      requestId: crypto.randomUUID(),
      payload: { ...command.payload, slotIndex: 0, payout: 100000 },
    }).success,
  ).toBe(false);
});
