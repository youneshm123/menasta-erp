const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

// ── Clients ──────────────────────────────────────────────────
router.get('/clients', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM credit_clients WHERE is_active=1 ORDER BY name').all())
);

router.post('/clients', requireAuth, (req, res) => {
  const { name, phone, company, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = db.prepare('INSERT INTO credit_clients (name, phone, company, notes) VALUES (?,?,?,?)')
    .run(name, phone||null, company||null, notes||null).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM credit_clients WHERE id=?').get(id));
});

router.put('/clients/:id', requireAuth, (req, res) => {
  const { name, phone, company, notes } = req.body || {};
  const c = db.prepare('SELECT * FROM credit_clients WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  db.prepare('UPDATE credit_clients SET name=?, phone=?, company=?, notes=? WHERE id=?')
    .run(name||c.name, phone||c.phone, company||c.company, notes||c.notes, c.id);
  res.json(db.prepare('SELECT * FROM credit_clients WHERE id=?').get(c.id));
});

router.delete('/clients/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE credit_clients SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// client history
router.get('/clients/:id/history', requireAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM credit_clients WHERE id=?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  const sales = db.prepare(`
    SELECT cs.*, p.name as pump_name, s.opened_at as shift_date
    FROM credit_sales cs
    JOIN pumps p ON p.id = cs.pump_id
    JOIN shifts s ON s.id = cs.shift_id
    WHERE cs.credit_client_id = ?
    ORDER BY cs.sale_time DESC
  `).all(req.params.id);
  const payments = db.prepare(`
    SELECT cp.*, u.full_name as received_by_name
    FROM credit_payments cp
    LEFT JOIN users u ON u.id = cp.recorded_by
    WHERE cp.credit_client_id = ?
    ORDER BY cp.payment_time DESC
  `).all(req.params.id);
  res.json({ client, sales, payments });
});

// ── Credit Sales ──────────────────────────────────────────────
router.get('/sales', requireAuth, (req, res) => {
  const { shift_id, client_id } = req.query;
  let q = `
    SELECT cs.*, cc.name as client_name, p.name as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id = cs.credit_client_id
    JOIN pumps p ON p.id = cs.pump_id
    WHERE 1=1
  `;
  const params = [];
  if (shift_id)  { q += ' AND cs.shift_id = ?';          params.push(shift_id);  }
  if (client_id) { q += ' AND cs.credit_client_id = ?';  params.push(client_id); }
  q += ' ORDER BY cs.sale_time DESC';
  res.json(db.prepare(q).all(...params));
});

router.post('/sales', requireAuth, (req, res) => {
  const { shift_id, credit_client_id, pump_id, amount, notes } = req.body || {};
  if (!shift_id || !credit_client_id || !pump_id || !amount)
    return res.status(400).json({ error: 'Champs obligatoires manquants' });

  const shift = db.prepare("SELECT * FROM shifts WHERE id=? AND status='open'").get(shift_id);
  if (!shift) return res.status(400).json({ error: 'Poste non trouvé ou déjà fermé' });

  const ft = db.prepare(`SELECT ft.price_per_liter FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.id=?`).get(pump_id);
  if (!ft) return res.status(400).json({ error: 'Pompe introuvable' });

  const liters = +(amount / ft.price_per_liter).toFixed(2);

  const id = db.prepare(`
    INSERT INTO credit_sales (shift_id, credit_client_id, pump_id, liters, price_per_liter, amount, recorded_by, notes)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(shift_id, credit_client_id, pump_id, liters, ft.price_per_liter, amount, req.user.id, notes||null).lastInsertRowid;

  db.prepare('UPDATE credit_clients SET balance_due = balance_due + ? WHERE id=?').run(amount, credit_client_id);

  res.status(201).json(db.prepare(`
    SELECT cs.*, cc.name as client_name, p.name as pump_name
    FROM credit_sales cs JOIN credit_clients cc ON cc.id=cs.credit_client_id JOIN pumps p ON p.id=cs.pump_id
    WHERE cs.id=?
  `).get(id));
});

router.delete('/sales/:id', requireAuth, (req, res) => {
  const sale = db.prepare(`
    SELECT cs.*, s.status FROM credit_sales cs JOIN shifts s ON s.id=cs.shift_id WHERE cs.id=?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.status !== 'open') return res.status(400).json({ error: 'Impossible d\'annuler: poste fermé' });
  db.prepare('UPDATE credit_clients SET balance_due = balance_due - ? WHERE id=?').run(sale.amount, sale.credit_client_id);
  db.prepare('DELETE FROM credit_sales WHERE id=?').run(sale.id);
  res.json({ ok: true });
});

// ── Payments ──────────────────────────────────────────────────
router.post('/payments', requireAuth, (req, res) => {
  const { credit_client_id, amount, shift_id, notes } = req.body || {};
  if (!credit_client_id || !amount) return res.status(400).json({ error: 'Client et montant requis' });

  const client = db.prepare('SELECT * FROM credit_clients WHERE id=?').get(credit_client_id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });

  const id = db.prepare(`
    INSERT INTO credit_payments (credit_client_id, shift_id, amount, recorded_by, notes)
    VALUES (?,?,?,?,?)
  `).run(credit_client_id, shift_id||null, amount, req.user.id, notes||null).lastInsertRowid;

  db.prepare('UPDATE credit_clients SET balance_due = MAX(0, balance_due - ?) WHERE id=?').run(amount, credit_client_id);

  res.status(201).json(db.prepare('SELECT * FROM credit_payments WHERE id=?').get(id));
});

router.get('/payments', requireAuth, (req, res) => {
  const { client_id } = req.query;
  const q = client_id
    ? 'SELECT cp.*, cc.name as client_name FROM credit_payments cp JOIN credit_clients cc ON cc.id=cp.credit_client_id WHERE cp.credit_client_id=? ORDER BY cp.payment_time DESC'
    : 'SELECT cp.*, cc.name as client_name FROM credit_payments cp JOIN credit_clients cc ON cc.id=cp.credit_client_id ORDER BY cp.payment_time DESC LIMIT 100';
  res.json(client_id ? db.prepare(q).all(client_id) : db.prepare(q).all());
});

module.exports = router;
