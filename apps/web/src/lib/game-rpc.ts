import { AxiosError, AxiosHeaders } from "axios";
import type { ApiErrorResponse } from "@baccarat/contracts";

type RpcResult<Data> = {
  requestId: string;
  result: { ok: true; data: Data } | { ok: false; status: number; error: ApiErrorResponse };
};

// One outstanding operation per board. A lost response is uncertain: callers
// retain the idempotency key and reconcile before allowing another operation.
export function createGameRpc<Command, Data>(
  getSocket: () => WebSocket | null,
  options: {
    name: string;
    buildMessage: (command: Command, requestId: string) => { requestId: string };
  },
) {
  let pending: {
    id: string;
    resolve: (data: Data) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function disconnect() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new Error(`${options.name} 連線中斷，正在確認上一個操作。`));
    pending = null;
  }

  const request: (command: Command) => Promise<Data> = async (command) => {
    const socket = getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error(`${options.name} 連線尚未就緒。`);
    if (pending) throw new Error(`上一個 ${options.name} 操作仍在確認中。`);
    const message = options.buildMessage(command, crypto.randomUUID());
    return new Promise((resolve, reject) => {
      pending = {
        id: message.requestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          disconnect();
          socket.close(4000, `${options.name} response timeout`);
        }, 10_000),
      };
      try {
        socket.send(JSON.stringify(message));
      } catch {
        disconnect();
      }
    });
  };

  function receive(message: RpcResult<Data>) {
    if (!pending || pending.id !== message.requestId) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (message.result.ok) current.resolve(message.result.data);
    else {
      // Preserve the app's existing typed API error/retry handling.
      const error = new AxiosError(message.result.error.message);
      error.response = {
        status: message.result.status,
        data: message.result.error,
        statusText: "",
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      current.reject(error);
    }
  }

  return { request, receive, disconnect };
}
