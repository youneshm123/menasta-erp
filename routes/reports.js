const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

router.get('/monthly', requireAuth, (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const months = db.prepare(`
    SELECT
      strftime('%Y-%m', opened_at) as month,
      COUNT(*) as shift_count,
      COALESCE(SUM(total_fuel_revenue),0)    as fuel_revenue,
      COALESCE(SUM(total_credit_deducted),0) as credits,
      COALESCE(SUM(total_product_sales),0)   as products,
      COALESCE(SUM(net_cash),0)              as net_cash,
      COALESCE(SUM(total_liters_sold),0)     as liters_sold
    FROM shifts
    WHERE status='closed' AND strftime('%Y', opened_at)=?
    GROUP BY month ORDER BY month DESC
  `).all(String(year));

  const expenses = db.prepare(`
    SELECT strftime('%Y-%m', expense_date) as month, COALESCE(SUM(amount),0) as total
    FROM expenses WHERE strftime('%Y', expense_date)=?
    GROUP BY month
  `).all(String(year));

  const expMap = {};
  expenses.forEach(e => expMap[e.month] = e.total);

  const result = months.map(m => ({
    ...m,
    expenses: expMap[m.month] || 0,
    profit: m.net_cash - (expMap[m.month] || 0)
  }));

  res.json(result);
});

router.get('/years', requireAuth, (_req, res) => {
  const years = db.prepare(`SELECT DISTINCT strftime('%Y', opened_at) as y FROM shifts ORDER BY y DESC`).all();
  res.json(years.map(r => r.y));
});

module.exports = router;
