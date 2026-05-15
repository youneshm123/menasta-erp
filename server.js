require('dotenv').config();

const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const { initDB, pool } = require('./db');
const { requireAuth } = require('./middleware');

async function start() {
  await initDB();

  const app = express();

  // ── Security headers ──
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // ── Compression ──
  app.use(compression());

  // ── Body parsing ──
  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ──
  app.use('/api/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: 'Trop de requêtes.' },
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // ── Activity logging ──
  const ACTION_MAP = {
    'POST /shifts':                  ['Carburant',  'Ouverture Poste'],
    'POST /shifts/:id/close':        ['Carburant',  'Fermeture Poste'],
    'DELETE /shifts/:id':            ['Carburant',  'Supprimer Poste'],
    'POST /credits/sales':           ['Créances',   'Vente Crédit'],
    'DELETE /credits/sales/:id':     ['Créances',   'Annuler Vente Crédit'],
    'POST /credits/payments/:id':    ['Créances',   'Paiement Client'],
    'POST /credits/clients':         ['Créances',   'Nouveau Client'],
    'PUT /credits/clients/:id':      ['Créances',   'Modifier Client'],
    'DELETE /credits/clients/:id':   ['Créances',   'Supprimer Client'],
    'POST /products':                ['Produits',   'Ajouter Produit'],
    'POST /products/sell':           ['Produits',   'Vente Produit'],
    'PUT /products/:id':             ['Produits',   'Modifier Produit'],
    'DELETE /products/:id':          ['Produits',   'Supprimer Produit'],
    'DELETE /products/sales/:id':    ['Produits',   'Annuler Vente Produit'],
    'POST /expenses':                ['Dépenses',   'Ajouter Dépense'],
    'DELETE /expenses/:id':          ['Dépenses',   'Supprimer Dépense'],
    'POST /stock/deliveries':        ['Stock',      'Livraison Carburant'],
    'DELETE /stock/deliveries/:id':  ['Stock',      'Supprimer Livraison'],
    'POST /pumps':                   ['Pompes',     'Ajouter Pompe'],
    'PUT /pumps/:id':                ['Pompes',     'Modifier Pompe'],
    'DELETE /pumps/:id':             ['Pompes',     'Supprimer Pompe'],
    'PUT /pumps/prices/:id':         ['Pompes',     'Modifier Prix'],
    'POST /cafe/sales':              ['Café',       'Saisie Ventes'],
    'POST /cafe/stock/usage':        ['Café',       'Saisie Stock'],
    'POST /cafe/menu':               ['Café',       'Ajouter Article Menu'],
    'PUT /cafe/menu/:id':            ['Café',       'Modifier Article Menu'],
    'DELETE /cafe/menu/:id':         ['Café',       'Supprimer Article Menu'],
    'POST /cafe/stock/items':        ['Café',       'Ajouter Article Stock'],
    'PUT /cafe/stock/items/:id':     ['Café',       'Modifier Article Stock'],
    'DELETE /cafe/stock/items/:id':  ['Café',       'Supprimer Article Stock'],
    'POST /bank':                    ['Banque',     'Nouvelle Transaction'],
    'DELETE /bank/:id':              ['Banque',     'Supprimer Transaction'],
    'PUT /bank/:id/reconcile':       ['Banque',     'Pointer Transaction'],
    'PUT /bank/cheques/:id':         ['Banque',     'Modifier Chèque'],
    'DELETE /bank/cheques/:id':      ['Banque',     'Supprimer Chèque'],
    'POST /tabac/ventes':            ['Tabac',      'Saisie Ventes'],
    'POST /tabac/produits':          ['Tabac',      'Ajouter Produit'],
    'PUT /tabac/produits/:id':       ['Tabac',      'Modifier Produit'],
    'DELETE /tabac/produits/:id':    ['Tabac',      'Supprimer Produit'],
    'POST /factures':                ['Factures',   'Créer Facture'],
    'DELETE /factures/:id':          ['Factures',   'Supprimer Facture'],
    'POST /cuves/:id/lectures':      ['Cuves',      'Saisie Niveau Cuve'],
    'PUT /cuves/lectures/:id':       ['Cuves',      'Modifier Lecture'],
    'POST /cuves/:id/livraisons':    ['Cuves',      'Livraison Cuve'],
    'DELETE /cuves/livraisons/:id':  ['Cuves',      'Supprimer Livraison'],
  };

  function resolveAction(method, rawPath) {
    const p = rawPath.split('?')[0].replace(/\/\d+/g, '/:id');
    return ACTION_MAP[`${method} ${p}`] || [rawPath.split('/')[1] || 'API', `${method} ${rawPath}`];
  }

  function extractDetails(body) {
    if (!body || typeof body !== 'object') return null;
    const fields = ['description','amount','montant','date','client_name','name','numero','notes','username'];
    const parts = [];
    for (const f of fields) {
      if (body[f] != null && body[f] !== '') {
        parts.push(String(body[f]).slice(0, 100));
        if (parts.length >= 3) break;
      }
    }
    return parts.length ? parts.join(' · ') : null;
  }

  app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/api/auth')) return next();
    if (!['POST','PUT','DELETE','PATCH'].includes(req.method)) return next();
    if (!req.originalUrl.startsWith('/api/')) return next();
    res.on('finish', async () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || !req.user) return;
      const apiPath = req.originalUrl.replace('/api', '');
      const [module, action] = resolveAction(req.method, apiPath);
      const details = extractDetails(req.body);
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
      try {
        await pool.query(
          'INSERT INTO activity_logs (user_id, username, module, action, details, ip_addr) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.user.id, req.user.username, module, action, details, ip]
        );
      } catch (_) {}
    });
    next();
  });

  // ── Static files ──
  app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    etag: true,
  }));

  // ── API Routes ──
  app.use('/api/auth',      require('./routes/auth'));
  app.use('/api/shifts',    require('./routes/shifts'));
  app.use('/api/pumps',     require('./routes/pumps'));
  app.use('/api/credits',   require('./routes/credits'));
  app.use('/api/products',  require('./routes/products'));
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api/reports',   require('./routes/reports'));
  app.use('/api/expenses',  require('./routes/expenses'));
  app.use('/api/stock',     require('./routes/stock'));
  app.use('/api/cafe',      require('./routes/cafe'));
  app.use('/api/bank',      require('./routes/bank'));
  app.use('/api/tabac',     require('./routes/tabac'));
  app.use('/api/factures',  require('./routes/factures'));
  app.use('/api/patron',    require('./routes/patron'));
  app.use('/api/cuves',     require('./routes/cuves'));
  app.use('/api/ai',        require('./routes/ai'));

  // ── Logs API ──
  app.get('/api/logs', requireAuth, async (req, res, next) => {
    try {
      const { module: mod, from, to, limit = 200 } = req.query;
      let sql = 'SELECT * FROM activity_logs WHERE 1=1';
      const params = [];
      if (mod)  { params.push(mod);  sql += ` AND module=$${params.length}`; }
      if (from) { params.push(from); sql += ` AND created_at>=$${params.length}`; }
      if (to)   { params.push(to);   sql += ` AND created_at<=$${params.length}`; }
      params.push(Math.min(parseInt(limit)||200, 1000));
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch(e) { next(e); }
  });

  app.get('/api/logs/modules', requireAuth, async (_req, res, next) => {
    try {
      const { rows } = await pool.query('SELECT DISTINCT module FROM activity_logs ORDER BY module');
      res.json(rows.map(r => r.module));
    } catch(e) { next(e); }
  });

  // ── Page Routes ──
  const page = f => (_req, res) => res.sendFile(path.join(__dirname, 'public', f));
  app.get('/',         page('login.html'));
  app.get('/home',     page('home.html'));
  app.get('/app',      page('app.html'));
  app.get('/cafe',     page('cafe.html'));
  app.get('/bank',     page('bank.html'));
  app.get('/tabac',    page('tabac.html'));
  app.get('/factures', page('factures.html'));
  app.get('/patron',   page('patron.html'));
  app.get('/cuves',    page('cuves.html'));
  app.get('/logs',     page('logs.html'));
  app.get('/ai',       page('ai-chat.html'));

  // ── Error handler ──
  app.use((err, _req, res, _next) => {
    console.error('[ERROR]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur interne' });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n⛽  MENASTA v2 — http://localhost:${PORT}\n`);
  });
}

start().catch(err => { console.error('Démarrage impossible:', err); process.exit(1); });
