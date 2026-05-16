require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function toPostgres(sql) {
  return sql
    .replace(/datetime\('now'\)/g, 'NOW()')
    .replace(/date\('now',\s*'-(\d+) days'\)/g, (_, n) => `CURRENT_DATE - INTERVAL '${n} days'`)
    .replace(/date\('now'\)/g, 'CURRENT_DATE')
    .replace(/\bdate\(([^)'"]+)\)/g, (_, col) => `(${col.trim()})::date`)
    .replace(/strftime\('%Y-%m',\s*([^)]+)\)/g, (_, col) => `TO_CHAR(${col.trim()}, 'YYYY-MM')`)
    .replace(/strftime\('%Y',\s*([^)]+)\)/g,    (_, col) => `TO_CHAR(${col.trim()}, 'YYYY')`);
}

const pool = {
  query:   (sql, params = []) => pgPool.query(toPostgres(sql), params),
  connect: () => pgPool.connect()
};

async function initDB() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS cuves (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      fuel_type_id   INTEGER NOT NULL REFERENCES fuel_types(id),
      capacite_max   REAL NOT NULL DEFAULT 20000,
      niveau_alerte  REAL NOT NULL DEFAULT 3000,
      is_active      INTEGER NOT NULL DEFAULT 1,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cuve_lectures (
      id            SERIAL PRIMARY KEY,
      cuve_id       INTEGER NOT NULL REFERENCES cuves(id),
      lecture_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      niveau_litres REAL NOT NULL,
      recorded_by   INTEGER REFERENCES users(id),
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(cuve_id, lecture_date)
    );
    CREATE TABLE IF NOT EXISTS cuve_livraisons (
      id             SERIAL PRIMARY KEY,
      cuve_id        INTEGER NOT NULL REFERENCES cuves(id),
      livraison_date DATE NOT NULL DEFAULT CURRENT_DATE,
      litres_recus   REAL NOT NULL,
      fournisseur    TEXT,
      prix_unitaire  REAL,
      bon_livraison  TEXT,
      recorded_by    INTEGER REFERENCES users(id),
      notes          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tabac_products (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      prix_achat REAL NOT NULL,
      prix_vente REAL NOT NULL,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tabac_ventes (
      id          SERIAL PRIMARY KEY,
      vente_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      product_id  INTEGER NOT NULL REFERENCES tabac_products(id),
      quantite    REAL NOT NULL DEFAULT 1,
      prix_vente  REAL NOT NULL,
      prix_achat  REAL NOT NULL,
      montant     REAL NOT NULL,
      benefice    REAL NOT NULL,
      recorded_by INTEGER REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(vente_date, product_id)
    );
    CREATE TABLE IF NOT EXISTS factures (
      id             SERIAL PRIMARY KEY,
      numero         TEXT NOT NULL UNIQUE,
      facture_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      client_name    TEXT NOT NULL,
      client_adresse TEXT,
      client_ice     TEXT,
      total_ht       REAL NOT NULL DEFAULT 0,
      montant_tva    REAL NOT NULL DEFAULT 0,
      total_ttc      REAL NOT NULL DEFAULT 0,
      notes          TEXT,
      recorded_by    INTEGER REFERENCES users(id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS facture_lignes (
      id           SERIAL PRIMARY KEY,
      facture_id   INTEGER NOT NULL REFERENCES factures(id),
      code_produit TEXT,
      designation  TEXT NOT NULL,
      quantite     REAL NOT NULL,
      prix_ht      REAL NOT NULL,
      taux_tva     REAL NOT NULL DEFAULT 10,
      total_ht     REAL NOT NULL,
      montant_tva  REAL NOT NULL,
      montant_ttc  REAL NOT NULL
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      username   TEXT NOT NULL DEFAULT '?',
      module     TEXT NOT NULL DEFAULT 'API',
      action     TEXT NOT NULL,
      details    TEXT,
      ip_addr    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs(created_at DESC);
  `);

  await pgPool.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS avance REAL NOT NULL DEFAULT 0');
  await pgPool.query('ALTER TABLE credit_clients ADD COLUMN IF NOT EXISTS credit_limit REAL');

  // Seed cuves
  const { rows: [{ c: cuvc }] } = await pgPool.query('SELECT COUNT(*) as c FROM cuves');
  if (parseInt(cuvc) === 0) {
    const { rows: fts } = await pgPool.query("SELECT id, name FROM fuel_types WHERE name IN ('Gazoil','Essence')");
    for (const ft of fts) {
      await pgPool.query('INSERT INTO cuves (name,fuel_type_id,capacite_max,niveau_alerte) VALUES ($1,$2,$3,$4)',
        [`Cuve ${ft.name}`, ft.id, 20000, 3000]);
    }
  }

  // Papa account
  const { rows: [{ c: pu }] } = await pgPool.query("SELECT COUNT(*) as c FROM users WHERE username='papa'");
  if (parseInt(pu) === 0) {
    const hash = await bcrypt.hash('papa123', 10);
    await pgPool.query("INSERT INTO users (full_name,username,password_hash,role) VALUES ($1,$2,$3,$4)", ['Papa','papa',hash,'patron']);
  }

  // Tabac seed
  const { rows: [{ c: tc }] } = await pgPool.query('SELECT COUNT(*) as c FROM tabac_products');
  if (parseInt(tc) === 0) {
    const ip = 'INSERT INTO tabac_products (name,prix_achat,prix_vente) VALUES ($1,$2,$3)';
    for (const [n,a,v] of [
      ['Camel',32.90,36.00],['LM Malboro',26.30,30.00],
      ['Zig Zag Orange',3.20,4.00],['Zig Zag Noire',3.90,5.00],
      ['Gauloises Generation FF KS',28.57,30.00],['Marquise',29.90,31.00],
      ['Winston',37.70,40.00],['Malboro',37.05,39.50],
    ]) await pgPool.query(ip, [n,a,v]);
  }

  console.log('✅ PostgreSQL prêt');
}

module.exports = { pool, initDB };
