const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// middleware.js reads JWT_SECRET at load time and throws if missing.
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests-only';
const { requireAuth, requireRole, requireMinRole } = require('../middleware');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
function runMiddleware(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}
const token = role => jwt.sign({ id: 1, role }, process.env.JWT_SECRET);

// ── requireAuth ────────────────────────────────────────────────
test('requireAuth: 401 when Authorization header is missing', () => {
  const { res, nextCalled } = runMiddleware(requireAuth, { headers: {} });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth: 401 when header is not a Bearer token', () => {
  const { res, nextCalled } = runMiddleware(requireAuth, { headers: { authorization: 'Basic abc' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth: 401 on an invalid/forged token', () => {
  const { res, nextCalled } = runMiddleware(requireAuth, { headers: { authorization: 'Bearer not.a.real.token' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth: passes and attaches req.user on a valid token', () => {
  const req = { headers: { authorization: `Bearer ${token('patron')}` } };
  const { res, nextCalled } = runMiddleware(requireAuth, req);
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(req.user.role, 'patron');
});

// ── requireRole (exact match) ──────────────────────────────────
test('requireRole: allows an exact role match', () => {
  const { nextCalled } = runMiddleware(requireRole('patron'), { user: { role: 'patron' } });
  assert.equal(nextCalled, true);
});

test('requireRole: 403 for a non-listed role', () => {
  const { res, nextCalled } = runMiddleware(requireRole('patron'), { user: { role: 'gerant' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireRole: 401 when there is no authenticated user', () => {
  const { res, nextCalled } = runMiddleware(requireRole('patron'), {});
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

// ── requireMinRole (hierarchy) ─────────────────────────────────
test('requireMinRole: rejects a role below the threshold', () => {
  const { res, nextCalled } = runMiddleware(requireMinRole('gerant'), { user: { role: 'caissier' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireMinRole: allows the exact threshold and anything above it', () => {
  for (const role of ['gerant', 'patron', 'admin']) {
    const { nextCalled } = runMiddleware(requireMinRole('gerant'), { user: { role } });
    assert.equal(nextCalled, true, `${role} should pass min-role gerant`);
  }
});

test('requireMinRole: admin bypasses even the highest threshold', () => {
  const { nextCalled } = runMiddleware(requireMinRole('patron'), { user: { role: 'admin' } });
  assert.equal(nextCalled, true);
});

test('requireMinRole: an unknown role is treated as level 0 and rejected', () => {
  const { res, nextCalled } = runMiddleware(requireMinRole('caissier'), { user: { role: 'ghost' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
