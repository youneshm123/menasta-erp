const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Exact fuel cost of goods SOLD, bucketed by month, using the same automatic
// FIFO layers as /stock (opening stock + priced deliveries, legacy fallback).
// FIFO must be walked chronologically over ALL history so layer consumption is
// correct; we then keep the buckets for whatever year the caller asked for.
async function computeMonthlyFuelCost() {
  const { rows: fuels } = await pool.query('SELECT id, cost_per_liter FROM fuel_types WHERE is_active=1');

  const { rows: avgRows } = await pool.query(`
    SELECT c.fuel_type_id AS ftid,
           COALESCE(SUM(cl.litres_recus*cl.prix_unitaire),0) AS cost,
           COALESCE(SUM(cl.litres_recus),0) AS liters
    FROM cuve_livraisons cl JOIN cuves c ON c.id=cl.cuve_id GROUP BY c.fuel_type_id`);
  const avgMap = {};
  avgRows.forEach(r => { const L = parseFloat(r.liters); avgMap[r.ftid] = L > 0 ? parseFloat(r.cost) / L : 0; });
  const legacyCost = {};
  fuels.forEach(f => { const c = parseFloat(f.cost_per_liter); legacyCost[f.id] = c > 0 ? c : (avgMap[f.id] || 0); });

  const opening = {};
  (await pool.query("SELECT fuel_type_id AS ftid, liters, cost_per_liter AS c, to_char(since_date,'YYYY-MM-DD') AS s FROM fuel_opening_stock")).rows
    .forEach(o => { opening[o.ftid] = { liters: parseFloat(o.liters), cost: parseFloat(o.c), since: o.s }; });

  const deliveriesByFuel = {};
  (await pool.query(`
    SELECT c.fuel_type_id AS ftid, to_char(cl.livraison_date,'YYYY-MM-DD') AS d,
           cl.litres_recus AS liters, cl.prix_unitaire AS cost
    FROM cuve_livraisons cl JOIN cuves c ON c.id=cl.cuve_id
    WHERE cl.prix_unitaire IS NOT NULL AND cl.litres_recus > 0
    ORDER BY cl.livraison_date, cl.id`)).rows
    .forEach(r => (deliveriesByFuel[r.ftid] = deliveriesByFuel[r.ftid] || []).push({ date: r.d, liters: parseFloat(r.liters), cost: parseFloat(r.cost) }));

  const { rows: allDay } = await pool.query(`
    SELECT to_char(s.opened_at,'YYYY-MM-DD') AS d, p.fuel_type_id AS ftid,
           COALESCE(SUM(pr_end.meter_value - pr_start.meter_value),0) AS liters
    FROM pumps p
    JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end' AND pr_end.shift_id=pr_start.shift_id
    JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
    GROUP BY 1, 2 ORDER BY 1`);

  function makeConsumer(ls, legacy) {
    let cursor = 0;
    return {
      consume(day, qty) {
        let avail = 0; for (const l of ls) if (l.date <= day) avail += l.liters;
        const usable = Math.min(qty, Math.max(0, avail - cursor));
        let cost = 0, off = 0;
        for (const l of ls) {
          const lo = Math.max(cursor, off), hi = Math.min(cursor + usable, off + l.liters);
          if (hi > lo) cost += (hi - lo) * l.cost;
          off += l.liters;
          if (off >= cursor + usable) break;
        }
        cursor += usable;
        const overflow = qty - usable;
        if (overflow > 0) cost += overflow * legacy;
        return cost;
      }
    };
  }

  const consumers = {};
  for (const f of fuels) {
    const op = opening[f.id];
    const ls = [];
    if (op) ls.push({ date: op.since, liters: op.liters, cost: op.cost });
    for (const dlv of (deliveriesByFuel[f.id] || [])) if (!op || dlv.date >= op.since) ls.push(dlv);
    if (!ls.length) continue;
    ls.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    consumers[f.id] = makeConsumer(ls, legacyCost[f.id] || (op ? op.cost : 0));
  }

  const byMonth = {};
  for (const r of allDay) {
    const ftid = r.ftid, liters = Math.max(0, parseFloat(r.liters)), day = r.d, month = day.slice(0, 7);
    const cost = consumers[ftid] ? consumers[ftid].consume(day, liters) : liters * (legacyCost[ftid] || 0);
    byMonth[month] = (byMonth[month] || 0) + cost;
  }
  return byMonth;
}

router.get('/monthly', requireAuth, wrap(async (req, res) => {
  const year = String(req.query.year || new Date().getFullYear());

  const { rows: months } = await pool.query(`
    SELECT
      TO_CHAR(opened_at,'YYYY-MM') as month,
      COUNT(*) as shift_count,
      COALESCE(SUM(total_fuel_revenue),0)    as fuel_revenue,
      COALESCE(SUM(total_credit_deducted),0) as credits,
      COALESCE(SUM(total_product_sales),0)   as products,
      COALESCE(SUM(net_cash),0)              as net_cash,
      COALESCE(SUM(total_liters_sold),0)     as liters_sold
    FROM shifts
    WHERE status='closed' AND TO_CHAR(opened_at,'YYYY')=$1
    GROUP BY TO_CHAR(opened_at,'YYYY-MM') ORDER BY month DESC
  `, [year]);

  const { rows: expenses } = await pool.query(`
    SELECT TO_CHAR(expense_date,'YYYY-MM') as month, COALESCE(SUM(amount),0) as total
    FROM expenses WHERE TO_CHAR(expense_date,'YYYY')=$1
    GROUP BY TO_CHAR(expense_date,'YYYY-MM')
  `, [year]);
  const expMap = {};
  expenses.forEach(e => { expMap[e.month] = parseFloat(e.total); });

  const fuelCostByMonth = await computeMonthlyFuelCost();

  const result = months.map(m => {
    const fuel_revenue = parseFloat(m.fuel_revenue);
    const fuel_cost    = +(fuelCostByMonth[m.month] || 0).toFixed(2);
    const gross_margin = +(fuel_revenue - fuel_cost).toFixed(2);
    const exp          = expMap[m.month] || 0;
    return {
      month:        m.month,
      shift_count:  parseInt(m.shift_count),
      fuel_revenue,
      credits:      parseFloat(m.credits),
      products:     parseFloat(m.products),
      net_cash:     parseFloat(m.net_cash),
      liters_sold:  parseFloat(m.liters_sold),
      fuel_cost,
      gross_margin,
      expenses:     exp,
      // Real profit = fuel gross margin (revenue − FIFO cost of fuel sold) − expenses.
      profit:       +(gross_margin - exp).toFixed(2),
    };
  });

  res.json(result);
}));

router.get('/years', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT DISTINCT TO_CHAR(opened_at,'YYYY') as y FROM shifts ORDER BY y DESC`);
  res.json(rows.map(r => r.y));
}));

module.exports = router;
