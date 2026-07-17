import { createServer } from "node:http";
import {
  closeHttpServer,
  installProcessShutdownHandlers,
} from "../graceful-shutdown.js";

const server = createServer(async (_request, response) => {
  console.log("REQUEST_STARTED");
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  response.setHeader("Connection", "close");
  response.end("complete");
});

installProcessShutdownHandlers({
  serviceName: "shutdown-fixture",
  timeoutMs: 2_000,
  shutdown: async () => closeHttpServer(server),
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP port");
  }
  console.log(`LISTEN ${address.port}`);
});
