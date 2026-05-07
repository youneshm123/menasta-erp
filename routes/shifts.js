const router      = require('express').Router();
const db          = require('../db');
const { requireAuth } = require('../middleware');

// ── helpers ──────────────────────────────────────────────────
function calcShift(shiftId) {
  const readings = db.prepare(`
    SELECT s.pump_id,
      s.meter_value as start_val,
      e.meter_value as end_val,
      ft.price_per_liter
    FROM pump_readings s
    JOIN pump_readings e   ON e.shift_id = s.shift_id AND e.pump_id = s.pump_id AND e.reading_type = 'end'
    JOIN pumps p           ON p.id = s.pump_id
    JOIN fuel_types ft     ON ft.id = p.fuel_type_id
    WHERE s.shift_id = ? AND s.reading_type = 'start'
  `).all(shiftId);

  let totalLiters = 0, totalFuel = 0;
  for (const r of readings) {
    const liters  = Math.max(0, r.end_val - r.start_val);
    const revenue = liters * r.price_per_liter;
    totalLiters += liters;
    totalFuel   += revenue;
  }
  const totalCredit  = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM credit_sales WHERE shift_id = ?').get(shiftId).t;
  const totalProduct = db.prepare('SELECT COALESCE(SUM(total_amount),0) as t FROM product_sales WHERE shift_id = ?').get(shiftId).t;
  const netCash      = totalFuel - totalCredit + totalProduct;
  return { totalLiters, totalFuel, totalCredit, totalProduct, netCash };
}

function shiftDetail(shift) {
  shift.pump_readings = db.prepare(`
    SELECT pr.*, p.name as pump_name, ft.name as fuel_name, ft.price_per_liter
    FROM pump_readings pr
    JOIN pumps p ON p.id = pr.pump_id
    JOIN fuel_types ft ON ft.id = p.fuel_type_id
    WHERE pr.shift_id = ?
    ORDER BY pr.pump_id, pr.reading_type
  `).all(shift.id);

  shift.credit_sales = db.prepare(`
    SELECT cs.*, cc.name as client_name, p.name as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id = cs.credit_client_id
    JOIN pumps p ON p.id = cs.pump_id
    WHERE cs.shift_id = ?
    ORDER BY cs.sale_time
  `).all(shift.id);

  shift.product_sales = db.prepare(`
    SELECT ps.*, pr.name as product_name, pr.reference
    FROM product_sales ps
    JOIN products pr ON pr.id = ps.product_id
    WHERE ps.shift_id = ?
    ORDER BY ps.sale_time
  `).all(shift.id);

  return shift;
}

// GET /api/shifts
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s
    LEFT JOIN users u ON u.id = s.opened_by
    ORDER BY s.opened_at DESC LIMIT 50
  `).all();
  res.json(rows);
});

// GET /api/shifts/current
router.get('/current', requireAuth, (req, res) => {
  const shift = db.prepare(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s LEFT JOIN users u ON u.id = s.opened_by
    WHERE s.status = 'open'
  `).get();
  if (!shift) return res.json(null);
  res.json(shiftDetail(shift));
});

// GET /api/shifts/:id
router.get('/:id', requireAuth, (req, res) => {
  const shift = db.prepare(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s LEFT JOIN users u ON u.id = s.opened_by
    WHERE s.id = ?
  `).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Poste introuvable' });
  res.json(shiftDetail(shift));
});

// POST /api/shifts  — open shift + start readings
router.post('/', requireAuth, (req, res) => {
  const { readings, notes } = req.body || {};
  if (!readings || !readings.length)
    return res.status(400).json({ error: 'Relevés de début requis' });

  const open = db.prepare("SELECT id FROM shifts WHERE status='open'").get();
  if (open) return res.status(400).json({ error: 'Un poste est déjà ouvert (ID ' + open.id + ')' });

  const shiftId = db.prepare(
    'INSERT INTO shifts (opened_by, notes) VALUES (?,?)'
  ).run(req.user.id, notes || '').lastInsertRowid;

  const ins = db.prepare(
    "INSERT INTO pump_readings (shift_id, pump_id, reading_type, meter_value, recorded_by) VALUES (?,?,'start',?,?)"
  );
  for (const r of readings) ins.run(shiftId, r.pump_id, r.meter_value, req.user.id);

  res.status(201).json(shiftDetail(db.prepare('SELECT * FROM shifts WHERE id=?').get(shiftId)));
});

// POST /api/shifts/:id/close  — end readings + compute
router.post('/:id/close', requireAuth, (req, res) => {
  const { readings, notes } = req.body || {};
  const shift = db.prepare("SELECT * FROM shifts WHERE id=? AND status='open'").get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Poste ouvert introuvable' });
  if (!readings || !readings.length)
    return res.status(400).json({ error: 'Relevés de fin requis' });

  const ins = db.prepare(
    "INSERT OR REPLACE INTO pump_readings (shift_id, pump_id, reading_type, meter_value, recorded_by) VALUES (?,?,'end',?,?)"
  );
  for (const r of readings) ins.run(shift.id, r.pump_id, r.meter_value, req.user.id);

  const calc = calcShift(shift.id);
  db.prepare(`
    UPDATE shifts SET
      status='closed', closed_at=datetime('now','localtime'),
      total_liters_sold=?, total_fuel_revenue=?, total_credit_deducted=?,
      total_product_sales=?, net_cash=?, notes=COALESCE(?,notes)
    WHERE id=?
  `).run(calc.totalLiters, calc.totalFuel, calc.totalCredit, calc.totalProduct, calc.netCash, notes||null, shift.id);

  res.json({ ...shiftDetail(db.prepare('SELECT * FROM shifts WHERE id=?').get(shift.id)), calc });
});

// POST /api/shifts/:id/reopen
router.post('/:id/reopen', requireAuth, (req, res) => {
  const shift = db.prepare("SELECT * FROM shifts WHERE id=? AND status='closed'").get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Poste fermé introuvable' });
  const open = db.prepare("SELECT id FROM shifts WHERE status='open'").get();
  if (open) return res.status(400).json({ error: 'Un poste est déjà ouvert (ID ' + open.id + '). Fermez-le avant de réouvrir.' });
  db.prepare(`
    UPDATE shifts SET status='open', closed_at=NULL,
      total_liters_sold=NULL, total_fuel_revenue=NULL,
      total_credit_deducted=NULL, total_product_sales=NULL, net_cash=NULL
    WHERE id=?
  `).run(shift.id);
  res.json(shiftDetail(db.prepare('SELECT * FROM shifts WHERE id=?').get(shift.id)));
});

module.exports = router;
