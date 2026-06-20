const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const { sendWhatsApp } = require('../services/whatsapp');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── Clients ──────────────────────────────────────────────────
router.get('/clients', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM credit_clients WHERE is_active=1 ORDER BY name');
  res.json(rows);
}));

router.post('/clients', requireAuth, wrap(async (req, res) => {
  const { name, phone, company, notes, credit_limit } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO credit_clients (name,phone,company,notes,credit_limit) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [name, phone||null, company||null, notes||null, credit_limit||null]
  );
  const { rows: [c] } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [id]);
  res.status(201).json(c);
}));

router.put('/clients/:id', requireAuth, wrap(async (req, res) => {
  const { name, phone, company, notes, credit_limit } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  await pool.query(
    'UPDATE credit_clients SET name=$1,phone=$2,company=$3,notes=$4,credit_limit=$5 WHERE id=$6',
    [name||c.name, phone||c.phone, company||c.company, notes||c.notes, credit_limit!==undefined?credit_limit:c.credit_limit, c.id]
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
    SELECT cs.*, COALESCE(p.name,'Lubrifiant') as pump_name, s.opened_at as shift_date
    FROM credit_sales cs
    LEFT JOIN pumps p ON p.id=cs.pump_id
    LEFT JOIN shifts s ON s.id=cs.shift_id
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
    SELECT cs.*, cc.name as client_name, COALESCE(p.name,'Lubrifiant') as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id=cs.credit_client_id
    LEFT JOIN pumps p ON p.id=cs.pump_id WHERE 1=1
  `;
  const params = []; let i = 1;
  if (shift_id)  { q += ` AND cs.shift_id=$${i++}`;          params.push(shift_id);  }
  if (client_id) { q += ` AND cs.credit_client_id=$${i++}`;  params.push(client_id); }
  q += ' ORDER BY cs.sale_time DESC';
  const { rows } = await pool.query(q, params);
  res.json(rows);
}));

router.post('/sales', requireAuth, wrap(async (req, res) => {
  const { shift_id, credit_client_id, pump_id, notes, product_type } = req.body || {};
  const amount = parseFloat(req.body.amount);
  if (!credit_client_id || !amount || amount <= 0)
    return res.status(400).json({ error: 'Champs obligatoires manquants ou montant invalide' });

  // A shift is optional — but if one is given it must be open.
  if (shift_id) {
    const { rows: sr } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='open'", [shift_id]);
    if (!sr.length) return res.status(400).json({ error: 'Poste non trouvé ou déjà fermé' });
  }

  let liters = 0, price_per_liter = 0;
  if (pump_id) {
    const { rows: ftr } = await pool.query(
      'SELECT ft.price_per_liter FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.id=$1', [pump_id]
    );
    if (!ftr.length) return res.status(400).json({ error: 'Pompe introuvable' });
    liters = +(amount / ftr[0].price_per_liter).toFixed(2);
    price_per_liter = ftr[0].price_per_liter;
  }

  const pType = product_type || (pump_id ? 'carburant' : 'lubrifiant');
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO credit_sales (shift_id,credit_client_id,pump_id,liters,price_per_liter,amount,recorded_by,notes,product_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
  `, [shift_id, credit_client_id, pump_id||null, liters, price_per_liter, amount, req.user.id, notes||null, pType]);

  await pool.query('UPDATE credit_clients SET balance_due=balance_due+$1 WHERE id=$2', [amount, credit_client_id]);

  const { rows: [sale] } = await pool.query(`
    SELECT cs.*, cc.name as client_name, cc.phone as client_phone, cc.balance_due, cc.credit_limit,
           COALESCE(p.name, 'Lubrifiant') as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id=cs.credit_client_id
    LEFT JOIN pumps p ON p.id=cs.pump_id WHERE cs.id=$1
  `, [id]);

  // Auto WhatsApp if credit limit hit
  if (sale.client_phone && sale.credit_limit && parseFloat(sale.balance_due) >= parseFloat(sale.credit_limit)) {
    const fmt = n => parseFloat(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const msg = `🚨 *Station MENASTA*\n\nBonjour *${sale.client_name}*,\n\nVotre solde crédit a atteint *${fmt(sale.balance_due)} MAD*, ce qui dépasse votre limite autorisée de *${fmt(sale.credit_limit)} MAD*.\n\nMerci de régulariser votre situation au plus tôt.\n\n_Station MENASTA_`;
    sendWhatsApp(sale.client_phone, msg).catch(() => {});
  }

  res.status(201).json(sale);
}));

router.delete('/sales/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT cs.*, s.status FROM credit_sales cs LEFT JOIN shifts s ON s.id=cs.shift_id WHERE cs.id=$1', [req.params.id]
  );
  const sale = rows[0];
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  // Block deletion only when it belongs to a poste that is already closed.
  if (sale.shift_id && sale.status !== 'open') return res.status(400).json({ error: "Impossible d'annuler: poste fermé" });
  await pool.query('UPDATE credit_clients SET balance_due=GREATEST(balance_due-$1, 0) WHERE id=$2', [sale.amount, sale.credit_client_id]);
  await pool.query('DELETE FROM credit_sales WHERE id=$1', [sale.id]);
  res.json({ ok: true });
}));

// ── Manual WhatsApp Reminder ──────────────────────────────────
router.post('/clients/:id/remind', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  if (!c.phone) return res.status(400).json({ error: 'Ce client n\'a pas de numéro de téléphone' });
  if (!parseFloat(c.balance_due)) return res.status(400).json({ error: 'Ce client n\'a pas de dette' });

  const fmt = n => parseFloat(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const msg = `📢 *Station MENASTA*\n\nBonjour *${c.name}*,\n\nNous vous rappelons que votre solde crédit est de *${fmt(c.balance_due)} MAD*.\n\nMerci de passer à la station pour régulariser votre situation.\n\n_Bonne journée !_\n_Station MENASTA_`;

  try {
    await sendWhatsApp(c.phone, msg);
    res.json({ ok: true, message: `Rappel envoyé à ${c.name} (${c.phone})` });
  } catch(e) {
    res.status(500).json({ error: e.message || 'Erreur envoi WhatsApp' });
  }
}));

// ── Payments ──────────────────────────────────────────────────
router.post('/payments', requireAuth, wrap(async (req, res) => {
  const { credit_client_id, shift_id, notes } = req.body || {};
  const amount = parseFloat(req.body.amount);
  if (!credit_client_id || !amount || amount <= 0) return res.status(400).json({ error: 'Client et montant valide requis' });

  const { rows: cr } = await pool.query('SELECT * FROM credit_clients WHERE id=$1', [credit_client_id]);
  if (!cr.length) return res.status(404).json({ error: 'Client introuvable' });

  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO credit_payments (credit_client_id,shift_id,amount,recorded_by,notes)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [credit_client_id, shift_id||null, amount, req.user.id, notes||null]);

  await pool.query('UPDATE credit_clients SET balance_due=GREATEST(balance_due-$1, 0) WHERE id=$2', [amount, credit_client_id]);

  const { rows: [p] } = await pool.query('SELECT * FROM credit_payments WHERE id=$1', [id]);
  res.status(201).json(p);
}));

router.delete('/payments/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT cp.*, s.status FROM credit_payments cp LEFT JOIN shifts s ON s.id=cp.shift_id WHERE cp.id=$1', [req.params.id]
  );
  const pay = rows[0];
  if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
  // Block deletion only when it belongs to a poste that is already closed.
  if (pay.shift_id && pay.status !== 'open') return res.status(400).json({ error: "Impossible d'annuler: poste fermé" });
  // Reverse the payment: the amount goes back onto the client's debt.
  await pool.query('UPDATE credit_clients SET balance_due=balance_due+$1 WHERE id=$2', [pay.amount, pay.credit_client_id]);
  await pool.query('DELETE FROM credit_payments WHERE id=$1', [pay.id]);
  res.json({ ok: true });
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
