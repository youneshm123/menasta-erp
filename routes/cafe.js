const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS cafe_products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'Boissons',
  price      REAL    NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS cafe_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  total_amount REAL    NOT NULL DEFAULT 0,
  payment_type TEXT    NOT NULL DEFAULT 'cash',
  status       TEXT    NOT NULL DEFAULT 'open',
  note         TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at    TEXT
);
CREATE TABLE IF NOT EXISTS cafe_order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES cafe_orders(id),
  product_id  INTEGER NOT NULL REFERENCES cafe_products(id),
  quantity    INTEGER NOT NULL DEFAULT 1,
  unit_price  REAL    NOT NULL,
  total       REAL    NOT NULL
);
`);

// seed default menu
if (db.prepare('SELECT COUNT(*) as c FROM cafe_products').get().c === 0) {
  const ins = db.prepare('INSERT INTO cafe_products (name,category,price) VALUES (?,?,?)');
  ins.run('Café Express',      'Boissons', 6);
  ins.run('Café au Lait',      'Boissons', 8);
  ins.run('Thé',               'Boissons', 5);
  ins.run('Jus Orange',        'Boissons', 15);
  ins.run('Eau Minérale',      'Boissons', 5);
  ins.run('Sandwich',          'Nourriture', 25);
  ins.run('Croissant',         'Nourriture', 8);
  ins.run('Crêpe',             'Nourriture', 12);
}

// GET /api/cafe/products
router.get('/products', requireAuth, (_req, res) => {
  res.json(db.prepare('SELECT * FROM cafe_products WHERE is_active=1 ORDER BY category,name').all());
});

// POST /api/cafe/products
router.post('/products', requireAuth, (req, res) => {
  const { name, category, price } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: 'Nom et prix requis' });
  const id = db.prepare('INSERT INTO cafe_products (name,category,price) VALUES (?,?,?)').run(name, category||'Boissons', price).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM cafe_products WHERE id=?').get(id));
});

// PUT /api/cafe/products/:id
router.put('/products/:id', requireAuth, (req, res) => {
  const { name, category, price, is_active } = req.body || {};
  db.prepare('UPDATE cafe_products SET name=COALESCE(?,name), category=COALESCE(?,category), price=COALESCE(?,price), is_active=COALESCE(?,is_active) WHERE id=?')
    .run(name||null, category||null, price||null, is_active!=null?is_active:null, req.params.id);
  res.json(db.prepare('SELECT * FROM cafe_products WHERE id=?').get(req.params.id));
});

// DELETE /api/cafe/products/:id  (soft delete)
router.delete('/products/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE cafe_products SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/cafe/orders  — create order with items
router.post('/orders', requireAuth, (req, res) => {
  const { items, payment_type, note } = req.body || {};
  if (!items || !items.length) return res.status(400).json({ error: 'Commande vide' });
  let total = 0;
  const orderId = db.prepare('INSERT INTO cafe_orders (payment_type, note, created_by) VALUES (?,?,?)').run(payment_type||'cash', note||null, req.user.id).lastInsertRowid;
  const ins = db.prepare('INSERT INTO cafe_order_items (order_id,product_id,quantity,unit_price,total) VALUES (?,?,?,?,?)');
  for (const it of items) {
    const p = db.prepare('SELECT price FROM cafe_products WHERE id=?').get(it.product_id);
    if (!p) continue;
    const lineTotal = p.price * it.quantity;
    ins.run(orderId, it.product_id, it.quantity, p.price, lineTotal);
    total += lineTotal;
  }
  db.prepare('UPDATE cafe_orders SET total_amount=?, status=\'closed\', closed_at=datetime(\'now\',\'localtime\') WHERE id=?').run(total, orderId);
  res.status(201).json({ ok: true, id: Number(orderId), total });
});

// GET /api/cafe/orders?date=YYYY-MM-DD
router.get('/orders', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const orders = db.prepare(`
    SELECT o.*, u.full_name as by_name
    FROM cafe_orders o LEFT JOIN users u ON u.id=o.created_by
    WHERE date(o.created_at)=? AND o.status='closed'
    ORDER BY o.created_at DESC
  `).all(date);
  for (const o of orders) {
    o.items = db.prepare(`
      SELECT ci.*, p.name as product_name, p.category
      FROM cafe_order_items ci JOIN cafe_products p ON p.id=ci.product_id
      WHERE ci.order_id=?
    `).all(o.id);
  }
  res.json(orders);
});

// DELETE /api/cafe/orders/:id
router.delete('/orders/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM cafe_order_items WHERE order_id=?').run(req.params.id);
  db.prepare('DELETE FROM cafe_orders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/cafe/stats?date=YYYY-MM-DD
router.get('/stats', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const day  = db.prepare("SELECT COALESCE(SUM(total_amount),0) as total, COUNT(*) as count FROM cafe_orders WHERE date(created_at)=? AND status='closed'").get(date);
  const topItems = db.prepare(`
    SELECT p.name, p.category, SUM(ci.quantity) as qty, SUM(ci.total) as revenue
    FROM cafe_order_items ci
    JOIN cafe_orders o ON o.id=ci.order_id
    JOIN cafe_products p ON p.id=ci.product_id
    WHERE date(o.created_at)=? AND o.status='closed'
    GROUP BY ci.product_id ORDER BY qty DESC LIMIT 5
  `).all(date);
  const byPayment = db.prepare("SELECT payment_type, SUM(total_amount) as total FROM cafe_orders WHERE date(created_at)=? AND status='closed' GROUP BY payment_type").all(date);
  res.json({ date, day_total: Number(day.total), order_count: Number(day.count), top_items: topItems, by_payment: byPayment });
});

// GET /api/cafe/report?month=YYYY-MM
router.get('/report', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const rows = db.prepare(`
    SELECT date(created_at) as day, SUM(total_amount) as total, COUNT(*) as count
    FROM cafe_orders WHERE strftime('%Y-%m',created_at)=? AND status='closed'
    GROUP BY day ORDER BY day DESC
  `).all(month);
  const grand = rows.reduce((s,r)=>s+r.total,0);
  res.json({ month, days: rows, month_total: grand });
});

module.exports = router;
