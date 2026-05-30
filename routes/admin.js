const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { pool } = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const VALID_ROLES = ['caissier', 'gerant', 'patron', 'admin'];

async function countActiveAdmins() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin' AND is_active=1");
  return rows[0].c;
}

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
  const u = (username || '').trim();
  if (!u || !password) return res.status(400).json({ error: 'username et password requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const userRole = VALID_ROLES.includes(role) ? role : 'caissier';

  const exists = await pool.query('SELECT 1 FROM users WHERE username=$1', [u]);
  if (exists.rowCount) return res.status(409).json({ error: "Ce nom d'utilisateur existe déjà" });

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (username, full_name, password_hash, role, is_active) VALUES ($1,$2,$3,$4,1) RETURNING id,username,full_name,role,is_active',
    [u, (full_name || u).trim(), hash, userRole]
  );
  res.json(rows[0]);
}));

// PUT /api/admin/users/:id/role — change role
router.put('/users/:id/role', wrap(async (req, res) => {
  const { role } = req.body || {};
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  const id = parseInt(req.params.id);

  const { rows } = await pool.query('SELECT role, is_active FROM users WHERE id=$1', [id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (target.role === 'admin' && role !== 'admin' && target.is_active === 1 && (await countActiveAdmins()) <= 1) {
    return res.status(409).json({ error: "Impossible : c'est le dernier administrateur actif" });
  }
  await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
  res.json({ ok: true });
}));

// PUT /api/admin/users/:id/status — activate/deactivate
router.put('/users/:id/status', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const active = req.body && req.body.is_active ? 1 : 0;
  if (active === 0) {
    if (id === req.user.id) return res.status(409).json({ error: 'Vous ne pouvez pas désactiver votre propre compte' });
    const { rows } = await pool.query('SELECT role, is_active FROM users WHERE id=$1', [id]);
    const target = rows[0];
    if (target && target.role === 'admin' && target.is_active === 1 && (await countActiveAdmins()) <= 1) {
      return res.status(409).json({ error: "Impossible : c'est le dernier administrateur actif" });
    }
  }
  await pool.query('UPDATE users SET is_active=$1 WHERE id=$2', [active, id]);
  res.json({ ok: true });
}));

// PUT /api/admin/users/:id/password — reset password
router.put('/users/:id/password', wrap(async (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, parseInt(req.params.id)]);
  res.json({ ok: true });
}));

// DELETE /api/admin/users/:id — delete user
router.delete('/users/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(409).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });

  const { rows } = await pool.query('SELECT role, is_active FROM users WHERE id=$1', [id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (target.role === 'admin' && target.is_active === 1 && (await countActiveAdmins()) <= 1) {
    return res.status(409).json({ error: "Impossible : c'est le dernier administrateur actif" });
  }

  try {
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
  } catch (e) {
    if (e.code === '23503') {
      return res.status(409).json({ error: 'Cet utilisateur a un historique lié. Désactivez-le au lieu de le supprimer.' });
    }
    throw e;
  }
  res.json({ ok: true });
}));

module.exports = router;
