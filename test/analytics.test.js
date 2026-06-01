const test = require('node:test');
const assert = require('node:assert/strict');
const { pctDelta, fillDailySeries, estMargin } = require('../lib/analytics');

// ── pctDelta ───────────────────────────────────────────────────
test('pctDelta computes a positive change', () => {
  assert.equal(pctDelta(108, 100), 8);
});

test('pctDelta computes a negative change', () => {
  assert.equal(pctDelta(96, 100), -4);
});

test('pctDelta rounds to one decimal', () => {
  assert.equal(pctDelta(133, 100), 33);
  assert.equal(pctDelta(100.5, 100), 0.5);
  assert.equal(pctDelta(2, 3), -33.3);
});

test('pctDelta returns null when prior value is zero (no baseline)', () => {
  assert.equal(pctDelta(500, 0), null);
  assert.equal(pctDelta(0, 0), null);
});

test('pctDelta coerces null/undefined/strings safely', () => {
  assert.equal(pctDelta(null, 100), -100);
  assert.equal(pctDelta('108', '100'), 8);
  assert.equal(pctDelta(undefined, 50), -100);
});

// ── fillDailySeries ────────────────────────────────────────────
test('fillDailySeries returns exactly `days` entries ending today', () => {
  const today = new Date('2026-06-01T12:00:00Z');
  const out = fillDailySeries([], 7, 'revenue', today);
  assert.equal(out.length, 7);
  assert.equal(out[6].day, '2026-06-01');
  assert.equal(out[0].day, '2026-05-26');
});

test('fillDailySeries fills zeros for missing days and keeps known values', () => {
  const today = new Date('2026-06-01T12:00:00Z');
  const rows = [
    { day: '2026-05-30', revenue: 1200 },
    { day: '2026-06-01', revenue: 999 },
  ];
  const out = fillDailySeries(rows, 3, 'revenue', today);
  assert.deepEqual(out, [
    { day: '2026-05-30', revenue: 1200 },
    { day: '2026-05-31', revenue: 0 },
    { day: '2026-06-01', revenue: 999 },
  ]);
});

test('fillDailySeries tolerates timestamp-shaped day keys and string numbers', () => {
  const today = new Date('2026-06-02T00:00:00Z');
  const rows = [{ day: '2026-06-02T00:00:00.000Z', revenue: '42' }];
  const out = fillDailySeries(rows, 1, 'revenue', today);
  assert.deepEqual(out, [{ day: '2026-06-02', revenue: 42 }]);
});

test('fillDailySeries supports a custom value key', () => {
  const today = new Date('2026-06-01T12:00:00Z');
  const rows = [{ day: '2026-06-01', liters: 3000 }];
  const out = fillDailySeries(rows, 1, 'liters', today);
  assert.deepEqual(out, [{ day: '2026-06-01', liters: 3000 }]);
});

test('fillDailySeries handles a 30-day window across a month boundary', () => {
  const today = new Date('2026-06-01T12:00:00Z');
  const out = fillDailySeries([], 30, 'revenue', today);
  assert.equal(out.length, 30);
  assert.equal(out[0].day, '2026-05-03');
  assert.equal(out[29].day, '2026-06-01');
});

// ── estMargin ──────────────────────────────────────────────────
test('estMargin subtracts blended cost of liters from revenue', () => {
  // 1000 L sold for 11000 DH revenue, blended cost 9 DH/L → margin 2000
  assert.equal(estMargin(11000, 1000, 9), 2000);
});

test('estMargin returns null without a usable cost basis', () => {
  assert.equal(estMargin(11000, 1000, null), null);
  assert.equal(estMargin(11000, 1000, 0), null);
  assert.equal(estMargin(11000, 1000, undefined), null);
  assert.equal(estMargin(11000, 1000, NaN), null);
});

test('estMargin rounds to two decimals', () => {
  assert.equal(estMargin(100, 3, 9.999), 100 - Math.round(3 * 9.999 * 100) / 100);
});
