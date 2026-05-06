const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

const list = () => db.prepare(`
  SELECT p.*, ft.name as fuel_name, ft.price_per_liter, ft.color_hex
  FROM pumps p JOIN fuel_types ft ON ft.id = p.fuel_type_id
  ORDER BY p.id
`).all();

router.get('/', requireAuth, (_req, res) => res.json(list()));

router.post('/', requireAuth, (req, res) => {
  const { name, fuel_type_id } = req.body || {};
  if (!name || !fuel_type_id) return res.status(400).json({ error: 'Nom et type carburant requis' });
  const id = db.prepare('INSERT INTO pumps (name, fuel_type_id) VALUES (?,?)').run(name, fuel_type_id).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT p.*, ft.name as fuel_name FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.id=?').get(id));
});

router.put('/:id', requireAuth, (req, res) => {
  const { name, fuel_type_id, status } = req.body || {};
  const p = db.prepare('SELECT * FROM pumps WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pompe introuvable' });
  db.prepare('UPDATE pumps SET name=?, fuel_type_id=?, status=? WHERE id=?')
    .run(name||p.name, fuel_type_id||p.fuel_type_id, status||p.status, p.id);
  res.json(list().find(x => x.id === p.id));
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare("UPDATE pumps SET status='inactive' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/pumps/fuel-types
router.get('/fuel-types', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM fuel_types WHERE is_active=1 ORDER BY id').all())
);

router.post('/fuel-types', requireAuth, (req, res) => {
  const { name, price_per_liter, color_hex } = req.body || {};
  if (!name || !price_per_liter) return res.status(400).json({ error: 'Nom et prix requis' });
  const id = db.prepare('INSERT INTO fuel_types (name, price_per_liter, color_hex) VALUES (?,?,?)')
    .run(name, price_per_liter, color_hex||'#0070F2').lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM fuel_types WHERE id=?').get(id));
});

router.put('/fuel-types/:id', requireAuth, (req, res) => {
  const { price_per_liter, name, color_hex } = req.body || {};
  const ft = db.prepare('SELECT * FROM fuel_types WHERE id=?').get(req.params.id);
  if (!ft) return res.status(404).json({ error: 'Type carburant introuvable' });
  db.prepare('UPDATE fuel_types SET name=?, price_per_liter=?, color_hex=? WHERE id=?')
    .run(name||ft.name, price_per_liter||ft.price_per_liter, color_hex||ft.color_hex, ft.id);
  res.json(db.prepare('SELECT * FROM fuel_types WHERE id=?').get(ft.id));
});

module.exports = router;
