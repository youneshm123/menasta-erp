const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── GET all cuves with current status ─────────────────────────
router.get('/', requireAuth, wrap(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: cuves } = await pool.query(`
    SELECT c.*, ft.name as fuel_name, ft.color_hex
    FROM cuves c JOIN fuel_types ft ON ft.id=c.fuel_type_id
    WHERE c.is_active=1 ORDER BY c.id
  `);

  const result = [];
  for (const cuve of cuves) {
    // Last reading
    const { rows: [lastLec] } = await pool.query(`
      SELECT * FROM cuve_lectures WHERE cuve_id=$1 ORDER BY lecture_date DESC LIMIT 1
    `, [cuve.id]);

    // Today's reading
    const { rows: [todayLec] } = await pool.query(`
      SELECT * FROM cuve_lectures WHERE cuve_id=$1 AND lecture_date=$2
    `, [cuve.id, today]);

    // Theoretical: last reading + deliveries since - liters sold since
    let theorique = null;
    if (lastLec) {
      const sinceDate = lastLec.lecture_date;

      const { rows: [{ liv }] } = await pool.query(`
        SELECT COALESCE(SUM(litres_recus),0) as liv
        FROM cuve_livraisons
        WHERE cuve_id=$1 AND livraison_date > $2
      `, [cuve.id, sinceDate]);

      const { rows: [{ sold }] } = await pool.query(`
        SELECT COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as sold
        FROM pumps p
        JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
        JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                    AND pr_end.shift_id=pr_start.shift_id
        JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
        WHERE p.fuel_type_id=$1 AND date(s.opened_at) > $2
      `, [cuve.fuel_type_id, sinceDate]);

      theorique = parseFloat(lastLec.niveau_litres) + parseFloat(liv) - parseFloat(sold);
    }

    const ecart = (todayLec && theorique !== null)
      ? parseFloat(todayLec.niveau_litres) - theorique
      : null;

    result.push({
      ...cuve,
      capacite_max:  parseFloat(cuve.capacite_max),
      niveau_alerte: parseFloat(cuve.niveau_alerte),
      last_lecture:  lastLec || null,
      today_lecture: todayLec || null,
      theorique:     theorique !== null ? Math.round(theorique) : null,
      ecart:         ecart !== null ? Math.round(ecart) : null,
      niveau_actuel: lastLec ? parseFloat(lastLec.niveau_litres) : null,
    });
  }

  res.json(result);
}));

// ── POST new cuve ─────────────────────────────────────────────
router.post('/', requireAuth, wrap(async (req, res) => {
  const { name, fuel_type_id, capacite_max, niveau_alerte } = req.body || {};
  if (!name || !fuel_type_id) return res.status(400).json({ error: 'name et fuel_type_id requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO cuves (name, fuel_type_id, capacite_max, niveau_alerte) VALUES ($1,$2,$3,$4) RETURNING id',
    [name, fuel_type_id, capacite_max || 20000, niveau_alerte || 3000]
  );
  res.status(201).json({ ok: true, id });
}));

// ── DELETE cuve ───────────────────────────────────────────────
router.delete('/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE cuves SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── GET all fuel types ────────────────────────────────────────
router.get('/fuel-types', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM fuel_types ORDER BY id');
  res.json(rows);
}));

// ── GET lecture history for a cuve ────────────────────────────
router.get('/:id/historique', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT cl.*, u.full_name as recorded_by_name
    FROM cuve_lectures cl
    LEFT JOIN users u ON u.id=cl.recorded_by
    WHERE cl.cuve_id=$1 ORDER BY cl.lecture_date DESC LIMIT 60
  `, [req.params.id]);
  res.json(rows);
}));

// ── POST new lecture (dip reading) ────────────────────────────
router.post('/lectures', requireAuth, wrap(async (req, res) => {
  const { cuve_id, lecture_date, niveau_litres, notes } = req.body || {};
  const niv = parseFloat(niveau_litres);
  if (!cuve_id || !isFinite(niv) || niv < 0) return res.status(400).json({ error: 'cuve_id et niveau_litres valide requis' });
  const date = lecture_date || new Date().toISOString().slice(0, 10);

  await pool.query(`
    INSERT INTO cuve_lectures (cuve_id, lecture_date, niveau_litres, recorded_by, notes)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(cuve_id, lecture_date) DO UPDATE SET
      niveau_litres=EXCLUDED.niveau_litres,
      recorded_by=EXCLUDED.recorded_by,
      notes=EXCLUDED.notes
  `, [cuve_id, date, niv, req.user.id, notes || null]);

  res.json({ ok: true });
}));

// ── GET all livraisons ────────────────────────────────────────
router.get('/livraisons', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT cl.*, c.name as cuve_name, ft.name as fuel_name, u.full_name as recorded_by_name
    FROM cuve_livraisons cl
    JOIN cuves c ON c.id=cl.cuve_id
    JOIN fuel_types ft ON ft.id=c.fuel_type_id
    LEFT JOIN users u ON u.id=cl.recorded_by
    ORDER BY cl.livraison_date DESC, cl.id DESC LIMIT 50
  `);
  res.json(rows);
}));

// ── POST new livraison ────────────────────────────────────────
router.post('/livraisons', requireAuth, wrap(async (req, res) => {
  const { cuve_id, livraison_date, litres_recus, fournisseur, prix_unitaire, bon_livraison, notes } = req.body || {};
  const litres = parseFloat(litres_recus);
  if (!cuve_id || !isFinite(litres) || litres <= 0) return res.status(400).json({ error: 'cuve_id et litres_recus valide requis' });
  if (prix_unitaire != null && (!isFinite(parseFloat(prix_unitaire)) || parseFloat(prix_unitaire) < 0))
    return res.status(400).json({ error: 'Prix unitaire invalide' });
  const date = livraison_date || new Date().toISOString().slice(0, 10);

  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO cuve_livraisons (cuve_id,livraison_date,litres_recus,fournisseur,prix_unitaire,bon_livraison,recorded_by,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [cuve_id, date, litres, fournisseur||null, prix_unitaire||null, bon_livraison||null, req.user.id, notes||null]);

  res.status(201).json({ ok: true, id });
}));

router.delete('/livraisons/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM cuve_livraisons WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── GET ecart history (last 30 days) ─────────────────────────
router.get('/:id/ecarts', requireAuth, wrap(async (req, res) => {
  const { rows: lectures } = await pool.query(`
    SELECT * FROM cuve_lectures WHERE cuve_id=$1 ORDER BY lecture_date DESC LIMIT 30
  `, [req.params.id]);

  const { rows: [cuve] } = await pool.query(
    'SELECT * FROM cuves WHERE id=$1', [req.params.id]
  );

  const ecarts = [];
  for (let i = 0; i < lectures.length - 1; i++) {
    const cur  = lectures[i];
    const prev = lectures[i + 1];

    const { rows: [{ liv }] } = await pool.query(`
      SELECT COALESCE(SUM(litres_recus),0) as liv FROM cuve_livraisons
      WHERE cuve_id=$1 AND livraison_date > $2 AND livraison_date <= $3
    `, [req.params.id, prev.lecture_date, cur.lecture_date]);

    const { rows: [{ sold }] } = await pool.query(`
      SELECT COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as sold
      FROM pumps p
      JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
      JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                  AND pr_end.shift_id=pr_start.shift_id
      JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
      WHERE p.fuel_type_id=$1 AND date(s.opened_at) > $2 AND date(s.opened_at) <= $3
    `, [cuve.fuel_type_id, prev.lecture_date, cur.lecture_date]);

    const theorique = parseFloat(prev.niveau_litres) + parseFloat(liv) - parseFloat(sold);
    const reel      = parseFloat(cur.niveau_litres);
    const ecart     = reel - theorique;

    ecarts.push({
      date:      cur.lecture_date,
      reel:      Math.round(reel),
      theorique: Math.round(theorique),
      livraisons: parseFloat(liv),
      vendu:     parseFloat(sold),
      ecart:     Math.round(ecart),
    });
  }

  res.json(ecarts);
}));

module.exports = router;
