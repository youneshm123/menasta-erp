const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS cafe_menu (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  emoji      TEXT    NOT NULL DEFAULT '☕',
  price      REAL    NOT NULL DEFAULT 7,
  is_active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cafe_sales (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_date    TEXT    NOT NULL,
  menu_item_id INTEGER NOT NULL REFERENCES cafe_menu(id),
  quantity     INTEGER NOT NULL DEFAULT 0,
  unit_price   REAL    NOT NULL DEFAULT 7,
  total        REAL    NOT NULL DEFAULT 0,
  recorded_by  INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(sale_date, menu_item_id)
);
CREATE TABLE IF NOT EXISTS cafe_stock_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  unit          TEXT    NOT NULL DEFAULT 'unité',
  cost_per_unit REAL    NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cafe_stock_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  usage_date      TEXT    NOT NULL,
  stock_item_id   INTEGER NOT NULL REFERENCES cafe_stock_items(id),
  quantity_used   REAL    NOT NULL DEFAULT 0,
  cost_per_unit   REAL    NOT NULL DEFAULT 0,
  total_cost      REAL    NOT NULL DEFAULT 0,
  recorded_by     INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(usage_date, stock_item_id)
);
`);

// ── Seed ─────────────────────────────────────────────────────
if (db.prepare('SELECT COUNT(*) as c FROM cafe_menu').get().c === 0) {
  const ins = db.prepare('INSERT INTO cafe_menu (name,emoji,price) VALUES (?,?,?)');
  ins.run('Café',            '☕', 7);
  ins.run('Café au Lait',    '🥛', 7);
  ins.run('Lait Chocolat',   '🍫', 7);
  ins.run('Thé',             '🍵', 7);
  ins.run('Soda',            '🥤', 7);
}
if (db.prepare('SELECT COUNT(*) as c FROM cafe_stock_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO cafe_stock_items (name,unit,cost_per_unit) VALUES (?,?,?)');
  ins.run('Café en grains',    'kg',     80);
  ins.run('Lait',              'litre',  8);
  ins.run('Chocolat en poudre','paquet', 25);
  ins.run('Soda (canettes)',   'unité',  4);
  ins.run('Sachets de thé',    'boîte',  15);
  ins.run('Sucre',             'kg',     6);
  ins.run('Gobelets',          'paquet', 12);
}

// ── MENU ─────────────────────────────────────────────────────
router.get('/menu', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM cafe_menu WHERE is_active=1 ORDER BY id').all()));

router.post('/menu', requireAuth, (req, res) => {
  const { name, emoji, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = db.prepare('INSERT INTO cafe_menu (name,emoji,price) VALUES (?,?,?)').run(name, emoji||'☕', price||7).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM cafe_menu WHERE id=?').get(id));
});

router.put('/menu/:id', requireAuth, (req, res) => {
  const { name, emoji, price, is_active } = req.body || {};
  db.prepare('UPDATE cafe_menu SET name=COALESCE(?,name), emoji=COALESCE(?,emoji), price=COALESCE(?,price), is_active=COALESCE(?,is_active) WHERE id=?')
    .run(name||null, emoji||null, price||null, is_active!=null?is_active:null, req.params.id);
  res.json(db.prepare('SELECT * FROM cafe_menu WHERE id=?').get(req.params.id));
});

router.delete('/menu/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE cafe_menu SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── SALES ────────────────────────────────────────────────────
router.get('/sales', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const items = db.prepare(`
    SELECT cs.*, cm.name, cm.emoji, cm.price as default_price
    FROM cafe_menu cm
    LEFT JOIN cafe_sales cs ON cs.menu_item_id=cm.id AND cs.sale_date=?
    WHERE cm.is_active=1 ORDER BY cm.id
  `).all(date);
  const total = items.reduce((s,i)=>s+(i.total||0),0);
  res.json({ date, items, day_total: total });
});

router.post('/sales', requireAuth, (req, res) => {
  const { date, entries } = req.body || {};
  if (!entries || !entries.length) return res.status(400).json({ error: 'Données manquantes' });
  const d = date || new Date().toISOString().slice(0,10);
  const ups = db.prepare(`
    INSERT INTO cafe_sales (sale_date, menu_item_id, quantity, unit_price, total, recorded_by)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(sale_date, menu_item_id) DO UPDATE SET
      quantity=excluded.quantity, unit_price=excluded.unit_price,
      total=excluded.total, recorded_by=excluded.recorded_by
  `);
  for (const e of entries) {
    const price = e.unit_price || 7;
    ups.run(d, e.menu_item_id, e.quantity||0, price, (e.quantity||0)*price, req.user.id);
  }
  res.json({ ok: true });
});

// ── STOCK ITEMS ───────────────────────────────────────────────
router.get('/stock/items', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM cafe_stock_items WHERE is_active=1 ORDER BY id').all()));

router.post('/stock/items', requireAuth, (req, res) => {
  const { name, unit, cost_per_unit } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = db.prepare('INSERT INTO cafe_stock_items (name,unit,cost_per_unit) VALUES (?,?,?)').run(name, unit||'unité', cost_per_unit||0).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM cafe_stock_items WHERE id=?').get(id));
});

router.put('/stock/items/:id', requireAuth, (req, res) => {
  const { name, unit, cost_per_unit, is_active } = req.body || {};
  db.prepare('UPDATE cafe_stock_items SET name=COALESCE(?,name), unit=COALESCE(?,unit), cost_per_unit=COALESCE(?,cost_per_unit), is_active=COALESCE(?,is_active) WHERE id=?')
    .run(name||null, unit||null, cost_per_unit!=null?cost_per_unit:null, is_active!=null?is_active:null, req.params.id);
  res.json(db.prepare('SELECT * FROM cafe_stock_items WHERE id=?').get(req.params.id));
});

router.delete('/stock/items/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE cafe_stock_items SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── STOCK USAGE ───────────────────────────────────────────────
router.get('/stock/usage', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const items = db.prepare(`
    SELECT csi.*, csu.quantity_used, csu.total_cost,
           csu.cost_per_unit as used_cost
    FROM cafe_stock_items csi
    LEFT JOIN cafe_stock_usage csu ON csu.stock_item_id=csi.id AND csu.usage_date=?
    WHERE csi.is_active=1 ORDER BY csi.id
  `).all(date);
  const total_cost = items.reduce((s,i)=>s+(i.total_cost||0),0);
  res.json({ date, items, total_cost });
});

router.post('/stock/usage', requireAuth, (req, res) => {
  const { date, entries } = req.body || {};
  if (!entries || !entries.length) return res.status(400).json({ error: 'Données manquantes' });
  const d = date || new Date().toISOString().slice(0,10);
  const ups = db.prepare(`
    INSERT INTO cafe_stock_usage (usage_date, stock_item_id, quantity_used, cost_per_unit, total_cost, recorded_by)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(usage_date, stock_item_id) DO UPDATE SET
      quantity_used=excluded.quantity_used, cost_per_unit=excluded.cost_per_unit,
      total_cost=excluded.total_cost, recorded_by=excluded.recorded_by
  `);
  for (const e of entries) {
    const cost = e.cost_per_unit;
    ups.run(d, e.stock_item_id, e.quantity_used||0, cost, (e.quantity_used||0)*cost, req.user.id);
  }
  res.json({ ok: true });
});

// ── RAPPORT JOURNALIER ────────────────────────────────────────
router.get('/report/day', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const sales = db.prepare(`
    SELECT cs.*, cm.name, cm.emoji FROM cafe_sales cs
    JOIN cafe_menu cm ON cm.id=cs.menu_item_id
    WHERE cs.sale_date=? AND cs.quantity>0 ORDER BY cm.id
  `).all(date);
  const stock = db.prepare(`
    SELECT csu.*, csi.name, csi.unit FROM cafe_stock_usage csu
    JOIN cafe_stock_items csi ON csi.id=csu.stock_item_id
    WHERE csu.usage_date=? AND csu.quantity_used>0 ORDER BY csi.id
  `).all(date);
  const revenue    = sales.reduce((s,r)=>s+r.total,0);
  const stock_cost = stock.reduce((s,r)=>s+r.total_cost,0);
  const net_profit = revenue - stock_cost;
  res.json({ date, sales, stock, revenue, stock_cost, net_profit });
});

// ── RAPPORT MENSUEL ───────────────────────────────────────────
router.get('/report/month', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const days = db.prepare(`
    SELECT d.day,
      COALESCE(r.revenue,0) as revenue,
      COALESCE(s.stock_cost,0) as stock_cost,
      COALESCE(r.revenue,0)-COALESCE(s.stock_cost,0) as net_profit
    FROM (
      SELECT DISTINCT sale_date as day FROM cafe_sales WHERE strftime('%Y-%m',sale_date)=?
      UNION
      SELECT DISTINCT usage_date FROM cafe_stock_usage WHERE strftime('%Y-%m',usage_date)=?
    ) d
    LEFT JOIN (SELECT sale_date, SUM(total) as revenue FROM cafe_sales WHERE strftime('%Y-%m',sale_date)=? GROUP BY sale_date) r ON r.sale_date=d.day
    LEFT JOIN (SELECT usage_date, SUM(total_cost) as stock_cost FROM cafe_stock_usage WHERE strftime('%Y-%m',usage_date)=? GROUP BY usage_date) s ON s.usage_date=d.day
    ORDER BY d.day DESC
  `).all(month, month, month, month);
  const totRevenue   = days.reduce((s,d)=>s+d.revenue,0);
  const totStockCost = days.reduce((s,d)=>s+d.stock_cost,0);
  const totProfit    = days.reduce((s,d)=>s+d.net_profit,0);
  res.json({ month, days, total_revenue: totRevenue, total_stock_cost: totStockCost, total_profit: totProfit });
});

module.exports = router;
