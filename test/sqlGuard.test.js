const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeSelect } = require('../lib/sqlGuard');

test('allows plain SELECT and WITH queries', () => {
  assert.equal(isSafeSelect('SELECT * FROM shifts'), true);
  assert.equal(isSafeSelect('select id, name from clients'), true);
  assert.equal(isSafeSelect('WITH x AS (SELECT 1 AS n) SELECT * FROM x'), true);
});

test('tolerates surrounding whitespace and a single trailing semicolon', () => {
  assert.equal(isSafeSelect('   SELECT 1   '), true);
  assert.equal(isSafeSelect('SELECT * FROM shifts;'), true);
  assert.equal(isSafeSelect('SELECT * FROM shifts;;  '), true);
});

test('rejects non-string / empty input', () => {
  assert.equal(isSafeSelect(null), false);
  assert.equal(isSafeSelect(undefined), false);
  assert.equal(isSafeSelect(''), false);
  assert.equal(isSafeSelect('    '), false);
  assert.equal(isSafeSelect(123), false);
  assert.equal(isSafeSelect({}), false);
});

test('rejects write / DDL statements (case-insensitive)', () => {
  assert.equal(isSafeSelect("INSERT INTO users VALUES (1)"), false);
  assert.equal(isSafeSelect("InSeRt INTO users VALUES (1)"), false);
  assert.equal(isSafeSelect("UPDATE users SET role='admin'"), false);
  assert.equal(isSafeSelect('DELETE FROM shifts'), false);
  assert.equal(isSafeSelect('DROP TABLE users'), false);
  assert.equal(isSafeSelect('ALTER TABLE users ADD COLUMN x INT'), false);
  assert.equal(isSafeSelect('TRUNCATE shifts'), false);
});

test('rejects stacked / multiple statements', () => {
  assert.equal(isSafeSelect('SELECT 1; DROP TABLE users'), false);
  assert.equal(isSafeSelect('SELECT 1; SELECT 2'), false);
});

test('rejects dangerous server-side functions', () => {
  assert.equal(isSafeSelect('SELECT pg_sleep(10)'), false);
  assert.equal(isSafeSelect("SELECT pg_read_file('/etc/passwd')"), false);
  assert.equal(isSafeSelect("COPY users TO '/tmp/out.csv'"), false);
  assert.equal(isSafeSelect("SELECT dblink('','')"), false);
});

test('rejects access to sensitive columns and system catalogs', () => {
  assert.equal(isSafeSelect('SELECT password_hash FROM users'), false);
  assert.equal(isSafeSelect('SELECT * FROM users WHERE password IS NOT NULL'), false);
  assert.equal(isSafeSelect('SELECT * FROM information_schema.columns'), false);
  assert.equal(isSafeSelect('SELECT * FROM pg_catalog.pg_tables'), false);
  assert.equal(isSafeSelect('SELECT * FROM pg_user'), false);
});
