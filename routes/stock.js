const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const DENSITY = 1000;

router.get('/', requireAuth, wrap(async (_req, res) => {
  const { rows: fuels } = await pool.query('SELECT * FROM fuel_types WHERE is_active=1');
  const { rows: [{ t: totalRevenue }] } = await pool.query(
    "SELECT COALESCE(SUM(total_fuel_revenue),0) as t FROM shifts WHERE status='closed'"
  );

  const result = [];
  for (const ft of fuels) {
    const { rows: [row] } = await pool.query(
      'SELECT COALESCE(SUM(quantity_liters),0) as total, COALESCE(SUM(quantity_liters*COALESCE(cost_per_liter,0)),0) as cost FROM fuel_deliveries WHERE fuel_type_id=$1',
      [ft.id]
    );
    const { rows: deliveries } = await pool.query(`
      SELECT fd.*, u.full_name as by_name
      FROM fuel_deliveries fd LEFT JOIN users u ON u.id=fd.recorded_by
      WHERE fd.fuel_type_id=$1 ORDER BY fd.created_at DESC LIMIT 20
    `, [ft.id]);
    result.push({
      id: ft.id, name: ft.name, color_hex: ft.color_hex,
      stock_liters: parseFloat(row.total),
      total_cost:   parseFloat(row.cost),
      deliveries
    });
  }

  const grandCost = result.reduce((s, f) => s + f.total_cost, 0);
  res.json({ fuels: result, total_revenue: parseFloat(totalRevenue), total_cost: grandCost, profit: parseFloat(totalRevenue) - grandCost });
}));

router.post('/delivery', requireAuth, wrap(async (req, res) => {
  const { fuel_type_id, quantity, unit, delivery_date, supplier, notes, cost_per_liter, numero_cheque } = req.body || {};
  const qty = parseFloat(quantity);
  if (!fuel_type_id || !qty || qty <= 0) return res.status(400).json({ error: 'Carburant et quantité valide requis' });
  const { rows: ftr } = await pool.query('SELECT * FROM fuel_types WHERE id=$1', [Number(fuel_type_id)]);
  if (!ftr.length) return res.status(404).json({ error: 'Carburant introuvable' });
  const litres = unit === 'tonnes' ? qty * DENSITY : qty;
  const cost   = cost_per_liter ? parseFloat(cost_per_liter) : null;
  const delivDate = delivery_date || new Date().toISOString().slice(0,10);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO fuel_deliveries (fuel_type_id,quantity_liters,delivery_date,supplier,notes,cost_per_liter,numero_cheque,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [Number(fuel_type_id), litres, delivDate, supplier||null, notes||null, cost, numero_cheque||null, req.user.id]);

  // Auto-fill cuve livraison for the matching fuel type
  const { rows: cuves } = await pool.query(
    'SELECT id FROM cuves WHERE fuel_type_id=$1 AND is_active=1 ORDER BY id LIMIT 1',
    [Number(fuel_type_id)]
  );
  if (cuves.length) {
    await pool.query(`
      INSERT INTO cuve_livraisons (cuve_id,livraison_date,litres_recus,fournisseur,prix_unitaire,notes,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [cuves[0].id, delivDate, litres, supplier||null, cost||null, notes||null, req.user.id]);
  }

  res.status(201).json({ ok: true, id: Number(id), quantity_liters: litres });
}));

router.delete('/delivery/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM fuel_deliveries WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

module.exports = router;
