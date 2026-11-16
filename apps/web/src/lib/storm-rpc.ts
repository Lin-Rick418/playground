import {
  stormCommandSchema,
  type StormCommand,
  type StormMutationResponse,
} from "@baccarat/contracts";
import { createGameRpc } from "./game-rpc";

export type StormTransport = (
  command: Omit<StormCommand, "type" | "requestId">,
) => Promise<StormMutationResponse>;

export function createStormRpc(getSocket: () => WebSocket | null) {
  return createGameRpc<Omit<StormCommand, "type" | "requestId">, StormMutationResponse>(getSocket, {
    name: "Storm",
    buildMessage: (command, requestId) =>
      stormCommandSchema.parse({ ...command, type: "storm_command", requestId }),
  });
}
