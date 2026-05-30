// Pure fuel computation from paired pump readings.
// Each reading: { start_val, end_val, price_per_liter }. A meter can only go up,
// so a non-positive delta contributes zero (guards against bad/rolled-back data).
function computeFuelTotals(readings) {
  let totalLiters = 0, totalFuel = 0;
  for (const r of readings || []) {
    const liters = Math.max(0, Number(r.end_val) - Number(r.start_val));
    totalLiters += liters;
    totalFuel   += liters * Number(r.price_per_liter);
  }
  return { totalLiters, totalFuel };
}

module.exports = { computeFuelTotals };
