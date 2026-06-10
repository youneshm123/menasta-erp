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

  // ── Low cuve levels — Gazoil ≤ 10 000 L (10 T), Essence ≤ 1 000 L (1 T) ──
  const fuelThreshold = (name) => {
    const f = (name || '').toLowerCase();
    if (f.includes('gazoil') || f.includes('gasoil') || f.includes('diesel')) return 10000;
    if (f.includes('essence')) return 1000;
    return null; // fall back to the cuve's own niveau_alerte
  };
  const cuves = [];
  try {
    const { rows: cuveRows } = await pool.query(`
      SELECT c.id, c.name, c.niveau_alerte, ft.name AS fuel
      FROM cuves c JOIN fuel_types ft ON ft.id=c.fuel_type_id
      WHERE c.is_active=1 ORDER BY c.id
    `);
    for (const cu of cuveRows) {
      const { rows: [lec] } = await pool.query(
        'SELECT niveau_litres FROM cuve_lectures WHERE cuve_id=$1 ORDER BY lecture_date DESC LIMIT 1', [cu.id]
      );
      const seuil = fuelThreshold(cu.fuel) != null ? fuelThreshold(cu.fuel) : parseFloat(cu.niveau_alerte);
      if (lec && parseFloat(lec.niveau_litres) <= seuil) {
        cuves.push({ id: cu.id, name: cu.name, fuel: cu.fuel, niveau: parseFloat(lec.niveau_litres), seuil });
      }
    }
  } catch (_) { /* cuves optional */ }

  const chequesOut = cheques.map(c => ({
    id: c.id, type: c.type, amount: parseFloat(c.amount), due_date: c.due_date,
    check_number: c.check_number, beneficiary: c.beneficiary, description: c.description,
    days_left: c.days_left, overdue: c.days_left < 0,
  }));

  const count = chequesOut.length + produits.length + tabac.length + cuves.length;
  res.json({
    count,
    cheques: chequesOut,
    stock_produits: produits.map(p => ({ ...p, stock_qty: parseFloat(p.stock_qty), stock_min: parseFloat(p.stock_min) })),
    stock_tabac: tabac.map(t => ({ ...t, stock_actuel: parseFloat(t.stock_actuel) })),
    cuves,
  });
}));

module.exports = router;
