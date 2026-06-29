const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireMinRole } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Staff-only guard: blocks the limited "scan" role from everything except
// loading a product (/:id) and confirming a QR sale (/scan-sell).
const staff = requireMinRole('caissier');

router.get('/', requireAuth, staff, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE is_active=1 ORDER BY category, name');
  res.json(rows);
}));

router.post('/', requireAuth, staff, wrap(async (req, res) => {
  const { reference, name, category, unit, price, stock_qty, stock_min } = req.body || {};
  const prix = parseFloat(price);
  if (!reference || !name || !isFinite(prix) || prix <= 0) return res.status(400).json({ error: 'Référence, nom et prix valide requis' });

  // The "reference" column is UNIQUE. Handle conflicts cleanly instead of letting
  // the DB throw a 500: block a duplicate of an active product with a clear message,
  // and reuse (reactivate) the row if that reference belonged to a deleted product.
  const { rows: dup } = await pool.query('SELECT id, name, is_active FROM products WHERE reference=$1', [reference]);
  if (dup[0]) {
    if (dup[0].is_active) {
      return res.status(409).json({ error: `La référence « ${reference} » est déjà utilisée par « ${dup[0].name} ». Choisissez une référence différente.` });
    }
    await pool.query(
      'UPDATE products SET name=$1,category=$2,unit=$3,price=$4,stock_qty=$5,stock_min=$6,is_active=1 WHERE id=$7',
      [name, category||'Huiles', unit||'unité', prix, stock_qty||0, stock_min||5, dup[0].id]
    );
    const { rows: [p] } = await pool.query('SELECT * FROM products WHERE id=$1', [dup[0].id]);
    return res.status(201).json(p);
  }

  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO products (reference,name,category,unit,price,stock_qty,stock_min)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
  `, [reference, name, category||'Huiles', unit||'unité', prix, stock_qty||0, stock_min||5]);
  const { rows: [p] } = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
  res.status(201).json(p);
}));

router.put('/:id', requireAuth, staff, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const { name, category, unit, price, stock_qty, stock_min } = req.body;
  await pool.query(
    'UPDATE products SET name=$1,category=$2,unit=$3,price=$4,stock_qty=$5,stock_min=$6 WHERE id=$7',
    [name||p.name, category||p.category, unit||p.unit, price||p.price, stock_qty??p.stock_qty, stock_min||p.stock_min, p.id]
  );
  const { rows: [updated] } = await pool.query('SELECT * FROM products WHERE id=$1', [p.id]);
  res.json(updated);
}));

router.delete('/:id', requireAuth, staff, wrap(async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
  if (p) {
    await pool.query(
      `INSERT INTO stock_adjustments (module, product_id, product_name, old_stock, new_stock, delta, action, note, recorded_by)
       VALUES ('produit',$1,$2,$3,0,$4,'suppression','Produit supprimé',$5)`,
      [p.id, p.name, p.stock_qty, -(parseFloat(p.stock_qty) || 0), req.user.id]
    );
  }
  await pool.query('UPDATE products SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Set stock to an exact value + log the change with its date ──
router.post('/:id/stock', requireAuth, staff, wrap(async (req, res) => {
  const newStock = parseFloat(req.body && req.body.new_stock);
  if (!isFinite(newStock) || newStock < 0) return res.status(400).json({ error: 'Stock invalide' });
  const { rows: [p] } = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const oldStock = parseFloat(p.stock_qty) || 0;
  await pool.query('UPDATE products SET stock_qty=$1 WHERE id=$2', [newStock, p.id]);
  await pool.query(
    `INSERT INTO stock_adjustments (module, product_id, product_name, old_stock, new_stock, delta, action, note, recorded_by)
     VALUES ('produit',$1,$2,$3,$4,$5,'modification',$6,$7)`,
    [p.id, p.name, oldStock, newStock, newStock - oldStock, (req.body.note || '').trim() || null, req.user.id]
  );
  res.json({ ok: true, old_stock: oldStock, new_stock: newStock });
}));

// ── Stock change history (carburant huile / produits) ──
router.get('/stock-history', requireAuth, staff, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT sa.*, u.full_name AS by_name
    FROM stock_adjustments sa LEFT JOIN users u ON u.id=sa.recorded_by
    WHERE sa.module='produit'
    ORDER BY sa.created_at DESC LIMIT 100
  `);
  res.json(rows);
}));

// ── Sales ──────────────────────────────────────────────────────
router.get('/sales', requireAuth, staff, wrap(async (req, res) => {
  const { shift_id } = req.query;
  let q, params;
  if (shift_id) {
    q = `SELECT ps.*,p.name as product_name,p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id WHERE ps.shift_id=$1 ORDER BY ps.sale_time DESC`;
    params = [shift_id];
  } else {
    q = `SELECT ps.*,p.name as product_name,p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id ORDER BY ps.sale_time DESC LIMIT 100`;
    params = [];
  }
  const { rows } = await pool.query(q, params);
  res.json(rows);
}));

router.post('/sales', requireAuth, staff, wrap(async (req, res) => {
  const { shift_id, product_id, quantity } = req.body || {};
  const qty = parseFloat(quantity);
  if (!product_id || !isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantité valide et produit requis' });

  // Poste optionnel : s'il est fourni il doit être ouvert, sinon vente boutique (shift_id NULL).
  let sid = null;
  if (shift_id) {
    const { rows: sr } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='open'", [shift_id]);
    if (!sr.length) return res.status(400).json({ error: 'Poste non trouvé ou déjà fermé' });
    sid = shift_id;
  }

  const { rows: pr } = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=1', [product_id]);
  const product = pr[0];
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  if (product.stock_qty < qty) return res.status(400).json({ error: 'Stock insuffisant' });

  const total = +(qty * product.price).toFixed(2);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO product_sales (shift_id,product_id,quantity,unit_price,total_amount,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
  `, [sid, product_id, qty, product.price, total, req.user.id]);

  await pool.query('UPDATE products SET stock_qty=stock_qty-$1 WHERE id=$2', [qty, product_id]);

  const { rows: [sale] } = await pool.query(
    'SELECT ps.*,p.name as product_name,p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id WHERE ps.id=$1', [id]
  );
  res.status(201).json(sale);
}));

router.delete('/sales/:id', requireAuth, staff, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT ps.*,s.status as shift_status FROM product_sales ps LEFT JOIN shifts s ON s.id=ps.shift_id WHERE ps.id=$1', [req.params.id]
  );
  const sale = rows[0];
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.shift_id && sale.shift_status !== 'open') return res.status(400).json({ error: 'Poste déjà fermé' });
  await pool.query('UPDATE products SET stock_qty=stock_qty+$1 WHERE id=$2', [sale.quantity, sale.product_id]);
  await pool.query('DELETE FROM product_sales WHERE id=$1', [sale.id]);
  res.json({ ok: true });
}));

// ── Boutique QR scan ───────────────────────────────────────────
// Recent shop sales (QR scans = sales with no poste attached). Defaults to today.
router.get('/shop-sales', requireAuth, staff, wrap(async (req, res) => {
  const { date } = req.query;
  const day = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : null;
  // When no date is provided, default to today.
  const sql = `
    SELECT ps.id, ps.quantity, ps.unit_price, ps.total_amount, ps.sale_time,
           p.name AS product_name, p.reference, u.full_name AS sold_by
    FROM product_sales ps
    JOIN products p ON p.id = ps.product_id
    LEFT JOIN users u ON u.id = ps.recorded_by
    WHERE ps.shift_id IS NULL AND DATE(ps.sale_time) = COALESCE($1::date, CURRENT_DATE)
    ORDER BY ps.sale_time DESC
    LIMIT 200`;
  const { rows } = await pool.query(sql, [day]);
  const total = rows.reduce((a, r) => a + (parseFloat(r.total_amount) || 0), 0);
  res.json({ sales: rows, total: +total.toFixed(2), count: rows.length });
}));

// QR scan sale — sells exactly 1 unit, no poste required, attributed to scanner.
router.post('/scan-sell', requireAuth, wrap(async (req, res) => {
  const { product_id, client_uid } = req.body || {};
  if (!product_id) return res.status(400).json({ error: 'Produit requis' });

  // Idempotency: a replayed offline sale carries a client_uid already saved → return it, don't re-sell.
  if (client_uid) {
    const { rows: dup } = await pool.query(
      `SELECT ps.id, ps.total_amount, p.name AS product_name, p.reference, p.price AS unit_price, p.stock_qty
       FROM product_sales ps JOIN products p ON p.id=ps.product_id WHERE ps.client_uid=$1`, [client_uid]
    );
    if (dup[0]) {
      return res.status(200).json({
        ok: true, duplicate: true, sale_id: dup[0].id,
        product_name: dup[0].product_name, reference: dup[0].reference,
        unit_price: dup[0].unit_price, total_amount: dup[0].total_amount,
        remaining_stock: dup[0].stock_qty,
      });
    }
  }

  const { rows: pr } = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=1', [product_id]);
  const product = pr[0];
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  if (product.stock_qty < 1) return res.status(400).json({ error: 'Stock épuisé — rien à vendre' });

  const total = +product.price.toFixed(2);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO product_sales (shift_id, product_id, quantity, unit_price, total_amount, recorded_by, client_uid)
    VALUES (NULL, $1, 1, $2, $3, $4, $5) RETURNING id
  `, [product_id, product.price, total, req.user.id, client_uid || null]);

  await pool.query('UPDATE products SET stock_qty = stock_qty - 1 WHERE id=$1', [product_id]);

  res.status(201).json({
    ok: true,
    sale_id: id,
    product_name: product.name,
    reference: product.reference,
    unit_price: product.price,
    total_amount: total,
    remaining_stock: product.stock_qty - 1,
  });
}));

// Single product (for the scan landing page). Declared last so it never shadows
// the literal routes above (/sales, /shop-sales).
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Produit introuvable' });
  res.json(rows[0]);
}));

module.exports = router;
