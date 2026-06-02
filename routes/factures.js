const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function genNumero(lastNum) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const seq = String((lastNum || 0) + 1).padStart(4, '0');
  return `F-${yy}${mm}M${seq}`;
}

router.get('/', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query("SELECT *, to_char(facture_date,'YYYY-MM-DD') AS facture_date FROM factures ORDER BY facture_date DESC, id DESC");
  res.json(rows);
}));

// Client suggestions: merge credit_clients + past invoice clients
router.get('/clients-suggest', requireAuth, wrap(async (_req, res) => {
  const { rows: cc } = await pool.query(`
    SELECT name, ice, adresse, company FROM credit_clients WHERE is_active=1 ORDER BY name
  `);
  const { rows: fc } = await pool.query(`
    SELECT DISTINCT client_name as name, client_ice as ice, client_adresse as adresse, NULL as company
    FROM factures ORDER BY client_name
  `);
  // merge, deduplicate by name (credit_clients take priority)
  const seen = new Set(cc.map(c => c.name.toLowerCase()));
  const all = [...cc, ...fc.filter(c => !seen.has(c.name.toLowerCase()))];
  res.json(all);
}));

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

  const yymm = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`;
  const { rows: [last] } = await pool.query(`SELECT COUNT(*) as c FROM factures WHERE facture_date >= $1`, [`${yymm}-01`]);
  const numero = genNumero(parseInt(last.c));

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
