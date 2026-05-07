const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const IN_TYPES  = ['depot', 'virement_in', 'cheque_in'];
const OUT_TYPES = ['retrait', 'virement_out', 'cheque_out'];
const sign = t => IN_TYPES.includes(t) ? 1 : -1;

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
  const { rows: [{ t: ti }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN ('depot','virement_in','cheque_in')`);
  const { rows: [{ t: to }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN ('retrait','virement_out','cheque_out')`);
  const { rows: [{ t: po }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type='cheque_out' AND check_status='pending'`);
  const { rows: [{ t: pi }] } = await pool.query(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type='cheque_in'  AND check_status='pending'`);
  const balance = parseFloat(s.initial_balance) + parseFloat(ti) - parseFloat(to);
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
  if (search)   { where.push(`(t.description ILIKE $${i} OR t.beneficiary ILIKE $${i} OR t.check_number ILIKE $${i})`); params.push('%'+search+'%'); i++; }
  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT t.*, u.full_name as by_name
    FROM bank_transactions t LEFT JOIN users u ON u.id=t.recorded_by
    ${wc} ORDER BY t.txn_date DESC, t.id DESC
  `, params);

  const { rows: [s] }       = await pool.query('SELECT initial_balance FROM bank_settings WHERE id=1');
  const { rows: all }        = await pool.query('SELECT id,type,amount FROM bank_transactions ORDER BY txn_date ASC, id ASC');
  let bal = parseFloat(s.initial_balance);
  const balMap = {};
  for (const r of all) { bal += sign(r.type) * parseFloat(r.amount); balMap[r.id] = bal; }

  const totIn  = rows.filter(r => IN_TYPES.includes(r.type)).reduce((s,r) => s + parseFloat(r.amount), 0);
  const totOut = rows.filter(r => OUT_TYPES.includes(r.type)).reduce((s,r) => s + parseFloat(r.amount), 0);

  res.json({ rows: rows.map(r => ({ ...r, running_balance: balMap[r.id] ?? null })), total_in: totIn, total_out: totOut });
}));

// ── create transaction ────────────────────────────────────────
router.post('/transactions', requireAuth, wrap(async (req, res) => {
  const { txn_date, type, category, description, amount, check_number, beneficiary, due_date, check_status, notes } = req.body || {};
  if (!type || !description || !amount) return res.status(400).json({ error: 'Type, description et montant requis' });
  const isCheck = type === 'cheque_in' || type === 'cheque_out';
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
  if (!['pending','cashed','cancelled'].includes(check_status))
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
    WHERE t.type IN ('cheque_in','cheque_out')
    ORDER BY CASE check_status WHEN 'pending' THEN 0 WHEN 'cashed' THEN 1 ELSE 2 END, t.txn_date DESC
  `);
  res.json(rows);
}));

// ── balance history ───────────────────────────────────────────
router.get('/history', requireAuth, wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const { rows: [s] } = await pool.query('SELECT initial_balance FROM bank_settings WHERE id=1');
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0,10);

  const { rows: [{ t: before }] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END),0) as t
    FROM bank_transactions WHERE txn_date < $1
  `, [cutoffStr]);

  let runBal = parseFloat(s.initial_balance) + parseFloat(before);

  const { rows: daily } = await pool.query(`
    SELECT txn_date::text as day,
      SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END) as net
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
    WHERE TO_CHAR(txn_date,'YYYY-MM')=$1 AND type IN ('retrait','virement_out','cheque_out')
    GROUP BY category ORDER BY total DESC
  `, [month]);
  const { rows: inp } = await pool.query(`
    SELECT category, SUM(amount) as total FROM bank_transactions
    WHERE TO_CHAR(txn_date,'YYYY-MM')=$1 AND type IN ('depot','virement_in','cheque_in')
    GROUP BY category ORDER BY total DESC
  `, [month]);
  res.json({ out, in: inp });
}));

// ── monthly report ────────────────────────────────────────────
router.get('/report', requireAuth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const { rows } = await pool.query(`
    SELECT txn_date::text as day,
      SUM(CASE WHEN type IN ('depot','virement_in','cheque_in')    THEN amount ELSE 0 END) as total_in,
      SUM(CASE WHEN type IN ('retrait','virement_out','cheque_out') THEN amount ELSE 0 END) as total_out
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
  let bal = parseFloat(s.initial_balance);
  const balMap = {};
  for (const r of all) { bal += sign(r.type) * parseFloat(r.amount); balMap[r.id] = bal; }

  const { rows: [{ t: rn }] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END),0) as t
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

module.exports = router;
