const router = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1) AND is_active=1', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });

  // Pompistes use a shared phone and shouldn't be asked to log in again — give
  // them a long-lived token. Everyone else gets a normal 24h session.
  const expiresIn = user.role === 'pompiste' ? '180d' : '24h';
  const token = jwt.sign(
    { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    JWT_SECRET, { expiresIn }
  );
  res.json({ token, user: { id: user.id, full_name: user.full_name, username: user.username, role: user.role } });
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id,full_name,username,role FROM users WHERE id=$1', [req.user.id]);
  res.json(rows[0] || {});
}));

router.put('/password', requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ error: 'Nouveau mot de passe trop court (min 8 caractères)' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (!current_password || !(await bcrypt.compare(current_password, user.password_hash)))
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  const newHash = await bcrypt.hash(new_password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, req.user.id]);
  res.json({ message: 'Mot de passe mis à jour' });
}));

module.exports = router;
