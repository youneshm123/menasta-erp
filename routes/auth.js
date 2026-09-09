const router = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, JWT_SECRET, SESSION_COOKIE } = require('../middleware');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Rôles « téléphone » : le vendeur graissage (scan) et les pompistes travaillent
// sur un portable partagé et ne connaissent pas leur mot de passe. Leur session
// ne doit JAMAIS expirer, sinon ils restent bloqués sur l'écran de connexion.
const PHONE_ROLES = ['scan', 'pompiste'];
const TEN_YEARS_S = 10 * 365 * 24 * 3600;

// Cookie de session : double le token du localStorage. Si le navigateur du
// téléphone vide son stockage local, le cookie suffit pour rester connecté.
function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'Max-Age=' + maxAgeSeconds,
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', SESSION_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
}

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1) AND is_active=1', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });

  // Session longue pour tout le monde (180 jours) ; illimitée pour les rôles
  // téléphone (scan / pompiste) qui ne peuvent pas se reconnecter tout seuls.
  const phone   = PHONE_ROLES.includes(user.role);
  const payload = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  const token   = phone
    ? jwt.sign(payload, JWT_SECRET)                    // aucune expiration
    : jwt.sign(payload, JWT_SECRET, { expiresIn: '180d' });
  setSessionCookie(res, token, phone ? TEN_YEARS_S : 180 * 24 * 3600);
  res.json({ token, user: payload });
}));

// Reprise de session : sert au téléphone qui a perdu son localStorage mais garde
// le cookie. Renvoie l'utilisateur ET un token frais à remettre en localStorage.
router.get('/session', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, full_name, username, role FROM users WHERE id=$1 AND is_active=1', [req.user.id]
  );
  const user = rows[0];
  if (!user) { clearSessionCookie(res); return res.status(401).json({ error: 'Compte désactivé' }); }
  const phone   = PHONE_ROLES.includes(user.role);
  const payload = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  const token   = phone
    ? jwt.sign(payload, JWT_SECRET)
    : jwt.sign(payload, JWT_SECRET, { expiresIn: '180d' });
  setSessionCookie(res, token, phone ? TEN_YEARS_S : 180 * 24 * 3600);
  res.json({ token, user: payload });
}));

router.post('/logout', wrap(async (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
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
