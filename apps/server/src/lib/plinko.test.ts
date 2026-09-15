import assert from "node:assert/strict";
import test from "node:test";
import { toMinorUnits } from "@baccarat/contracts";
import {
  generatePlinkoPath,
  getPlinkoTable,
  plinkoPayout,
  plinkoTables,
  plinkoWeights,
} from "../modules/plinko/math.js";

test("all 27 Plinko paytables and actual payouts meet the approved 95–96% RTP", () => {
  assert.equal(plinkoTables.length, 27);
  assert.equal(new Set(plinkoTables.map(({ rows, risk }) => `${rows}:${risk}`)).size, 27);
  for (const table of plinkoTables) {
    const weights = plinkoWeights(table.rows);
    const paths = 2n ** BigInt(table.rows);
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
  assert.equal(getPlinkoTable(16, "low").multipliers[0], 15.4345);
  assert.equal(getPlinkoTable(16, "medium").multipliers[0], 106.1236);
  const high = getPlinkoTable(16, "high");
  assert.equal(high.multipliers[0], 964.8761);
  assert.equal(plinkoPayout(100, high.units[0]!), 96487.61);
  assert.equal(plinkoPayout(100, high.units[8]!), 19.3);
  assert.equal(plinkoPayout(5000, high.units[16]!), 4824380.5);
});

test("every possible path has the expected binomial slot distribution", () => {
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
