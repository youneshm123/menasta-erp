const test = require('node:test');
const assert = require('node:assert/strict');
const { computeFuelTotals } = require('../lib/shiftCalc');

test('empty or missing readings yield zero totals', () => {
  assert.deepEqual(computeFuelTotals([]), { totalLiters: 0, totalFuel: 0 });
  assert.deepEqual(computeFuelTotals(undefined), { totalLiters: 0, totalFuel: 0 });
});

test('computes liters and revenue from a single pump', () => {
  const r = computeFuelTotals([{ start_val: 100, end_val: 150, price_per_liter: 10 }]);
  assert.equal(r.totalLiters, 50);
  assert.equal(r.totalFuel, 500);
});

test('clamps a non-positive meter delta to zero', () => {
  const r = computeFuelTotals([{ start_val: 200, end_val: 100, price_per_liter: 10 }]);
  assert.equal(r.totalLiters, 0);
  assert.equal(r.totalFuel, 0);
});

test('sums multiple pumps', () => {
  const r = computeFuelTotals([
    { start_val: 100, end_val: 150, price_per_liter: 10 }, // 50 L, 500
    { start_val: 0,   end_val: 20,  price_per_liter: 5  }, //  20 L, 100
  ]);
  assert.equal(r.totalLiters, 70);
  assert.equal(r.totalFuel, 600);
});

test('coerces string-typed values (as pg returns numerics)', () => {
  const r = computeFuelTotals([{ start_val: '100', end_val: '150', price_per_liter: '2.5' }]);
  assert.equal(r.totalLiters, 50);
  assert.equal(r.totalFuel, 125);
});
