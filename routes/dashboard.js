const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

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
    FROM shifts WHERE opened_at::date=$1 AND status='closed'
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
    SELECT opened_at::date as day,
      COALESCE(SUM(total_fuel_revenue),0) as fuel,
      COALESCE(SUM(total_product_sales),0) as products,
      COALESCE(SUM(net_cash),0) as net
    FROM shifts
    WHERE opened_at::date >= CURRENT_DATE - INTERVAL '6 days' AND status='closed'
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
    WHERE s.opened_at::date=$1 AND s.status='closed'
    GROUP BY ft.id, ft.name, ft.color_hex
  `, [today]);
  res.json(rows);
}));

module.exports = router;
