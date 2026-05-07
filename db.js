// Uses Node.js built-in SQLite (node:sqlite) — available since Node 22.5, stable in Node 24+
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path   = require('path');

const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(__dirname, 'fuelmaster.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Schema ─────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS fuel_types (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  price_per_liter REAL NOT NULL,
  color_hex       TEXT NOT NULL DEFAULT '#0070F2',
  is_active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pumps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  fuel_type_id INTEGER NOT NULL REFERENCES fuel_types(id),
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_by              INTEGER NOT NULL REFERENCES users(id),
  opened_at              TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at              TEXT,
  status                 TEXT    NOT NULL DEFAULT 'open',
  total_liters_sold      REAL,
  total_fuel_revenue     REAL,
  total_credit_deducted  REAL,
  total_product_sales    REAL,
  net_cash               REAL,
  notes                  TEXT
);

CREATE TABLE IF NOT EXISTS pump_readings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id     INTEGER NOT NULL REFERENCES shifts(id),
  pump_id      INTEGER NOT NULL REFERENCES pumps(id),
  reading_type TEXT    NOT NULL,
  meter_value  REAL    NOT NULL,
  recorded_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  recorded_by  INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(shift_id, pump_id, reading_type)
);

CREATE TABLE IF NOT EXISTS credit_clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,
  company     TEXT,
  balance_due REAL NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS credit_sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id         INTEGER NOT NULL REFERENCES shifts(id),
  credit_client_id INTEGER NOT NULL REFERENCES credit_clients(id),
  pump_id          INTEGER NOT NULL REFERENCES pumps(id),
  liters           REAL    NOT NULL,
  price_per_liter  REAL    NOT NULL,
  amount           REAL    NOT NULL,
  sale_time        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  recorded_by      INTEGER NOT NULL REFERENCES users(id),
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS credit_payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_client_id INTEGER NOT NULL REFERENCES credit_clients(id),
  shift_id         INTEGER REFERENCES shifts(id),
  amount           REAL    NOT NULL,
  payment_time     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  recorded_by      INTEGER NOT NULL REFERENCES users(id),
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reference   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Huiles',
  unit        TEXT NOT NULL DEFAULT 'unite',
  price       REAL NOT NULL,
  stock_qty   INTEGER NOT NULL DEFAULT 0,
  stock_min   INTEGER NOT NULL DEFAULT 5,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS product_sales (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id     INTEGER NOT NULL REFERENCES shifts(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  quantity     INTEGER NOT NULL DEFAULT 1,
  unit_price   REAL    NOT NULL,
  total_amount REAL    NOT NULL,
  sale_time    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  recorded_by  INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL DEFAULT 'Autre',
  description  TEXT NOT NULL,
  amount       REAL NOT NULL,
  expense_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  notes        TEXT,
  recorded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS fuel_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_type_id    INTEGER NOT NULL REFERENCES fuel_types(id),
  quantity_liters REAL    NOT NULL,
  delivery_date   TEXT    NOT NULL DEFAULT (date('now','localtime')),
  supplier        TEXT,
  notes           TEXT,
  recorded_by     INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ── Migrations ───────────────────────────────────────────────
try { db.exec('ALTER TABLE fuel_deliveries ADD COLUMN cost_per_liter REAL'); } catch(_) {}

// ── Helpers ──────────────────────────────────────────────────
const q  = (sql) => db.prepare(sql);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

// ── Seed ──────────────────────────────────────────────────────
if (get('SELECT COUNT(*) as c FROM users').c === 0) {
  run('INSERT INTO users (full_name, username, password_hash, role) VALUES (?,?,?,?)',
    'Aida Hmimidi',   'aida.hmimidi',   bcrypt.hashSync('aida123',   10), 'admin');
  run('INSERT INTO users (full_name, username, password_hash, role) VALUES (?,?,?,?)',
    'Younes Hmimidi', 'younes.hmimidi', bcrypt.hashSync('younes123', 10), 'admin');
  console.log('✅ Comptes admin créés:');
  console.log('   aida.hmimidi   / aida123');
  console.log('   younes.hmimidi / younes123');
}

if (get('SELECT COUNT(*) as c FROM fuel_types').c === 0) {
  run('INSERT INTO fuel_types (name, price_per_liter, color_hex) VALUES (?,?,?)', 'Gazoil',        9.40,  '#DF6E0C');
  run('INSERT INTO fuel_types (name, price_per_liter, color_hex) VALUES (?,?,?)', 'Essence', 11.20, '#0070F2');

  const gazoil  = get("SELECT id FROM fuel_types WHERE name='Gazoil'");
  const essence = get("SELECT id FROM fuel_types WHERE name='Essence'");
  run('INSERT INTO pumps (name, fuel_type_id) VALUES (?,?)', 'Pompe 1', gazoil.id);
  run('INSERT INTO pumps (name, fuel_type_id) VALUES (?,?)', 'Pompe 2', gazoil.id);
  run('INSERT INTO pumps (name, fuel_type_id) VALUES (?,?)', 'Pompe 3', essence.id);
  run('INSERT INTO pumps (name, fuel_type_id) VALUES (?,?)', 'Pompe 4', essence.id);
  console.log('✅ Pompes & types carburant créés');
}

if (get('SELECT COUNT(*) as c FROM products').c === 0) {
  const ip = 'INSERT INTO products (reference,name,category,unit,price,stock_qty,stock_min) VALUES (?,?,?,?,?,?,?)';
  run(ip, 'HUI-001', 'Huile Moteur 5W-30 1L',  'Huiles',      'Litre', 85, 50, 10);
  run(ip, 'HUI-002', 'Huile Moteur 5W-40 1L',  'Huiles',      'Litre', 90, 30, 10);
  run(ip, 'HUI-003', 'Huile Moteur 10W-40 1L', 'Huiles',      'Litre', 75, 40, 10);
  run(ip, 'FIL-001', 'Filtre a Huile',          'Filtres',     'Piece', 45, 20, 5);
  run(ip, 'FIL-002', 'Filtre a Air',            'Filtres',     'Piece', 65, 15, 5);
  run(ip, 'LIQ-001', 'Liquide Refroidissement', 'Accessoires', 'Litre', 35, 20, 5);
  console.log('✅ Produits par défaut créés');
}

module.exports = db;
