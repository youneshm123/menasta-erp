const router = require('express').Router();
const { pool } = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const CUR_MONTH = () => new Date().toISOString().slice(0, 7);

// ── List employees with this-(or given-)month advances + reste à payer ──
router.get('/', wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : CUR_MONTH();
  const { rows } = await pool.query(`
    SELECT e.*,
      COALESCE((SELECT SUM(amount) FROM employee_advances a
        WHERE a.employee_id=e.id AND TO_CHAR(a.advance_date,'YYYY-MM')=$1),0) AS advances_month
    FROM employees e WHERE e.is_active=1 ORDER BY e.name
  `, [month]);
  res.json(rows.map(e => {
    const salary   = parseFloat(e.monthly_salary) || 0;
    const advances = parseFloat(e.advances_month) || 0;
    return {
      id: e.id, name: e.name, phone: e.phone, notes: e.notes,
      monthly_salary: salary, advances_month: advances,
      reste: +(salary - advances).toFixed(2),
    };
  }));
}));

router.post('/', wrap(async (req, res) => {
  const { name, phone, notes } = req.body || {};
  const salary = parseFloat(req.body.monthly_salary);
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO employees (name,monthly_salary,phone,notes) VALUES ($1,$2,$3,$4) RETURNING id',
    [name.trim(), isFinite(salary) ? salary : 0, phone || null, notes || null]
  );
  const { rows: [e] } = await pool.query('SELECT * FROM employees WHERE id=$1', [id]);
  res.status(201).json(e);
}));

router.put('/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Employé introuvable' });
  const salary = req.body.monthly_salary != null ? parseFloat(req.body.monthly_salary) : parseFloat(c.monthly_salary);
  await pool.query(
    'UPDATE employees SET name=$1,monthly_salary=$2,phone=$3,notes=$4 WHERE id=$5',
    [req.body.name || c.name, isFinite(salary) ? salary : 0, req.body.phone ?? c.phone, req.body.notes ?? c.notes, c.id]
  );
  const { rows: [u] } = await pool.query('SELECT * FROM employees WHERE id=$1', [c.id]);
  res.json(u);
}));

router.delete('/:id', wrap(async (req, res) => {
  await pool.query('UPDATE employees SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Advances (money the employee took, cut from salary) ──
router.get('/:id/advances', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.*, u.full_name AS recorded_by_name
    FROM employee_advances a LEFT JOIN users u ON u.id=a.recorded_by
    WHERE a.employee_id=$1 ORDER BY a.advance_date DESC, a.id DESC
  `, [req.params.id]);
  res.json(rows);
}));

router.post('/:id/advances', wrap(async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Montant valide requis' });
  const { rows: emp } = await pool.query('SELECT id FROM employees WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!emp.length) return res.status(404).json({ error: 'Employé introuvable' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO employee_advances (employee_id,amount,advance_date,note,recorded_by,shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [req.params.id, +amount.toFixed(2), req.body.advance_date || new Date().toISOString().slice(0, 10), req.body.note || null, req.user.id, req.body.shift_id || null]
  );
  const { rows: [a] } = await pool.query('SELECT * FROM employee_advances WHERE id=$1', [id]);
  res.status(201).json(a);
}));

router.delete('/advances/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM employee_advances WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
