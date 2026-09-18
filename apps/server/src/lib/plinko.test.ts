import assert from "node:assert/strict";
import test from "node:test";
import { toMinorUnits } from "@baccarat/contracts";
import {
  generatePlinkoPath,
  getPlinkoTable,
  plinkoPayout,
  plinkoTables,
  plinkoWeights,
  plinkoOutcomeWeights,
  plinkoV1Tables,
} from "../modules/plinko/math.js";

test("all 27 Plinko paytables and actual payouts meet the approved 95–96% RTP", () => {
  assert.equal(plinkoTables.length, 27);
  assert.equal(new Set(plinkoTables.map(({ rows, risk }) => `${rows}:${risk}`)).size, 27);
  for (const table of plinkoTables) {
    const weights = plinkoOutcomeWeights(table.rows);
    const paths =
      2n ** BigInt(table.rows) * (2n ** BigInt(table.rows) - 2n * BigInt(table.rows + 1));
    assert.equal(
      weights.reduce((a, b) => a + b, 0n),
      paths,
    );
    assert.equal(table.units.length, table.rows + 1);
    assert.deepEqual(table.units, [...table.units].reverse());
    // Check every supported stake, every slot, including real credited cents.
    for (let amount = 100; amount <= 5000; amount += 100) {
      let total = 0n;
      table.units.forEach((units, slot) => {
        assert.ok(Number.isSafeInteger(units) && units > 0);
        assert.equal(table.multipliers[slot], units / 10000);
        const cents = toMinorUnits(plinkoPayout(amount, units));
        assert.equal(cents * 10000n, BigInt(amount * 100) * BigInt(units));
        total += cents * weights[slot]!;
      });
      const wagered = BigInt(amount * 100) * paths;
      assert.ok(total * 100n >= wagered * 95n && total * 100n <= wagered * 96n);
      assert.ok(total * 100000n >= wagered * 95495n && total * 100000n <= wagered * 95505n);
      assert.equal(Number(total) / Number(wagered), table.rtp);
    }
  }
});

test("v1 edge and centre payouts match the approved 16-row examples", () => {
  const legacy = (risk: "low" | "medium" | "high") =>
    plinkoV1Tables.find((table) => table.rows === 16 && table.risk === risk)!;
  assert.equal(legacy("low").multipliers[0], 15.4345);
  assert.equal(legacy("medium").multipliers[0], 106.1236);
  const high = legacy("high");
  assert.equal(high.multipliers[0], 964.8761);
  assert.equal(plinkoPayout(100, high.units[0]!), 96487.61);
  assert.equal(plinkoPayout(100, high.units[8]!), 19.3);
  assert.equal(plinkoPayout(5000, high.units[16]!), 4824380.5);
});

test("v1 path counts are binomial and v2 paths remain valid", () => {
  for (let rows = 8; rows <= 16; rows++) {
    const slots = Array<bigint>(rows + 1).fill(0n);
    for (let bits = 0; bits < 2 ** rows; bits++) {
      let slot = 0;
      for (let row = 0; row < rows; row++) slot += (bits >> row) & 1;
      slots[slot]! += 1n;
    }
    assert.deepEqual(slots, plinkoWeights(rows));
    const path = generatePlinkoPath(rows);
    assert.equal(path.length, rows);
    assert.ok(path.every((direction) => direction === 0 || direction === 1));
  }
  assert.throws(() => generatePlinkoPath(7));
  assert.throws(() => getPlinkoTable(17, "low"));
  assert.throws(() => plinkoPayout(101, 10000));
});

test("v2 doubles the four edge probabilities, keeps symmetry, and preserves each table RTP", () => {
  for (let rows = 8; rows <= 16; rows++) {
    const old = plinkoWeights(rows);
    const weights = plinkoOutcomeWeights(rows);
    const originalTotal = 2n ** BigInt(rows);
    const total = weights.reduce((a, b) => a + b, 0n);
    assert.deepEqual(weights, [...weights].reverse());
    assert.ok(total > 0n && total < 2n ** 48n);
    for (const slot of [0, 1, rows - 1, rows])
      assert.equal(weights[slot]! * originalTotal, 2n * old[slot]! * total);
    for (let slot = 2; slot <= rows - 2; slot++) {
      assert.ok(weights[slot]! > 0n);
      assert.equal(weights[slot]! * old[2]!, weights[2]! * old[slot]!);
    }
    for (const legacy of plinkoV1Tables.filter((t) => t.rows === rows)) {
      const current = getPlinkoTable(rows, legacy.risk);
      const oldReturn = legacy.units.reduce((sum, units, k) => sum + BigInt(units) * old[k]!, 0n);
      const newReturn = current.units.reduce(
        (sum, units, k) => sum + BigInt(units) * weights[k]!,
        0n,
      );
      const difference = newReturn * originalTotal - oldReturn * total;
      // ROUND_HALF_UP of each multiplier can change the weighted mean by at most 0.00005.
      assert.ok(2n * (difference < 0n ? -difference : difference) <= total * originalTotal);
      assert.ok(current.units.every((units, k) => units > 0 && units <= legacy.units[k]!));
    }
  }
});

test("weighted draw covers both boundaries of every slot and generates a matching path", () => {
  for (let rows = 8; rows <= 16; rows++) {
    const weights = plinkoOutcomeWeights(rows);
    const total = Number(weights.reduce((a, b) => a + b, 0n));
    let start = 0;
    weights.forEach((weight, slot) => {
      for (const ticket of [start, start + Number(weight) - 1]) {
        for (const drawEnd of [false, true]) {
          let first = true;
          const path = generatePlinkoPath(rows, (max) => {
            if (first) {
              first = false;
              assert.equal(max, total);
              return ticket;
            }
            assert.ok(max >= 2 && max <= rows);
            return drawEnd ? max - 1 : 0;
          });
          assert.equal(path.length, rows);
          assert.ok(path.every((direction) => direction === 0 || direction === 1));
          assert.equal(
            path.reduce<number>((a, b) => a + b, 0),
            slot,
          );
        }
      }
      start += Number(weight);
    });
    assert.equal(start, total);
  }
});
