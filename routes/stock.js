const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

// Litres per tonne by fuel type name (Moroccan ONHYM standards)
const DENSITY = { 'Gazoil': 1176, 'Sans Plomb 91': 1351, 'Sans Plomb 95': 1333 };
const toLitres = (name, qty, unit) =>
  unit === 'tonnes' ? qty * (DENSITY[name] || 1176) : qty;

router.get('/', requireAuth, (_req, res) => {
  const fuels = db.prepare('SELECT * FROM fuel_types WHERE is_active=1').all();
  const result = fuels.map(ft => {
    const id = Number(ft.id);

    const delivered = Number(db.prepare(
      'SELECT COALESCE(SUM(quantity_liters),0) as t FROM fuel_deliveries WHERE fuel_type_id=?'
    ).get(id).t) || 0;

    const endTotal = Number(db.prepare(`
      SELECT COALESCE(SUM(pr.meter_value),0) as t
      FROM pump_readings pr JOIN pumps p ON p.id=pr.pump_id
      WHERE pr.reading_type='end' AND p.fuel_type_id=?
    `).get(id).t) || 0;

    const startTotal = Number(db.prepare(`
      SELECT COALESCE(SUM(pr.meter_value),0) as t
      FROM pump_readings pr JOIN pumps p ON p.id=pr.pump_id
      WHERE pr.reading_type='start' AND p.fuel_type_id=?
    `).get(id).t) || 0;

    const sold  = Math.max(0, endTotal - startTotal);
    const stock = Math.max(0, delivered - sold);

    const deliveries = db.prepare(`
      SELECT fd.*, u.full_name as recorded_by_name FROM fuel_deliveries fd
      LEFT JOIN users u ON u.id=fd.recorded_by
      WHERE fd.fuel_type_id=? ORDER BY fd.delivery_date DESC LIMIT 20
    `).all(id);

    return { ...ft, stock_liters: stock, delivered, sold, deliveries };
  });
  res.json(result);
});

router.post('/delivery', requireAuth, (req, res) => {
  const { fuel_type_id, quantity, unit, delivery_date, supplier, notes } = req.body || {};
  if (!fuel_type_id || !quantity) return res.status(400).json({ error: 'Carburant et quantité requis' });

  const ft = db.prepare('SELECT * FROM fuel_types WHERE id=?').get(Number(fuel_type_id));
  if (!ft) return res.status(404).json({ error: 'Carburant introuvable' });

  const quantity_liters = toLitres(ft.name, parseFloat(quantity), unit || 'litres');

  const id = db.prepare(`
    INSERT INTO fuel_deliveries (fuel_type_id, quantity_liters, delivery_date, supplier, notes, recorded_by)
    VALUES (?,?,?,?,?,?)
  `).run(Number(fuel_type_id), quantity_liters, delivery_date || new Date().toISOString().slice(0,10), supplier||null, notes||null, req.user.id).lastInsertRowid;

  res.status(201).json(db.prepare('SELECT * FROM fuel_deliveries WHERE id=?').get(Number(id)));
});

module.exports = router;
