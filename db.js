require('dotenv').config();
const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      full_name     TEXT NOT NULL,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fuel_types (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      price_per_liter REAL NOT NULL,
      color_hex       TEXT NOT NULL DEFAULT '#0070F2',
      is_active       INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS pumps (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      fuel_type_id INTEGER NOT NULL REFERENCES fuel_types(id),
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id                     SERIAL PRIMARY KEY,
      opened_by              INTEGER NOT NULL REFERENCES users(id),
      opened_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at              TIMESTAMPTZ,
      status                 TEXT    NOT NULL DEFAULT 'open',
      total_liters_sold      REAL,
      total_fuel_revenue     REAL,
      total_credit_deducted  REAL,
      total_product_sales    REAL,
      net_cash               REAL,
      notes                  TEXT
    );
    CREATE TABLE IF NOT EXISTS pump_readings (
      id           SERIAL PRIMARY KEY,
      shift_id     INTEGER NOT NULL REFERENCES shifts(id),
      pump_id      INTEGER NOT NULL REFERENCES pumps(id),
      reading_type TEXT    NOT NULL,
      meter_value  REAL    NOT NULL,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_by  INTEGER NOT NULL REFERENCES users(id),
      UNIQUE(shift_id, pump_id, reading_type)
    );
    CREATE TABLE IF NOT EXISTS credit_clients (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT,
      company     TEXT,
      balance_due REAL NOT NULL DEFAULT 0,
      is_active   INTEGER NOT NULL DEFAULT 1,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS credit_sales (
      id               SERIAL PRIMARY KEY,
      shift_id         INTEGER NOT NULL REFERENCES shifts(id),
      credit_client_id INTEGER NOT NULL REFERENCES credit_clients(id),
      pump_id          INTEGER NOT NULL REFERENCES pumps(id),
      liters           REAL    NOT NULL,
      price_per_liter  REAL    NOT NULL,
      amount           REAL    NOT NULL,
      sale_time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_by      INTEGER NOT NULL REFERENCES users(id),
      notes            TEXT
    );
    CREATE TABLE IF NOT EXISTS credit_payments (
      id               SERIAL PRIMARY KEY,
      credit_client_id INTEGER NOT NULL REFERENCES credit_clients(id),
      shift_id         INTEGER REFERENCES shifts(id),
      amount           REAL    NOT NULL,
      payment_time     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_by      INTEGER NOT NULL REFERENCES users(id),
      notes            TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      reference   TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'Huiles',
      unit        TEXT NOT NULL DEFAULT 'unite',
      price       REAL NOT NULL,
      stock_qty   INTEGER NOT NULL DEFAULT 0,
      stock_min   INTEGER NOT NULL DEFAULT 5,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS product_sales (
      id           SERIAL PRIMARY KEY,
      shift_id     INTEGER NOT NULL REFERENCES shifts(id),
      product_id   INTEGER NOT NULL REFERENCES products(id),
      quantity     INTEGER NOT NULL DEFAULT 1,
      unit_price   REAL    NOT NULL,
      total_amount REAL    NOT NULL,
      sale_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_by  INTEGER NOT NULL REFERENCES users(id)
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
      id              SERIAL PRIMARY KEY,
      fuel_type_id    INTEGER NOT NULL REFERENCES fuel_types(id),
      quantity_liters REAL    NOT NULL,
      delivery_date   DATE    NOT NULL DEFAULT CURRENT_DATE,
      supplier        TEXT,
      notes           TEXT,
      cost_per_liter  REAL,
      recorded_by     INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cafe_menu (
      id         SERIAL PRIMARY KEY,
      name       TEXT    NOT NULL,
      emoji      TEXT    NOT NULL DEFAULT '☕',
      price      REAL    NOT NULL DEFAULT 7,
      is_active  INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cafe_sales (
      id           SERIAL PRIMARY KEY,
      sale_date    DATE    NOT NULL,
      menu_item_id INTEGER NOT NULL REFERENCES cafe_menu(id),
      quantity     INTEGER NOT NULL DEFAULT 0,
      unit_price   REAL    NOT NULL DEFAULT 7,
      total        REAL    NOT NULL DEFAULT 0,
      recorded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(sale_date, menu_item_id)
    );
    CREATE TABLE IF NOT EXISTS cafe_stock_items (
      id            SERIAL PRIMARY KEY,
      name          TEXT    NOT NULL,
      unit          TEXT    NOT NULL DEFAULT 'unité',
      cost_per_unit REAL    NOT NULL DEFAULT 0,
      is_active     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cafe_stock_usage (
      id              SERIAL PRIMARY KEY,
      usage_date      DATE    NOT NULL,
      stock_item_id   INTEGER NOT NULL REFERENCES cafe_stock_items(id),
      quantity_used   REAL    NOT NULL DEFAULT 0,
      cost_per_unit   REAL    NOT NULL DEFAULT 0,
      total_cost      REAL    NOT NULL DEFAULT 0,
      recorded_by     INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(usage_date, stock_item_id)
    );
    CREATE TABLE IF NOT EXISTS bank_settings (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      initial_balance REAL NOT NULL DEFAULT 0,
      account_name    TEXT NOT NULL DEFAULT 'Compte Bancaire'
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id              SERIAL PRIMARY KEY,
      txn_date        DATE    NOT NULL DEFAULT CURRENT_DATE,
      type            TEXT    NOT NULL,
      category        TEXT    NOT NULL DEFAULT 'Autre',
      description     TEXT    NOT NULL,
      amount          REAL    NOT NULL,
      check_number    TEXT,
      beneficiary     TEXT,
      due_date        DATE,
      check_status    TEXT    DEFAULT NULL,
      is_reconciled   INTEGER NOT NULL DEFAULT 0,
      reconciled_at   DATE,
      notes           TEXT,
      recorded_by     INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Bank settings seed
  await pool.query(
    `INSERT INTO bank_settings (id, initial_balance, account_name) VALUES (1, 0, 'Compte Bancaire') ON CONFLICT (id) DO NOTHING`
  );

  // Users seed
  const { rows: [{ c: uc }] } = await pool.query('SELECT COUNT(*) as c FROM users');
  if (parseInt(uc) === 0) {
    await pool.query('INSERT INTO users (full_name,username,password_hash,role) VALUES ($1,$2,$3,$4)',
      ['Aida Hmimidi', 'aida.hmimidi', bcrypt.hashSync('aida123', 10), 'admin']);
    await pool.query('INSERT INTO users (full_name,username,password_hash,role) VALUES ($1,$2,$3,$4)',
      ['Younes Hmimidi', 'younes.hmimidi', bcrypt.hashSync('younes123', 10), 'admin']);
    console.log('✅ Comptes: aida.hmimidi/aida123  younes.hmimidi/younes123');
  }

  // Fuel types + pumps seed
  const { rows: [{ c: ftc }] } = await pool.query('SELECT COUNT(*) as c FROM fuel_types');
  if (parseInt(ftc) === 0) {
    await pool.query('INSERT INTO fuel_types (name,price_per_liter,color_hex) VALUES ($1,$2,$3)', ['Gazoil', 9.40, '#DF6E0C']);
    await pool.query('INSERT INTO fuel_types (name,price_per_liter,color_hex) VALUES ($1,$2,$3)', ['Essence', 11.20, '#0070F2']);
    const { rows: [gz] } = await pool.query("SELECT id FROM fuel_types WHERE name='Gazoil'");
    const { rows: [es] } = await pool.query("SELECT id FROM fuel_types WHERE name='Essence'");
    for (const [n, fid] of [['Pompe 1', gz.id], ['Pompe 2', gz.id], ['Pompe 3', es.id], ['Pompe 4', es.id]])
      await pool.query('INSERT INTO pumps (name,fuel_type_id) VALUES ($1,$2)', [n, fid]);
    console.log('✅ Pompes & carburants créés');
  }

  // Products seed
  const { rows: [{ c: pc }] } = await pool.query('SELECT COUNT(*) as c FROM products');
  if (parseInt(pc) === 0) {
    const ip = 'INSERT INTO products (reference,name,category,unit,price,stock_qty,stock_min) VALUES ($1,$2,$3,$4,$5,$6,$7)';
    for (const p of [
      ['HUI-001','Huile Moteur 5W-30 1L','Huiles','Litre',85,50,10],
      ['HUI-002','Huile Moteur 5W-40 1L','Huiles','Litre',90,30,10],
      ['HUI-003','Huile Moteur 10W-40 1L','Huiles','Litre',75,40,10],
      ['FIL-001','Filtre a Huile','Filtres','Piece',45,20,5],
      ['FIL-002','Filtre a Air','Filtres','Piece',65,15,5],
      ['LIQ-001','Liquide Refroidissement','Accessoires','Litre',35,20,5],
    ]) await pool.query(ip, p);
    console.log('✅ Produits par défaut créés');
  }

  // Cafe seed
  const { rows: [{ c: cc }] } = await pool.query('SELECT COUNT(*) as c FROM cafe_menu');
  if (parseInt(cc) === 0) {
    for (const [n, e, p] of [['Café','☕',7],['Café au Lait','🥛',7],['Lait Chocolat','🍫',7],['Thé','🍵',7],['Soda','🥤',7]])
      await pool.query('INSERT INTO cafe_menu (name,emoji,price) VALUES ($1,$2,$3)', [n, e, p]);
  }
  const { rows: [{ c: sc }] } = await pool.query('SELECT COUNT(*) as c FROM cafe_stock_items');
  if (parseInt(sc) === 0) {
    for (const [n, u, c] of [
      ['Café en grains','kg',80],['Lait','litre',8],['Chocolat en poudre','paquet',25],
      ['Soda (canettes)','unité',4],['Sachets de thé','boîte',15],['Sucre','kg',6],['Gobelets','paquet',12]
    ]) await pool.query('INSERT INTO cafe_stock_items (name,unit,cost_per_unit) VALUES ($1,$2,$3)', [n, u, c]);
  }

  console.log('✅ PostgreSQL prêt');
}

module.exports = { pool, initDB };
