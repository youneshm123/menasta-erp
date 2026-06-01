// Pure analytics helpers — no DB, no I/O. Unit-tested in test/analytics.test.js.
//
// Used by routes/dashboard.js (GET /analytics) and the export endpoints to turn
// raw aggregate rows into the period-comparison shape the dashboard renders.

// Percentage change from `prev` to `curr`, rounded to 1 decimal.
// Returns null when a percentage is undefined/meaningless (no prior value to
// compare against), so the UI can show the value without a misleading badge.
function pctDelta(curr, prev) {
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  if (p === 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

// Fill a contiguous daily series of length `days` ending on `today` (inclusive),
// inserting zeros for days with no data. `rows` is [{ day:'YYYY-MM-DD', [valueKey]:n }].
// Date math is done in UTC to match the DB's ::date grouping on TIMESTAMPTZ columns.
function fillDailySeries(rows, days, valueKey = 'revenue', today = new Date()) {
  const map = new Map(
    (rows || []).map(r => [String(r.day).slice(0, 10), Number(r[valueKey]) || 0])
  );
  const out = [];
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, [valueKey]: map.get(key) || 0 });
  }
  return out;
}

// Estimated margin = revenue - liters * blended unit cost.
// Returns null when there is no cost basis (so the UI shows "—" rather than a
// figure that looks like pure revenue).
function estMargin(revenue, liters, avgCost) {
  const c = Number(avgCost);
  if (!Number.isFinite(c) || c <= 0) return null;
  const r = Number(revenue) || 0;
  const l = Number(liters) || 0;
  return Math.round((r - l * c) * 100) / 100;
}

module.exports = { pctDelta, fillDailySeries, estMargin };
