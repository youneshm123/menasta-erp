const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/monthly', requireAuth, wrap(async (req, res) => {
  const year = req.query.year || new Date().getFullYear();

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
  `, [String(year)]);

  const { rows: expenses } = await pool.query(`
    SELECT TO_CHAR(expense_date,'YYYY-MM') as month, COALESCE(SUM(amount),0) as total
    FROM expenses WHERE TO_CHAR(expense_date,'YYYY')=$1
    GROUP BY TO_CHAR(expense_date,'YYYY-MM')
  `, [String(year)]);

  const expMap = {};
  expenses.forEach(e => { expMap[e.month] = parseFloat(e.total); });

  const result = months.map(m => ({
    ...m,
    fuel_revenue: parseFloat(m.fuel_revenue),
    credits:      parseFloat(m.credits),
    products:     parseFloat(m.products),
    net_cash:     parseFloat(m.net_cash),
    liters_sold:  parseFloat(m.liters_sold),
    expenses:     expMap[m.month] || 0,
    profit:       parseFloat(m.net_cash) - (expMap[m.month] || 0),
  }));

  res.json(result);
}));

router.get('/years', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT DISTINCT TO_CHAR(opened_at,'YYYY') as y FROM shifts ORDER BY y DESC`);
  res.json(rows.map(r => r.y));
}));

module.exports = router;
