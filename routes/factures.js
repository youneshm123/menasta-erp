const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', requireAuth, wrap(async (_req, res) => {
  // Order by facture date (newest month first), so factures group by month;
  // within the same date, newest created first.
  const { rows } = await pool.query("SELECT *, to_char(facture_date,'YYYY-MM-DD') AS facture_date FROM factures ORDER BY factures.facture_date DESC, factures.id DESC");
  res.json(rows);
}));

// Client suggestions for the autocomplete — dedicated facture_clients only
router.get('/clients-suggest', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT name, ice, adresse, NULL as company
    FROM facture_clients WHERE is_active=1 ORDER BY name
  `);
  res.json(rows);
}));

// ── Facture clients (dedicated, separate from carburant credit clients) ──
router.get('/clients', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM facture_clients WHERE is_active=1 ORDER BY name');
  res.json(rows);
}));

router.post('/clients', requireAuth, wrap(async (req, res) => {
  const { name, ice, adresse } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom client requis' });
  const { rows: [c] } = await pool.query(
    'INSERT INTO facture_clients (name, ice, adresse) VALUES ($1,$2,$3) RETURNING *',
    [name.trim(), (ice||'').trim() || null, (adresse||'').trim() || null]
  );
  res.status(201).json(c);
}));

// ── Bulk import facture clients (paste from old software) ──
router.post('/clients/bulk', requireAuth, wrap(async (req, res) => {
  const list = Array.isArray(req.body && req.body.clients) ? req.body.clients : [];
  if (!list.length) return res.status(400).json({ error: 'Aucun client à importer' });

  // Existing names (case-insensitive) to skip duplicates
  const { rows: existing } = await pool.query('SELECT LOWER(name) as n FROM facture_clients WHERE is_active=1');
  const seen = new Set(existing.map(r => r.n));

  let inserted = 0, skipped = 0;
  const added = [];
  for (const c of list) {
    const name = (c && c.name ? String(c.name) : '').trim();
    if (!name) { skipped++; continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const ice     = (c.ice     ? String(c.ice)     : '').trim() || null;
    const adresse = (c.adresse ? String(c.adresse) : '').trim() || null;
    const { rows: [row] } = await pool.query(
      'INSERT INTO facture_clients (name, ice, adresse) VALUES ($1,$2,$3) RETURNING name',
      [name, ice, adresse]
    );
    added.push(row.name);
    inserted++;
  }
  res.json({ ok: true, inserted, skipped });
}));

router.put('/clients/:id', requireAuth, wrap(async (req, res) => {
  const { name, ice, adresse } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom client requis' });
  const { rows: [c] } = await pool.query(
    'UPDATE facture_clients SET name=$1, ice=$2, adresse=$3 WHERE id=$4 RETURNING *',
    [name.trim(), (ice||'').trim() || null, (adresse||'').trim() || null, req.params.id]
  );
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  res.json(c);
}));

router.delete('/clients/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE facture_clients SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Lubrifiant products are pulled from the shared /api/products stock ──
// (Huiles, Lubrifiants, Filtres, etc.) — no separate facture catalogue.

router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT *, to_char(facture_date,'YYYY-MM-DD') AS facture_date FROM factures WHERE id=$1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Facture introuvable' });
  const { rows: lignes } = await pool.query('SELECT * FROM facture_lignes WHERE facture_id=$1 ORDER BY id', [req.params.id]);
  res.json({ ...rows[0], lignes });
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const { facture_date, client_name, client_adresse, client_ice, lignes, notes } = req.body || {};
  if (!client_name || !lignes || !lignes.length) return res.status(400).json({ error: 'Client et lignes requis' });

  for (const l of lignes) {
    const qty = +l.quantite, prix = +l.prix_ht, tva = +l.taux_tva;
    if (!isFinite(qty) || qty < 0 || !isFinite(prix) || prix < 0 || !isFinite(tva) || tva < 0 || tva > 100)
      return res.status(400).json({ error: 'Valeurs de ligne invalides (quantité, prix ou TVA)' });
  }

  // Number prefix follows the facture's own month (May -> 2605), not today.
  // Next sequence = max existing number for that month's prefix + 1.
  // (Using MAX avoids collisions after deletions or date/prefix mismatches.)
  const fdate = facture_date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const [fy, fm] = fdate.split('-');
  const prefix = `F-${fy.slice(-2)}${fm}M`;
  const { rows: [last] } = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(numero FROM '[0-9]+$') AS INTEGER)), 0) AS c
     FROM factures WHERE numero LIKE $1`, [prefix + '%']);
  const numero = `${prefix}${String(parseInt(last.c) + 1).padStart(4, '0')}`;

  let total_ht = 0, montant_tva = 0, total_ttc = 0;
  for (const l of lignes) {
    l.total_ht = +(l.quantite * l.prix_ht).toFixed(2);
    l.montant_tva = +(l.total_ht * (l.taux_tva / 100)).toFixed(2);
    l.montant_ttc = +(l.total_ht + l.montant_tva).toFixed(2);
    total_ht += l.total_ht;
    montant_tva += l.montant_tva;
    total_ttc += l.montant_ttc;
  }
  total_ht = +total_ht.toFixed(2);
  montant_tva = +montant_tva.toFixed(2);
  total_ttc = +total_ttc.toFixed(2);

  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    const { rows: [{ id }] } = await dbc.query(`
      INSERT INTO factures (numero,facture_date,client_name,client_adresse,client_ice,total_ht,montant_tva,total_ttc,notes,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [numero, facture_date||new Date().toISOString().slice(0,10), client_name, client_adresse||null, client_ice||null, total_ht, montant_tva, total_ttc, notes||null, req.user.id]);

    for (const l of lignes) {
      await dbc.query(`
        INSERT INTO facture_lignes (facture_id,code_produit,designation,quantite,prix_ht,taux_tva,total_ht,montant_tva,montant_ttc)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [id, l.code_produit||null, l.designation, l.quantite, l.prix_ht, l.taux_tva||10, l.total_ht, l.montant_tva, l.montant_ttc]);
    }
    await dbc.query('COMMIT');

    const { rows: [facture] } = await dbc.query("SELECT *, to_char(facture_date,'YYYY-MM-DD') AS facture_date FROM factures WHERE id=$1", [id]);
    const { rows: lignesRes } = await dbc.query('SELECT * FROM facture_lignes WHERE facture_id=$1 ORDER BY id', [id]);
    res.status(201).json({ ...facture, lignes: lignesRes });
  } catch (e) {
    await dbc.query('ROLLBACK');
    throw e;
  } finally {
    dbc.release();
  }
}));

router.put('/:id', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM factures WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Facture introuvable' });

  const { facture_date, client_name, client_adresse, client_ice, lignes, notes } = req.body || {};
  if (!client_name || !lignes || !lignes.length) return res.status(400).json({ error: 'Client et lignes requis' });

  for (const l of lignes) {
    const qty = +l.quantite, prix = +l.prix_ht, tva = +l.taux_tva;
    if (!isFinite(qty) || qty < 0 || !isFinite(prix) || prix < 0 || !isFinite(tva) || tva < 0 || tva > 100)
      return res.status(400).json({ error: 'Valeurs de ligne invalides (quantité, prix ou TVA)' });
  }

  let total_ht = 0, montant_tva = 0, total_ttc = 0;
  for (const l of lignes) {
    l.total_ht    = +(l.quantite * l.prix_ht).toFixed(2);
    l.montant_tva = +(l.total_ht * (l.taux_tva / 100)).toFixed(2);
    l.montant_ttc = +(l.total_ht + l.montant_tva).toFixed(2);
    total_ht   += l.total_ht;
    montant_tva += l.montant_tva;
    total_ttc  += l.montant_ttc;
  }
  total_ht = +total_ht.toFixed(2);
  montant_tva = +montant_tva.toFixed(2);
  total_ttc = +total_ttc.toFixed(2);

  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    await dbc.query(`
      UPDATE factures SET facture_date=$1,client_name=$2,client_adresse=$3,client_ice=$4,
        total_ht=$5,montant_tva=$6,total_ttc=$7,notes=$8 WHERE id=$9
    `, [facture_date||rows[0].facture_date, client_name, client_adresse||null, client_ice||null, total_ht, montant_tva, total_ttc, notes||null, req.params.id]);

    await dbc.query('DELETE FROM facture_lignes WHERE facture_id=$1', [req.params.id]);
    for (const l of lignes) {
      await dbc.query(`
        INSERT INTO facture_lignes (facture_id,code_produit,designation,quantite,prix_ht,taux_tva,total_ht,montant_tva,montant_ttc)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [req.params.id, l.code_produit||null, l.designation, l.quantite, l.prix_ht, l.taux_tva||10, l.total_ht, l.montant_tva, l.montant_ttc]);
    }
    await dbc.query('COMMIT');

    const { rows: [facture] } = await dbc.query("SELECT *, to_char(facture_date,'YYYY-MM-DD') AS facture_date FROM factures WHERE id=$1", [req.params.id]);
    const { rows: lignesRes } = await dbc.query('SELECT * FROM facture_lignes WHERE facture_id=$1 ORDER BY id', [req.params.id]);
    res.json({ ...facture, lignes: lignesRes });
  } catch (e) {
    await dbc.query('ROLLBACK');
    throw e;
  } finally {
    dbc.release();
  }
}));

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const dbc = await pool.connect();
  try {
    await dbc.query('BEGIN');
    await dbc.query('DELETE FROM facture_lignes WHERE facture_id=$1', [req.params.id]);
    await dbc.query('DELETE FROM factures WHERE id=$1', [req.params.id]);
    await dbc.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await dbc.query('ROLLBACK');
    throw e;
  } finally {
    dbc.release();
  }
}));

module.exports = router;
