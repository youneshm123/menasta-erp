const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChartSvg, niceMax, fmtShort, normalize } = require('../public/js/chart.js');

// ── niceMax: rounds a max up to a 1/2/5 × 10ⁿ axis ceiling ─────────────
test('niceMax picks a clean axis ceiling', () => {
  assert.equal(niceMax(20), 20);
  assert.equal(niceMax(18), 20);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(2500), 5000);
  assert.equal(niceMax(120), 200);
});

test('niceMax guards zero / negative (never divides by zero)', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
});

// ── fmtShort: compact human labels ─────────────────────────────────────
test('fmtShort abbreviates thousands and millions', () => {
  assert.equal(fmtShort(1234), '1.2k');
  assert.equal(fmtShort(1000), '1k');
  assert.equal(fmtShort(12000), '12k');
  assert.equal(fmtShort(2500000), '2.5M');
  assert.equal(fmtShort(999), '999');
  assert.equal(fmtShort(50), '50');
});

// ── normalize: defensive parsing of the AI-supplied spec ───────────────
test('normalize caps the series at 12 points', () => {
  const series = Array.from({ length: 15 }, (_, i) => ({ label: 'd' + i, value: i }));
  assert.equal(normalize({ series }).points.length, 12);
});

test('normalize coerces numeric strings and junk to numbers', () => {
  const pts = normalize({ series: [{ label: 'a', value: '1500' }, { label: 'b', value: null }, { label: 'c', value: 'abc' }] }).points;
  assert.equal(pts[0].value, 1500);
  assert.equal(pts[1].value, 0);
  assert.equal(pts[2].value, 0);
});

test('normalize falls back to a bar for unknown types', () => {
  assert.equal(normalize({ type: 'pie', series: [] }).type, 'bar');
  assert.equal(normalize({ type: 'LINE', series: [] }).type, 'line');
});

// ── bar chart geometry ─────────────────────────────────────────────────
test('bar chart scales bar heights against a nice axis max', () => {
  const svg = buildChartSvg({
    type: 'bar', title: 'Ventes', unit: 'MAD',
    series: [{ label: 'Lun', value: 10 }, { label: 'Mar', value: 20 }],
  });
  assert.ok(svg.startsWith('<svg'));
  assert.match(svg, /viewBox="0 0 480 248"/);
  assert.match(svg, /Ventes \(MAD\)/);
  const heights = [...svg.matchAll(/<rect class="cbar"[^>]*height="([\d.]+)"/g)].map(m => +m[1]);
  // top = niceMax(20) = 20, plotH = 248 - 30 - 40 = 178
  // Mar(20) -> full height 178, Lun(10) -> half 89, in source order.
  assert.deepEqual(heights, [89, 178]);
});

test('bar chart renders one bar per data point', () => {
  const svg = buildChartSvg({ type: 'bar', series: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { label: 'c', value: 3 }] });
  assert.equal((svg.match(/<rect class="cbar"/g) || []).length, 3);
});

// ── line chart ─────────────────────────────────────────────────────────
test('line chart draws a polyline, an area fill and one dot per point', () => {
  const svg = buildChartSvg({
    type: 'line', title: 'Évolution',
    series: [{ label: 'j1', value: 5 }, { label: 'j2', value: 15 }, { label: 'j3', value: 10 }],
  });
  assert.match(svg, /<polyline class="cline"/);
  assert.match(svg, /<polygon class="carea"/);
  assert.equal((svg.match(/<circle class="cdot"/g) || []).length, 3);
});

// ── horizontal bar (rankings) ──────────────────────────────────────────
test('hbar scales widths against the max value', () => {
  const svg = buildChartSvg({
    type: 'hbar', title: 'Top clients',
    series: [{ label: 'X', value: 30 }, { label: 'Y', value: 10 }],
  });
  // plotW = 480 - 96 - 40 = 344; X(30) is the max -> full width 344.
  assert.match(svg, /<rect class="cbar"[^>]*width="344"/);
  assert.match(svg, />X</);
  assert.match(svg, />Y</);
});

// ── robustness: empty, all-zero, hostile input ─────────────────────────
test('empty series renders a friendly placeholder, not a broken chart', () => {
  const svg = buildChartSvg({ type: 'bar', series: [] });
  assert.match(svg, /Aucune donnée/);
  assert.doesNotMatch(svg, /NaN/);
});

test('all-zero values never produce NaN coordinates', () => {
  const svg = buildChartSvg({ type: 'line', series: [{ label: 'a', value: 0 }, { label: 'b', value: 0 }] });
  assert.doesNotMatch(svg, /NaN/);
  assert.match(svg, /<polyline class="cline"/);
});

test('labels and titles are HTML-escaped (no script injection via AI output)', () => {
  const svg = buildChartSvg({
    type: 'bar', title: '<script>alert(1)</script>',
    series: [{ label: '<img src=x onerror=alert(1)>', value: 5 }],
  });
  assert.ok(!svg.includes('<script>'), 'raw <script> must not appear');
  assert.ok(!svg.includes('onerror=alert'), 'raw event handler must not appear');
  assert.match(svg, /&lt;script&gt;/);
});

test('long labels are truncated with an ellipsis', () => {
  const svg = buildChartSvg({ type: 'bar', series: [{ label: 'ABCDEFGHIJKL', value: 5 }] });
  assert.match(svg, /…/);
});

test('garbage input degrades gracefully to an empty-state chart', () => {
  assert.match(buildChartSvg(null), /Aucune donnée/);
  assert.match(buildChartSvg(undefined), /Aucune donnée/);
  assert.match(buildChartSvg('nonsense'), /Aucune donnée/);
});
