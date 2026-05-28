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

  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND is_active=1', [username]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });

  const token = jwt.sign(
    { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    JWT_SECRET, { expiresIn: '12h' }
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
  if (!bcrypt.compareSync(current_password, user.password_hash))
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.user.id]);
  res.json({ message: 'Mot de passe mis à jour' });
}));

module.exports = router;
