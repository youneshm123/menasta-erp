const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireMinRole } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Staff-only guard: blocks the limited "scan" role from everything except
// loading a product (/:id) and confirming a QR sale (/scan-sell).
const staff = requireMinRole('caissier');

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };

// ── Catalogue ───────────────────────────────────────────────────
router.get('/products', requireAuth, staff, wrap(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM graissage_products WHERE is_active=1 ORDER BY name'
  );
  res.json(rows);
}));

router.post('/products', requireAuth, staff, wrap(async (req, res) => {
  const { name, unit, image_data } = req.body || {};
  const price = num(req.body.price);
  const cost  = num(req.body.cost);
  const depot = num(req.body.depot_qty);
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!isFinite(price) || price <= 0) return res.status(400).json({ error: 'Prix de vente valide requis' });
  const startDepot = isFinite(depot) && depot > 0 ? depot : 0;
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO graissage_products (name, price, cost, unit, image_data, depot_qty)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
  `, [name.trim(), price, isFinite(cost) && cost >= 0 ? cost : 0, (unit || 'unité').trim(), image_data || null, startDepot]);
  if (startDepot > 0) {
    await pool.query(
      "INSERT INTO graissage_movements (product_id, type, qty, note, recorded_by) VALUES ($1,'reception',$2,'Stock initial',$3)",
      [id, startDepot, req.user.id]
    );
  }
  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1', [id]);
  res.status(201).json(p);
}));

router.put('/products/:id', requireAuth, staff, wrap(async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const { name, unit, image_data } = req.body || {};
  const price = num(req.body.price);
  const cost  = num(req.body.cost);
  await pool.query(
    'UPDATE graissage_products SET name=$1, price=$2, cost=$3, unit=$4, image_data=COALESCE($5,image_data) WHERE id=$6',
    [name && name.trim() ? name.trim() : p.name,
     isFinite(price) && price > 0 ? price : p.price,
     isFinite(cost) && cost >= 0 ? cost : p.cost,
     unit && unit.trim() ? unit.trim() : p.unit,
     image_data || null, p.id]
  );
  const { rows: [u] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1', [p.id]);
  res.json(u);
}));

router.delete('/products/:id', requireAuth, staff, wrap(async (req, res) => {
  await pool.query('UPDATE graissage_products SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Réception : stock arrive au dépôt ───────────────────────────
router.post('/products/:id/reception', requireAuth, staff, wrap(async (req, res) => {
  const qty = num(req.body && req.body.qty);
  if (!isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantité valide requise' });
  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  await pool.query('UPDATE graissage_products SET depot_qty=depot_qty+$1 WHERE id=$2', [qty, p.id]);
  await pool.query(
    "INSERT INTO graissage_movements (product_id, type, qty, note, recorded_by) VALUES ($1,'reception',$2,$3,$4)",
    [p.id, qty, (req.body.note || '').trim() || null, req.user.id]
  );
  res.json({ ok: true });
}));

// ── Correction manuelle d'un stock (dépôt ou chez l'employé) ────
router.post('/products/:id/adjust', requireAuth, staff, wrap(async (req, res) => {
  const where = req.body && req.body.where;
  const newQty = num(req.body && req.body.new_qty);
  if (!['depot', 'held'].includes(where)) return res.status(400).json({ error: 'Emplacement invalide' });
  if (!isFinite(newQty) || newQty < 0) return res.status(400).json({ error: 'Quantité invalide' });
  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const col = where === 'depot' ? 'depot_qty' : 'held_qty';
  const old = parseFloat(where === 'depot' ? p.depot_qty : p.held_qty) || 0;
  await pool.query(`UPDATE graissage_products SET ${col}=$1 WHERE id=$2`, [newQty, p.id]);
  await pool.query(
    "INSERT INTO graissage_movements (product_id, type, qty, note, recorded_by) VALUES ($1,'adjust',$2,$3,$4)",
    [p.id, newQty - old, `Correction ${where==='depot'?'dépôt':'employé'}: ${old} → ${newQty}` + ((req.body.note||'').trim() ? ' · '+req.body.note.trim() : ''), req.user.id]
  );
  res.json({ ok: true });
}));

// ── Remise : on donne un lot à l'employé (dépôt → chez lui) ─────
router.post('/handout', requireAuth, staff, wrap(async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const note = (req.body && req.body.note || '').trim() || null;
  const clean = items
    .map(it => ({ product_id: parseInt(it.product_id), qty: num(it.qty) }))
    .filter(it => it.product_id && isFinite(it.qty) && it.qty > 0);
  if (!clean.length) return res.status(400).json({ error: 'Aucun article à remettre' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of clean) {
      const { rows: [p] } = await client.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1 FOR UPDATE', [it.product_id]);
      if (!p) throw Object.assign(new Error('Produit introuvable'), { status: 404 });
      if ((parseFloat(p.depot_qty) || 0) < it.qty) throw Object.assign(new Error(`Stock dépôt insuffisant pour ${p.name}`), { status: 400 });
      await client.query('UPDATE graissage_products SET depot_qty=depot_qty-$1, held_qty=held_qty+$1 WHERE id=$2', [it.qty, p.id]);
      await client.query(
        "INSERT INTO graissage_movements (product_id, type, qty, note, recorded_by) VALUES ($1,'handout',$2,$3,$4)",
        [p.id, it.qty, note, req.user.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ── Retour : l'employé rend du stock (chez lui → dépôt) ─────────
router.post('/return', requireAuth, staff, wrap(async (req, res) => {
  const product_id = parseInt(req.body && req.body.product_id);
  const qty = num(req.body && req.body.qty);
  if (!product_id || !isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Produit et quantité requis' });
  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [product_id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  if ((parseFloat(p.held_qty) || 0) < qty) return res.status(400).json({ error: 'Quantité chez l\'employé insuffisante' });
  await pool.query('UPDATE graissage_products SET held_qty=held_qty-$1, depot_qty=depot_qty+$1 WHERE id=$2', [qty, p.id]);
  await pool.query(
    "INSERT INTO graissage_movements (product_id, type, qty, note, recorded_by) VALUES ($1,'return',$2,$3,$4)",
    [p.id, qty, (req.body.note || '').trim() || null, req.user.id]
  );
  res.json({ ok: true });
}));

// ── Mouvements (journal) ────────────────────────────────────────
router.get('/movements', requireAuth, staff, wrap(async (req, res) => {
  const { type } = req.query;
  const params = [];
  let sql = `
    SELECT m.*, p.name AS product_name, p.unit, u.full_name AS by_name
    FROM graissage_movements m
    LEFT JOIN graissage_products p ON p.id=m.product_id
    LEFT JOIN users u ON u.id=m.recorded_by
    WHERE 1=1`;
  if (type) { params.push(type); sql += ` AND m.type=$${params.length}`; }
  sql += ' ORDER BY m.created_at DESC LIMIT 200';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

// ── Compte de l'employé : vendu, payé, solde dû ─────────────────
router.get('/account', requireAuth, staff, wrap(async (_req, res) => {
  const { rows: [{ total_sold }] } = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS total_sold FROM graissage_movements WHERE type='sale'"
  );
  const { rows: [{ total_paid }] } = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS total_paid FROM graissage_payments'
  );
  const { rows: items } = await pool.query(
    'SELECT id, name, unit, price, cost, depot_qty, held_qty, image_data FROM graissage_products WHERE is_active=1 ORDER BY name'
  );
  const stock_value_depot = items.reduce((a, p) => a + (parseFloat(p.depot_qty)||0) * (parseFloat(p.cost)||0), 0);
  const stock_value_held  = items.reduce((a, p) => a + (parseFloat(p.held_qty)||0)  * (parseFloat(p.price)||0), 0);
  res.json({
    total_sold:  +(+total_sold).toFixed(2),
    total_paid:  +(+total_paid).toFixed(2),
    balance_due: +((+total_sold) - (+total_paid)).toFixed(2),
    stock_value_depot: +stock_value_depot.toFixed(2),
    stock_value_held:  +stock_value_held.toFixed(2),
    items,
  });
}));

// ── Règlements (l'employé paie ce qu'il a vendu) ────────────────
router.get('/payments', requireAuth, staff, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT pay.*, u.full_name AS by_name
    FROM graissage_payments pay LEFT JOIN users u ON u.id=pay.recorded_by
    ORDER BY pay.created_at DESC LIMIT 100
  `);
  res.json(rows);
}));

router.post('/payments', requireAuth, staff, wrap(async (req, res) => {
  const amount = num(req.body && req.body.amount);
  if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Montant valide requis' });
  const { rows: [pay] } = await pool.query(
    'INSERT INTO graissage_payments (amount, note, recorded_by) VALUES ($1,$2,$3) RETURNING *',
    [+amount.toFixed(2), (req.body.note || '').trim() || null, req.user.id]
  );
  res.status(201).json(pay);
}));

router.delete('/payments/:id', requireAuth, staff, wrap(async (req, res) => {
  await pool.query('DELETE FROM graissage_payments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Vente par QR — vend 1 unité du stock chez l'employé ─────────
// Ouvert à tout utilisateur connecté (l'employé graissage peut avoir un rôle limité).
router.post('/scan-sell', requireAuth, wrap(async (req, res) => {
  const product_id = parseInt(req.body && req.body.product_id);
  const client_uid = req.body && req.body.client_uid;
  if (!product_id) return res.status(400).json({ error: 'Produit requis' });

  // Idempotence : une vente hors-ligne rejouée (même client_uid) → on renvoie l'existante.
  if (client_uid) {
    const { rows: dup } = await pool.query(
      `SELECT m.id, m.amount, p.name AS product_name, p.price AS unit_price, p.held_qty
       FROM graissage_movements m JOIN graissage_products p ON p.id=m.product_id
       WHERE m.client_uid=$1`, [client_uid]
    );
    if (dup[0]) {
      return res.status(200).json({
        ok: true, duplicate: true, sale_id: dup[0].id,
        product_name: dup[0].product_name, unit_price: dup[0].unit_price,
        total_amount: dup[0].amount, remaining_stock: dup[0].held_qty,
      });
    }
  }

  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [product_id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  if ((parseFloat(p.held_qty) || 0) < 1) return res.status(400).json({ error: 'Stock épuisé chez l\'employé — rien à vendre' });

  const total = +(+p.price).toFixed(2);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO graissage_movements (product_id, type, qty, unit_price, amount, client_uid, recorded_by)
    VALUES ($1,'sale',1,$2,$3,$4,$5) RETURNING id
  `, [p.id, p.price, total, client_uid || null, req.user.id]);
  await pool.query('UPDATE graissage_products SET held_qty=held_qty-1 WHERE id=$1', [p.id]);

  res.status(201).json({
    ok: true, sale_id: id,
    product_name: p.name, unit: p.unit, unit_price: p.price,
    total_amount: total, remaining_stock: (parseFloat(p.held_qty) || 0) - 1,
  });
}));

// Produit unique (page de scan). En dernier pour ne pas masquer les routes ci-dessus.
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  res.json(rows[0]);
}));

module.exports = router;
