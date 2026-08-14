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
  // Stock unique : tout vit dans held_qty (c'est lui que la vente QR décrémente).
  const startStock = isFinite(depot) && depot > 0 ? depot : 0;
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO graissage_products (name, price, cost, unit, image_data, held_qty)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
  `, [name.trim(), price, isFinite(cost) && cost >= 0 ? cost : 0, (unit || 'unité').trim(), image_data || null, startStock]);
  if (startStock > 0) {
    await pool.query(
      "INSERT INTO graissage_movements (product_id, type, qty, note, recorded_by) VALUES ($1,'reception',$2,'Stock initial',$3)",
      [id, startStock, req.user.id]
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

// ── Réception : nouveau stock qui arrive (stock unique) ─────────
router.post('/products/:id/reception', requireAuth, staff, wrap(async (req, res) => {
  const qty = num(req.body && req.body.qty);
  if (!isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantité valide requise' });
  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  await pool.query('UPDATE graissage_products SET held_qty=held_qty+$1 WHERE id=$2', [qty, p.id]);
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
    SELECT m.*, p.name AS product_name, p.unit, u.full_name AS by_name,
           cu.full_name AS cancelled_by_name
    FROM graissage_movements m
    LEFT JOIN graissage_products p ON p.id=m.product_id
    LEFT JOIN users u ON u.id=m.recorded_by
    LEFT JOIN users cu ON cu.id=m.cancelled_by
    WHERE 1=1`;
  if (type) { params.push(type); sql += ` AND m.type=$${params.length}`; }
  sql += ' ORDER BY m.created_at DESC LIMIT 200';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

// ── Historique complet des pièces vendues (scan + saisie manuelle) ──
// Chaque pièce vendue reste ici pour toujours, même annulée (marquée, jamais effacée).
// Filtres : from / to (dates), product_id, source ('scan'|'manual'), q (nom),
// status ('all'|'active'|'cancelled'), page / per_page.
router.get('/sales', requireAuth, staff, wrap(async (req, res) => {
  const { from, to, product_id, source, q, status } = req.query;
  const perPage = Math.min(500, Math.max(10, parseInt(req.query.per_page) || 50));
  const page    = Math.max(1, parseInt(req.query.page) || 1);

  const params = [];
  let where = "WHERE m.type='sale'";
  if (from)  { params.push(from); where += ` AND (m.created_at AT TIME ZONE 'Africa/Casablanca')::date >= $${params.length}::date`; }
  if (to)    { params.push(to);   where += ` AND (m.created_at AT TIME ZONE 'Africa/Casablanca')::date <= $${params.length}::date`; }
  if (product_id) { params.push(parseInt(product_id)); where += ` AND m.product_id=$${params.length}`; }
  if (source === 'scan')   where += " AND COALESCE(m.source,'scan')='scan'";
  if (source === 'manual') where += " AND m.source='manual'";
  if (status === 'active')    where += ' AND m.cancelled_at IS NULL';
  if (status === 'cancelled') where += ' AND m.cancelled_at IS NOT NULL';
  if (q && q.trim()) { params.push('%' + q.trim() + '%'); where += ` AND p.name ILIKE $${params.length}`; }

  const joins = `
    FROM graissage_movements m
    LEFT JOIN graissage_products p ON p.id=m.product_id`;
  const base = `${joins} ${where}`;

  const { rows: [tot] } = await pool.query(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(CASE WHEN m.cancelled_at IS NULL THEN m.qty    ELSE 0 END),0) AS qty,
           COALESCE(SUM(CASE WHEN m.cancelled_at IS NULL THEN m.amount ELSE 0 END),0) AS amount,
           COUNT(*) FILTER (WHERE m.cancelled_at IS NOT NULL)::int AS cancelled_n,
           COALESCE(SUM(CASE WHEN m.cancelled_at IS NULL
                             THEN (COALESCE(m.unit_price, p.price) - COALESCE(p.cost,0)) * m.qty ELSE 0 END),0) AS profit
    ${base}`, params);

  params.push(perPage, (page - 1) * perPage);
  const { rows } = await pool.query(`
    SELECT m.id, m.product_id, m.qty, m.unit_price, m.amount, m.note, m.created_at,
           m.cancelled_at, COALESCE(m.source,'scan') AS source,
           p.name AS product_name, p.unit,
           u.full_name AS by_name, cu.full_name AS cancelled_by_name
    ${joins}
    LEFT JOIN users u  ON u.id=m.recorded_by
    LEFT JOIN users cu ON cu.id=m.cancelled_by
    ${where}
    ORDER BY m.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  res.json({
    rows, page, per_page: perPage,
    total: tot.n, pages: Math.max(1, Math.ceil(tot.n / perPage)),
    total_qty: +(+tot.qty).toFixed(2),
    total_amount: +(+tot.amount).toFixed(2),
    total_profit: +(+tot.profit).toFixed(2),
    cancelled_count: tot.cancelled_n,
  });
}));

// ── Vente manuelle (sans scan) — patron & admin uniquement ──────
// Sert à rattraper une pièce vendue dont le QR n'a pas été scanné.
router.post('/manual-sale', requireAuth, requireMinRole('patron'), wrap(async (req, res) => {
  const product_id = parseInt(req.body && req.body.product_id);
  const qty = num(req.body && req.body.qty);
  const priceIn = num(req.body && req.body.unit_price);
  const force = !!(req.body && req.body.force);
  const saleDate = (req.body && req.body.sale_date || '').trim();
  if (!product_id) return res.status(400).json({ error: 'Produit requis' });
  if (!isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantité valide requise' });
  if (saleDate && !/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) return res.status(400).json({ error: 'Date invalide' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [p] } = await client.query(
      'SELECT * FROM graissage_products WHERE id=$1 AND is_active=1 FOR UPDATE', [product_id]
    );
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Produit introuvable' }); }
    const held = parseFloat(p.held_qty) || 0;
    if (held < qty && !force) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Stock insuffisant : il reste ${held} ${p.unit || 'unité(s)'}`,
        insufficient_stock: true, available: held,
      });
    }
    const unitPrice = isFinite(priceIn) && priceIn >= 0 ? priceIn : parseFloat(p.price) || 0;
    const total = +(unitPrice * qty).toFixed(2);
    const note = (req.body.note || '').trim() || null;
    // Date passée : on la pose à midi (heure marocaine) pour rester sur le bon jour.
    const { rows: [{ id }] } = await client.query(`
      INSERT INTO graissage_movements
        (product_id, type, qty, unit_price, amount, note, source, recorded_by, created_at)
      VALUES ($1,'sale',$2,$3,$4,$5,'manual',$6,
              COALESCE($7::timestamptz, NOW()))
      RETURNING id`,
      [p.id, qty, unitPrice, total, note, req.user.id,
       saleDate ? `${saleDate} 12:00:00 Africa/Casablanca` : null]
    );
    await client.query('UPDATE graissage_products SET held_qty=held_qty-$1 WHERE id=$2', [qty, p.id]);
    await client.query('COMMIT');
    res.status(201).json({
      ok: true, sale_id: id, qty, product_name: p.name, unit: p.unit,
      unit_price: unitPrice, total_amount: total, remaining_stock: held - qty,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ── Compte de l'employé : vendu, payé, solde dû ─────────────────
router.get('/account', requireAuth, staff, wrap(async (_req, res) => {
  // Les ventes annulées restent en base (historique) mais ne comptent nulle part.
  const { rows: [{ total_sold }] } = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS total_sold FROM graissage_movements WHERE type='sale' AND cancelled_at IS NULL"
  );
  const { rows: [{ total_paid }] } = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS total_paid FROM graissage_payments'
  );
  // Ventes du jour (heure marocaine — le serveur tourne en GMT).
  const { rows: [today] } = await pool.query(`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total
    FROM graissage_movements
    WHERE type='sale' AND cancelled_at IS NULL
      AND (created_at AT TIME ZONE 'Africa/Casablanca')::date = (now() AT TIME ZONE 'Africa/Casablanca')::date
  `);
  // Ventes de la semaine (lundi → dimanche, heure marocaine) — règlement hebdomadaire.
  const { rows: [week] } = await pool.query(`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total
    FROM graissage_movements
    WHERE type='sale' AND cancelled_at IS NULL
      AND (created_at AT TIME ZONE 'Africa/Casablanca') >= date_trunc('week', now() AT TIME ZONE 'Africa/Casablanca')
  `);
  // Bénéfice estimé : prix vendu − prix d'achat actuel du produit.
  const { rows: [{ total_profit }] } = await pool.query(`
    SELECT COALESCE(SUM((COALESCE(m.unit_price, p.price) - COALESCE(p.cost, 0)) * m.qty), 0) AS total_profit
    FROM graissage_movements m JOIN graissage_products p ON p.id = m.product_id
    WHERE m.type='sale' AND m.cancelled_at IS NULL
  `);
  const { rows: items } = await pool.query(
    'SELECT id, name, unit, price, cost, depot_qty, held_qty, image_data FROM graissage_products WHERE is_active=1 ORDER BY name'
  );
  const stock_value_depot = items.reduce((a, p) => a + (parseFloat(p.depot_qty)||0) * (parseFloat(p.cost)||0), 0);
  const stock_value_held  = items.reduce((a, p) => a + (parseFloat(p.held_qty)||0)  * (parseFloat(p.price)||0), 0);
  res.json({
    total_sold:  +(+total_sold).toFixed(2),
    total_paid:  +(+total_paid).toFixed(2),
    balance_due: +((+total_sold) - (+total_paid)).toFixed(2),
    today_count: today.n,
    today_total: +(+today.total).toFixed(2),
    week_count: week.n,
    week_total: +(+week.total).toFixed(2),
    total_profit: +(+total_profit).toFixed(2),
    stock_value_depot: +stock_value_depot.toFixed(2),
    stock_value_held:  +stock_value_held.toFixed(2),
    items,
  });
}));

// ── Annulation d'une vente (erreur de scan) ─────────────────────
// Rend le stock chez l'employé et retire le montant de son compte, mais la ligne
// de vente n'est JAMAIS supprimée : elle reste dans l'historique, marquée annulée.
router.post('/sales/:id/cancel', requireAuth, staff, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(
      "SELECT * FROM graissage_movements WHERE id=$1 AND type='sale' FOR UPDATE", [req.params.id]
    );
    if (!m) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vente introuvable' });
    }
    if (m.cancelled_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Vente déjà annulée' });
    }
    await client.query('UPDATE graissage_products SET held_qty=held_qty+$1 WHERE id=$2', [m.qty, m.product_id]);
    await client.query(
      'UPDATE graissage_movements SET cancelled_at=NOW(), cancelled_by=$1, note=$2 WHERE id=$3',
      [req.user.id,
       (m.note ? m.note + ' · ' : '') + ((req.body && req.body.reason || '').trim() || 'Annulée'),
       m.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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
  // Quantity the seller picked (default 1). Whole units only, min 1.
  const qty = Math.max(1, Math.floor(parseFloat(req.body && req.body.qty) || 1));
  if (!product_id) return res.status(400).json({ error: 'Produit requis' });

  // Idempotence : une vente hors-ligne rejouée (même client_uid) → on renvoie l'existante.
  if (client_uid) {
    const { rows: dup } = await pool.query(
      `SELECT m.id, m.qty, m.amount, p.name AS product_name, p.price AS unit_price, p.held_qty
       FROM graissage_movements m JOIN graissage_products p ON p.id=m.product_id
       WHERE m.client_uid=$1`, [client_uid]
    );
    if (dup[0]) {
      return res.status(200).json({
        ok: true, duplicate: true, sale_id: dup[0].id, qty: dup[0].qty,
        product_name: dup[0].product_name, unit_price: dup[0].unit_price,
        total_amount: dup[0].amount, remaining_stock: dup[0].held_qty,
      });
    }
  }

  const { rows: [p] } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [product_id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const held = parseFloat(p.held_qty) || 0;
  if (held < 1) return res.status(400).json({ error: 'Stock épuisé — rien à vendre' });
  if (held < qty) return res.status(400).json({ error: `Stock insuffisant : il reste ${held} ${p.unit || 'unité(s)'}` });

  const total = +(+p.price * qty).toFixed(2);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO graissage_movements (product_id, type, qty, unit_price, amount, client_uid, source, recorded_by)
    VALUES ($1,'sale',$2,$3,$4,$5,'scan',$6) RETURNING id
  `, [p.id, qty, p.price, total, client_uid || null, req.user.id]);
  await pool.query('UPDATE graissage_products SET held_qty=held_qty-$1 WHERE id=$2', [qty, p.id]);

  res.status(201).json({
    ok: true, sale_id: id, qty,
    product_name: p.name, unit: p.unit, unit_price: p.price,
    total_amount: total, remaining_stock: held - qty,
  });
}));

// Produit unique (page de scan). En dernier pour ne pas masquer les routes ci-dessus.
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM graissage_products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  res.json(rows[0]);
}));

module.exports = router;
