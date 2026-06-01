const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const { pctDelta, fillDailySeries, estMargin } = require('../lib/analytics');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', requireAuth, wrap(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: [openShift] } = await pool.query("SELECT * FROM shifts WHERE status='open'");

  const { rows: [tr] } = await pool.query(`
    SELECT COALESCE(SUM(total_fuel_revenue),0) as fuel,
           COALESCE(SUM(total_product_sales),0) as products,
           COALESCE(SUM(total_credit_deducted),0) as credits,
           COALESCE(SUM(net_cash),0) as net,
           COALESCE(SUM(total_liters_sold),0) as liters
    FROM shifts WHERE date(opened_at)=$1 AND status='closed'
  `, [today]);

  const { rows: [{ t: debt }] }    = await pool.query('SELECT COALESCE(SUM(balance_due),0) as t FROM credit_clients WHERE is_active=1');
  const { rows: [{ c: low }] }     = await pool.query('SELECT COUNT(*) as c FROM products WHERE stock_qty<=stock_min AND is_active=1');
  const { rows: [{ c: clients }] } = await pool.query('SELECT COUNT(*) as c FROM credit_clients WHERE is_active=1');

  res.json({
    open_shift:    openShift || null,
    today: {
      fuel_revenue:    parseFloat(tr.fuel),
      product_revenue: parseFloat(tr.products),
      credit_deducted: parseFloat(tr.credits),
      net_cash:        parseFloat(tr.net),
      liters_sold:     parseFloat(tr.liters),
    },
    total_debt:    parseFloat(debt),
    low_stock:     parseInt(low),
    total_clients: parseInt(clients),
  });
}));

router.get('/weekly', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT date(opened_at) as day,
      COALESCE(SUM(total_fuel_revenue),0) as fuel,
      COALESCE(SUM(total_product_sales),0) as products,
      COALESCE(SUM(net_cash),0) as net
    FROM shifts
    WHERE date(opened_at) >= date('now', '-6 days') AND status='closed'
    GROUP BY day ORDER BY day
  `);
  res.json(rows);
}));

router.get('/fuel-split', requireAuth, wrap(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT ft.name, ft.color_hex,
      COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as liters
    FROM fuel_types ft
    JOIN pumps p          ON p.fuel_type_id=ft.id
    JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id=p.id   AND pr_end.reading_type='end'
                                AND pr_end.shift_id=pr_start.shift_id
    JOIN shifts s ON s.id=pr_start.shift_id
    WHERE date(s.opened_at)=$1 AND s.status='closed'
    GROUP BY ft.id, ft.name, ft.color_hex
  `, [today]);
  res.json(rows);
}));

// All-in-one home page summary — single DB round-trip bundle
router.get('/summary', requireAuth, wrap(async (_req, res) => {
  const [shifts, bank, cuves, credits, logs, weeklyRaw] = await Promise.all([
    pool.query('SELECT total_fuel_revenue, opened_at FROM shifts ORDER BY opened_at DESC LIMIT 1'),
    pool.query(`
      SELECT
        (SELECT COALESCE(initial_balance,0) FROM bank_settings WHERE id=1) +
        COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in')  THEN amount ELSE -amount END),0)
        AS total
      FROM bank_transactions
    `),
    pool.query('SELECT COALESCE(SUM(niveau_litres),0) as vol, COALESCE(SUM(capacite_max),0) as cap FROM (SELECT DISTINCT ON (cuve_id) cuve_id, niveau_litres FROM cuve_lectures ORDER BY cuve_id, lecture_date DESC) latest JOIN cuves c ON c.id=latest.cuve_id WHERE c.is_active=1'),
    pool.query("SELECT COALESCE(SUM(balance_due),0) as total, COUNT(*) as clients FROM credit_clients WHERE is_active=1 AND balance_due > 0"),
    pool.query('SELECT COUNT(*) as total FROM activity_logs'),
    pool.query(`
      SELECT (opened_at::date)::text as day,
             COALESCE(SUM(COALESCE(total_fuel_revenue,0)),0) as revenue
      FROM shifts
      WHERE opened_at >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY day ORDER BY day
    `),
  ]);

  const lastShift = shifts.rows[0];
  const lastShiftRevenue = lastShift ? (parseFloat(lastShift.total_fuel_revenue)||0) : 0;

  // Build 7-day array with zeros for missing days
  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    const found = weeklyRaw.rows.find(r => r.day === key);
    weekly.push({ day: key, revenue: found ? parseFloat(found.revenue) : 0 });
  }

  res.json({
    last_shift_revenue:  lastShiftRevenue,
    bank_balance:        parseFloat(bank.rows[0]?.total || 0),
    cuves_volume:        parseFloat(cuves.rows[0]?.vol  || 0),
    cuves_capacity:      parseFloat(cuves.rows[0]?.cap  || 0),
    credits_outstanding: parseFloat(credits.rows[0]?.total   || 0),
    credits_clients:     parseInt(credits.rows[0]?.clients   || 0),
    logs_total:          parseInt(logs.rows[0]?.total        || 0),
    weekly_revenue:      weekly,
  });
}));

// Advanced analytics — period comparisons, 30-day trend, top credit clients.
// Numbers come straight from shifts; fuel margin uses a blended purchase cost
// (fuel_deliveries + cuve_livraisons) and degrades to null when no cost is known.
router.get('/analytics', requireAuth, wrap(async (_req, res) => {
  const [agg, cost, trend, topClients] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_today,
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE - INTERVAL '1 day'
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_yesterday,
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_today,
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE - INTERVAL '1 day'
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_yesterday,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE)
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_mtd,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                       AND opened_at::date <= (CURRENT_DATE - INTERVAL '1 month')::date
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_last_month,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE)
              THEN COALESCE(total_fuel_revenue,0) ELSE 0 END),0) AS fuel_rev_mtd,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE)
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_mtd,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                       AND opened_at::date <= (CURRENT_DATE - INTERVAL '1 month')::date
              THEN COALESCE(total_fuel_revenue,0) ELSE 0 END),0) AS fuel_rev_last_month,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                       AND opened_at::date <= (CURRENT_DATE - INTERVAL '1 month')::date
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_last_month
      FROM shifts
    `),
    pool.query(`
      SELECT CASE WHEN SUM(qty) > 0 THEN SUM(cost*qty)/SUM(qty) ELSE NULL END AS avg_cost
      FROM (
        SELECT cost_per_liter AS cost, quantity_liters AS qty
          FROM fuel_deliveries WHERE cost_per_liter IS NOT NULL AND quantity_liters > 0
        UNION ALL
        SELECT prix_unitaire AS cost, litres_recus AS qty
          FROM cuve_livraisons WHERE prix_unitaire IS NOT NULL AND litres_recus > 0
      ) x
    `),
    pool.query(`
      SELECT opened_at::date AS day,
             COALESCE(SUM(COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0)),0) AS revenue
      FROM shifts
      WHERE opened_at >= CURRENT_DATE - INTERVAL '29 days'
      GROUP BY day ORDER BY day
    `),
    pool.query(`
      SELECT name, COALESCE(company,'') AS company,
             COALESCE(balance_due,0) AS balance, credit_limit
      FROM credit_clients
      WHERE is_active=1 AND balance_due > 0
      ORDER BY balance_due DESC
      LIMIT 5
    `),
  ]);

  const a = agg.rows[0] || {};
  const num = v => parseFloat(v) || 0;
  const avgCost = (cost.rows[0] && cost.rows[0].avg_cost != null) ? parseFloat(cost.rows[0].avg_cost) : null;

  const revToday = num(a.rev_today), revYest = num(a.rev_yesterday);
  const revMtd   = num(a.rev_mtd),   revLast = num(a.rev_last_month);
  const litToday = num(a.liters_today), litYest = num(a.liters_yesterday);
  const litMtd   = num(a.liters_mtd),   litLast = num(a.liters_last_month);

  const marginMtd  = estMargin(num(a.fuel_rev_mtd),        litMtd,  avgCost);
  const marginLast = estMargin(num(a.fuel_rev_last_month), litLast, avgCost);

  res.json({
    revenue: {
      today: revToday, yesterday: revYest, delta_pct: pctDelta(revToday, revYest),
      mtd: revMtd, last_month_same: revLast, mtd_delta_pct: pctDelta(revMtd, revLast),
    },
    liters: {
      today: litToday, yesterday: litYest, delta_pct: pctDelta(litToday, litYest),
      mtd: litMtd, last_month_same: litLast, mtd_delta_pct: pctDelta(litMtd, litLast),
    },
    margin: {
      mtd: marginMtd, last_month: marginLast,
      delta_pct: (marginMtd != null && marginLast != null) ? pctDelta(marginMtd, marginLast) : null,
      avg_cost_per_liter: avgCost,
    },
    trend_30d: fillDailySeries(trend.rows, 30),
    top_credit_clients: topClients.rows.map(r => ({
      name: r.name,
      company: r.company || '',
      balance: num(r.balance),
      credit_limit: r.credit_limit != null ? num(r.credit_limit) : null,
    })),
  });
}));

module.exports = router;
