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
    // Deliveries + cost come from cuve_livraisons (the single source of truth).
    const { rows: [row] } = await pool.query(
      `SELECT COALESCE(SUM(cl.litres_recus),0) as total,
              COALESCE(SUM(cl.litres_recus*cl.prix_unitaire),0) as cost
       FROM cuve_livraisons cl JOIN cuves c ON c.id=cl.cuve_id WHERE c.fuel_type_id=$1`,
      [ft.id]
    );
    const { rows: deliveries } = await pool.query(`
      SELECT cl.id,
             cl.litres_recus  AS quantity_liters,
             cl.prix_unitaire AS cost_per_liter,
             cl.livraison_date AS delivery_date,
             cl.fournisseur   AS supplier,
             cl.bon_livraison AS numero_cheque,
             cl.notes, cl.created_at,
             u.full_name as by_name
      FROM cuve_livraisons cl JOIN cuves c ON c.id=cl.cuve_id
      LEFT JOIN users u ON u.id=cl.recorded_by
      WHERE c.fuel_type_id=$1 ORDER BY cl.livraison_date DESC, cl.id DESC LIMIT 20
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
      cost_per_liter: parseFloat(ft.cost_per_liter) || 0,
      deliveries
    });
  }

  // Purchase cost per liter set by the owner (fuel_types.cost_per_liter);
  // falls back to the average delivery cost when not set.
  const avgCost = {};
  for (const f of result) avgCost[f.id] = f.cost_per_liter > 0 ? f.cost_per_liter : (f.stock_liters > 0 ? f.total_cost / f.stock_liters : 0);

  // Real benefice = revenue − cost of fuel SOLD (all-time liters sold × purchase cost).
  const { rows: soldRows } = await pool.query(`
    SELECT p.fuel_type_id as ftid, COALESCE(SUM(pr_end.meter_value - pr_start.meter_value),0) as liters
    FROM pumps p
    JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                AND pr_end.shift_id=pr_start.shift_id
    JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
    GROUP BY p.fuel_type_id
  `);
  let grandCost = 0;
  for (const r of soldRows) grandCost += Math.max(0, parseFloat(r.liters)) * (avgCost[r.ftid] || 0);

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

  // A cuve is required (single source of truth for fuel stock + cost).
  const { rows: cuves } = await pool.query(
    'SELECT id FROM cuves WHERE fuel_type_id=$1 AND is_active=1 ORDER BY id LIMIT 1', [Number(fuel_type_id)]
  );
  if (!cuves.length) return res.status(400).json({ error: 'Aucune cuve pour ce carburant' });

  const litres    = unit === 'tonnes' ? qty * DENSITY : qty;
  const prixUnit  = cost_per_liter ? parseFloat(cost_per_liter) : null;
  const delivDate = delivery_date || new Date().toISOString().slice(0,10);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO cuve_livraisons (cuve_id,livraison_date,litres_recus,fournisseur,prix_unitaire,bon_livraison,notes,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [cuves[0].id, delivDate, litres, supplier||null, prixUnit, numero_cheque||null, notes||null, req.user.id]);

  res.status(201).json({ ok: true, id: Number(id), quantity_liters: litres });
}));

router.delete('/delivery/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM cuve_livraisons WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// Set the purchase cost per liter for a fuel (drives the real benefice).
router.put('/fuel-cost/:id', requireAuth, wrap(async (req, res) => {
  const cost = parseFloat(req.body && req.body.cost_per_liter);
  if (!isFinite(cost) || cost < 0) return res.status(400).json({ error: "Coût d'achat invalide" });
  await pool.query('UPDATE fuel_types SET cost_per_liter=$1 WHERE id=$2', [cost, Number(req.params.id)]);
  res.json({ ok: true, cost_per_liter: cost });
}));

module.exports = router;
