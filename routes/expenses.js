const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

router.get('/', requireAuth, (req, res) => {
  const { month } = req.query;
  let q = `SELECT e.*, u.full_name as recorded_by_name FROM expenses e LEFT JOIN users u ON u.id=e.recorded_by`;
  if (month) q += ` WHERE strftime('%Y-%m', e.expense_date)=?`;
  q += ` ORDER BY e.expense_date DESC`;
  res.json(month ? db.prepare(q).all(month) : db.prepare(q).all());
});

router.post('/', requireAuth, (req, res) => {
  const { category, description, amount, expense_date, notes } = req.body || {};
  if (!description || !amount) return res.status(400).json({ error: 'Description et montant requis' });
  const id = db.prepare(`
    INSERT INTO expenses (category, description, amount, expense_date, notes, recorded_by)
    VALUES (?,?,?,?,?,?)
  `).run(category||'Autre', description, amount, expense_date||new Date().toISOString().slice(0,10), notes||null, req.user.id).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
