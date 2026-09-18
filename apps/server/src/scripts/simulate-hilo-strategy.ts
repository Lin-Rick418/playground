import { simulateStrategy, STRATEGY_TARGET } from "../lib/hilo-strategy-simulation.js";

const rounds = Number(process.argv[2] ?? 1_000_000);
const target = process.argv[3] === undefined ? STRATEGY_TARGET : BigInt(process.argv[3]);
const startedAt = new Date().toISOString();
const start = performance.now();
const result = simulateStrategy(rounds, target);
process.stdout.write(
  `${JSON.stringify({ startedAt, elapsedSeconds: (performance.now() - start) / 1000, ...result }, null, 2)}\n`,
);
