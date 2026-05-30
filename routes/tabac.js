const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── Produits ──────────────────────────────────────────────────
router.get('/produits', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM tabac_products WHERE is_active=1 ORDER BY name');
  res.json(rows);
}));

router.post('/produits', requireAuth, wrap(async (req, res) => {
  const { name, prix_achat, prix_vente } = req.body || {};
  const pa = parseFloat(prix_achat), pv = parseFloat(prix_vente);
  if (!name || !isFinite(pa) || pa <= 0 || !isFinite(pv) || pv <= 0) return res.status(400).json({ error: 'Nom et prix valides requis' });
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO tabac_products (name,prix_achat,prix_vente) VALUES ($1,$2,$3) RETURNING id',
    [name, pa, pv]
  );
  const { rows: [p] } = await pool.query('SELECT * FROM tabac_products WHERE id=$1', [id]);
  res.status(201).json(p);
}));

router.put('/produits/:id', requireAuth, wrap(async (req, res) => {
  const { name, prix_achat, prix_vente } = req.body || {};
  if (prix_achat != null && (!isFinite(parseFloat(prix_achat)) || parseFloat(prix_achat) < 0))
    return res.status(400).json({ error: 'Prix d\'achat invalide' });
  if (prix_vente != null && (!isFinite(parseFloat(prix_vente)) || parseFloat(prix_vente) < 0))
    return res.status(400).json({ error: 'Prix de vente invalide' });
  const { rows } = await pool.query('SELECT * FROM tabac_products WHERE id=$1', [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  await pool.query(
    'UPDATE tabac_products SET name=$1,prix_achat=$2,prix_vente=$3 WHERE id=$4',
    [name||p.name, prix_achat||p.prix_achat, prix_vente||p.prix_vente, p.id]
  );
  const { rows: [updated] } = await pool.query('SELECT * FROM tabac_products WHERE id=$1', [p.id]);
  res.json(updated);
}));

router.delete('/produits/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('UPDATE tabac_products SET is_active=0 WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Ventes ────────────────────────────────────────────────────
router.get('/ventes', requireAuth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows: produits } = await pool.query(`
    SELECT tp.*, tv.quantite, tv.montant, tv.benefice
    FROM tabac_products tp
    LEFT JOIN tabac_ventes tv ON tv.product_id=tp.id AND tv.vente_date=$1
    WHERE tp.is_active=1 ORDER BY tp.name
  `, [date]);
  const total = produits.reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
  const benefice_total = produits.reduce((s, p) => s + (parseFloat(p.benefice) || 0), 0);
  res.json({ date, produits, total, benefice_total });
}));

router.post('/ventes', requireAuth, wrap(async (req, res) => {
  const { date, entries } = req.body || {};
  if (!entries || !entries.length) return res.status(400).json({ error: 'Données manquantes' });
  const d = date || new Date().toISOString().slice(0, 10);
  for (const e of entries) {
    const q = parseFloat(e.quantite);
    if (!isFinite(q) || q < 0) return res.status(400).json({ error: 'Quantité invalide' });
    const { rows: [p] } = await pool.query('SELECT * FROM tabac_products WHERE id=$1', [e.product_id]);
    if (!p) continue;
    const montant = +(q * p.prix_vente).toFixed(2);
    const benefice = +((p.prix_vente - p.prix_achat) * q).toFixed(2);
    await pool.query(`
      INSERT INTO tabac_ventes (vente_date,product_id,quantite,prix_vente,prix_achat,montant,benefice,recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(vente_date,product_id) DO UPDATE SET
        quantite=EXCLUDED.quantite, montant=EXCLUDED.montant,
        benefice=EXCLUDED.benefice, recorded_by=EXCLUDED.recorded_by
    `, [d, e.product_id, q, p.prix_vente, p.prix_achat, montant, benefice, req.user.id]);
  }
  res.json({ ok: true });
}));

router.get('/historique', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT vente_date, SUM(montant) as total, SUM(benefice) as benefice
    FROM tabac_ventes GROUP BY vente_date ORDER BY vente_date DESC LIMIT 30
  `);
  res.json(rows);
}));

router.get('/ventes-mois', requireAuth, wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from et to requis' });
  const { rows } = await pool.query(`
    SELECT tp.name, tp.prix_vente,
           COALESCE(SUM(tv.quantite),0)  AS total_quantite,
           COALESCE(SUM(tv.montant),0)   AS total_montant,
           COALESCE(SUM(tv.benefice),0)  AS total_benefice
    FROM tabac_products tp
    LEFT JOIN tabac_ventes tv ON tv.product_id=tp.id
      AND tv.vente_date >= $1 AND tv.vente_date <= $2
    WHERE tp.is_active=1
    GROUP BY tp.id, tp.name, tp.prix_vente
    ORDER BY total_montant DESC
  `, [from, to]);
  res.json({ rows });
}));

// ── Stock ─────────────────────────────────────────────────────
router.get('/stock', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT tp.id, tp.name, tp.prix_achat, tp.prix_vente,
           COALESCE(SUM(ta.quantite), 0) as total_achete,
           COALESCE((SELECT SUM(tv.quantite) FROM tabac_ventes tv WHERE tv.product_id=tp.id), 0) as total_vendu
    FROM tabac_products tp
    LEFT JOIN tabac_achats ta ON ta.product_id=tp.id
    WHERE tp.is_active=1
    GROUP BY tp.id, tp.name, tp.prix_achat, tp.prix_vente
    ORDER BY tp.name
  `);
  res.json(rows.map(r => ({
    ...r,
    stock_actuel: parseFloat(r.total_achete) - parseFloat(r.total_vendu),
    total_achete: parseFloat(r.total_achete),
    total_vendu:  parseFloat(r.total_vendu),
  })));
}));

router.get('/achats', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT ta.*, tp.name as product_name
    FROM tabac_achats ta JOIN tabac_products tp ON tp.id=ta.product_id
    ORDER BY ta.achat_date DESC, ta.id DESC LIMIT 50
  `);
  res.json(rows);
}));

router.post('/achats', requireAuth, wrap(async (req, res) => {
  const { product_id, quantite, prix_achat, achat_date, notes } = req.body || {};
  const q = parseFloat(quantite);
  if (!product_id || !isFinite(q) || q <= 0) return res.status(400).json({ error: 'Produit et quantité valide requis' });
  if (prix_achat != null && (!isFinite(parseFloat(prix_achat)) || parseFloat(prix_achat) < 0))
    return res.status(400).json({ error: 'Prix d\'achat invalide' });
  const { rows: [p] } = await pool.query('SELECT * FROM tabac_products WHERE id=$1', [product_id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const { rows: [a] } = await pool.query(
    'INSERT INTO tabac_achats (product_id,quantite,prix_achat,achat_date,notes,recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [product_id, q, prix_achat || p.prix_achat, achat_date || new Date().toISOString().slice(0,10), notes||null, req.user.id]
  );
  res.status(201).json(a);
}));

router.delete('/achats/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM tabac_achats WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
