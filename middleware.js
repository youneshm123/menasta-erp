const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'yexweb-hmimidi-xK9$mP2@nQ7&zL4!vR8#wJ5^tY3*cB6';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée, veuillez vous reconnecter' });
  }
}

module.exports = { requireAuth, JWT_SECRET };
