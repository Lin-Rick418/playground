import {
  blackjackCommandSchema,
  type BlackjackCommand,
  type BlackjackMutationResponse,
} from "@baccarat/contracts";
import { createGameRpc } from "./game-rpc";

export type BlackjackTransport = (
  command: Omit<BlackjackCommand, "type" | "requestId">,
) => Promise<BlackjackMutationResponse>;

export function createBlackjackRpc(getSocket: () => WebSocket | null) {
  return createGameRpc<Omit<BlackjackCommand, "type" | "requestId">, BlackjackMutationResponse>(
    getSocket,
    {
      name: "Blackjack",
      buildMessage: (command, requestId) =>
        blackjackCommandSchema.parse({ ...command, type: "blackjack_command", requestId }),
    },
  );
}
