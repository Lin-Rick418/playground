import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  closeHttpServer,
  installProcessShutdownHandlers,
  withShutdownTimeout,
} from "./graceful-shutdown.js";

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function waitForLine(
  lines: ReturnType<typeof createInterface>,
  child: ReturnType<typeof spawn>,
  prefix: string,
) {
  return new Promise<string>((resolve, reject) => {
    const onLine = (line: string) => {
      if (!line.startsWith(prefix)) return;
      cleanup();
      resolve(line);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Fixture exited before ${prefix}: code=${code}, signal=${signal}`));
    };
    const cleanup = () => {
      lines.off("line", onLine);
      child.off("exit", onExit);
    };

    lines.on("line", onLine);
    child.once("exit", onExit);
  });
}

test("shutdown timeout fails instead of waiting forever", async () => {
  await assert.rejects(
    withShutdownTimeout(new Promise<never>(() => undefined), 5),
    /exceeded 5ms/,
  );
});

test("HTTP shutdown waits for an in-flight request to finish", async () => {
  let notifyRequestStarted!: () => void;
  let releaseResponse!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    notifyRequestStarted = resolve;
  });
  const responseBlocked = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const server = createServer(async (_request, response) => {
    notifyRequestStarted();
    await responseBlocked;
    response.end("complete");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const responsePending = fetch(`http://127.0.0.1:${address.port}`, {
    headers: { connection: "close" },
  });
  await requestStarted;

  let closed = false;
  const closing = closeHttpServer(server).then(() => {
    closed = true;
  });
  await nextTurn();
  assert.equal(closed, false);

  releaseResponse();
  const response = await responsePending;
  assert.equal(await response.text(), "complete");
  await closing;
  assert.equal(closed, true);
});

test("SIGTERM lets an in-flight request finish before the process exits", async (context) => {
  const fixture = new URL("./fixtures/graceful-shutdown-process.ts", import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", fixture.pathname], {
    cwd: new URL("../../../", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const lines = createInterface({ input: child.stdout });
  const listening = await waitForLine(lines, child, "LISTEN ");
  const port = Number(listening.slice("LISTEN ".length));
  const requestStarted = waitForLine(lines, child, "REQUEST_STARTED");
  const responsePending = fetch(`http://127.0.0.1:${port}`, {
    headers: { connection: "close" },
  });
  await requestStarted;
  const exited = once(child, "exit");
  child.kill("SIGTERM");

  const response = await responsePending;
  assert.equal(await response.text(), "complete");
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  lines.close();
});

test("signals trigger one graceful shutdown and exit zero", async () => {
  const events = new EventEmitter();
  const exits: number[] = [];
  let shutdownCount = 0;
  const removeHandlers = installProcessShutdownHandlers({
    serviceName: "test-service",
    shutdown: async () => {
      shutdownCount += 1;
    },
    timeoutMs: 100,
    logger: { info() {}, error() {} },
    eventSource: events,
    exit: (code) => exits.push(code),
  });

  events.emit("SIGTERM");
  await nextTurn();

  assert.equal(shutdownCount, 1);
  assert.deepEqual(exits, [0]);
  removeHandlers();
});

test("fatal errors are logged and escalate an in-progress shutdown to exit one", async () => {
  const events = new EventEmitter();
  const exits: number[] = [];
  const errors: unknown[][] = [];
  let releaseShutdown!: () => void;
  const shutdownBlocked = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });
  let shutdownCount = 0;

  const removeHandlers = installProcessShutdownHandlers({
    serviceName: "test-service",
    shutdown: async () => {
      shutdownCount += 1;
      await shutdownBlocked;
    },
    timeoutMs: 100,
    logger: { info() {}, error: (...args) => errors.push(args) },
    eventSource: events,
    exit: (code) => exits.push(code),
  });

  events.emit("SIGTERM");
  events.emit("unhandledRejection", new Error("fatal"));
  releaseShutdown();
  await nextTurn();

  assert.equal(shutdownCount, 1);
  assert.equal(errors.some((entry) => JSON.stringify(entry).includes("unhandledRejection")), true);
  assert.deepEqual(exits, [1]);
  removeHandlers();
});
