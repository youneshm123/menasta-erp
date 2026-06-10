const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('[MENASTA] JWT_SECRET env var manquant — serveur refusé');

// Role hierarchy — higher index = more permissions
// admin = 99 → bypasses all role restrictions automatically
const ROLE_LEVELS = { scan: 0, caissier: 1, gerant: 2, patron: 3, admin: 99 };

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
