const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE is_active=1 ORDER BY category, name');
  res.json(rows);
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { reference, name, category, unit, price, stock_qty, stock_min } = req.body || {};
  if (!reference || !name || !price) return res.status(400).json({ error: 'Référence, nom et prix requis' });
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO products (reference,name,category,unit,price,stock_qty,stock_min)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
  `, [reference, name, category||'Huiles', unit||'unité', price, stock_qty||0, stock_min||5]);
  const { rows: [p] } = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
  res.status(201).json(p);
}));

router.put('/:id', requireAuth, wrap(async (req, res) => {
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

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE products SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Sales ──────────────────────────────────────────────────────
router.get('/sales', requireAuth, wrap(async (req, res) => {
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

router.post('/sales', requireAuth, wrap(async (req, res) => {
  const { shift_id, product_id, quantity } = req.body || {};
  if (!shift_id || !product_id || !quantity) return res.status(400).json({ error: 'Champs obligatoires manquants' });

  const { rows: sr } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='open'", [shift_id]);
  if (!sr.length) return res.status(400).json({ error: 'Poste non trouvé ou déjà fermé' });

  const { rows: pr } = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=1', [product_id]);
  const product = pr[0];
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  if (product.stock_qty < quantity) return res.status(400).json({ error: 'Stock insuffisant' });

  const total = +(quantity * product.price).toFixed(2);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO product_sales (shift_id,product_id,quantity,unit_price,total_amount,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
  `, [shift_id, product_id, quantity, product.price, total, req.user.id]);

  await pool.query('UPDATE products SET stock_qty=stock_qty-$1 WHERE id=$2', [quantity, product_id]);

  const { rows: [sale] } = await pool.query(
    'SELECT ps.*,p.name as product_name,p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id WHERE ps.id=$1', [id]
  );
  res.status(201).json(sale);
}));

router.delete('/sales/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT ps.*,s.status as shift_status FROM product_sales ps JOIN shifts s ON s.id=ps.shift_id WHERE ps.id=$1', [req.params.id]
  );
  const sale = rows[0];
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.shift_status !== 'open') return res.status(400).json({ error: 'Poste déjà fermé' });
  await pool.query('UPDATE products SET stock_qty=stock_qty+$1 WHERE id=$2', [sale.quantity, sale.product_id]);
  await pool.query('DELETE FROM product_sales WHERE id=$1', [sale.id]);
  res.json({ ok: true });
}));

module.exports = router;
