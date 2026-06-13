require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// pg-connection-string warns that sslmode 'require' is currently treated as
// 'verify-full' and will weaken to libpq semantics in pg v9. We pin TLS
// explicitly via the ssl object below, so the URL param is redundant — strip
// it to silence the deprecation warning without changing security posture.
function stripSslmode(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

const pgPool = new Pool({
  connectionString: stripSslmode(process.env.DATABASE_URL),
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: false }
});

const { toPostgres } = require('./lib/toPostgres');

const pool = {
  query:   (sql, params = []) => pgPool.query(toPostgres(sql), params),
  connect: () => pgPool.connect()
};

async function initDB() {
  // ── Core schema (safe to run on existing DB — all IF NOT EXISTS) ──
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      full_name     TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'caissier',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fuel_types (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      price_per_liter REAL NOT NULL DEFAULT 0,
      color_hex       TEXT NOT NULL DEFAULT '#0070F2',
      is_active       INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS pumps (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      fuel_type_id INTEGER NOT NULL REFERENCES fuel_types(id),
      status       TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id                    SERIAL PRIMARY KEY,
      opened_by             INTEGER REFERENCES users(id),
      status                TEXT NOT NULL DEFAULT 'open',
      opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at             TIMESTAMPTZ,
      total_liters_sold     REAL,
      total_fuel_revenue    REAL,
      total_credit_deducted REAL,
      total_product_sales   REAL,
      net_cash              REAL,
      notes                 TEXT,
      avance                REAL NOT NULL DEFAULT 0,
      pompiste              TEXT,
      heure_debut           TEXT,
      heure_fin             TEXT
    );
    CREATE TABLE IF NOT EXISTS pump_readings (
      id           SERIAL PRIMARY KEY,
      shift_id     INTEGER NOT NULL REFERENCES shifts(id),
      pump_id      INTEGER NOT NULL REFERENCES pumps(id),
      reading_type TEXT NOT NULL,
      meter_value  REAL NOT NULL,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shift_id, pump_id, reading_type)
    );
    CREATE TABLE IF NOT EXISTS credit_clients (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      phone        TEXT,
      company      TEXT,
      notes        TEXT,
      credit_limit REAL,
      balance_due  REAL NOT NULL DEFAULT 0,
      is_active    INTEGER NOT NULL DEFAULT 1,
      ice          TEXT,
      adresse      TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS credit_sales (
      id                SERIAL PRIMARY KEY,
      shift_id          INTEGER NOT NULL REFERENCES shifts(id),
      credit_client_id  INTEGER NOT NULL REFERENCES credit_clients(id),
      pump_id           INTEGER REFERENCES pumps(id),
      liters            REAL NOT NULL DEFAULT 0,
      price_per_liter   REAL NOT NULL DEFAULT 0,
      amount            REAL NOT NULL,
      recorded_by       INTEGER REFERENCES users(id),
      notes             TEXT,
      product_type      TEXT NOT NULL DEFAULT 'carburant',
      sale_time         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS credit_payments (
      id               SERIAL PRIMARY KEY,
      credit_client_id INTEGER NOT NULL REFERENCES credit_clients(id),
      shift_id         INTEGER REFERENCES shifts(id),
      amount           REAL NOT NULL,
      recorded_by      INTEGER REFERENCES users(id),
      notes            TEXT,
      payment_time     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id        SERIAL PRIMARY KEY,
      reference TEXT NOT NULL,
      name      TEXT NOT NULL,
      category  TEXT NOT NULL DEFAULT 'Huiles',
      unit      TEXT NOT NULL DEFAULT 'unité',
      price     REAL NOT NULL,
      stock_qty REAL NOT NULL DEFAULT 0,
      stock_min REAL NOT NULL DEFAULT 5,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS product_sales (
      id           SERIAL PRIMARY KEY,
      shift_id     INTEGER NOT NULL REFERENCES shifts(id),
      product_id   INTEGER NOT NULL REFERENCES products(id),
      quantity     REAL NOT NULL,
      unit_price   REAL NOT NULL,
      total_amount REAL NOT NULL,
      recorded_by  INTEGER REFERENCES users(id),
      sale_time    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id           SERIAL PRIMARY KEY,
      category     TEXT NOT NULL DEFAULT 'Autre',
      description  TEXT NOT NULL,
      amount       REAL NOT NULL,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes        TEXT,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fuel_deliveries (
      id               SERIAL PRIMARY KEY,
      fuel_type_id     INTEGER NOT NULL REFERENCES fuel_types(id),
      quantity_liters  REAL NOT NULL,
      delivery_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      supplier         TEXT,
      notes            TEXT,
      cost_per_liter   REAL,
      recorded_by      INTEGER REFERENCES users(id),
      numero_cheque    TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_settings (
      id              SERIAL PRIMARY KEY,
      account_name    TEXT NOT NULL DEFAULT 'Compte Principal',
      initial_balance REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id            SERIAL PRIMARY KEY,
      txn_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      type          TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'Autre',
      description   TEXT NOT NULL,
      amount        REAL NOT NULL,
      check_number  TEXT,
      beneficiary   TEXT,
      due_date      DATE,
      check_status  TEXT,
      notes         TEXT,
      recorded_by   INTEGER REFERENCES users(id),
      is_reconciled INTEGER NOT NULL DEFAULT 0,
      reconciled_at DATE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cafe_menu (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      emoji     TEXT NOT NULL DEFAULT '☕',
      price     REAL NOT NULL DEFAULT 7,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cafe_sales (
      id           SERIAL PRIMARY KEY,
      sale_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      menu_item_id INTEGER NOT NULL REFERENCES cafe_menu(id),
      quantity     REAL NOT NULL DEFAULT 0,
      unit_price   REAL NOT NULL DEFAULT 0,
      total        REAL NOT NULL DEFAULT 0,
      recorded_by  INTEGER REFERENCES users(id),
      UNIQUE(sale_date, menu_item_id)
    );
    CREATE TABLE IF NOT EXISTS cafe_stock_items (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      unit          TEXT NOT NULL DEFAULT 'unité',
      cost_per_unit REAL NOT NULL DEFAULT 0,
      is_active     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cafe_stock_usage (
      id            SERIAL PRIMARY KEY,
      usage_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      stock_item_id INTEGER NOT NULL REFERENCES cafe_stock_items(id),
      quantity_used REAL NOT NULL DEFAULT 0,
      cost_per_unit REAL NOT NULL DEFAULT 0,
      total_cost    REAL NOT NULL DEFAULT 0,
      recorded_by   INTEGER REFERENCES users(id),
      UNIQUE(usage_date, stock_item_id)
    );
    CREATE TABLE IF NOT EXISTS service_entries (
      id           SERIAL PRIMARY KEY,
      entry_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      service_type TEXT NOT NULL,
      montant      REAL NOT NULL DEFAULT 0,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ── Seed fuel types ──
  const { rows: [{ c: ftc }] } = await pgPool.query('SELECT COUNT(*) as c FROM fuel_types');
  if (parseInt(ftc) === 0) {
    await pgPool.query(`INSERT INTO fuel_types (name,price_per_liter,color_hex) VALUES ('Gazoil',11.00,'#0070F2'),('Essence',12.50,'#E84C3D')`);
  }

  // ── Ensure bank_settings has a row ──
  await pgPool.query(`INSERT INTO bank_settings (id,account_name,initial_balance) VALUES (1,'Compte Principal',0) ON CONFLICT (id) DO NOTHING`);

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
    CREATE TABLE IF NOT EXISTS facture_clients (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      ice        TEXT,
      adresse    TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  await pgPool.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS credit_paid REAL NOT NULL DEFAULT 0');
  await pgPool.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS pompiste TEXT');
  await pgPool.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS heure_debut TEXT');
  await pgPool.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS heure_fin TEXT');
  await pgPool.query('ALTER TABLE credit_sales ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT \'carburant\'');
  try { await pgPool.query('ALTER TABLE credit_sales ALTER COLUMN pump_id DROP NOT NULL'); } catch(_) {}
  await pgPool.query('ALTER TABLE credit_clients ADD COLUMN IF NOT EXISTS credit_limit REAL');
  await pgPool.query('ALTER TABLE fuel_deliveries ADD COLUMN IF NOT EXISTS numero_cheque TEXT');
  await pgPool.query('ALTER TABLE fuel_types ADD COLUMN IF NOT EXISTS cost_per_liter REAL NOT NULL DEFAULT 0');
  await pgPool.query('ALTER TABLE credit_clients ADD COLUMN IF NOT EXISTS ice TEXT');
  await pgPool.query('ALTER TABLE credit_clients ADD COLUMN IF NOT EXISTS adresse TEXT');
  await pgPool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id)');
  // Boutique QR scan sales record without an open poste — make shift_id optional.
  try { await pgPool.query('ALTER TABLE product_sales ALTER COLUMN shift_id DROP NOT NULL'); } catch(_) {}
  // Credit sales can be recorded without an open poste too.
  try { await pgPool.query('ALTER TABLE credit_sales ALTER COLUMN shift_id DROP NOT NULL'); } catch(_) {}
  await pgPool.query('ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS bank_ref TEXT');
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS bank_import_rules (
      id          SERIAL PRIMARY KEY,
      signature   TEXT NOT NULL UNIQUE,
      category    TEXT,
      txn_type    TEXT,
      hits        INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS tabac_achats (
      id          SERIAL PRIMARY KEY,
      product_id  INTEGER NOT NULL REFERENCES tabac_products(id),
      quantite    REAL NOT NULL,
      prix_achat  REAL NOT NULL,
      achat_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      notes       TEXT,
      recorded_by INTEGER REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Manual stock adjustment column for tabac (inventory corrections, kept
  // separate from purchases so cost reports stay clean).
  await pgPool.query('ALTER TABLE tabac_products ADD COLUMN IF NOT EXISTS stock_adjust REAL NOT NULL DEFAULT 0');

  // Stock change history — every manual stock change (both carburant huile
  // products and tabac), with the date it happened.
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id           SERIAL PRIMARY KEY,
      module       TEXT NOT NULL,            -- 'produit' | 'tabac'
      product_id   INTEGER,
      product_name TEXT,
      old_stock    REAL,
      new_stock    REAL,
      delta        REAL,
      action       TEXT NOT NULL DEFAULT 'modification', -- 'modification' | 'suppression'
      note         TEXT,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Mid-shift fuel price changes: an intermediate meter reading per pump at the
  // moment the price changed, so revenue splits old-price vs new-price.
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS shift_price_changes (
      id           SERIAL PRIMARY KEY,
      shift_id     INTEGER NOT NULL REFERENCES shifts(id),
      pump_id      INTEGER NOT NULL REFERENCES pumps(id),
      meter_value  REAL NOT NULL,
      price_before REAL NOT NULL,
      price_after  REAL NOT NULL,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed cuves
  const { rows: [{ c: cuvc }] } = await pgPool.query('SELECT COUNT(*) as c FROM cuves');
  if (parseInt(cuvc) === 0) {
    const { rows: fts } = await pgPool.query("SELECT id, name FROM fuel_types WHERE name IN ('Gazoil','Essence')");
    for (const ft of fts) {
      await pgPool.query('INSERT INTO cuves (name,fuel_type_id,capacite_max,niveau_alerte) VALUES ($1,$2,$3,$4)',
        [`Cuve ${ft.name}`, ft.id, 20000, 3000]);
    }
  }

  // ── Bootstrap account (only on a truly empty users table) ──
  // No hard-coded credentials. Set BOOTSTRAP_ADMIN_USER + BOOTSTRAP_ADMIN_PASSWORD
  // (min 12 chars) in the environment to create the first patron account on a fresh DB.
  const { rows: [{ c: uc }] } = await pgPool.query('SELECT COUNT(*) as c FROM users');
  if (parseInt(uc) === 0) {
    const bu = (process.env.BOOTSTRAP_ADMIN_USER || '').trim();
    const bp = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
    if (bu && bp.length >= 12) {
      const hash = await bcrypt.hash(bp, 12);
      await pgPool.query(
        'INSERT INTO users (full_name,username,password_hash,role) VALUES ($1,$2,$3,$4)',
        ['Administrateur', bu, hash, 'patron']
      );
      console.log(`✅ Compte initial '${bu}' (patron) créé depuis les variables d'environnement.`);
    } else {
      console.warn("⚠️  Aucun utilisateur en base. Définissez BOOTSTRAP_ADMIN_USER et BOOTSTRAP_ADMIN_PASSWORD (≥12 caractères) puis redémarrez pour créer le compte initial.");
    }
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
