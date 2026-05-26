const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', requireAuth, wrap(async (req, res) => {
  const { month, shift_id } = req.query;
  let q, params;
  if (shift_id) {
    q = `SELECT e.*,u.full_name as recorded_by_name FROM expenses e LEFT JOIN users u ON u.id=e.recorded_by WHERE e.shift_id=$1 ORDER BY e.created_at`;
    params = [shift_id];
  } else if (month) {
    q = `SELECT e.*,u.full_name as recorded_by_name FROM expenses e LEFT JOIN users u ON u.id=e.recorded_by WHERE TO_CHAR(e.expense_date,'YYYY-MM')=$1 ORDER BY e.expense_date DESC`;
    params = [month];
  } else {
    q = `SELECT e.*,u.full_name as recorded_by_name FROM expenses e LEFT JOIN users u ON u.id=e.recorded_by ORDER BY e.expense_date DESC`;
    params = [];
  }
  const { rows } = await pool.query(q, params);
  res.json(rows);
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { category, description, expense_date, notes, shift_id } = req.body || {};
  const amount = parseFloat(req.body.amount);
  if (!description || !amount || amount <= 0) return res.status(400).json({ error: 'Description et montant valide requis' });
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO expenses (category,description,amount,expense_date,notes,recorded_by,shift_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
  `, [category||'Autre', description, amount, expense_date||new Date().toISOString().slice(0,10), notes||null, req.user.id, shift_id||null]);
  const { rows: [e] } = await pool.query('SELECT * FROM expenses WHERE id=$1', [id]);
  res.status(201).json(e);
}));

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
