// Copie complète Neon → Railway Postgres.
// S'exécute DANS le conteneur Railway (railway ssh) :
//   TARGET_DB=postgresql://...railway.internal.../railway node scripts/migrate-to-railway.js
// Source = DATABASE_URL (Neon, l'actuelle). Cible = TARGET_DB. Neon n'est jamais modifié.
const SOURCE = process.env.SOURCE_DB || process.env.DATABASE_URL;
const TARGET = process.env.TARGET_DB;
if (!SOURCE || !TARGET) { console.error('SOURCE_DB/DATABASE_URL (source) et TARGET_DB (cible) requis'); process.exit(1); }
// Garde-fou : source et cible identiques = on viderait la base en la « copiant »
// sur elle-même (la vérification passerait trompeusement). Refus absolu.
const hostOf = u => { try { return new URL(u).host + new URL(u).pathname; } catch { return u; } };
if (hostOf(SOURCE) === hostOf(TARGET)) {
  console.error('REFUS: SOURCE et TARGET pointent sur la même base — rien à copier.');
  process.exit(1);
}

process.env.DATABASE_URL = TARGET;          // db.js/initDB créent le schéma sur la CIBLE
const { Pool } = require('pg');
const { initDB } = require('../db');

const src = new Pool({ connectionString: SOURCE, ssl: { rejectUnauthorized: false } });
const dst = new Pool({ connectionString: TARGET, ssl: false });

// jsonb : node-pg convertit un tableau JS en tableau Postgres → on force le JSON texte.
const fix = v => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) ? JSON.stringify(v) : v;

// Colonnes d'une table côté source (type formaté, nullabilité, défaut).
async function srcColumns(t) {
  const { rows } = await src.query(`
    SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ,
           a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ('public.' || quote_ident($1))::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`, [t]);
  return rows;
}

// Crée sur la cible une table qui n'existe que sur la source (colonnes + PK).
async function cloneTable(t) {
  const cols = await srcColumns(t);
  for (const c of cols) {
    const m = /nextval\('([^']+)'/.exec(c.def || '');
    if (m) await dst.query(`CREATE SEQUENCE IF NOT EXISTS ${m[1].replace(/^public\./, '')}`);
  }
  const defs = cols.map(c =>
    `"${c.col}" ${c.typ}${c.notnull ? ' NOT NULL' : ''}${c.def ? ' DEFAULT ' + c.def : ''}`);
  const { rows: pk } = await src.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = ('public.' || quote_ident($1))::regclass AND i.indisprimary`, [t]);
  if (pk.length) defs.push(`PRIMARY KEY (${pk.map(r => '"' + r.attname + '"').join(',')})`);
  await dst.query(`CREATE TABLE "${t}" (${defs.join(', ')})`);
  console.log(`   + table créée : ${t}`);
}

// Ajoute sur la cible les colonnes que la source a en plus (ALTER manuels historiques).
async function addMissingColumns(t) {
  const scols = await srcColumns(t);
  const { rows: dcols } = await dst.query(
    "SELECT column_name AS col FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t]);
  const dset = new Set(dcols.map(r => r.col));
  for (const c of scols.filter(c => !dset.has(c.col))) {
    await dst.query(`ALTER TABLE "${t}" ADD COLUMN "${c.col}" ${c.typ}${c.def ? ' DEFAULT ' + c.def : ''}`);
    console.log(`   + colonne ajoutée : ${t}.${c.col}`);
  }
}

(async () => {
  console.log('1) Schéma sur la cible (initDB)…');
  await initDB();

  const { rows: st } = await src.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const { rows: dt } = await dst.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const dset = new Set(dt.map(r => r.tablename));
  const tables = st.map(r => r.tablename);
  console.log('1b) Alignement du schéma (tables/colonnes hors initDB)…');
  for (const t of tables) {
    if (!dset.has(t)) await cloneTable(t);
    else await addMissingColumns(t);
  }

  const c = await dst.connect();
  await c.query('SET session_replication_role = replica');
  // Vider TOUTES les tables d'un coup AVANT de copier : un TRUNCATE CASCADE
  // par table effacerait les tables déjà copiées (clés étrangères).
  await c.query(`TRUNCATE TABLE ${tables.map(t => `"${t}"`).join(', ')} CASCADE`);
  console.log('2) Copie des données…');
  for (const t of tables) {
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
