import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedIntervalRunner } from "./serialized-interval.js";

test("stopping waits for the active task and prevents later ticks", async () => {
  let runCount = 0;
  let releaseSecondRun!: () => void;
  let notifySecondRun!: () => void;
  const secondRunStarted = new Promise<void>((resolve) => {
    notifySecondRun = resolve;
  });
  const secondRunBlocked = new Promise<void>((resolve) => {
    releaseSecondRun = resolve;
  });
  const runner = createSerializedIntervalRunner(async () => {
    runCount += 1;
    if (runCount === 2) {
      notifySecondRun();
      await secondRunBlocked;
    }
  }, 1);

  await runner.start();
  await secondRunStarted;
  let stopped = false;
  const stopping = runner.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseSecondRun();
  await stopping;
  const countAfterStop = runCount;
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(runCount, countAfterStop);
});
