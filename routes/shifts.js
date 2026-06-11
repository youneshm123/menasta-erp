const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const { computeFuelTotals } = require('../lib/shiftCalc');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

async function calcShift(shiftId) {
  const { rows: readings } = await pool.query(`
    SELECT s.pump_id, s.meter_value as start_val, e.meter_value as end_val, ft.price_per_liter
    FROM pump_readings s
    JOIN pump_readings e ON e.shift_id=s.shift_id AND e.pump_id=s.pump_id AND e.reading_type='end'
    JOIN pumps p         ON p.id=s.pump_id
    JOIN fuel_types ft   ON ft.id=p.fuel_type_id
    WHERE s.shift_id=$1 AND s.reading_type='start'
  `, [shiftId]);

  // Mid-shift price changes per pump (sorted by meter ascending)
  const { rows: changes } = await pool.query(
    'SELECT pump_id, meter_value, price_before, price_after FROM shift_price_changes WHERE shift_id=$1 ORDER BY pump_id, meter_value ASC',
    [shiftId]
  );
  const chByPump = {};
  for (const c of changes) (chByPump[c.pump_id] = chByPump[c.pump_id] || []).push(c);

  let totalLiters = 0, totalFuel = 0;
  for (const r of readings) {
    const S = Number(r.start_val), E = Number(r.end_val);
    totalLiters += Math.max(0, E - S);
    const segs = chByPump[r.pump_id];
    if (!segs || !segs.length) {
      totalFuel += Math.max(0, E - S) * Number(r.price_per_liter);
    } else {
      let prev = S;
      for (const c of segs) {
        const m = Math.min(Math.max(Number(c.meter_value), S), E);
        totalFuel += Math.max(0, m - prev) * Number(c.price_before);
        prev = Math.max(prev, m);
      }
      totalFuel += Math.max(0, E - prev) * Number(segs[segs.length - 1].price_after);
    }
  }
  const { rows: [{ t: tc }] } = await pool.query('SELECT COALESCE(SUM(amount),0) as t FROM credit_sales WHERE shift_id=$1', [shiftId]);
  const { rows: [{ t: tp }] } = await pool.query('SELECT COALESCE(SUM(total_amount),0) as t FROM product_sales WHERE shift_id=$1', [shiftId]);
  const { rows: [{ avance }] } = await pool.query('SELECT avance FROM shifts WHERE id=$1', [shiftId]);
  const { rows: [{ t: te }] } = await pool.query('SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE shift_id=$1', [shiftId]);
  const { rows: [{ t: tpay }] } = await pool.query('SELECT COALESCE(SUM(amount),0) as t FROM credit_payments WHERE shift_id=$1', [shiftId]);
  const totalCredit   = parseFloat(tc);
  const totalProduct  = parseFloat(tp);
  const totalAvance   = parseFloat(avance) || 0;
  const totalExpenses = parseFloat(te) || 0;
  const totalPayments = parseFloat(tpay) || 0;
  return { totalLiters, totalFuel, totalCredit, totalProduct, totalAvance, totalExpenses, totalPayments,
           netCash: totalFuel - totalCredit + totalProduct - totalAvance - totalExpenses + totalPayments };
}

async function shiftDetail(shift) {
  const { rows: pr } = await pool.query(`
    SELECT pr.*, p.name as pump_name, ft.name as fuel_name, ft.price_per_liter
    FROM pump_readings pr
    JOIN pumps p     ON p.id=pr.pump_id
    JOIN fuel_types ft ON ft.id=p.fuel_type_id
    WHERE pr.shift_id=$1 ORDER BY pr.pump_id, pr.reading_type
  `, [shift.id]);
  shift.pump_readings = pr;

  const { rows: cs } = await pool.query(`
    SELECT cs.*, cc.name as client_name,
      COALESCE(p.name, 'Lubrifiant') as pump_name
    FROM credit_sales cs
    JOIN credit_clients cc ON cc.id=cs.credit_client_id
    LEFT JOIN pumps p ON p.id=cs.pump_id
    WHERE cs.shift_id=$1 ORDER BY cs.sale_time
  `, [shift.id]);
  shift.credit_sales = cs;

  const { rows: cpay } = await pool.query(`
    SELECT cp.*, cc.name as client_name
    FROM credit_payments cp
    JOIN credit_clients cc ON cc.id=cp.credit_client_id
    WHERE cp.shift_id=$1 ORDER BY cp.payment_time
  `, [shift.id]);
  shift.credit_payments = cpay;

  const { rows: ps } = await pool.query(`
    SELECT ps.*, pr.name as product_name, pr.reference
    FROM product_sales ps
    JOIN products pr ON pr.id=ps.product_id
    WHERE ps.shift_id=$1 ORDER BY ps.sale_time
  `, [shift.id]);
  shift.product_sales = ps;

  const { rows: exp } = await pool.query(
    'SELECT * FROM expenses WHERE shift_id=$1 ORDER BY created_at',
    [shift.id]
  );
  shift.expenses = exp;

  const { rows: pc } = await pool.query(`
    SELECT pc.*, p.name as pump_name, ft.name as fuel_name
    FROM shift_price_changes pc
    JOIN pumps p ON p.id=pc.pump_id
    JOIN fuel_types ft ON ft.id=p.fuel_type_id
    WHERE pc.shift_id=$1 ORDER BY pc.created_at, pc.pump_id
  `, [shift.id]);
  shift.price_changes = pc;

  return shift;
}

router.get('/', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s LEFT JOIN users u ON u.id=s.opened_by
    ORDER BY s.opened_at DESC LIMIT 50
  `);
  res.json(rows);
}));

router.get('/last-readings', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT pr.pump_id, pr.meter_value
    FROM pump_readings pr
    JOIN shifts s ON s.id=pr.shift_id
    WHERE s.status='closed' AND pr.reading_type='end'
    AND s.id=(SELECT id FROM shifts WHERE status='closed' ORDER BY closed_at DESC LIMIT 1)
  `);
  const map = {};
  rows.forEach(r => { map[r.pump_id] = parseFloat(r.meter_value); });
  res.json(map);
}));

router.get('/current', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s LEFT JOIN users u ON u.id=s.opened_by
    WHERE s.status='open'
  `);
  if (!rows.length) return res.json(null);
  res.json(await shiftDetail(rows[0]));
}));

router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s LEFT JOIN users u ON u.id=s.opened_by
    WHERE s.id=$1
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Poste introuvable' });
  res.json(await shiftDetail(rows[0]));
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { readings, notes, avance, pompiste, heure_debut, heure_fin } = req.body || {};
  if (!readings || !readings.length)
    return res.status(400).json({ error: 'Relevés de début requis' });

  const { rows: open } = await pool.query("SELECT id FROM shifts WHERE status='open'");
  if (open.length) return res.status(400).json({ error: 'Un poste est déjà ouvert (ID ' + open[0].id + ')' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ id: shiftId }] } = await client.query(
      'INSERT INTO shifts (opened_by,notes,avance,pompiste,heure_debut,heure_fin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, notes || '', parseFloat(avance) || 0, pompiste||null, heure_debut||null, heure_fin||null]
    );
    for (const r of readings)
      await client.query(
        "INSERT INTO pump_readings (shift_id,pump_id,reading_type,meter_value,recorded_by) VALUES ($1,$2,'start',$3,$4)",
        [shiftId, r.pump_id, r.meter_value, req.user.id]
      );
    await client.query('COMMIT');

    const { rows: [shift] } = await pool.query('SELECT * FROM shifts WHERE id=$1', [shiftId]);
    res.status(201).json(await shiftDetail(shift));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

router.post('/:id/close', requireAuth, wrap(async (req, res) => {
  const { readings, notes } = req.body || {};
  const { rows } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='open'", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Poste ouvert introuvable' });
  if (!readings || !readings.length)
    return res.status(400).json({ error: 'Relevés de fin requis' });

  const shift = rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of readings)
      await client.query(`
        INSERT INTO pump_readings (shift_id,pump_id,reading_type,meter_value,recorded_by)
        VALUES ($1,$2,'end',$3,$4)
        ON CONFLICT (shift_id,pump_id,reading_type) DO UPDATE SET meter_value=EXCLUDED.meter_value, recorded_by=EXCLUDED.recorded_by
      `, [shift.id, r.pump_id, r.meter_value, req.user.id]);

    const calc = await calcShift(shift.id);
    await client.query(`
      UPDATE shifts SET
        status='closed', closed_at=NOW(),
        total_liters_sold=$1, total_fuel_revenue=$2, total_credit_deducted=$3,
        total_product_sales=$4, net_cash=$5, credit_paid=$6, notes=COALESCE($7,notes)
      WHERE id=$8
    `, [calc.totalLiters, calc.totalFuel, calc.totalCredit, calc.totalProduct, calc.netCash, calc.totalPayments, notes||null, shift.id]);
    await client.query('COMMIT');

    const { rows: [updated] } = await pool.query('SELECT * FROM shifts WHERE id=$1', [shift.id]);
    res.json({ ...await shiftDetail(updated), calc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ── Mid-shift fuel price change (applies to all pumps of a fuel) ──
router.post('/:id/price-change', requireAuth, wrap(async (req, res) => {
  const { fuel_type_id, new_price, readings } = req.body || {};
  const np = parseFloat(new_price);
  if (!fuel_type_id || !isFinite(np) || np <= 0) return res.status(400).json({ error: 'Carburant et nouveau prix valides requis' });
  if (!Array.isArray(readings) || !readings.length) return res.status(400).json({ error: 'Compteurs requis' });

  const { rows: sh } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='open'", [req.params.id]);
  if (!sh.length) return res.status(404).json({ error: 'Poste ouvert introuvable' });
  const { rows: [ft] } = await pool.query('SELECT * FROM fuel_types WHERE id=$1', [fuel_type_id]);
  if (!ft) return res.status(404).json({ error: 'Carburant introuvable' });
  const priceBefore = parseFloat(ft.price_per_liter);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of readings) {
      const mv = parseFloat(r.meter_value);
      if (!isFinite(mv) || mv < 0) continue;
      await client.query(
        'INSERT INTO shift_price_changes (shift_id,pump_id,meter_value,price_before,price_after,recorded_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.params.id, r.pump_id, mv, priceBefore, np, req.user.id]
      );
    }
    // The new price becomes the official price going forward.
    await client.query('UPDATE fuel_types SET price_per_liter=$1 WHERE id=$2', [np, fuel_type_id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { rows: [shift] } = await pool.query('SELECT * FROM shifts WHERE id=$1', [req.params.id]);
  res.json(await shiftDetail(shift));
}));

router.post('/:id/reopen', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM shifts WHERE id=$1 AND status='closed'", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Poste fermé introuvable' });
  const { rows: open } = await pool.query("SELECT id FROM shifts WHERE status='open'");
  if (open.length) return res.status(400).json({ error: 'Un poste est déjà ouvert (ID ' + open[0].id + '). Fermez-le avant de réouvrir.' });

  const shift = rows[0];
  await pool.query(`
    UPDATE shifts SET status='open', closed_at=NULL,
      total_liters_sold=NULL, total_fuel_revenue=NULL,
      total_credit_deducted=NULL, total_product_sales=NULL, net_cash=NULL
    WHERE id=$1
  `, [shift.id]);
  const { rows: [updated] } = await pool.query('SELECT * FROM shifts WHERE id=$1', [shift.id]);
  res.json(await shiftDetail(updated));
}));

module.exports = router;
