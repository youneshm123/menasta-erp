const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Aggregated daily alerts: cheques due soon + low stock (huile, tabac, cuves).
router.get('/', requireAuth, wrap(async (_req, res) => {
  // ── Cheques still pending, due within 7 days or overdue ──
  const { rows: cheques } = await pool.query(`
    SELECT id, type, amount, due_date, check_number, beneficiary, description,
           (due_date - CURRENT_DATE) AS days_left
    FROM bank_transactions
    WHERE type IN ('cheque_in','cheque_out') AND check_status='pending'
      AND due_date IS NOT NULL AND due_date <= (CURRENT_DATE + 7)
    ORDER BY due_date ASC
  `);

  // ── Low huile / produits stock ──
  const { rows: produits } = await pool.query(`
    SELECT id, name, stock_qty, stock_min, unit
    FROM products WHERE is_active=1 AND stock_qty <= stock_min
    ORDER BY stock_qty ASC
  `);

  // ── Low tabac stock (≤ 5 units) ──
  const { rows: tabac } = await pool.query(`
    SELECT id, name, stock_actuel FROM (
      SELECT tp.id, tp.name,
        COALESCE(SUM(ta.quantite),0)
        - COALESCE((SELECT SUM(tv.quantite) FROM tabac_ventes tv WHERE tv.product_id=tp.id),0)
        + COALESCE(tp.stock_adjust,0) AS stock_actuel
      FROM tabac_products tp
      LEFT JOIN tabac_achats ta ON ta.product_id=tp.id
      WHERE tp.is_active=1
      GROUP BY tp.id, tp.name, tp.stock_adjust
    ) s WHERE s.stock_actuel <= 5 ORDER BY s.stock_actuel ASC
  `);

  // ── Carburant : stock live par carburant (Gazoil / Essence) + projection ──
  // Toujours affiché. Niveau estimé = dernière lecture + livraisons − ventes
  // depuis cette lecture. Heures avant vide = niveau / conso moyenne récente.
  // Seuils bas : Gazoil ≤ 10 000 L, Essence ≤ 1 000 L (sinon niveau_alerte cuve).
  const fuelThreshold = (name) => {
    const f = (name || '').toLowerCase();
    if (f.includes('gazoil') || f.includes('gasoil') || f.includes('diesel')) return 10000;
    if (f.includes('essence')) return 1000;
    return null;
  };

  const fuel_stock = [];
  try {
    // Latest reading per active cuve, grouped by fuel.
    const { rows: cuveRows } = await pool.query(`
      SELECT ft.name AS fuel, c.niveau_alerte,
        (SELECT l.niveau_litres FROM cuve_lectures l WHERE l.cuve_id=c.id ORDER BY l.lecture_date DESC, l.id DESC LIMIT 1) AS lvl,
        (SELECT l.lecture_date  FROM cuve_lectures l WHERE l.cuve_id=c.id ORDER BY l.lecture_date DESC, l.id DESC LIMIT 1) AS ref_date
      FROM cuves c JOIN fuel_types ft ON ft.id=c.fuel_type_id
      WHERE c.is_active=1
    `);

    // Deliveries per fuel with their date (sum the ones after the reference date).
    const { rows: livRows } = await pool.query(`
      SELECT ft.name AS fuel, cl.livraison_date AS day, cl.litres_recus AS litres
      FROM cuve_livraisons cl JOIN cuves c ON c.id=cl.cuve_id JOIN fuel_types ft ON ft.id=c.fuel_type_id
    `);

    // Liters sold per fuel per day (paired start/end meter readings on closed shifts).
    const { rows: salesRows } = await pool.query(`
      SELECT ft.name AS fuel, (sh.opened_at)::date AS day,
             SUM(GREATEST(0, e.meter_value - s.meter_value)) AS liters
      FROM shifts sh
      JOIN pump_readings s ON s.shift_id=sh.id AND s.reading_type='start'
      JOIN pump_readings e ON e.shift_id=sh.id AND e.pump_id=s.pump_id AND e.reading_type='end'
      JOIN pumps p ON p.id=s.pump_id
      JOIN fuel_types ft ON ft.id=p.fuel_type_id
      WHERE sh.status='closed'
      GROUP BY ft.name, (sh.opened_at)::date
    `);

    const today = new Date();
    const win7 = new Date(today); win7.setDate(win7.getDate() - 7);
    const dstr = d => d ? new Date(d).toISOString().slice(0, 10) : null;

    // Aggregate per fuel.
    const fuels = {};
    for (const r of cuveRows) {
      const f = (fuels[r.fuel] ||= { fuel: r.fuel, base: 0, ref_date: null, niveau_alerte: parseFloat(r.niveau_alerte) || 0 });
      f.base += parseFloat(r.lvl) || 0;
      const rd = dstr(r.ref_date);
      if (rd && (!f.ref_date || rd > f.ref_date)) f.ref_date = rd;
    }

    for (const f of Object.values(fuels)) {
      const ref = f.ref_date;
      const deliveredSince = livRows
        .filter(l => l.fuel === f.fuel && ref && dstr(l.day) > ref)
        .reduce((s, l) => s + (parseFloat(l.litres) || 0), 0);
      const soldSince = salesRows
        .filter(r => r.fuel === f.fuel && ref && dstr(r.day) > ref)
        .reduce((s, r) => s + (parseFloat(r.liters) || 0), 0);

      const level = Math.max(0, f.base + deliveredSince - soldSince);

      // Average daily consumption over the last 7 days (operating days only).
      const recent = salesRows.filter(r => r.fuel === f.fuel && new Date(r.day) >= win7);
      const recentDays = new Set(recent.map(r => dstr(r.day))).size;
      const recentLiters = recent.reduce((s, r) => s + (parseFloat(r.liters) || 0), 0);
      const daily = recentDays > 0 ? recentLiters / recentDays : 0;

      const hours_to_empty = daily > 0 ? (level / daily) * 24 : null;
      const seuil = fuelThreshold(f.fuel) != null ? fuelThreshold(f.fuel) : f.niveau_alerte;
      const low = level <= seuil;
      const empty_soon = (hours_to_empty != null && hours_to_empty <= 24) || level <= 0;

      fuel_stock.push({
        fuel: f.fuel, level, as_of_date: ref, daily_liters: Math.round(daily),
        hours_to_empty: hours_to_empty != null ? Math.round(hours_to_empty) : null,
        seuil, low, empty_soon,
      });
    }
    fuel_stock.sort((a, b) => (b.empty_soon - a.empty_soon) || (a.level - b.level));
  } catch (_) { /* cuves / readings optional */ }

  const chequesOut = cheques.map(c => ({
    id: c.id, type: c.type, amount: parseFloat(c.amount), due_date: c.due_date,
    check_number: c.check_number, beneficiary: c.beneficiary, description: c.description,
    days_left: c.days_left, overdue: c.days_left < 0,
  }));

  // Badge counts only actionable fuels (low or about to be empty).
  const fuelAlerts = fuel_stock.filter(f => f.low || f.empty_soon).length;
  const count = chequesOut.length + produits.length + tabac.length + fuelAlerts;
  res.json({
    count,
    cheques: chequesOut,
    stock_produits: produits.map(p => ({ ...p, stock_qty: parseFloat(p.stock_qty), stock_min: parseFloat(p.stock_min) })),
    stock_tabac: tabac.map(t => ({ ...t, stock_actuel: parseFloat(t.stock_actuel) })),
    fuel_stock,
  });
}));

module.exports = router;
