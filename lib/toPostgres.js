// SQLite → PostgreSQL syntax shim. Applied to every pool.query() call (see db.js),
// so legacy SQLite-flavored date/time expressions keep working against Neon Postgres.
//
// Pure string transform — unit-tested in test/toPostgres.test.js.
// Notes:
//  - Case-sensitive by design (the codebase always writes these functions lowercase).
//  - Order matters: date('now','-N days') is handled before the bare date('now'),
//    and strftime('%Y-%m',…) before strftime('%Y',…).
//  - Raw client.query() obtained from pool.connect() (transactions) BYPASSES this
//    shim — use explicit PostgreSQL syntax there.
function toPostgres(sql) {
  return sql
    .replace(/datetime\('now'\)/g, 'NOW()')
    .replace(/date\('now',\s*'-(\d+) days'\)/g, (_, n) => `CURRENT_DATE - INTERVAL '${n} days'`)
    .replace(/date\('now'\)/g, 'CURRENT_DATE')
    .replace(/\bdate\(([^)'"]+)\)/g, (_, col) => `(${col.trim()})::date`)
    .replace(/strftime\('%Y-%m',\s*([^)]+)\)/g, (_, col) => `TO_CHAR(${col.trim()}, 'YYYY-MM')`)
    .replace(/strftime\('%Y',\s*([^)]+)\)/g,    (_, col) => `TO_CHAR(${col.trim()}, 'YYYY')`);
}

module.exports = { toPostgres };
