const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware');

// ── Schema ────────────────────────────────────────────────────
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
  description     TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  check_number    TEXT,
  beneficiary     TEXT,
  check_status    TEXT    DEFAULT NULL,
  notes           TEXT,
  recorded_by     INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ── helper: types that increase balance (IN) ──────────────────
const IN_TYPES = ['depot', 'virement_in', 'cheque_in'];
function isIn(type) { return IN_TYPES.includes(type); }

// ── GET /api/bank/settings ────────────────────────────────────
router.get('/settings', requireAuth, (_req, res) =>
  res.json(db.prepare('SELECT * FROM bank_settings WHERE id=1').get()));

// ── PUT /api/bank/settings ────────────────────────────────────
router.put('/settings', requireAuth, (req, res) => {
  const { initial_balance, account_name } = req.body || {};
  db.prepare('UPDATE bank_settings SET initial_balance=COALESCE(?,initial_balance), account_name=COALESCE(?,account_name) WHERE id=1')
    .run(initial_balance!=null?initial_balance:null, account_name||null);
  res.json(db.prepare('SELECT * FROM bank_settings WHERE id=1').get());
});

// ── GET /api/bank/balance ─────────────────────────────────────
router.get('/balance', requireAuth, (_req, res) => {
  const s = db.prepare('SELECT * FROM bank_settings WHERE id=1').get();
  const totIn  = Number(db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN ('depot','virement_in','cheque_in')").get().t);
  const totOut = Number(db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type IN ('retrait','virement_out','cheque_out')").get().t);
  const pending = Number(db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM bank_transactions WHERE type='cheque_out' AND check_status='pending'").get().t);
  res.json({
    account_name: s.account_name,
    initial_balance: s.initial_balance,
    total_in:  totIn,
    total_out: totOut,
    balance:   s.initial_balance + totIn - totOut,
    pending_checks_out: pending
  });
});

// ── GET /api/bank/transactions?month= ────────────────────────
router.get('/transactions', requireAuth, (req, res) => {
  const { month } = req.query;
  let q = `SELECT t.*, u.full_name as by_name FROM bank_transactions t LEFT JOIN users u ON u.id=t.recorded_by`;
  const params = [];
  if (month) { q += ` WHERE strftime('%Y-%m', t.txn_date)=?`; params.push(month); }
  q += ` ORDER BY t.txn_date DESC, t.created_at DESC`;
  res.json(db.prepare(q).all(...params));
});

// ── POST /api/bank/transactions ───────────────────────────────
router.post('/transactions', requireAuth, (req, res) => {
  const { txn_date, type, description, amount, check_number, beneficiary, check_status, notes } = req.body || {};
  if (!type || !description || !amount) return res.status(400).json({ error: 'Type, description et montant requis' });
  const isCheck = type === 'cheque_in' || type === 'cheque_out';
  const status  = isCheck ? (check_status || 'pending') : null;
  const id = db.prepare(`
    INSERT INTO bank_transactions (txn_date, type, description, amount, check_number, beneficiary, check_status, notes, recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    txn_date || new Date().toISOString().slice(0,10),
    type, description, amount,
    check_number||null, beneficiary||null, status, notes||null, req.user.id
  ).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id));
});

// ── PATCH /api/bank/checks/:id/status ────────────────────────
router.patch('/checks/:id/status', requireAuth, (req, res) => {
  const { check_status } = req.body || {};
  if (!['pending','cashed','cancelled'].includes(check_status))
    return res.status(400).json({ error: 'Statut invalide' });
  db.prepare('UPDATE bank_transactions SET check_status=? WHERE id=?').run(check_status, req.params.id);
  res.json(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(req.params.id));
});

// ── DELETE /api/bank/transactions/:id ────────────────────────
router.delete('/transactions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bank_transactions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── GET /api/bank/checks — pending checks only ────────────────
router.get('/checks', requireAuth, (_req, res) => {
  res.json(db.prepare(`
    SELECT t.*, u.full_name as by_name FROM bank_transactions t
    LEFT JOIN users u ON u.id=t.recorded_by
    WHERE t.type IN ('cheque_in','cheque_out')
    ORDER BY t.check_status ASC, t.txn_date DESC
  `).all());
});

// ── GET /api/bank/report?month= ──────────────────────────────
router.get('/report', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  const s = db.prepare('SELECT initial_balance FROM bank_settings WHERE id=1').get();
  const rows = db.prepare(`
    SELECT txn_date as day,
      SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE 0 END) as total_in,
      SUM(CASE WHEN type IN ('retrait','virement_out','cheque_out') THEN amount ELSE 0 END) as total_out
    FROM bank_transactions WHERE strftime('%Y-%m',txn_date)=?
    GROUP BY txn_date ORDER BY txn_date DESC
  `).all(month);
  const totIn  = rows.reduce((s,r)=>s+r.total_in,0);
  const totOut = rows.reduce((s,r)=>s+r.total_out,0);
  res.json({ month, rows, total_in: totIn, total_out: totOut, net: totIn - totOut });
});

module.exports = router;
