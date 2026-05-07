const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

router.get('/', requireAuth, (_req, res) => {
  const fuels = db.prepare('SELECT * FROM fuel_types WHERE is_active=1').all();
  const result = fuels.map(ft => {
    const delivered = db.prepare('SELECT COALESCE(SUM(quantity_liters),0) as t FROM fuel_deliveries WHERE fuel_type_id=?').get(ft.id).t;
    const sold      = db.prepare(`
      SELECT COALESCE(SUM(pr.meter_value - ps.meter_value),0) as t
      FROM pump_readings pr
      JOIN pump_readings ps ON ps.shift_id=pr.shift_id AND ps.pump_id=pr.pump_id AND ps.reading_type='start'
      JOIN pumps p ON p.id=pr.pump_id
      WHERE pr.reading_type='end' AND p.fuel_type_id=?
    `).get(ft.id).t;
    const stock = delivered - sold;
    const deliveries = db.prepare(`
      SELECT fd.*, u.full_name as recorded_by_name FROM fuel_deliveries fd
      LEFT JOIN users u ON u.id=fd.recorded_by
      WHERE fd.fuel_type_id=? ORDER BY fd.delivery_date DESC LIMIT 10
    `).all(ft.id);
    return { ...ft, stock_liters: Math.max(0, stock), delivered, sold, deliveries };
  });
  res.json(result);
});

router.post('/delivery', requireAuth, (req, res) => {
  const { fuel_type_id, quantity_liters, delivery_date, supplier, notes } = req.body || {};
  if (!fuel_type_id || !quantity_liters) return res.status(400).json({ error: 'Carburant et quantité requis' });
  const id = db.prepare(`
    INSERT INTO fuel_deliveries (fuel_type_id, quantity_liters, delivery_date, supplier, notes, recorded_by)
    VALUES (?,?,?,?,?,?)
  `).run(fuel_type_id, quantity_liters, delivery_date||new Date().toISOString().slice(0,10), supplier||null, notes||null, req.user.id).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM fuel_deliveries WHERE id=?').get(id));
});

module.exports = router;
