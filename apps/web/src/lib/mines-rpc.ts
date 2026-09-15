import {
  minesCommandSchema,
  type MinesCommand,
  type MinesMutationResponse,
} from "@baccarat/contracts";
import { createGameRpc } from "./game-rpc";
export type MinesTransport = (
  command: Omit<MinesCommand, "type" | "requestId">,
) => Promise<MinesMutationResponse>;
export function createMinesRpc(getSocket: () => WebSocket | null) {
  return createGameRpc<Omit<MinesCommand, "type" | "requestId">, MinesMutationResponse>(getSocket, {
    name: "Mines",
    buildMessage: (command, requestId) =>
      minesCommandSchema.parse({ ...command, type: "mines_command", requestId }),
  });
}
