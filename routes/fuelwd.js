const router = require('express').Router();
const { pool } = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const CATS = ['Famille', 'Employé', 'Patron', 'Autre'];
const CUR_MONTH = () => new Date().toISOString().slice(0, 7);

// ── List fuel withdrawals (free fuel), optionally by month ──
router.get('/', wrap(async (req, res) => {
  const { month } = req.query;
  let where = '', params = [];
  if (/^\d{4}-\d{2}$/.test(month || '')) { where = "WHERE TO_CHAR(w.wdate,'YYYY-MM')=$1"; params = [month]; }
  const { rows } = await pool.query(`
    SELECT w.*, ft.name AS fuel_name, u.full_name AS recorded_by_name
    FROM fuel_withdrawals w
    LEFT JOIN fuel_types ft ON ft.id=w.fuel_type_id
    LEFT JOIN users u ON u.id=w.recorded_by
    ${where} ORDER BY w.wdate DESC, w.id DESC
  `, params);
  res.json(rows);
}));

// ── Totals by category for a month ──
router.get('/summary', wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : CUR_MONTH();
  const { rows } = await pool.query(`
    SELECT category, COALESCE(SUM(amount),0) AS total, COALESCE(SUM(liters),0) AS liters, COUNT(*) AS n
    FROM fuel_withdrawals WHERE TO_CHAR(wdate,'YYYY-MM')=$1 GROUP BY category
  `, [month]);
  const { rows: [tot] } = await pool.query(`
    SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(liters),0) AS liters
    FROM fuel_withdrawals WHERE TO_CHAR(wdate,'YYYY-MM')=$1
  `, [month]);
  res.json({ month, by_cat: rows, total: parseFloat(tot.total), liters: parseFloat(tot.liters) });
}));

router.post('/', wrap(async (req, res) => {
  const { taker_name, category, fuel_type_id, wdate, note } = req.body || {};
  const liters = parseFloat(req.body.liters) || 0;
  const amount = parseFloat(req.body.amount) || 0;
  if (!taker_name || !taker_name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (amount <= 0 && liters <= 0) return res.status(400).json({ error: 'Litres ou montant requis' });
  const cat = CATS.includes(category) ? category : 'Autre';
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO fuel_withdrawals (taker_name,category,fuel_type_id,liters,amount,wdate,note,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [taker_name.trim(), cat, fuel_type_id || null, +liters.toFixed(2), +amount.toFixed(2),
      wdate || new Date().toISOString().slice(0, 10), note || null, req.user.id]);
  const { rows: [w] } = await pool.query('SELECT * FROM fuel_withdrawals WHERE id=$1', [id]);
  res.status(201).json(w);
}));

router.delete('/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM fuel_withdrawals WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
