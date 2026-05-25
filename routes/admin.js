const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { pool } = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/admin/users — list all users
router.get('/users', wrap(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, full_name, role, is_active FROM users ORDER BY id'
  );
  res.json(rows);
}));

// POST /api/admin/users — create new user
router.post('/users', wrap(async (req, res) => {
  const { username, full_name, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username et password requis' });
  const validRoles = ['caissier', 'gerant', 'patron', 'admin'];
  const userRole = validRoles.includes(role) ? role : 'caissier';
  const hash = bcrypt.hashSync(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (username, full_name, password_hash, role, is_active) VALUES ($1,$2,$3,$4,1) RETURNING id,username,full_name,role,is_active',
    [username.trim(), (full_name||username).trim(), hash, userRole]
  );
  res.json(rows[0]);
}));

// PUT /api/admin/users/:id/role — change role
router.put('/users/:id/role', wrap(async (req, res) => {
  const { role } = req.body || {};
  const validRoles = ['caissier', 'gerant', 'patron', 'admin'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
  res.json({ ok: true });
}));

// PUT /api/admin/users/:id/status — activate/deactivate
router.put('/users/:id/status', wrap(async (req, res) => {
  const { is_active } = req.body || {};
  await pool.query('UPDATE users SET is_active=$1 WHERE id=$2', [is_active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

// PUT /api/admin/users/:id/password — reset password
router.put('/users/:id/password', wrap(async (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const hash = bcrypt.hashSync(new_password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
  res.json({ ok: true });
}));

// DELETE /api/admin/users/:id — delete user
router.delete('/users/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
