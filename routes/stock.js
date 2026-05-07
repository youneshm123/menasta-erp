const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

const DENSITY = { 'Gazoil': 1176, 'Essence': 1340 };

router.get('/', requireAuth, (_req, res) => {
  const fuels = db.prepare('SELECT * FROM fuel_types WHERE is_active=1').all();
  const totalRevenue = Number(db.prepare("SELECT COALESCE(SUM(total_fuel_revenue),0) as t FROM shifts WHERE status='closed'").get().t) || 0;
  const result = fuels.map(ft => {
    const id = Number(ft.id);
    const row = db.prepare('SELECT COALESCE(SUM(quantity_liters),0) as total, COALESCE(SUM(quantity_liters * COALESCE(cost_per_liter,0)),0) as cost FROM fuel_deliveries WHERE fuel_type_id = ?').get(id);
    const stock = Number(row.total) || 0;
    const totalCost = Number(row.cost) || 0;
    const deliveries = db.prepare(`
      SELECT fd.*, u.full_name as by_name
      FROM fuel_deliveries fd
      LEFT JOIN users u ON u.id = fd.recorded_by
      WHERE fd.fuel_type_id = ?
      ORDER BY fd.created_at DESC LIMIT 20
    `).all(id);
    return { id, name: ft.name, color_hex: ft.color_hex, stock_liters: stock, total_cost: totalCost, deliveries };
  });
  const grandCost = result.reduce((s, f) => s + f.total_cost, 0);
  res.json({ fuels: result, total_revenue: totalRevenue, total_cost: grandCost, profit: totalRevenue - grandCost });
});

router.post('/delivery', requireAuth, (req, res) => {
  const { fuel_type_id, quantity, unit, delivery_date, supplier, notes, cost_per_liter } = req.body || {};
  if (!fuel_type_id || !quantity) return res.status(400).json({ error: 'Carburant et quantité requis' });
  const ft = db.prepare('SELECT * FROM fuel_types WHERE id = ?').get(Number(fuel_type_id));
  if (!ft) return res.status(404).json({ error: 'Carburant introuvable' });
  const litres = unit === 'tonnes' ? parseFloat(quantity) * (DENSITY[ft.name] || 1176) : parseFloat(quantity);
  const cost = cost_per_liter ? parseFloat(cost_per_liter) : null;
  const id = db.prepare(`
    INSERT INTO fuel_deliveries (fuel_type_id, quantity_liters, delivery_date, supplier, notes, cost_per_liter, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Number(fuel_type_id), litres, delivery_date || new Date().toISOString().slice(0,10), supplier||null, notes||null, cost, req.user.id).lastInsertRowid;
  res.status(201).json({ ok: true, id: Number(id), quantity_liters: litres });
});

router.delete('/delivery/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM fuel_deliveries WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
