import assert from "node:assert/strict";
import test from "node:test";
import { parseBuildMetadata } from "./build-metadata.js";

const validMetadata = {
  schemaVersion: 1,
  application: "baccarat-platform",
  version: "1.0.0",
  commitSha: "1234567890abcdef1234567890abcdef12345678",
  branch: "main",
  dirty: false,
  builtAt: "2026-07-16T04:00:00.000Z",
  nodeVersion: "22.19.0",
  npmVersion: "10.9.3",
};

test("parses complete build metadata with an exact commit SHA", () => {
  assert.deepEqual(parseBuildMetadata(validMetadata), validMetadata);
});

test("rejects missing or abbreviated build identity", () => {
  assert.throws(
    () => parseBuildMetadata({ ...validMetadata, commitSha: "1234567" }),
    /incomplete or invalid/,
  );
  assert.throws(
    () => parseBuildMetadata({ ...validMetadata, dirty: undefined }),
    /incomplete or invalid/,
  );
});
