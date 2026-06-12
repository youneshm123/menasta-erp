const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const Anthropic = require('@anthropic-ai/sdk');
const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const IN_TYPES  = ['depot', 'virement_in', 'cheque_in', 'effet_in'];
const OUT_TYPES = ['retrait', 'virement_out', 'cheque_out', 'effet_out'];
const sign = t => IN_TYPES.includes(t) ? 1 : -1;

const BANK_CATS = ['Carburant','Salaires','Loyer','Maintenance','Fournisseur','Client','Banque','Impôts','Autre'];
const TXN_TYPES = [...IN_TYPES, ...OUT_TYPES];

// Types that carry an échéance + status (cheques AND effets) — same columns.
const ECHEANCE_TYPES = ['cheque_in', 'cheque_out', 'effet_in', 'effet_out'];
const isEcheance = t => ECHEANCE_TYPES.includes(t);

// SQL IN-list fragments (built from our own constants — safe to interpolate).
const SQL_IN       = IN_TYPES.map(t => `'${t}'`).join(',');
const SQL_OUT      = OUT_TYPES.map(t => `'${t}'`).join(',');
const SQL_ECHEANCE = ECHEANCE_TYPES.map(t => `'${t}'`).join(',');
const SQL_PEND_OUT = OUT_TYPES.filter(isEcheance).map(t => `'${t}'`).join(',');
const SQL_PEND_IN  = IN_TYPES.filter(isEcheance).map(t => `'${t}'`).join(',');

// Normalised signature of a description (digits/punctuation stripped) — used to learn
// "this kind of line → this category/type" so repeat imports auto-fill.
function signature(desc) {
  return String(desc || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[0-9]/g, ' ').replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Normalise a date string to YYYY-MM-DD (accepts ISO or DD/MM/YYYY, Moroccan style). Returns null if unparseable.
function normDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return null;
}

// ── settings ──────────────────────────────────────────────────
router.get('/settings', requireAuth, wrap(async (_req, res) => {
  const { rows: [s] } = await pool.query('SELECT * FROM bank_settings WHERE id=1');
  res.json(s);
}));

router.put('/settings', requireAuth, wrap(async (req, res) => {
  const { initial_balance, account_name } = req.body || {};
  await pool.query(
    'UPDATE bank_settings SET initial_balance=COALESCE($1,initial_balance),account_name=COALESCE($2,account_name) WHERE id=1',
    [initial_balance != null ? initial_balance : null, account_name || null]
  );
  const { rows: [s] } = await pool.query('SELECT * FROM bank_settings WHERE id=1');
  res.json(s);
}));

// ── balance ───────────────────────────────────────────────────
router.get('/balance', requireAuth, wrap(async (_req, res) => {
  const { rows: [s] }        = await pool.query('SELECT * FROM bank_settings WHERE id=1');
  const { rows: [{ t: ti }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN (${SQL_IN})`);
  const { rows: [{ t: to }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN (${SQL_OUT})`);
  const { rows: [{ t: po }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN (${SQL_PEND_OUT}) AND check_status='pending'`);
  const { rows: [{ t: pi }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN (${SQL_PEND_IN})  AND check_status='pending'`);
  const balance = parseFloat(s?.initial_balance ?? 0) + parseFloat(ti) - parseFloat(to);
  res.json({
    account_name:       s.account_name,
    initial_balance:    parseFloat(s.initial_balance),
    total_in:           parseFloat(ti),
    total_out:          parseFloat(to),
    balance,
    forecasted_balance: balance + parseFloat(pi) - parseFloat(po),
    pending_out:        parseFloat(po),
    pending_in:         parseFloat(pi),
  });
}));

// ── transactions with running balance ─────────────────────────
router.get('/transactions', requireAuth, wrap(async (req, res) => {
  const { month, search, type, category } = req.query;
  let where = []; const params = []; let i = 1;
  if (month)    { where.push(`TO_CHAR(t.txn_date,'YYYY-MM')=$${i++}`); params.push(month); }
  if (type)     { where.push(`t.type=$${i++}`);                        params.push(type); }
  if (category) { where.push(`t.category=$${i++}`);                    params.push(category); }
  if (search)   { where.push(`(t.description ILIKE $${i} OR t.beneficiary ILIKE $${i+1} OR t.check_number ILIKE $${i+2})`); params.push('%'+search+'%', '%'+search+'%', '%'+search+'%'); i += 3; }
  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT t.*, u.full_name as by_name
    FROM bank_transactions t LEFT JOIN users u ON u.id=t.recorded_by
    ${wc} ORDER BY t.txn_date DESC, t.id DESC
  `, params);

  const { rows: [s] }       = await pool.query('SELECT initial_balance FROM bank_settings WHERE id=1');
  const { rows: all }        = await pool.query('SELECT id,type,amount FROM bank_transactions ORDER BY txn_date ASC, id ASC');
  let bal = parseFloat(s?.initial_balance ?? 0);
  const balMap = {};
  for (const r of all) { bal += sign(r.type) * parseFloat(r.amount); balMap[r.id] = bal; }

  const totIn  = rows.filter(r => IN_TYPES.includes(r.type)).reduce((s,r) => s + parseFloat(r.amount), 0);
  const totOut = rows.filter(r => OUT_TYPES.includes(r.type)).reduce((s,r) => s + parseFloat(r.amount), 0);

  res.json({ rows: rows.map(r => ({ ...r, running_balance: balMap[r.id] ?? null })), total_in: totIn, total_out: totOut });
}));

// ── create transaction ────────────────────────────────────────
router.post('/transactions', requireAuth, wrap(async (req, res) => {
  const { txn_date, type, category, description, check_number, beneficiary, due_date, check_status, notes } = req.body || {};
  const amount = parseFloat(req.body.amount);
  if (!type || !description || !amount || amount <= 0) return res.status(400).json({ error: 'Type, description et montant valide requis' });
  const isCheck = isEcheance(type);
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO bank_transactions (txn_date,type,category,description,amount,check_number,beneficiary,due_date,check_status,notes,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
  `, [
    txn_date || new Date().toISOString().slice(0,10),
    type, category||'Autre', description, amount,
    check_number||null, beneficiary||null, due_date||null,
    isCheck ? (check_status||'pending') : null,
    notes||null, req.user.id
  ]);
  const { rows: [txn] } = await pool.query('SELECT * FROM bank_transactions WHERE id=$1', [id]);
  res.status(201).json(txn);
}));

// ── update check status ───────────────────────────────────────
router.patch('/checks/:id/status', requireAuth, wrap(async (req, res) => {
  const { check_status } = req.body || {};
  if (!['pending','cashed','cancelled','returned'].includes(check_status))
    return res.status(400).json({ error: 'Statut invalide' });
  await pool.query('UPDATE bank_transactions SET check_status=$1 WHERE id=$2', [check_status, req.params.id]);
  const { rows: [txn] } = await pool.query('SELECT * FROM bank_transactions WHERE id=$1', [req.params.id]);
  res.json(txn);
}));

// ── toggle reconciled ─────────────────────────────────────────
router.patch('/transactions/:id/reconcile', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT is_reconciled FROM bank_transactions WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Non trouvé' });
  await pool.query('UPDATE bank_transactions SET is_reconciled=$1 WHERE id=$2', [rows[0].is_reconciled ? 0 : 1, req.params.id]);
  const { rows: [txn] } = await pool.query('SELECT * FROM bank_transactions WHERE id=$1', [req.params.id]);
  res.json(txn);
}));

// ── full edit of a transaction / check (montant, statut, tout) ──
router.put('/transactions/:id', requireAuth, wrap(async (req, res) => {
  const { rows: [cur] } = await pool.query('SELECT * FROM bank_transactions WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'Transaction introuvable' });
  const b = req.body || {};
  const type   = TXN_TYPES.includes(b.type) ? b.type : cur.type;
  const amount = b.amount != null ? parseFloat(b.amount) : parseFloat(cur.amount);
  if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Montant valide requis' });
  const isCheck = isEcheance(type);
  await pool.query(`
    UPDATE bank_transactions SET
      txn_date=$1, type=$2, category=$3, description=$4, amount=$5,
      check_number=$6, beneficiary=$7, due_date=$8, check_status=$9, notes=$10
    WHERE id=$11
  `, [
    normDate(b.txn_date) || cur.txn_date,
    type,
    b.category || cur.category,
    b.description != null ? b.description : cur.description,
    amount,
    isCheck ? (b.check_number != null ? b.check_number : cur.check_number) : null,
    isCheck ? (b.beneficiary  != null ? b.beneficiary  : cur.beneficiary)  : null,
    isCheck ? (b.due_date || cur.due_date) : null,
    isCheck ? (b.check_status || cur.check_status || 'pending') : null,
    b.notes != null ? b.notes : cur.notes,
    cur.id
  ]);
  const { rows: [txn] } = await pool.query('SELECT * FROM bank_transactions WHERE id=$1', [cur.id]);
  res.json(txn);
}));

// ── delete ────────────────────────────────────────────────────
router.delete('/transactions/:id', requireAuth, wrap(async (req, res) => {
  await pool.query('DELETE FROM bank_transactions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ── all checks ────────────────────────────────────────────────
router.get('/checks', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT t.*, u.full_name as by_name FROM bank_transactions t
    LEFT JOIN users u ON u.id=t.recorded_by
    WHERE t.type IN (${SQL_ECHEANCE})
    ORDER BY CASE check_status WHEN 'pending' THEN 0 WHEN 'cashed' THEN 1 ELSE 2 END, t.txn_date DESC
  `);
  res.json(rows);
}));

// ── balance history ───────────────────────────────────────────
router.get('/history', requireAuth, wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const { rows: [s] } = await pool.query('SELECT initial_balance FROM bank_settings WHERE id=1');
  const initialBal = parseFloat(s?.initial_balance ?? 0);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0,10);

  const { rows: [{ t: before }] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN type IN (${SQL_IN}) THEN amount ELSE -amount END),0) as t
    FROM bank_transactions WHERE txn_date < $1
  `, [cutoffStr]);

  let runBal = initialBal + parseFloat(before);

  const { rows: daily } = await pool.query(`
    SELECT txn_date as day,
      SUM(CASE WHEN type IN (${SQL_IN}) THEN amount ELSE -amount END) as net
    FROM bank_transactions WHERE txn_date >= $1
    GROUP BY txn_date ORDER BY txn_date ASC
  `, [cutoffStr]);

  const dayMap = Object.fromEntries(daily.map(r => [r.day, parseFloat(r.net)]));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    if (dayMap[key] !== undefined) runBal += dayMap[key];
    result.push({ day: key, balance: Math.round(runBal * 100) / 100 });
  }
  res.json(result);
}));

// ── category stats ────────────────────────────────────────────
router.get('/stats/categories', requireAuth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const { rows: out } = await pool.query(`
    SELECT category, SUM(amount) as total FROM bank_transactions
    WHERE TO_CHAR(txn_date,'YYYY-MM')=$1 AND type IN (${SQL_OUT})
    GROUP BY category ORDER BY total DESC
  `, [month]);
  const { rows: inp } = await pool.query(`
    SELECT category, SUM(amount) as total FROM bank_transactions
    WHERE TO_CHAR(txn_date,'YYYY-MM')=$1 AND type IN (${SQL_IN})
    GROUP BY category ORDER BY total DESC
  `, [month]);
  res.json({ out, in: inp });
}));

// ── monthly report ────────────────────────────────────────────
router.get('/report', requireAuth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const { rows } = await pool.query(`
    SELECT txn_date as day,
      SUM(CASE WHEN type IN (${SQL_IN})  THEN amount ELSE 0 END) as total_in,
      SUM(CASE WHEN type IN (${SQL_OUT}) THEN amount ELSE 0 END) as total_out
    FROM bank_transactions WHERE TO_CHAR(txn_date,'YYYY-MM')=$1
    GROUP BY txn_date ORDER BY txn_date DESC
  `, [month]);
  const totIn  = rows.reduce((s,r) => s + parseFloat(r.total_in), 0);
  const totOut = rows.reduce((s,r) => s + parseFloat(r.total_out), 0);
  res.json({ month, rows, total_in: totIn, total_out: totOut, net: totIn - totOut });
}));

// ── reconciliation session ────────────────────────────────────
router.get('/reconcile/unreconciled', requireAuth, wrap(async (_req, res) => {
  const { rows: [s] }    = await pool.query('SELECT initial_balance FROM bank_settings WHERE id=1');
  const { rows: all }     = await pool.query('SELECT id,type,amount FROM bank_transactions ORDER BY txn_date ASC, id ASC');
  let bal = parseFloat(s?.initial_balance ?? 0);
  const balMap = {};
  for (const r of all) { bal += sign(r.type) * parseFloat(r.amount); balMap[r.id] = bal; }

  const { rows: [{ t: rn }] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN type IN (${SQL_IN}) THEN amount ELSE -amount END),0) as t
    FROM bank_transactions WHERE is_reconciled=1
  `);
  const reconciledBal = parseFloat(rn) + parseFloat(s.initial_balance);

  const { rows } = await pool.query('SELECT * FROM bank_transactions WHERE is_reconciled=0 ORDER BY txn_date ASC, id ASC');
  res.json({ rows: rows.map(r => ({ ...r, running_balance: balMap[r.id] ?? null })), reconciled_balance: reconciledBal });
}));

router.post('/reconcile/session', requireAuth, wrap(async (req, res) => {
  const { ids, statement_date } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const date = statement_date || new Date().toISOString().slice(0,10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids)
      await client.query('UPDATE bank_transactions SET is_reconciled=1,reconciled_at=$1 WHERE id=$2', [date, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, count: ids.length });
}));

// ── AI STATEMENT IMPORT ───────────────────────────────────────
// Parse a pasted bank statement into structured rows (does NOT save).
router.post('/import/parse', requireAuth, wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  let pdf_base64 = req.body && req.body.pdf_base64 ? String(req.body.pdf_base64) : '';
  // Accept a full data URL (data:application/pdf;base64,XXXX) or bare base64
  if (pdf_base64.includes(',')) pdf_base64 = pdf_base64.slice(pdf_base64.indexOf(',') + 1);
  if (!pdf_base64 && text.length < 5) return res.status(400).json({ error: 'Collez le relevé ou chargez un PDF' });

  // Known names → help the AI map to the "Client" category
  const { rows: cc } = await pool.query('SELECT name FROM credit_clients WHERE is_active=1');
  let fc = [];
  try { fc = (await pool.query('SELECT name FROM facture_clients WHERE is_active=1')).rows; } catch (_) {}
  const names = [...new Set([...cc, ...fc].map(c => c.name).filter(Boolean))].slice(0, 150);
  const { rows: rules } = await pool.query('SELECT signature, category, txn_type FROM bank_import_rules');

  const instructions = `Tu es un expert comptable marocain. Analyse ce relevé bancaire et extrais CHAQUE opération.
Réponds UNIQUEMENT par un tableau JSON valide (rien d'autre), chaque élément ainsi:
{"date":"YYYY-MM-DD","description":"texte","amount":<nombre positif>,"direction":"in"|"out","type":"<${TXN_TYPES.join('|')}>","check_number":<string|null>,"beneficiary":<string|null>,"category":"<${BANK_CATS.join('|')}>"}
RÈGLES:
- "in"=argent reçu (crédit), "out"=argent sorti (débit). amount toujours positif (sans espaces ni virgules).
- type: dépôt espèces=depot, retrait=retrait, virement reçu=virement_in, virement émis/payé=virement_out, chèque reçu/remis=cheque_in, chèque émis/payé=cheque_out.
- Si un numéro de chèque apparaît, mets-le dans check_number.
- category mots-clés: AFRIQUIA/SHELL/TOTAL/PETROM/WINXO=Carburant ; SALAIRE/PAIE/CNSS=Salaires ; LOYER=Loyer ; IMPOT/TVA/DGI/PATENTE=Impôts ; AGIOS/COMMISSION/FRAIS/INTERET=Banque.
- Clients connus (=> category "Client"): ${names.join(', ') || 'aucun'}.`;

  // Either read the PDF directly (handles scanned/image PDFs) or parse pasted text.
  const userContent = pdf_base64
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
        { type: 'text', text: instructions + '\nLe relevé est dans le document PDF ci-joint. Lis toutes les pages.' }
      ]
    : instructions + '\nRELEVÉ:\n' + text.slice(0, 12000);

  let parsed = [];
  try {
    const msg = await aiClient.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8000,
      messages: [{ role: 'user', content: userContent }]
    });
    let t = (msg.content[0]?.text || '').trim();
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    parsed = JSON.parse(t);
  } catch (e) {
    return res.status(502).json({ error: "Analyse IA échouée. Réessayez ou collez le texte. (" + e.message + ")" });
  }
  if (!Array.isArray(parsed)) parsed = [];

  const ruleMap = Object.fromEntries(rules.map(r => [r.signature, r]));
  const out = [];
  for (const r of parsed) {
    const amount = Math.abs(parseFloat(r.amount) || 0);
    if (!amount) continue;
    let type = TXN_TYPES.includes(r.type) ? r.type : (r.direction === 'in' ? 'virement_in' : 'virement_out');
    let category = BANK_CATS.includes(r.category) ? r.category : 'Autre';
    const sig = signature(r.description);
    let learned = false;
    if (ruleMap[sig]) {
      if (ruleMap[sig].category) category = ruleMap[sig].category;
      if (ruleMap[sig].txn_type) type = ruleMap[sig].txn_type;
      learned = true;
    }
    const date = normDate(r.date);
    // duplicate detection (same date + amount + (cheque no | description))
    let duplicate = false;
    if (date) {
      const { rows: dup } = await pool.query(
        `SELECT id FROM bank_transactions
         WHERE txn_date=$1 AND ROUND(amount::numeric,2)=ROUND($2::numeric,2)
           AND ( (COALESCE($3,'')<>'' AND check_number=$3) OR (COALESCE($3,'')='' AND description=$4) )
         LIMIT 1`,
        [date, amount, r.check_number || null, r.description || '']
      );
      duplicate = dup.length > 0;
    }
    out.push({
      date: date || null, description: r.description || '', amount,
      type, category, check_number: r.check_number || null, beneficiary: r.beneficiary || null,
      learned, duplicate, include: !duplicate
    });
  }
  res.json({ rows: out, count: out.length });
}));

// Commit reviewed rows → create transactions + learn rules.
router.post('/import/commit', requireAuth, wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Aucune ligne à importer' });
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const amount = Math.abs(parseFloat(r.amount) || 0);
      if (!amount || !TXN_TYPES.includes(r.type)) continue;
      const isCheck = isEcheance(r.type);
      await client.query(`
        INSERT INTO bank_transactions (txn_date,type,category,description,amount,check_number,beneficiary,check_status,bank_ref,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [
        normDate(r.date) || new Date().toISOString().slice(0,10), r.type,
        BANK_CATS.includes(r.category) ? r.category : 'Autre',
        r.description || 'Import relevé', amount,
        r.check_number || null, r.beneficiary || null,
        isCheck ? 'pending' : null, r.description || null, req.user.id
      ]);
      inserted++;
      const sig = signature(r.description);
      if (sig) await client.query(`
        INSERT INTO bank_import_rules (signature,category,txn_type) VALUES ($1,$2,$3)
        ON CONFLICT(signature) DO UPDATE SET category=EXCLUDED.category, txn_type=EXCLUDED.txn_type, hits=bank_import_rules.hits+1, updated_at=NOW()
      `, [sig, r.category || null, r.type || null]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, inserted });
}));

module.exports = router;
