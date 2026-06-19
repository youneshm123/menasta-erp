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

  // Coût d'achat "hérité" : prix saisi par le patron, sinon moyenne des livraisons.
  // Sert pour les carburants sans stock de départ FIFO, et pour les ventes
  // antérieures à la date de départ (pas de changement rétroactif).
  const legacyCost = {};
  for (const f of result) legacyCost[f.id] = f.cost_per_liter > 0 ? f.cost_per_liter : (f.stock_liters > 0 ? f.total_cost / f.stock_liters : 0);

  // Stock de départ FIFO par carburant (ancien stock à l'ancien prix).
  const { rows: openRows } = await pool.query(
    "SELECT fuel_type_id, liters, cost_per_liter, to_char(since_date,'YYYY-MM-DD') AS since_date FROM fuel_opening_stock"
  );
  const opening = {};
  for (const o of openRows) opening[o.fuel_type_id] = { liters: parseFloat(o.liters), cost: parseFloat(o.cost_per_liter), since: o.since_date };

  // Livraisons (lots FIFO) par carburant, triées par date — chacune à son prix d'achat.
  const { rows: livRows } = await pool.query(`
    SELECT c.fuel_type_id AS ftid, to_char(cl.livraison_date,'YYYY-MM-DD') AS d,
           cl.litres_recus AS liters, cl.prix_unitaire AS cost
    FROM cuve_livraisons cl JOIN cuves c ON c.id=cl.cuve_id
    WHERE cl.prix_unitaire IS NOT NULL AND cl.litres_recus > 0
    ORDER BY cl.livraison_date, cl.id
  `);
  const deliveriesByFuel = {};
  for (const r of livRows) (deliveriesByFuel[r.ftid] = deliveriesByFuel[r.ftid] || []).push({ date: r.d, liters: parseFloat(r.liters), cost: parseFloat(r.cost) });

  // Litres vendus par jour et par carburant (tout l'historique, triés par date).
  const { rows: allDay } = await pool.query(`
    SELECT to_char(s.opened_at,'YYYY-MM-DD') AS d, p.fuel_type_id AS ftid,
           COALESCE(SUM(pr_end.meter_value - pr_start.meter_value),0) AS liters
    FROM pumps p
    JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                AND pr_end.shift_id=pr_start.shift_id
    JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
    GROUP BY 1, 2 ORDER BY 1
  `);

  // Un "consommateur" FIFO par carburant : lots = [stock de départ, …livraisons].
  // consume(jour, litres) renvoie le coût du lot consommé (avec date des lots
  // respectée), en repli sur le coût hérité si on dépasse les lots disponibles.
  function makeConsumer(ls, legacy) {
    let cursor = 0;
    return {
      consume(day, qty) {
        let avail = 0; for (const l of ls) if (l.date <= day) avail += l.liters;
        const usable = Math.min(qty, Math.max(0, avail - cursor));
        let cost = 0, off = 0;
        for (const l of ls) {
          const lo = Math.max(cursor, off), hi = Math.min(cursor + usable, off + l.liters);
          if (hi > lo) cost += (hi - lo) * l.cost;
          off += l.liters;
          if (off >= cursor + usable) break;
        }
        cursor += usable;
        const overflow = qty - usable;
        if (overflow > 0) cost += overflow * legacy;
        return cost;
      },
      currentCost() { let off = 0; for (const l of ls) { if (cursor < off + l.liters) return l.cost; off += l.liters; } return ls.length ? ls[ls.length - 1].cost : legacy; },
      consumed() { return cursor; },
    };
  }
  const consumers = {};
  for (const f of result) {
    const op = opening[f.id];
    if (!op) continue;
    const ls = [{ date: op.since, liters: op.liters, cost: op.cost }];
    for (const dlv of (deliveriesByFuel[f.id] || [])) if (dlv.date >= op.since) ls.push(dlv);
    ls.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    consumers[f.id] = makeConsumer(ls, legacyCost[f.id] || op.cost);
  }

  // Parcours chronologique : coût FIFO à partir de la date de départ, ancien coût avant.
  let grandCost = 0;
  const dayCostMap = {}, dayLitersMap = {};
  for (const r of allDay) {
    const ftid = r.ftid, liters = Math.max(0, parseFloat(r.liters)), day = r.d;
    const op = opening[ftid];
    const dayCost = (op && day >= op.since && consumers[ftid])
      ? consumers[ftid].consume(day, liters)
      : liters * (legacyCost[ftid] || 0);
    grandCost += dayCost;
    dayCostMap[day] = (dayCostMap[day] || 0) + dayCost;
    dayLitersMap[day] = (dayLitersMap[day] || 0) + liters;
  }

  // Coût d'achat effectif (prochain litre vendu) + reste d'ancien stock, par carburant.
  for (const f of result) {
    const op = opening[f.id], cons = consumers[f.id];
    if (op && cons) {
      f.cost_per_liter_effective = cons.currentCost();
      f.old_stock_remaining = Math.max(0, op.liters - cons.consumed());
      f.opening = op;
    } else {
      f.cost_per_liter_effective = legacyCost[f.id] || 0;
    }
  }

  const { rows: dayRev } = await pool.query(`
    SELECT to_char(opened_at,'YYYY-MM-DD') as d, COALESCE(SUM(total_fuel_revenue),0) as rev
    FROM shifts WHERE status='closed' AND opened_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1
  `);
  const dayMap = {};
  for (const r of dayRev) dayMap[r.d] = { date: r.d, liters: dayLitersMap[r.d] || 0, revenue: parseFloat(r.rev), cost: dayCostMap[r.d] || 0 };
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

// Définir le stock de départ FIFO (ancien stock à l'ancien prix) pour un carburant.
router.put('/opening/:id', requireAuth, wrap(async (req, res) => {
  const liters = parseFloat(req.body && req.body.liters);
  const cost   = parseFloat(req.body && req.body.cost_per_liter);
  const since  = (req.body && req.body.since_date) || new Date().toISOString().slice(0, 10);
  if (!isFinite(liters) || liters < 0) return res.status(400).json({ error: 'Litres invalides' });
  if (!isFinite(cost) || cost < 0)     return res.status(400).json({ error: "Prix d'achat invalide" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return res.status(400).json({ error: 'Date invalide (AAAA-MM-JJ)' });
  await pool.query(`
    INSERT INTO fuel_opening_stock (fuel_type_id, liters, cost_per_liter, since_date, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (fuel_type_id) DO UPDATE SET liters=EXCLUDED.liters, cost_per_liter=EXCLUDED.cost_per_liter, since_date=EXCLUDED.since_date, updated_at=NOW()
  `, [Number(req.params.id), liters, cost, since]);
  res.json({ ok: true });
}));

// Supprimer le stock de départ FIFO (retour au coût unique).
router.delete('/opening/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM fuel_opening_stock WHERE fuel_type_id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

module.exports = router;
