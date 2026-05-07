const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

// ── Schema + migrations ───────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS bank_settings (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  initial_balance REAL NOT NULL DEFAULT 0,
  account_name    TEXT NOT NULL DEFAULT 'Compte Bancaire'
);
INSERT OR IGNORE INTO bank_settings (id, initial_balance, account_name) VALUES (1, 0, 'Compte Bancaire');

CREATE TABLE IF NOT EXISTS bank_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date        TEXT    NOT NULL DEFAULT (date('now','localtime')),
  type            TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT 'Autre',
  description     TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  check_number    TEXT,
  beneficiary     TEXT,
  due_date        TEXT,
  check_status    TEXT    DEFAULT NULL,
  is_reconciled   INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  recorded_by     INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
try { db.exec('ALTER TABLE bank_transactions ADD COLUMN category TEXT NOT NULL DEFAULT \'Autre\''); } catch(_) {}
try { db.exec('ALTER TABLE bank_transactions ADD COLUMN due_date TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE bank_transactions ADD COLUMN is_reconciled INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE bank_transactions ADD COLUMN reconciled_at TEXT'); } catch(_) {}

const IN_TYPES  = ['depot', 'virement_in', 'cheque_in'];
const OUT_TYPES = ['retrait', 'virement_out', 'cheque_out'];
const sign = t => IN_TYPES.includes(t) ? 1 : -1;

// ── settings ──────────────────────────────────────────────────
router.get('/settings', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM bank_settings WHERE id=1').get()));

router.put('/settings', requireAuth, (req, res) => {
  const { initial_balance, account_name } = req.body || {};
  db.prepare('UPDATE bank_settings SET initial_balance=COALESCE(?,initial_balance), account_name=COALESCE(?,account_name) WHERE id=1')
    .run(initial_balance != null ? initial_balance : null, account_name || null);
  res.json(db.prepare('SELECT * FROM bank_settings WHERE id=1').get());
});

// ── balance ───────────────────────────────────────────────────
router.get('/balance', requireAuth, (_req, res) => {
  const s       = db.prepare('SELECT * FROM bank_settings WHERE id=1').get();
  const totIn   = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN ('depot','virement_in','cheque_in')`).get().t);
  const totOut  = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN ('retrait','virement_out','cheque_out')`).get().t);
  const pendOut = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type='cheque_out' AND check_status='pending'`).get().t);
  const pendIn  = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type='cheque_in'  AND check_status='pending'`).get().t);
  const balance = s.initial_balance + totIn - totOut;
  res.json({
    account_name: s.account_name,
    initial_balance: s.initial_balance,
    total_in: totIn, total_out: totOut,
    balance,
    forecasted_balance: balance + pendIn - pendOut,
    pending_out: pendOut, pending_in: pendIn
  });
});

// ── transactions with running balance ─────────────────────────
router.get('/transactions', requireAuth, (req, res) => {
  const { month, search, type, category } = req.query;
  let where = []; const params = [];
  if (month)    { where.push(`strftime('%Y-%m', t.txn_date)=?`); params.push(month); }
  if (type)     { where.push('t.type=?');     params.push(type); }
  if (category) { where.push('t.category=?'); params.push(category); }
  if (search)   { where.push('(t.description LIKE ? OR t.beneficiary LIKE ? OR t.check_number LIKE ?)'); params.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // Build filtered rows ordered newest first
  const rows = db.prepare(`
    SELECT t.*, u.full_name as by_name
    FROM bank_transactions t LEFT JOIN users u ON u.id=t.recorded_by
    ${whereClause}
    ORDER BY t.txn_date DESC, t.id DESC
  `).all(...params);

  // Running balance: need all txns ordered ASC to compute, then map back
  const s = db.prepare('SELECT initial_balance FROM bank_settings WHERE id=1').get();
  const all = db.prepare('SELECT id, type, amount FROM bank_transactions ORDER BY txn_date ASC, id ASC').all();
  let bal = s.initial_balance;
  const balMap = {};
  for (const r of all) { bal += sign(r.type) * r.amount; balMap[r.id] = bal; }

  const totIn  = rows.filter(r => IN_TYPES.includes(r.type)).reduce((s,r)=>s+r.amount,0);
  const totOut = rows.filter(r => OUT_TYPES.includes(r.type)).reduce((s,r)=>s+r.amount,0);

  res.json({
    rows: rows.map(r => ({ ...r, running_balance: balMap[r.id] ?? null })),
    total_in: totIn, total_out: totOut
  });
});

// ── create transaction ────────────────────────────────────────
router.post('/transactions', requireAuth, (req, res) => {
  const { txn_date, type, category, description, amount, check_number, beneficiary, due_date, check_status, notes } = req.body || {};
  if (!type || !description || !amount) return res.status(400).json({ error: 'Type, description et montant requis' });
  const isCheck = type === 'cheque_in' || type === 'cheque_out';
  const id = db.prepare(`
    INSERT INTO bank_transactions (txn_date,type,category,description,amount,check_number,beneficiary,due_date,check_status,notes,recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    txn_date || new Date().toISOString().slice(0,10),
    type, category || 'Autre', description, amount,
    check_number||null, beneficiary||null, due_date||null,
    isCheck ? (check_status||'pending') : null,
    notes||null, req.user.id
  ).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id));
});

// ── update check status ───────────────────────────────────────
router.patch('/checks/:id/status', requireAuth, (req, res) => {
  const { check_status } = req.body || {};
  if (!['pending','cashed','cancelled'].includes(check_status))
    return res.status(400).json({ error: 'Statut invalide' });
  db.prepare('UPDATE bank_transactions SET check_status=? WHERE id=?').run(check_status, req.params.id);
  res.json(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(req.params.id));
});

// ── toggle reconciled ─────────────────────────────────────────
router.patch('/transactions/:id/reconcile', requireAuth, (req, res) => {
  const t = db.prepare('SELECT is_reconciled FROM bank_transactions WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Non trouvé' });
  db.prepare('UPDATE bank_transactions SET is_reconciled=? WHERE id=?').run(t.is_reconciled ? 0 : 1, req.params.id);
  res.json(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(req.params.id));
});

// ── delete ────────────────────────────────────────────────────
router.delete('/transactions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bank_transactions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── all checks ────────────────────────────────────────────────
router.get('/checks', requireAuth, (_req, res) =>
  res.json(db.prepare(`
    SELECT t.*, u.full_name as by_name FROM bank_transactions t
    LEFT JOIN users u ON u.id=t.recorded_by
    WHERE t.type IN ('cheque_in','cheque_out')
    ORDER BY CASE check_status WHEN 'pending' THEN 0 WHEN 'cashed' THEN 1 ELSE 2 END, t.txn_date DESC
  `).all()));

// ── balance history for chart (last N days) ───────────────────
router.get('/history', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const s = db.prepare('SELECT initial_balance FROM bank_settings WHERE id=1').get();

  // Get sum before window to compute starting point
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0,10);

  const beforeBase = Number(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END),0) as t
    FROM bank_transactions WHERE txn_date < ?
  `).get(cutoffStr).t);

  let runBal = s.initial_balance + beforeBase;

  // Get daily net for each day in window
  const daily = db.prepare(`
    SELECT txn_date as day,
      SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END) as net
    FROM bank_transactions WHERE txn_date >= ?
    GROUP BY txn_date ORDER BY txn_date ASC
  `).all(cutoffStr);

  // Fill every day in range
  const result = [];
  const dayMap = Object.fromEntries(daily.map(r => [r.day, r.net]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    if (dayMap[key] !== undefined) runBal += dayMap[key];
    result.push({ day: key, balance: Math.round(runBal * 100) / 100 });
  }
  res.json(result);
});

// ── category stats for a month ────────────────────────────────
router.get('/stats/categories', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const out = db.prepare(`
    SELECT category, SUM(amount) as total FROM bank_transactions
    WHERE strftime('%Y-%m',txn_date)=? AND type IN ('retrait','virement_out','cheque_out')
    GROUP BY category ORDER BY total DESC
  `).all(month);
  const inp = db.prepare(`
    SELECT category, SUM(amount) as total FROM bank_transactions
    WHERE strftime('%Y-%m',txn_date)=? AND type IN ('depot','virement_in','cheque_in')
    GROUP BY category ORDER BY total DESC
  `).all(month);
  res.json({ out, in: inp });
});

// ── monthly report ────────────────────────────────────────────
router.get('/report', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const rows = db.prepare(`
    SELECT txn_date as day,
      SUM(CASE WHEN type IN ('depot','virement_in','cheque_in')  THEN amount ELSE 0 END) as total_in,
      SUM(CASE WHEN type IN ('retrait','virement_out','cheque_out') THEN amount ELSE 0 END) as total_out
    FROM bank_transactions WHERE strftime('%Y-%m',txn_date)=?
    GROUP BY txn_date ORDER BY txn_date DESC
  `).all(month);
  const totIn  = rows.reduce((s,r)=>s+r.total_in,0);
  const totOut = rows.reduce((s,r)=>s+r.total_out,0);
  res.json({ month, rows, total_in: totIn, total_out: totOut, net: totIn - totOut });
});

// ── reconciliation session ────────────────────────────────────
router.get('/reconcile/unreconciled', requireAuth, (_req, res) => {
  const s   = db.prepare('SELECT initial_balance FROM bank_settings WHERE id=1').get();
  const all = db.prepare('SELECT id, type, amount FROM bank_transactions ORDER BY txn_date ASC, id ASC').all();
  let bal = s.initial_balance;
  const balMap = {};
  for (const r of all) { bal += sign(r.type) * r.amount; balMap[r.id] = bal; }

  const reconciledBal = Number(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END),0) as t
    FROM bank_transactions WHERE is_reconciled=1
  `).get().t) + s.initial_balance;

  const rows = db.prepare(`
    SELECT * FROM bank_transactions WHERE is_reconciled=0 ORDER BY txn_date ASC, id ASC
  `).all();

  res.json({ rows: rows.map(r => ({ ...r, running_balance: balMap[r.id] ?? null })), reconciled_balance: reconciledBal });
});

router.post('/reconcile/session', requireAuth, (req, res) => {
  const { ids, statement_date } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const date = statement_date || new Date().toISOString().slice(0,10);
  const stmt = db.prepare('UPDATE bank_transactions SET is_reconciled=1, reconciled_at=? WHERE id=?');
  db.transaction(() => { for (const id of ids) stmt.run(date, id); })();
  res.json({ ok: true, count: ids.length });
});

module.exports = router;
