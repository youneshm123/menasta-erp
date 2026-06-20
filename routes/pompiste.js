const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireMinRole } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const fmt = n => (parseFloat(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ── Who am I (pompiste app uses this to show the name) ──
router.get('/me', requireAuth, wrap(async (req, res) => {
  res.json({ id: req.user.id, full_name: req.user.full_name, username: req.user.username, role: req.user.role });
}));

// ── Reference data for the pickers (pumps / clients / products) ──
router.get('/refs', requireAuth, wrap(async (_req, res) => {
  const [pumps, clients, products] = await Promise.all([
    pool.query(`SELECT p.id, p.name, ft.name AS fuel, ft.color_hex
                FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id
                WHERE p.status='active' ORDER BY p.name`),
    pool.query(`SELECT id, name FROM credit_clients WHERE is_active=1 ORDER BY name`),
    pool.query(`SELECT id, name, price, unit FROM products WHERE is_active=1 ORDER BY name`),
  ]);
  res.json({ pumps: pumps.rows, clients: clients.rows, products: products.rows });
}));

// ── Submit one entry (any authenticated user; pompiste is the intended caller) ──
router.post('/submit', requireAuth, wrap(async (req, res) => {
  const { kind, data } = req.body || {};
  if (!['compteur', 'credit', 'espece', 'produit'].includes(kind))
    return res.status(400).json({ error: 'Type invalide' });
  const d = (data && typeof data === 'object') ? data : {};

  // Build a human-readable label + validate per kind.
  let label = '';
  if (kind === 'compteur') {
    if (!d.pump_id || !(parseFloat(d.meter_value) >= 0)) return res.status(400).json({ error: 'Pompe et compteur requis' });
    label = `Compteur ${d.pump_name || ('#' + d.pump_id)} : ${fmt(d.meter_value)}`;
  } else if (kind === 'credit') {
    if (!d.credit_client_id || !(parseFloat(d.amount) > 0)) return res.status(400).json({ error: 'Client et montant requis' });
    label = `Crédit ${d.client_name || ('#' + d.credit_client_id)} : ${fmt(d.amount)} MAD`;
  } else if (kind === 'espece') {
    if (!(parseFloat(d.amount) >= 0)) return res.status(400).json({ error: 'Montant requis' });
    label = `Espèces : ${fmt(d.amount)} MAD`;
  } else if (kind === 'produit') {
    if (!d.product_id || !(parseFloat(d.quantity) > 0)) return res.status(400).json({ error: 'Produit et quantité requis' });
    label = `Produit ${d.product_name || ('#' + d.product_id)} × ${fmt(d.quantity)}`;
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO pompiste_submissions (pompiste_id, pompiste_name, kind, data, label)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.user.id, req.user.full_name || req.user.username, kind, JSON.stringify(d), label]
  );
  res.status(201).json({ ok: true, id: row.id, label });
}));

// ── My recent submissions (so the pompiste sees pending/confirmed status) ──
router.get('/mine', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, kind, label, status, created_at FROM pompiste_submissions
     WHERE pompiste_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.user.id]
  );
  res.json(rows);
}));

// ── Pending list for review (caissier and above) ──
router.get('/pending', requireAuth, requireMinRole('caissier'), wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, pompiste_name, kind, data, label, created_at
     FROM pompiste_submissions WHERE status='pending' ORDER BY created_at ASC`
  );
  res.json(rows);
}));

// ── Confirm a submission → apply it to the currently open poste ──
router.post('/:id/confirm', requireAuth, requireMinRole('caissier'), wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM pompiste_submissions WHERE id=$1 AND status='pending'", [req.params.id]);
  const sub = rows[0];
  if (!sub) return res.status(404).json({ error: 'Entrée introuvable ou déjà traitée' });
  const d = sub.data || {};

  const { rows: openShifts } = await pool.query("SELECT id FROM shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1");
  const shiftId = openShifts.length ? openShifts[0].id : null;
  // Compteur and espèces are poste-specific — they need an open poste.
  if ((sub.kind === 'compteur' || sub.kind === 'espece') && !shiftId)
    return res.status(400).json({ error: "Ouvrez un poste d'abord pour confirmer cette entrée." });

  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    if (sub.kind === 'compteur') {
      await c.query(
        `INSERT INTO pump_readings (shift_id, pump_id, reading_type, meter_value, recorded_by)
         VALUES ($1,$2,'end',$3,$4)
         ON CONFLICT (shift_id, pump_id, reading_type)
         DO UPDATE SET meter_value=EXCLUDED.meter_value, recorded_by=EXCLUDED.recorded_by`,
        [shiftId, d.pump_id, parseFloat(d.meter_value), req.user.id]
      );

    } else if (sub.kind === 'credit') {
      let liters = 0, ppl = 0;
      if (d.pump_id) {
        const { rows: ftr } = await c.query(
          'SELECT ft.price_per_liter FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.id=$1', [d.pump_id]);
        if (ftr.length && parseFloat(ftr[0].price_per_liter) > 0) {
          ppl = parseFloat(ftr[0].price_per_liter);
          liters = +(parseFloat(d.amount) / ppl).toFixed(2);
        }
      }
      const pType = d.product_type || (d.pump_id ? 'carburant' : 'lubrifiant');
      await c.query(
        `INSERT INTO credit_sales (shift_id, credit_client_id, pump_id, liters, price_per_liter, amount, recorded_by, notes, product_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [shiftId, d.credit_client_id, d.pump_id || null, liters, ppl, parseFloat(d.amount), req.user.id, d.notes || 'via pompiste', pType]
      );
      await c.query('UPDATE credit_clients SET balance_due=balance_due+$1 WHERE id=$2', [parseFloat(d.amount), d.credit_client_id]);

    } else if (sub.kind === 'produit') {
      const { rows: pr } = await c.query('SELECT price FROM products WHERE id=$1', [d.product_id]);
      if (!pr.length) throw Object.assign(new Error('Produit introuvable'), { status: 400 });
      const unit = parseFloat(pr[0].price) || 0;
      const qty = parseFloat(d.quantity);
      await c.query(
        `INSERT INTO product_sales (shift_id, product_id, quantity, unit_price, total_amount, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [shiftId, d.product_id, qty, unit, +(unit * qty).toFixed(2), req.user.id]
      );
      await c.query('UPDATE products SET stock_qty=stock_qty-$1 WHERE id=$2', [qty, d.product_id]);

    } else if (sub.kind === 'espece') {
      await c.query(
        `UPDATE shifts SET notes = COALESCE(notes,'') || $1 WHERE id=$2`,
        [`\n[Pompiste ${sub.pompiste_name}] Espèces déclarées : ${fmt(d.amount)} MAD`, shiftId]
      );
    }

    await c.query(
      "UPDATE pompiste_submissions SET status='confirmed', shift_id=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3",
      [shiftId, req.user.id, sub.id]
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  res.json({ ok: true });
}));

// ── Reject a submission (does not touch the poste) ──
router.post('/:id/reject', requireAuth, requireMinRole('caissier'), wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    "UPDATE pompiste_submissions SET status='rejected', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2 AND status='pending'",
    [req.user.id, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Entrée introuvable ou déjà traitée' });
  res.json({ ok: true });
}));

module.exports = router;
