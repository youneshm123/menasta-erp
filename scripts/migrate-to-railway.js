// Copie complète Neon → Railway Postgres.
// S'exécute DANS le conteneur Railway (railway ssh) :
//   TARGET_DB=postgresql://...railway.internal.../railway node scripts/migrate-to-railway.js
// Source = DATABASE_URL (Neon, l'actuelle). Cible = TARGET_DB. Neon n'est jamais modifié.
const SOURCE = process.env.DATABASE_URL;
const TARGET = process.env.TARGET_DB;
if (!SOURCE || !TARGET) { console.error('DATABASE_URL (source) et TARGET_DB (cible) requis'); process.exit(1); }

process.env.DATABASE_URL = TARGET;          // db.js/initDB créent le schéma sur la CIBLE
const { Pool } = require('pg');
const { initDB } = require('../db');

const src = new Pool({ connectionString: SOURCE, ssl: { rejectUnauthorized: false } });
const dst = new Pool({ connectionString: TARGET, ssl: false });

// jsonb : node-pg convertit un tableau JS en tableau Postgres → on force le JSON texte.
const fix = v => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) ? JSON.stringify(v) : v;

(async () => {
  console.log('1) Schéma sur la cible (initDB)…');
  await initDB();

  const { rows: st } = await src.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const { rows: dt } = await dst.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const dset = new Set(dt.map(r => r.tablename));
  const tables  = st.map(r => r.tablename).filter(t => dset.has(t));
  const missing = st.map(r => r.tablename).filter(t => !dset.has(t));
  if (missing.length) console.warn('⚠️ Tables absentes de la cible (NON copiées) :', missing.join(', '));

  const c = await dst.connect();
  await c.query('SET session_replication_role = replica');
  console.log('2) Copie des données…');
  for (const t of tables) {
    await c.query(`TRUNCATE TABLE "${t}" CASCADE`);
    const { rows } = await src.query(`SELECT * FROM "${t}"`);
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      const colSql = cols.map(x => `"${x}"`).join(',');
      const B = 100;
      for (let i = 0; i < rows.length; i += B) {
        const chunk = rows.slice(i, i + B);
        const vals = [], params = [];
        chunk.forEach((r, ri) => {
          vals.push('(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')');
          cols.forEach(cn => params.push(fix(r[cn])));
        });
        await c.query(`INSERT INTO "${t}" (${colSql}) VALUES ${vals.join(',')}`, params);
      }
    }
    console.log(`   ${t}: ${rows.length} lignes`);
  }
  await c.query('SET session_replication_role = DEFAULT');

  console.log('3) Resynchronisation des séquences…');
  const { rows: seqs } = await dst.query(`
    SELECT c.table_name AS t, c.column_name AS col,
           pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.column_default LIKE 'nextval%'`);
  for (const s of seqs) {
    if (!s.seq) continue;
    await c.query(`SELECT setval($1, COALESCE((SELECT MAX("${s.col}") FROM "${s.t}"), 0) + 1, false)`, [s.seq]);
  }

  console.log('4) Vérification des comptes de lignes…');
  let ok = true;
  for (const t of tables) {
    const a = (await src.query(`SELECT COUNT(*)::int AS c FROM "${t}"`)).rows[0].c;
    const b = (await dst.query(`SELECT COUNT(*)::int AS c FROM "${t}"`)).rows[0].c;
    if (a !== b) { ok = false; console.error(`   ❌ ${t}: source=${a} cible=${b}`); }
  }
  console.log(ok ? '✅ MIGRATION OK — toutes les tables correspondent.' : '❌ Différences détectées — NE PAS basculer.');
  c.release();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
