// AI-generated SQL safety guard (defense in depth).
// Only allows a single SELECT/WITH statement and denies dangerous functions /
// sensitive identifiers. The caller additionally runs the query inside a READ
// ONLY transaction with a statement timeout, so any write/DDL is rejected by
// Postgres itself even if these textual guards are ever bypassed.
function isSafeSelect(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const s = sql.trim().replace(/;+\s*$/, '').trim(); // drop trailing semicolons
  if (!s) return false;
  if (s.includes(';')) return false;                 // no multiple statements
  if (!/^(select|with)\b/i.test(s)) return false;    // read queries only
  // dangerous server-side functions (file/network access, DoS, bulk copy)
  if (/\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|copy)\b/i.test(s)) return false;
  // sensitive columns / system catalogs
  if (/password_hash|password|secret|\bjwt\b|\btoken\b|pg_catalog|information_schema|pg_shadow|pg_authid|pg_roles|pg_user\b/i.test(s)) return false;
  return true;
}

module.exports = { isSafeSelect };
