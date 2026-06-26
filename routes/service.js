const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const TYPES = ['lavage', 'graissage'];

// ── Entries for a day (grouped) ───────────────────────────────
router.get('/', requireAuth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT s.*, u.full_name AS by_name
     FROM service_entries s LEFT JOIN users u ON u.id=s.recorded_by
     WHERE s.entry_date=$1 ORDER BY s.id DESC`, [date]);
  const sum = t => rows.filter(r => r.service_type === t).reduce((a, r) => a + (parseFloat(r.montant) || 0), 0);
  const lavage = +sum('lavage').toFixed(2);
  const graissage = +sum('graissage').toFixed(2);
  res.json({ date, entries: rows, lavage, graissage, recette: +(lavage + graissage).toFixed(2) });
}));

// ── Add one entry (type + montant) ────────────────────────────
router.post('/entries', requireAuth, wrap(async (req, res) => {
  const { date, service_type } = req.body || {};
  const montant = parseFloat(req.body.montant);
  if (!TYPES.includes(service_type)) return res.status(400).json({ error: 'Type de service invalide' });
  if (!isFinite(montant) || montant <= 0) return res.status(400).json({ error: 'Montant invalide' });
  const d = date || new Date().toISOString().slice(0, 10);
  const { rows: [e] } = await pool.query(
    'INSERT INTO service_entries (entry_date,service_type,montant,recorded_by) VALUES ($1,$2,$3,$4) RETURNING *',
    [d, service_type, +montant.toFixed(2), req.user.id]
  );
  res.status(201).json(e);
}));

// ── Set the day's total for a type (replaces existing) ────────
router.post('/set', requireAuth, wrap(async (req, res) => {
  const { date, service_type } = req.body || {};
  const montant = parseFloat(req.body.montant);
  if (!TYPES.includes(service_type)) return res.status(400).json({ error: 'Type de service invalide' });
  if (!isFinite(montant) || montant < 0) return res.status(400).json({ error: 'Montant invalide' });
  const d = date || new Date().toISOString().slice(0, 10);
  await pool.query('DELETE FROM service_entries WHERE entry_date=$1 AND service_type=$2', [d, service_type]);
  if (montant > 0) {
    await pool.query(
      'INSERT INTO service_entries (entry_date,service_type,montant,recorded_by) VALUES ($1,$2,$3,$4)',
      [d, service_type, +montant.toFixed(2), req.user.id]
    );
  }
  res.json({ ok: true });
}));

// ── Delete one entry ──────────────────────────────────────────
router.delete('/entries/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM service_entries WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Delete a whole day (from historique) ──────────────────────
router.delete('/day/:date', requireAuth, wrap(async (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide' });
  await pool.query('DELETE FROM service_entries WHERE entry_date=$1', [date]);
  res.json({ ok: true });
}));

// ── Daily history — last 30 days, or a date range when from/to given ──
router.get('/historique', requireAuth, wrap(async (req, res) => {
  const { from, to } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  let rows;
  if (dateRe.test(from || '') || dateRe.test(to || '')) {
    const conds = [], params = [];
    if (dateRe.test(from || '')) { params.push(from); conds.push(`entry_date >= $${params.length}`); }
    if (dateRe.test(to   || '')) { params.push(to);   conds.push(`entry_date <= $${params.length}`); }
    ({ rows } = await pool.query(`
      SELECT entry_date,
        COALESCE(SUM(montant) FILTER (WHERE service_type='lavage'),0)    AS lavage,
        COALESCE(SUM(montant) FILTER (WHERE service_type='graissage'),0) AS graissage,
        COALESCE(SUM(montant),0) AS recette
      FROM service_entries WHERE ${conds.join(' AND ')}
      GROUP BY entry_date ORDER BY entry_date DESC
    `, params));
  } else {
    ({ rows } = await pool.query(`
      SELECT entry_date,
        COALESCE(SUM(montant) FILTER (WHERE service_type='lavage'),0)    AS lavage,
        COALESCE(SUM(montant) FILTER (WHERE service_type='graissage'),0) AS graissage,
        COALESCE(SUM(montant),0) AS recette
      FROM service_entries GROUP BY entry_date ORDER BY entry_date DESC LIMIT 30
    `));
  }
  res.json(rows);
}));

// ── Monthly totals ────────────────────────────────────────────
router.get('/mois', requireAuth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { rows: [r] } = await pool.query(`
    SELECT
      COALESCE(SUM(montant) FILTER (WHERE service_type='lavage'),0)    AS lavage,
      COALESCE(SUM(montant) FILTER (WHERE service_type='graissage'),0) AS graissage,
      COALESCE(SUM(montant),0) AS recette,
      COUNT(*) AS count
    FROM service_entries WHERE TO_CHAR(entry_date,'YYYY-MM')=$1
  `, [month]);
  res.json({ month, ...r });
}));

module.exports = router;
