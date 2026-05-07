const router     = require('express').Router();
const db         = require('../db');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');
const { requireAuth } = require('../middleware');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'fuelmaster.db');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS backup_settings (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  gmail_user  TEXT,
  gmail_pass  TEXT,
  recipient   TEXT NOT NULL DEFAULT 'darkhm7@gmail.com',
  hour        INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 0,
  last_sent   TEXT,
  last_status TEXT
);
INSERT OR IGNORE INTO backup_settings (id) VALUES (1);
`);

// ── Helpers ───────────────────────────────────────────────────
function getSettings() {
  return db.prepare('SELECT * FROM backup_settings WHERE id=1').get();
}

async function sendBackup(s) {
  s = s || getSettings();
  if (!s.gmail_user || !s.gmail_pass) throw new Error('Gmail non configuré');

  const date = new Date().toISOString().slice(0, 10);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: s.gmail_user, pass: s.gmail_pass }
  });

  await transporter.sendMail({
    from:    `MENASTA Backup <${s.gmail_user}>`,
    to:      s.recipient,
    subject: `📦 MENASTA — Backup du ${date}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px">
        <h2 style="color:#1A2332">📦 Backup MENASTA</h2>
        <p>Bonjour,</p>
        <p>Voici votre backup automatique de la base de données <strong>MENASTA</strong> du <strong>${date}</strong>.</p>
        <p>Le fichier <code>.db</code> joint contient toutes vos données : carburant, café, banque.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="color:#888;font-size:12px">MENASTA · Station Service · Maroc</p>
      </div>
    `,
    attachments: [{
      filename: `menasta_backup_${date}.db`,
      path:     DB_PATH
    }]
  });

  const now = new Date().toISOString();
  db.prepare('UPDATE backup_settings SET last_sent=?, last_status=? WHERE id=1').run(now, 'ok');
  console.log(`✅ Backup envoyé à ${s.recipient}`);
  return { ok: true, sent_at: now };
}

// ── Cron scheduler ────────────────────────────────────────────
let cronJob = null;

function startCron(hour) {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  cronJob = cron.schedule(`0 ${hour} * * *`, async () => {
    const s = getSettings();
    if (!s.is_active) return;
    try { await sendBackup(s); }
    catch(e) {
      console.error('❌ Backup failed:', e.message);
      db.prepare('UPDATE backup_settings SET last_status=? WHERE id=1').run('error: ' + e.message);
    }
  }, { timezone: 'Africa/Casablanca' });
  console.log(`📅 Backup cron planifié à ${hour}h00 (Maroc)`);
}

function initBackupScheduler() {
  const s = getSettings();
  if (s.is_active && s.gmail_user) startCron(s.hour);
}

// ── Routes ────────────────────────────────────────────────────
router.get('/settings', requireAuth, (_req, res) => {
  const s = getSettings();
  res.json({ ...s, gmail_pass: s.gmail_pass ? '••••••••••••••••' : '' });
});

router.put('/settings', requireAuth, (req, res) => {
  const { gmail_user, gmail_pass, recipient, hour, is_active } = req.body || {};
  const cur = getSettings();
  const newPass = gmail_pass && gmail_pass !== '••••••••••••••••' ? gmail_pass : cur.gmail_pass;
  db.prepare(`
    UPDATE backup_settings SET
      gmail_user = COALESCE(?,gmail_user),
      gmail_pass = ?,
      recipient  = COALESCE(?,recipient),
      hour       = COALESCE(?,hour),
      is_active  = COALESCE(?,is_active)
    WHERE id=1
  `).run(gmail_user||null, newPass, recipient||null, hour!=null?hour:null, is_active!=null?is_active:null);

  const updated = getSettings();
  if (updated.is_active && updated.gmail_user) startCron(updated.hour);
  else if (cronJob) { cronJob.stop(); cronJob = null; }

  res.json({ ok: true, settings: { ...updated, gmail_pass: updated.gmail_pass ? '••••••••••••••••' : '' } });
});

router.post('/send-now', requireAuth, async (_req, res) => {
  try {
    const result = await sendBackup();
    res.json(result);
  } catch(e) {
    db.prepare('UPDATE backup_settings SET last_status=? WHERE id=1').run('error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, initBackupScheduler };
