import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  assertRuntimeVersions,
} from "./verify-runtime.mjs";

test("accepts only the pinned Node and npm versions", () => {
  assert.doesNotThrow(() => assertRuntimeVersions({ node: REQUIRED_NODE_VERSION, npm: REQUIRED_NPM_VERSION }));
  assert.throws(
    () => assertRuntimeVersions({ node: "20.0.0", npm: REQUIRED_NPM_VERSION }),
    /Node 22\.19\.0 required/,
  );
  assert.throws(
    () => assertRuntimeVersions({ node: REQUIRED_NODE_VERSION, npm: "11.0.0" }),
    /npm 10\.9\.3 required/,
  );
});
