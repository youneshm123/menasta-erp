const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

router.get('/', requireAuth, (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const openShift = db.prepare("SELECT * FROM shifts WHERE status='open'").get();

  const todayRevenue = db.prepare(`
    SELECT COALESCE(SUM(total_fuel_revenue),0) as fuel,
           COALESCE(SUM(total_product_sales),0) as products,
           COALESCE(SUM(total_credit_deducted),0) as credits,
           COALESCE(SUM(net_cash),0) as net,
           COALESCE(SUM(total_liters_sold),0) as liters
    FROM shifts WHERE date(opened_at)=? AND status='closed'
  `).get(today);

  // include open shift partial figures
  const totalDebtSum = db.prepare('SELECT COALESCE(SUM(balance_due),0) as t FROM credit_clients WHERE is_active=1').get().t;
  const lowStock     = db.prepare('SELECT COUNT(*) as c FROM products WHERE stock_qty <= stock_min AND is_active=1').get().c;
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM credit_clients WHERE is_active=1').get().c;

  res.json({
    open_shift: openShift,
    today: {
      fuel_revenue:    todayRevenue.fuel,
      product_revenue: todayRevenue.products,
      credit_deducted: todayRevenue.credits,
      net_cash:        todayRevenue.net,
      liters_sold:     todayRevenue.liters,
    },
    total_debt:    totalDebtSum,
    low_stock:     lowStock,
    total_clients: totalClients,
  });
});

// Last 7 days revenue
router.get('/weekly', requireAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT date(opened_at) as day,
      COALESCE(SUM(total_fuel_revenue),0) as fuel,
      COALESCE(SUM(total_product_sales),0) as products,
      COALESCE(SUM(net_cash),0) as net
    FROM shifts
    WHERE date(opened_at) >= date('now','-6 days') AND status='closed'
    GROUP BY day ORDER BY day
  `).all();
  res.json(rows);
});

// Fuel split today
router.get('/fuel-split', requireAuth, (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT ft.name, ft.color_hex,
      COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as liters
    FROM fuel_types ft
    JOIN pumps p ON p.fuel_type_id = ft.id
    JOIN pump_readings pr_start ON pr_start.pump_id = p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id   = p.id AND pr_end.reading_type='end'
                                AND pr_end.shift_id = pr_start.shift_id
    JOIN shifts s ON s.id = pr_start.shift_id
    WHERE date(s.opened_at) = ? AND s.status='closed'
    GROUP BY ft.id
  `).all(today);
  res.json(rows);
});

module.exports = router;
