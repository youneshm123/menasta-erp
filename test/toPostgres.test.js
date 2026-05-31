const test = require('node:test');
const assert = require('node:assert/strict');
const { toPostgres } = require('../lib/toPostgres');

// ── datetime('now') → NOW() ────────────────────────────────────
test("datetime('now') becomes NOW()", () => {
  assert.equal(
    toPostgres("INSERT INTO logs (ts) VALUES (datetime('now'))"),
    'INSERT INTO logs (ts) VALUES (NOW())'
  );
});

test('replaces every datetime() occurrence (global)', () => {
  assert.equal(toPostgres("SELECT datetime('now'), datetime('now')"), 'SELECT NOW(), NOW()');
});

// ── date('now', '-N days') → CURRENT_DATE - INTERVAL 'N days' ───
test("date('now','-N days') becomes a CURRENT_DATE interval", () => {
  assert.equal(
    toPostgres("WHERE d >= date('now', '-7 days')"),
    "WHERE d >= CURRENT_DATE - INTERVAL '7 days'"
  );
});

test('the day-interval form tolerates no space after the comma', () => {
  assert.equal(
    toPostgres("date('now','-30 days')"),
    "CURRENT_DATE - INTERVAL '30 days'"
  );
});

// ── date('now') → CURRENT_DATE ─────────────────────────────────
test("bare date('now') becomes CURRENT_DATE", () => {
  assert.equal(toPostgres("WHERE d = date('now')"), 'WHERE d = CURRENT_DATE');
});

// ── date(col) → (col)::date ────────────────────────────────────
test('date(column) becomes a ::date cast', () => {
  assert.equal(toPostgres('GROUP BY date(created_at)'), 'GROUP BY (created_at)::date');
});

test('date() cast handles a table-qualified column', () => {
  assert.equal(toPostgres('date(o.ts)'), '(o.ts)::date');
});

// ── strftime → TO_CHAR ─────────────────────────────────────────
test("strftime('%Y-%m', col) becomes TO_CHAR YYYY-MM", () => {
  assert.equal(
    toPostgres("strftime('%Y-%m', created_at)"),
    "TO_CHAR(created_at, 'YYYY-MM')"
  );
});

test("strftime('%Y', col) becomes TO_CHAR YYYY", () => {
  assert.equal(
    toPostgres("strftime('%Y', created_at)"),
    "TO_CHAR(created_at, 'YYYY')"
  );
});

test('strftime trims surrounding whitespace in the captured column', () => {
  assert.equal(
    toPostgres("strftime('%Y-%m',  ts )"),
    "TO_CHAR(ts, 'YYYY-MM')"
  );
});

// ── \b anchor must not corrupt words ending in "date" ──────────
test('does not rewrite update()/validate() (word-boundary safety)', () => {
  assert.equal(toPostgres('SELECT validate(x), update_count(y)'), 'SELECT validate(x), update_count(y)');
});

// ── passthrough / idempotency ──────────────────────────────────
test('leaves already-PostgreSQL SQL unchanged (idempotent)', () => {
  const pg = "SELECT NOW(), CURRENT_DATE, TO_CHAR(ts,'YYYY-MM') FROM t";
  assert.equal(toPostgres(pg), pg);
});

test('leaves plain parameterized SQL untouched', () => {
  const sql = 'SELECT * FROM shifts WHERE id = $1 ORDER BY created_at DESC';
  assert.equal(toPostgres(sql), sql);
});

test('is case-sensitive: uppercase SQLite funcs pass through unchanged', () => {
  assert.equal(toPostgres("SELECT DATETIME('now')"), "SELECT DATETIME('now')");
});

// ── a realistic monthly-report query exercises several rules ───
test('translates a combined real-world reporting query', () => {
  const input =
    "SELECT strftime('%Y-%m', created_at) AS mois, COUNT(*) " +
    "FROM ventes WHERE created_at >= date('now', '-30 days') " +
    'GROUP BY date(created_at)';
  const expected =
    "SELECT TO_CHAR(created_at, 'YYYY-MM') AS mois, COUNT(*) " +
    "FROM ventes WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' " +
    'GROUP BY (created_at)::date';
  assert.equal(toPostgres(input), expected);
});
