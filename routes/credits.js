const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── Clients ──────────────────────────────────────────────────
router.get('/clients', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM credit_clients WHERE is_active=1 ORDER BY name');
  res.json(rows);
}));

router.post('/clients', requireAuth, wrap(async (req, res) => {
  const { name, phone, company, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO credit_clients (name,phone,company,notes) VALUES ($1,$2,$3,$4) RETURNING id',
    [name, phone||null, company||null, notes||null]
  );
  const { rows: [c] } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [id]);
  res.status(201).json(c);
}));

router.put('/clients/:id', requireAuth, wrap(async (req, res) => {
  const { name, phone, company, notes } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  await pool.query(
    'UPDATE credit_clients SET name=$1,phone=$2,company=$3,notes=$4 WHERE id=$5',
    [name||c.name, phone||c.phone, company||c.company, notes||c.notes, c.id]
  );
  const { rows: [updated] } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [c.id]);
  res.json(updated);
}));

router.delete('/clients/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE credit_clients SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

router.get('/clients/:id/history', requireAuth, wrap(async (req, res) => {
  const { rows: cr } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [req.params.id]);
  if (!cr.length) return res.status(404).json({ error: 'Client introuvable' });
  const { rows: sales } = await pool.query(`
    SELECT cs.*, p.name as pump_name, s.opened_at as shift_date
    FROM credit_sales cs
    JOIN pumps p ON p.id=cs.pump_id
    JOIN shifts s ON s.id=cs.shift_id
    WHERE cs.credit_client_id=$1 ORDER BY cs.sale_time DESC
  `, [req.params.id]);
  const { rows: payments } = await pool.query(`
    SELECT cp.*, u.full_name as received_by_name
    FROM credit_payments cp
    LEFT JOIN users u ON u.id=cp.recorded_by
    WHERE cp.credit_client_id=$1 ORDER BY cp.payment_time DESC
  `, [req.params.id]);
  res.json({ client: cr[0], sales, payments });
}));

// ── Credit Sales ──────────────────────────────────────────────
router.get('/sales', requireAuth, wrap(async (req, res) => {
  const { shift_id, client_id } = req.query;
  let q = `
    SELECT cs.*, cc.name as client_name, p.name as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id=cs.credit_client_id
    JOIN pumps p ON p.id=cs.pump_id WHERE 1=1
  `;
  const params = []; let i = 1;
  if (shift_id)  { q += ` AND cs.shift_id=$${i++}`;          params.push(shift_id);  }
  if (client_id) { q += ` AND cs.credit_client_id=$${i++}`;  params.push(client_id); }
  q += ' ORDER BY cs.sale_time DESC';
  const { rows } = await pool.query(q, params);
  res.json(rows);
}));

router.post('/sales', requireAuth, wrap(async (req, res) => {
  const { shift_id, credit_client_id, pump_id, amount, notes } = req.body || {};
  if (!shift_id || !credit_client_id || !pump_id || !amount)
    return res.status(400).json({ error: 'Champs obligatoires manquants' });

  const { rows: sr } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='open'", [shift_id]);
  if (!sr.length) return res.status(400).json({ error: 'Poste non trouvé ou déjà fermé' });

  const { rows: ftr } = await pool.query(
    'SELECT ft.price_per_liter FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.id=$1', [pump_id]
  );
  if (!ftr.length) return res.status(400).json({ error: 'Pompe introuvable' });

  const liters = +(amount / ftr[0].price_per_liter).toFixed(2);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO credit_sales (shift_id,credit_client_id,pump_id,liters,price_per_liter,amount,recorded_by,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [shift_id, credit_client_id, pump_id, liters, ftr[0].price_per_liter, amount, req.user.id, notes||null]);

  await pool.query('UPDATE credit_clients SET balance_due=balance_due+$1 WHERE id=$2', [amount, credit_client_id]);

  const { rows: [sale] } = await pool.query(`
    SELECT cs.*, cc.name as client_name, p.name as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id=cs.credit_client_id
    JOIN pumps p ON p.id=cs.pump_id WHERE cs.id=$1
  `, [id]);
  res.status(201).json(sale);
}));

router.delete('/sales/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT cs.*, s.status FROM credit_sales cs JOIN shifts s ON s.id=cs.shift_id WHERE cs.id=$1', [req.params.id]
  );
  const sale = rows[0];
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.status !== 'open') return res.status(400).json({ error: "Impossible d'annuler: poste fermé" });
  await pool.query('UPDATE credit_clients SET balance_due=balance_due-$1 WHERE id=$2', [sale.amount, sale.credit_client_id]);
  await pool.query('DELETE FROM credit_sales WHERE id=$1', [sale.id]);
  res.json({ ok: true });
}));

// ── Payments ──────────────────────────────────────────────────
router.post('/payments', requireAuth, wrap(async (req, res) => {
  const { credit_client_id, amount, shift_id, notes } = req.body || {};
  if (!credit_client_id || !amount) return res.status(400).json({ error: 'Client et montant requis' });

  const { rows: cr } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [credit_client_id]);
  if (!cr.length) return res.status(404).json({ error: 'Client introuvable' });

  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO credit_payments (credit_client_id,shift_id,amount,recorded_by,notes)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [credit_client_id, shift_id||null, amount, req.user.id, notes||null]);

  await pool.query('UPDATE credit_clients SET balance_due=GREATEST(0,balance_due-$1) WHERE id=$2', [amount, credit_client_id]);

  const { rows: [p] } = await pool.query('SELECT * FROM credit_payments WHERE id=$1', [id]);
  res.status(201).json(p);
}));

router.get('/payments', requireAuth, wrap(async (req, res) => {
  const { client_id } = req.query;
  let q, params;
  if (client_id) {
    q = 'SELECT cp.*,cc.name as client_name FROM credit_payments cp JOIN credit_clients cc ON cc.id=cp.credit_client_id WHERE cp.credit_client_id=$1 ORDER BY cp.payment_time DESC';
    params = [client_id];
  } else {
    q = 'SELECT cp.*,cc.name as client_name FROM credit_payments cp JOIN credit_clients cc ON cc.id=cp.credit_client_id ORDER BY cp.payment_time DESC LIMIT 100';
    params = [];
  }
  const { rows } = await pool.query(q, params);
  res.json(rows);
}));

module.exports = router;
