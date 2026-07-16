import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "./app.js";
import type { ApiErrorLogger } from "./lib/api-errors.js";

type ApiErrorEnvelope = {
  code: string;
  message: string;
  requestId: string;
};

describe("HTTP API error contract", () => {
  let server: Server;
  let baseUrl: string;
  const rejectionLogs: Parameters<ApiErrorLogger["warn"]>[0][] = [];
  const errorLogs: Parameters<ApiErrorLogger["error"]>[0][] = [];

  before(async () => {
    const app = createApp({
      logger: {
        warn(entry) {
          rejectionLogs.push(entry);
        },
        error(entry) {
          errorLogs.push(entry);
        },
      },
      registerAdditionalRoutes(testApp) {
        testApp.get("/test/internal", async () => {
          throw new Error("database-password=must-never-reach-client");
        });
        testApp.get("/test/non-error-throw", async () => {
          throw "non-error-internal-detail";
        });
        testApp.post("/test/conflict", async () => {
          throw Object.assign(new Error("duplicate key value violates unique constraint users_username_key"), {
            code: "23505",
          });
        });
      },
    });

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function readError(response: Response) {
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    const body = (await response.json()) as ApiErrorEnvelope;
    assert.deepEqual(Object.keys(body).sort(), ["code", "message", "requestId"]);
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    return body;
  }

  it("returns malformed JSON as a correlated 400 JSON error", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "test-malformed-json",
      },
      body: '{"username":',
    });
    const body = await readError(response);

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      code: "MALFORMED_JSON",
      message: "Malformed JSON request body",
      requestId: "test-malformed-json",
    });
    assert.deepEqual(
      rejectionLogs.find(({ requestId }) => requestId === "test-malformed-json"),
      {
        event: "http_request_rejected",
        requestId: "test-malformed-json",
        method: "POST",
        path: "/auth/login",
        statusCode: 400,
      },
    );
  });

  it("uses the same envelope for schema validation errors", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "test-validation",
      },
      body: "{}",
    });
    const body = await readError(response);

    assert.equal(response.status, 400);
    assert.equal(body.code, "VALIDATION_ERROR");
    assert.equal(body.requestId, "test-validation");
  });

  it("returns oversized parser input as a safe 413 envelope", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "test-payload-too-large",
      },
      body: JSON.stringify({ padding: "x".repeat(110 * 1024) }),
    });
    const body = await readError(response);

    assert.equal(response.status, 413);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
    assert.equal(body.requestId, "test-payload-too-large");
  });

  it("returns JSON instead of Express HTML for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/unknown-api-route`, {
      headers: {
        Accept: "text/html",
        "X-Request-Id": "test-not-found",
      },
    });
    const body = await readError(response);

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      code: "NOT_FOUND",
      message: "Route not found",
      requestId: "test-not-found",
    });
  });

  it("standardizes missing and invalid authentication errors", async () => {
    const missingResponse = await fetch(`${baseUrl}/game/history`, {
      headers: { "X-Request-Id": "test-auth-missing" },
    });
    const missingBody = await readError(missingResponse);
    assert.equal(missingResponse.status, 401);
    assert.equal(missingBody.code, "AUTHENTICATION_REQUIRED");

    const invalidResponse = await fetch(`${baseUrl}/game/history`, {
      headers: {
        Authorization: "Bearer definitely-not-a-jwt",
        "X-Request-Id": "test-auth-invalid",
      },
    });
    const invalidBody = await readError(invalidResponse);
    assert.equal(invalidResponse.status, 401);
    assert.equal(invalidBody.code, "INVALID_TOKEN");
  });

  it("maps database uniqueness races to a non-leaking conflict response", async () => {
    const response = await fetch(`${baseUrl}/test/conflict`, {
      method: "POST",
      headers: { "X-Request-Id": "test-conflict" },
    });
    const responseText = await response.text();
    const body = JSON.parse(responseText) as ApiErrorEnvelope;

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      code: "CONFLICT",
      message: "Resource already exists",
      requestId: "test-conflict",
    });
    assert.doesNotMatch(responseText, /users_username_key|duplicate key/);
  });

  it("does not leak internal details and writes a correlated structured log", async () => {
    const response = await fetch(`${baseUrl}/test/internal`, {
      headers: { "X-Request-Id": "test-internal" },
    });
    const responseText = await response.text();
    const body = JSON.parse(responseText) as ApiErrorEnvelope;

    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId: "test-internal",
    });
    assert.equal(response.headers.get("x-request-id"), "test-internal");
    assert.doesNotMatch(responseText, /database-password|must-never-reach-client/);

    const log = errorLogs.find(({ requestId }) => requestId === "test-internal");
    assert.ok(log);
    assert.equal(log.event, "http_request_failed");
    assert.equal(log.method, "GET");
    assert.equal(log.path, "/test/internal");
    assert.match(log.errorMessage, /must-never-reach-client/);
  });

  it("keeps the JSON contract when a route throws a non-Error value", async () => {
    const response = await fetch(`${baseUrl}/test/non-error-throw`, {
      headers: { "X-Request-Id": "test-non-error" },
    });
    const responseText = await response.text();
    const body = JSON.parse(responseText) as ApiErrorEnvelope;

    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId: "test-non-error",
    });
    assert.doesNotMatch(responseText, /non-error-internal-detail/);
  });

  it("replaces unsafe client correlation IDs with generated UUIDs", async () => {
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { "X-Request-Id": "contains spaces" },
    });
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 200);
    assert.match(requestId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
