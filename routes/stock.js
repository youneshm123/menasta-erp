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
      'SELECT COALESCE(SUM(quantity_liters),0) as total, COALESCE(SUM(quantity_liters*cost_per_liter),0) as cost FROM fuel_deliveries WHERE fuel_type_id=$1',
      [ft.id]
    );
    const { rows: deliveries } = await pool.query(`
      SELECT fd.*, u.full_name as by_name
      FROM fuel_deliveries fd LEFT JOIN users u ON u.id=fd.recorded_by
      WHERE fd.fuel_type_id=$1 ORDER BY fd.created_at DESC LIMIT 20
    `, [ft.id]);

    // ── Actual running stock = latest jauge + deliveries since − liters sold since ──
    // Mirrors the Cuves "théorique" logic, aggregated per fuel type.
    let actual_stock = null, jauge_date = null, liv_since = 0, sold_since = 0;
    const { rows: cuves } = await pool.query(
      'SELECT id FROM cuves WHERE fuel_type_id=$1 AND is_active=1', [ft.id]
    );
    if (cuves.length) {
      const cuveIds = cuves.map(c => c.id);
      let base = 0, hasLec = false, refDate = null;
      for (const cid of cuveIds) {
        const { rows: [lec] } = await pool.query(
          'SELECT * FROM cuve_lectures WHERE cuve_id=$1 ORDER BY lecture_date DESC LIMIT 1', [cid]
        );
        if (lec) {
          hasLec = true;
          base += parseFloat(lec.niveau_litres);
          if (!refDate || lec.lecture_date > refDate) refDate = lec.lecture_date;
        }
      }
      if (hasLec) {
        const { rows: [{ liv }] } = await pool.query(
          'SELECT COALESCE(SUM(litres_recus),0) as liv FROM cuve_livraisons WHERE cuve_id = ANY($1) AND livraison_date > $2',
          [cuveIds, refDate]
        );
        const { rows: [{ sold }] } = await pool.query(`
          SELECT COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as sold
          FROM pumps p
          JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
          JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                      AND pr_end.shift_id=pr_start.shift_id
          JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
          WHERE p.fuel_type_id=$1 AND date(s.opened_at) > $2
        `, [ft.id, refDate]);
        liv_since  = parseFloat(liv);
        sold_since = parseFloat(sold);
        actual_stock = base + liv_since - sold_since;
        jauge_date = refDate;
      }
    }

    result.push({
      id: ft.id, name: ft.name, color_hex: ft.color_hex,
      stock_liters: parseFloat(row.total),
      actual_stock: actual_stock != null ? Math.round(actual_stock) : null,
      jauge_date,
      liv_since:  Math.round(liv_since),
      sold_since: Math.round(sold_since),
      total_cost:   parseFloat(row.cost),
      deliveries
    });
  }

  const grandCost = result.reduce((s, f) => s + f.total_cost, 0);

  // ── Daily profit (last 30 days) = revenue that day − liters sold × avg purchase cost ──
  const avgCost = {};                       // fuel_type_id → average purchase cost per liter
  for (const f of result) avgCost[f.id] = f.stock_liters > 0 ? f.total_cost / f.stock_liters : 0;

  const { rows: dayLiters } = await pool.query(`
    SELECT to_char(s.opened_at,'YYYY-MM-DD') as d, p.fuel_type_id as ftid,
           COALESCE(SUM(pr_end.meter_value - pr_start.meter_value),0) as liters
    FROM pumps p
    JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                AND pr_end.shift_id=pr_start.shift_id
    JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
    WHERE s.opened_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1, 2
  `);
  const { rows: dayRev } = await pool.query(`
    SELECT to_char(opened_at,'YYYY-MM-DD') as d, COALESCE(SUM(total_fuel_revenue),0) as rev
    FROM shifts WHERE status='closed' AND opened_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1
  `);

  const dayMap = {};
  for (const r of dayRev) dayMap[r.d] = { date: r.d, liters: 0, revenue: parseFloat(r.rev), cost: 0 };
  for (const r of dayLiters) {
    const d = dayMap[r.d] || (dayMap[r.d] = { date: r.d, liters: 0, revenue: 0, cost: 0 });
    const liters = parseFloat(r.liters);
    d.liters += liters;
    d.cost   += liters * (avgCost[r.ftid] || 0);
  }
  const daily_profit = Object.values(dayMap)
    .map(d => ({ date: d.date, liters: Math.round(d.liters), revenue: Math.round(d.revenue), cost: Math.round(d.cost), profit: Math.round(d.revenue - d.cost) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  res.json({ fuels: result, total_revenue: parseFloat(totalRevenue), total_cost: grandCost, profit: parseFloat(totalRevenue) - grandCost, daily_profit });
}));

router.post('/delivery', requireAuth, wrap(async (req, res) => {
  const { fuel_type_id, quantity, unit, delivery_date, supplier, notes, cost_per_liter, numero_cheque } = req.body || {};
  const qty = parseFloat(quantity);
  if (!fuel_type_id || !qty || qty <= 0) return res.status(400).json({ error: 'Carburant et quantité valide requis' });
  const { rows: ftr } = await pool.query('SELECT * FROM fuel_types WHERE id=$1', [Number(fuel_type_id)]);
  if (!ftr.length) return res.status(404).json({ error: 'Carburant introuvable' });
  const litres     = unit === 'tonnes' ? qty * DENSITY : qty;
  const prixUnit   = cost_per_liter ? parseFloat(cost_per_liter) : null;
  const delivDate  = delivery_date || new Date().toISOString().slice(0,10);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO fuel_deliveries (fuel_type_id,quantity_liters,cost_per_liter,delivery_date,supplier,notes,numero_cheque,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [Number(fuel_type_id), litres, prixUnit, delivDate, supplier||null, notes||null, numero_cheque||null, req.user.id]);

  // Auto-fill cuve livraison for the matching fuel type
  const { rows: cuves } = await pool.query(
    'SELECT id FROM cuves WHERE fuel_type_id=$1 AND is_active=1 ORDER BY id LIMIT 1',
    [Number(fuel_type_id)]
  );
  if (cuves.length) {
    await pool.query(`
      INSERT INTO cuve_livraisons (cuve_id,livraison_date,litres_recus,fournisseur,prix_unitaire,notes,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [cuves[0].id, delivDate, litres, supplier||null, prixUnit||null, notes||null, req.user.id]);
  }

  res.status(201).json({ ok: true, id: Number(id), quantity_liters: litres });
}));

router.delete('/delivery/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM fuel_deliveries WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

module.exports = router;
