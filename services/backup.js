const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { sendWhatsApp } = require('./whatsapp');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = 30; // Keep 30 days

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function runBackup() {
  ensureBackupDir();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('[Backup] DATABASE_URL not set'); return null; }

  const date     = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `menasta_backup_${date}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    console.log(`[Backup] Starting backup → ${filename}`);
    execSync(`pg_dump "${dbUrl}" -f "${filepath}" --no-password`, {
      env: { ...process.env, PGPASSWORD: '' },
      timeout: 120000,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    const stats   = fs.statSync(filepath);
    const sizeMB  = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`[Backup] Done — ${filename} (${sizeMB} MB)`);

    // Rotate old backups
    rotateBackups();

    // Notify patron via WhatsApp
    const phone = process.env.OWNER_PHONE;
    if (phone) {
      try {
        await sendWhatsApp(phone,
          `✅ *MENASTA — Sauvegarde réussie*\n📁 Fichier: ${filename}\n📦 Taille: ${sizeMB} MB\n🕒 ${new Date().toLocaleString('fr-MA')}`
        );
      } catch (_) {}
    }

    return { filename, sizeMB };
  } catch (e) {
    console.error('[Backup] Failed:', e.message);

    const phone = process.env.OWNER_PHONE;
    if (phone) {
      try {
        await sendWhatsApp(phone,
          `❌ *MENASTA — Échec sauvegarde*\nErreur: ${e.message}\n🕒 ${new Date().toLocaleString('fr-MA')}`
        );
      } catch (_) {}
    }
    return null;
  }
}

function rotateBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('menasta_backup_') && f.endsWith('.sql'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  files.slice(MAX_BACKUPS).forEach(f => {
    fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    console.log(`[Backup] Deleted old backup: ${f.name}`);
  });
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('menasta_backup_') && f.endsWith('.sql'))
    .map(f => {
      const stats = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, sizeMB: (stats.size / 1024 / 1024).toFixed(2), createdAt: stats.mtime };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Schedule daily backup at 03:00
function startScheduledBackups() {
  const targetHour = process.env.BACKUP_HOUR || '03:00';
  let lastDate = '';

  setInterval(async () => {
    const now   = new Date();
    const hm    = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const today = now.toISOString().slice(0, 10);
    if (hm !== targetHour || lastDate === today) return;
    lastDate = today;
    console.log('[Backup] Scheduled backup triggered');
    await runBackup();
  }, 60 * 1000);

  console.log(`[Backup] Scheduled daily at ${targetHour}`);
}

module.exports = { startScheduledBackups, runBackup, listBackups };
