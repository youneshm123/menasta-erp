const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

router.get('/', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM products WHERE is_active=1 ORDER BY category, name').all())
);

router.post('/', requireAuth, (req, res) => {
  const { reference, name, category, unit, price, stock_qty, stock_min } = req.body || {};
  if (!reference || !name || !price) return res.status(400).json({ error: 'Référence, nom et prix requis' });
  const id = db.prepare(`
    INSERT INTO products (reference, name, category, unit, price, stock_qty, stock_min)
    VALUES (?,?,?,?,?,?,?)
  `).run(reference, name, category||'Huiles', unit||'unité', price, stock_qty||0, stock_min||5).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
});

router.put('/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const { name, category, unit, price, stock_qty, stock_min } = req.body;
  db.prepare('UPDATE products SET name=?, category=?, unit=?, price=?, stock_qty=?, stock_min=? WHERE id=?')
    .run(name||p.name, category||p.category, unit||p.unit, price||p.price, stock_qty??p.stock_qty, stock_min||p.stock_min, p.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(p.id));
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE products SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Sales ──────────────────────────────────────────────────────
router.get('/sales', requireAuth, (req, res) => {
  const { shift_id } = req.query;
  const q = shift_id
    ? `SELECT ps.*, p.name as product_name, p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id WHERE ps.shift_id=? ORDER BY ps.sale_time DESC`
    : `SELECT ps.*, p.name as product_name, p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id ORDER BY ps.sale_time DESC LIMIT 100`;
  res.json(shift_id ? db.prepare(q).all(shift_id) : db.prepare(q).all());
});

router.post('/sales', requireAuth, (req, res) => {
  const { shift_id, product_id, quantity } = req.body || {};
  if (!shift_id || !product_id || !quantity) return res.status(400).json({ error: 'Champs obligatoires manquants' });

  const shift = db.prepare("SELECT * FROM shifts WHERE id=? AND status='open'").get(shift_id);
  if (!shift) return res.status(400).json({ error: 'Poste non trouvé ou déjà fermé' });

  const product = db.prepare('SELECT * FROM products WHERE id=? AND is_active=1').get(product_id);
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  if (product.stock_qty < quantity) return res.status(400).json({ error: 'Stock insuffisant' });

  const total = +(quantity * product.price).toFixed(2);
  const id = db.prepare(`
    INSERT INTO product_sales (shift_id, product_id, quantity, unit_price, total_amount, recorded_by)
    VALUES (?,?,?,?,?,?)
  `).run(shift_id, product_id, quantity, product.price, total, req.user.id).lastInsertRowid;

  db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id=?').run(quantity, product_id);

  res.status(201).json(db.prepare(`
    SELECT ps.*, p.name as product_name, p.reference FROM product_sales ps JOIN products p ON p.id=ps.product_id WHERE ps.id=?
  `).get(id));
});

router.delete('/sales/:id', requireAuth, (req, res) => {
  const sale = db.prepare(`
    SELECT ps.*, s.status as shift_status FROM product_sales ps JOIN shifts s ON s.id=ps.shift_id WHERE ps.id=?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
  if (sale.shift_status !== 'open') return res.status(400).json({ error: 'Poste déjà fermé' });
  db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id=?').run(sale.quantity, sale.product_id);
  db.prepare('DELETE FROM product_sales WHERE id=?').run(sale.id);
  res.json({ ok: true });
});

module.exports = router;
