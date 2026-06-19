#!/usr/bin/env node
/**
 * Convert all REAL (single-precision float) columns to NUMERIC(16,4).
 *
 * WHY: REAL drifts (11.10 stored as 11.0999994), which corrupts money totals in
 * an accounting system. NUMERIC is exact. With the type parser in db.js, the app
 * keeps receiving plain JS numbers, so behaviour is unchanged.
 *
 * SAFETY:
 *  - Dumps every affected table to backups/ as JSON before touching anything.
 *  - Runs inside a single transaction (all-or-nothing).
 *  - Idempotent: columns already NUMERIC are skipped.
 *  - Prints SUM(col) before and after so you can confirm nothing material moved.
 *
 * ORDER: deploy the new db.js (NUMERIC type parser) to the live server FIRST,
 * otherwise the running server starts receiving NUMERIC values as strings.
 *
 * Usage:  node scripts/migrate-money-numeric.js          (backup + migrate + verify)
 *         node scripts/migrate-money-numeric.js --dry-run (backup + report only)
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DRY = process.argv.includes('--dry-run');
const TARGET_TYPE = 'numeric(16,4)';
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').replace(/([?&])sslmode=[^&]*/, '$1').replace(/[?&]$/, ''),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL manquant'); process.exit(1); }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // 1. Find every REAL / double precision column.
  const { rows: cols } = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type IN ('real', 'double precision')
    ORDER BY table_name, column_name`);

  if (cols.length === 0) { console.log('✅ Aucune colonne REAL — déjà migré.'); await pool.end(); return; }
  console.log(`Colonnes à convertir → ${TARGET_TYPE}: ${cols.length}`);

  const tables = [...new Set(cols.map(c => c.table_name))];

  // 2. JSON backup of every affected table.
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const backupFile = path.join(BACKUP_DIR, `pre-numeric-migration_${stamp}.json`);
  const dump = {};
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT * FROM "${t}"`);
    dump[t] = rows;
  }
  fs.writeFileSync(backupFile, JSON.stringify(dump, null, 0));
  console.log(`🗄️  Backup JSON: ${path.basename(backupFile)} (${tables.length} tables)`);

  // 3. SUM before (per column) for verification.
  const sumBefore = {};
  for (const c of cols) {
    const key = `${c.table_name}.${c.column_name}`;
    const { rows } = await pool.query(`SELECT COALESCE(SUM("${c.column_name}"),0) AS s FROM "${c.table_name}"`);
    sumBefore[key] = Number(rows[0].s);
  }

  if (DRY) {
    console.log('\n--- DRY RUN — aucune modification ---');
    for (const c of cols) console.log(`  ${c.table_name}.${c.column_name}  SUM=${sumBefore[`${c.table_name}.${c.column_name}`]}`);
    await pool.end();
    return;
  }

  // 4. Migrate inside one transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of cols) {
      await client.query(
        `ALTER TABLE "${c.table_name}" ALTER COLUMN "${c.column_name}" TYPE ${TARGET_TYPE} USING "${c.column_name}"::${TARGET_TYPE}`
      );
      process.stdout.write('.');
    }
    await client.query('COMMIT');
    console.log('\n✅ Migration committée.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ Rollback — aucune modification appliquée:', e.message);
    process.exitCode = 1;
    client.release();
    await pool.end();
    return;
  }
  client.release();

  // 5. SUM after + diff report.
  console.log('\nVérification (différence due à l\'arrondi 4 décimales) :');
  let maxDiff = 0;
  for (const c of cols) {
    const key = `${c.table_name}.${c.column_name}`;
    const { rows } = await pool.query(`SELECT COALESCE(SUM("${c.column_name}"),0) AS s FROM "${c.table_name}"`);
    const after = Number(rows[0].s);
    const diff = Math.abs(after - sumBefore[key]);
    maxDiff = Math.max(maxDiff, diff);
    if (diff > 0.01) console.log(`  ⚠️  ${key}: ${sumBefore[key]} → ${after} (Δ ${diff.toFixed(4)})`);
  }
  console.log(`Écart maximum sur un total de colonne : ${maxDiff.toFixed(6)}`);
  console.log('Terminé.');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
