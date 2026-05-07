const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

async function list() {
  const { rows } = await pool.query(`
    SELECT p.*, ft.name as fuel_name, ft.price_per_liter, ft.color_hex
    FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id ORDER BY p.id
  `);
  return rows;
}

router.get('/', requireAuth, wrap(async (_req, res) => res.json(await list())));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { name, fuel_type_id } = req.body || {};
  if (!name || !fuel_type_id) return res.status(400).json({ error: 'Nom et type carburant requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO pumps (name,fuel_type_id) VALUES ($1,$2) RETURNING id', [name, fuel_type_id]
  );
  const { rows: [p] } = await pool.query(
    'SELECT p.*,ft.name as fuel_name FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.id=$1', [id]
  );
  res.status(201).json(p);
}));

router.put('/:id', requireAuth, wrap(async (req, res) => {
  const { name, fuel_type_id, status } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM pumps WHERE id=$1', [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Pompe introuvable' });
  await pool.query(
    'UPDATE pumps SET name=$1,fuel_type_id=$2,status=$3 WHERE id=$4',
    [name||p.name, fuel_type_id||p.fuel_type_id, status||p.status, p.id]
  );
  const pumps = await list();
  res.json(pumps.find(x => x.id === p.id));
}));

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  await pool.query("UPDATE pumps SET status='inactive' WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

router.get('/fuel-types', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM fuel_types WHERE is_active=1 ORDER BY id');
  res.json(rows);
}));

router.post('/fuel-types', requireAuth, wrap(async (req, res) => {
  const { name, price_per_liter, color_hex } = req.body || {};
  if (!name || !price_per_liter) return res.status(400).json({ error: 'Nom et prix requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO fuel_types (name,price_per_liter,color_hex) VALUES ($1,$2,$3) RETURNING id',
    [name, price_per_liter, color_hex||'#0070F2']
  );
  const { rows: [ft] } = await pool.query('SELECT * FROM fuel_types WHERE id=$1', [id]);
  res.status(201).json(ft);
}));

router.put('/fuel-types/:id', requireAuth, wrap(async (req, res) => {
  const { price_per_liter, name, color_hex } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM fuel_types WHERE id=$1', [req.params.id]);
  const ft = rows[0];
  if (!ft) return res.status(404).json({ error: 'Type carburant introuvable' });
  await pool.query(
    'UPDATE fuel_types SET name=$1,price_per_liter=$2,color_hex=$3 WHERE id=$4',
    [name||ft.name, price_per_liter||ft.price_per_liter, color_hex||ft.color_hex, ft.id]
  );
  const { rows: [updated] } = await pool.query('SELECT * FROM fuel_types WHERE id=$1', [ft.id]);
  res.json(updated);
}));

module.exports = router;
