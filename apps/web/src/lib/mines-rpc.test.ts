import { afterEach, describe, expect, it, vi } from "vitest";
import { minesCommandSchema, minesCommandResultSchema } from "@baccarat/contracts";
import { createMinesRpc } from "./mines-rpc";

const command = {
  idempotencyKey: "same-key-123",
  action: { kind: "start" as const, amount: 100, mineCount: 3 },
};
function setup() {
  const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
  const rpc = createMinesRpc(() => socket as unknown as WebSocket);
  return { socket, rpc };
}
afterEach(() => vi.useRealTimers());

describe("Mines WebSocket commands", () => {
  it("correlates replies and preserves the idempotency key on a new attempt", async () => {
    const { socket, rpc } = setup();
    const first = rpc.request(command);
    const rejected = expect(first).rejects.toThrow("連線中斷");
    const sent = minesCommandSchema.parse(JSON.parse(socket.send.mock.calls[0]![0]));
    rpc.disconnect();
    await rejected;
    const retry = rpc.request(command);
    const rejection = expect(retry).rejects.toMatchObject({
      response: { status: 400, data: { code: "VALIDATION_ERROR" } },
    });
    const next = JSON.parse(socket.send.mock.calls[1]![0]);
    expect(next.idempotencyKey).toBe(sent.idempotencyKey);
    expect(next.requestId).not.toBe(sent.requestId);
    const response = (id: string) =>
      minesCommandResultSchema.parse({
        type: "mines_result",
        requestId: id,
        result: {
          ok: false,
          status: 400,
          error: { code: "VALIDATION_ERROR", message: "餘額不足", requestId: id },
        },
      });
    rpc.receive(response(sent.requestId)); // A stale reply must not consume the retry.
    rpc.receive(response(next.requestId));
    await rejection;
  });

  it("times out uncertain operations, closes the socket, and never sends a second command concurrently", async () => {
    vi.useFakeTimers();
    const { socket, rpc } = setup();
    const first = rpc.request(command);
    const rejection = expect(first).rejects.toThrow("連線中斷");
    await expect(rpc.request(command)).rejects.toThrow("上一個");
    expect(socket.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(socket.close).toHaveBeenCalledWith(4000, "Mines response timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects disconnected sockets and invalid commands before sending", async () => {
    await expect(createMinesRpc(() => null).request(command)).rejects.toThrow("尚未就緒");
    const { socket, rpc } = setup();
    await expect(
      rpc.request({ ...command, action: { ...command.action, amount: 1 } }),
    ).rejects.toThrow();
    expect(socket.send).not.toHaveBeenCalled();
    expect(
      minesCommandSchema.safeParse({
        ...command,
        type: "mines_command",
        requestId: crypto.randomUUID(),
        userId: "other",
      }).success,
    ).toBe(false);
  });
});
