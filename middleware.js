const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'yexweb-hmimidi-xK9$mP2@nQ7&zL4!vR8#wJ5^tY3*cB6';

// Role hierarchy — higher index = more permissions
const ROLE_LEVELS = { caissier: 1, gerant: 2, patron: 3 };

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

// requireRole('patron') — only patron
// requireRole('gerant', 'patron') — gerant or patron
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Accès refusé. Rôle requis: ${roles.join(' ou ')}. Votre rôle: ${req.user.role}`
      });
    }
    next();
  };
}

// requireMinRole('gerant') — gerant AND above (patron too)
function requireMinRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
    const userLevel = ROLE_LEVELS[req.user.role] || 0;
    const minLevel  = ROLE_LEVELS[minRole] || 99;
    if (userLevel < minLevel) {
      return res.status(403).json({
        error: `Accès refusé. Niveau minimum requis: ${minRole}. Votre rôle: ${req.user.role}`
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requireMinRole, JWT_SECRET };
