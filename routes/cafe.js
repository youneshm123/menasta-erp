const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── MENU ─────────────────────────────────────────────────────
router.get('/menu', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM cafe_menu WHERE is_active=1 ORDER BY id');
  res.json(rows);
}));

router.post('/menu', requireAuth, wrap(async (req, res) => {
  const { name, emoji, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO cafe_menu (name,emoji,price) VALUES ($1,$2,$3) RETURNING id',
    [name, emoji||'☕', price||7]
  );
  const { rows: [item] } = await pool.query('SELECT * FROM cafe_menu WHERE id=$1', [id]);
  res.status(201).json(item);
}));

router.put('/menu/:id', requireAuth, wrap(async (req, res) => {
  const { name, emoji, price, is_active } = req.body || {};
  await pool.query(
    'UPDATE cafe_menu SET name=COALESCE($1,name),emoji=COALESCE($2,emoji),price=COALESCE($3,price),is_active=COALESCE($4,is_active) WHERE id=$5',
    [name||null, emoji||null, price||null, is_active!=null?is_active:null, req.params.id]
  );
  const { rows: [item] } = await pool.query('SELECT * FROM cafe_menu WHERE id=$1', [req.params.id]);
  res.json(item);
}));

router.delete('/menu/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE cafe_menu SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── SALES ────────────────────────────────────────────────────
router.get('/sales', requireAuth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const { rows: items } = await pool.query(`
    SELECT cs.*, cm.name, cm.emoji, cm.price as default_price
    FROM cafe_menu cm
    LEFT JOIN cafe_sales cs ON cs.menu_item_id=cm.id AND cs.sale_date=$1
    WHERE cm.is_active=1 ORDER BY cm.id
  `, [date]);
  const total = items.reduce((s,i) => s + (parseFloat(i.total)||0), 0);
  res.json({ date, items, day_total: total });
}));

router.post('/sales', requireAuth, wrap(async (req, res) => {
  const { date, entries } = req.body || {};
  if (!entries || !entries.length) return res.status(400).json({ error: 'Données manquantes' });
  const d = date || new Date().toISOString().slice(0,10);
  for (const e of entries) {
    const price = e.unit_price || 7;
    await pool.query(`
      INSERT INTO cafe_sales (sale_date,menu_item_id,quantity,unit_price,total,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(sale_date,menu_item_id) DO UPDATE SET
        quantity=EXCLUDED.quantity, unit_price=EXCLUDED.unit_price,
        total=EXCLUDED.total, recorded_by=EXCLUDED.recorded_by
    `, [d, e.menu_item_id, e.quantity||0, price, (e.quantity||0)*price, req.user.id]);
  }
  res.json({ ok: true });
}));

// ── STOCK ITEMS ───────────────────────────────────────────────
router.get('/stock/items', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM cafe_stock_items WHERE is_active=1 ORDER BY id');
  res.json(rows);
}));

router.post('/stock/items', requireAuth, wrap(async (req, res) => {
  const { name, unit, cost_per_unit } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO cafe_stock_items (name,unit,cost_per_unit) VALUES ($1,$2,$3) RETURNING id',
    [name, unit||'unité', cost_per_unit||0]
  );
  const { rows: [item] } = await pool.query('SELECT * FROM cafe_stock_items WHERE id=$1', [id]);
  res.status(201).json(item);
}));

router.put('/stock/items/:id', requireAuth, wrap(async (req, res) => {
  const { name, unit, cost_per_unit, is_active } = req.body || {};
  await pool.query(
    'UPDATE cafe_stock_items SET name=COALESCE($1,name),unit=COALESCE($2,unit),cost_per_unit=COALESCE($3,cost_per_unit),is_active=COALESCE($4,is_active) WHERE id=$5',
    [name||null, unit||null, cost_per_unit!=null?cost_per_unit:null, is_active!=null?is_active:null, req.params.id]
  );
  const { rows: [item] } = await pool.query('SELECT * FROM cafe_stock_items WHERE id=$1', [req.params.id]);
  res.json(item);
}));

router.delete('/stock/items/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE cafe_stock_items SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── STOCK USAGE ───────────────────────────────────────────────
router.get('/stock/usage', requireAuth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const { rows: items } = await pool.query(`
    SELECT csi.*, csu.quantity_used, csu.total_cost, csu.cost_per_unit as used_cost
    FROM cafe_stock_items csi
    LEFT JOIN cafe_stock_usage csu ON csu.stock_item_id=csi.id AND csu.usage_date=$1
    WHERE csi.is_active=1 ORDER BY csi.id
  `, [date]);
  const total_cost = items.reduce((s,i) => s + (parseFloat(i.total_cost)||0), 0);
  res.json({ date, items, total_cost });
}));

router.post('/stock/usage', requireAuth, wrap(async (req, res) => {
  const { date, entries } = req.body || {};
  if (!entries || !entries.length) return res.status(400).json({ error: 'Données manquantes' });
  const d = date || new Date().toISOString().slice(0,10);
  for (const e of entries) {
    const cost = e.cost_per_unit;
    await pool.query(`
      INSERT INTO cafe_stock_usage (usage_date,stock_item_id,quantity_used,cost_per_unit,total_cost,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(usage_date,stock_item_id) DO UPDATE SET
        quantity_used=EXCLUDED.quantity_used, cost_per_unit=EXCLUDED.cost_per_unit,
        total_cost=EXCLUDED.total_cost, recorded_by=EXCLUDED.recorded_by
    `, [d, e.stock_item_id, e.quantity_used||0, cost, (e.quantity_used||0)*cost, req.user.id]);
  }
  res.json({ ok: true });
}));

// ── RAPPORT JOURNALIER ────────────────────────────────────────
router.get('/report/day', requireAuth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const { rows: sales } = await pool.query(`
    SELECT cs.*, cm.name, cm.emoji FROM cafe_sales cs
    JOIN cafe_menu cm ON cm.id=cs.menu_item_id
    WHERE cs.sale_date=$1 AND cs.quantity>0 ORDER BY cm.id
  `, [date]);
  const { rows: stock } = await pool.query(`
    SELECT csu.*, csi.name, csi.unit FROM cafe_stock_usage csu
    JOIN cafe_stock_items csi ON csi.id=csu.stock_item_id
    WHERE csu.usage_date=$1 AND csu.quantity_used>0 ORDER BY csi.id
  `, [date]);
  const revenue    = sales.reduce((s,r) => s + parseFloat(r.total), 0);
  const stock_cost = stock.reduce((s,r) => s + parseFloat(r.total_cost), 0);
  res.json({ date, sales, stock, revenue, stock_cost, net_profit: revenue - stock_cost });
}));

// ── RAPPORT MENSUEL ───────────────────────────────────────────
router.get('/report/month', requireAuth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const { rows: days } = await pool.query(`
    SELECT d.day,
      COALESCE(r.revenue,0) as revenue,
      COALESCE(s.stock_cost,0) as stock_cost,
      COALESCE(r.revenue,0)-COALESCE(s.stock_cost,0) as net_profit
    FROM (
      SELECT DISTINCT date(sale_date) as day FROM cafe_sales WHERE strftime('%Y-%m', sale_date)=$1
      UNION
      SELECT DISTINCT date(usage_date) FROM cafe_stock_usage WHERE strftime('%Y-%m', usage_date)=$2
    ) d
    LEFT JOIN (SELECT sale_date, SUM(total) as revenue FROM cafe_sales WHERE strftime('%Y-%m', sale_date)=$3 GROUP BY sale_date) r ON r.sale_date=d.day
    LEFT JOIN (SELECT usage_date, SUM(total_cost) as stock_cost FROM cafe_stock_usage WHERE strftime('%Y-%m', usage_date)=$4 GROUP BY usage_date) s ON s.usage_date=d.day
    ORDER BY d.day DESC
  `, [month, month, month, month]);
  const totRevenue   = days.reduce((s,d) => s + parseFloat(d.revenue), 0);
  const totStockCost = days.reduce((s,d) => s + parseFloat(d.stock_cost), 0);
  const totProfit    = days.reduce((s,d) => s + parseFloat(d.net_profit), 0);
  res.json({ month, days, total_revenue: totRevenue, total_stock_cost: totStockCost, total_profit: totProfit });
}));

module.exports = router;
