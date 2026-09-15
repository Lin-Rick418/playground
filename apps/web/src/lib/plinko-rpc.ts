import {
  plinkoCommandSchema,
  type PlinkoCommand,
  type PlinkoMutationResponse,
} from "@baccarat/contracts";
import { createGameRpc } from "./game-rpc";
export type PlinkoTransport = (
  command: Omit<PlinkoCommand, "type" | "requestId">,
) => Promise<PlinkoMutationResponse>;
export function createPlinkoRpc(getSocket: () => WebSocket | null) {
  return createGameRpc<Omit<PlinkoCommand, "type" | "requestId">, PlinkoMutationResponse>(
    getSocket,
    {
      name: "Plinko",
      buildMessage: (command, requestId) =>
        plinkoCommandSchema.parse({ ...command, type: "plinko_command", requestId }),
    },
  );
}
