import {
  hiloCommandSchema,
  type HiloCommand,
  type HiloMutationResponse,
} from "@baccarat/contracts";
import { createGameRpc } from "./game-rpc";
export type HiloTransport = (
  command: Omit<HiloCommand, "type" | "requestId">,
) => Promise<HiloMutationResponse>;
export function createHiloRpc(getSocket: () => WebSocket | null) {
  return createGameRpc<Omit<HiloCommand, "type" | "requestId">, HiloMutationResponse>(getSocket, {
    name: "Hilo",
    buildMessage: (command, requestId) =>
      hiloCommandSchema.parse({ ...command, type: "hilo_command", requestId }),
  });
}
