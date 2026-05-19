require('dotenv').config();

const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const { initDB, pool } = require('./db');
const { requireAuth, requireMinRole } = require('./middleware');

async function start() {
  await initDB();

  const app = express();

  // ── Trust Railway's proxy ──
  app.set('trust proxy', 1);

  // ── Security headers ──
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "cdn.jsdelivr.net", "'unsafe-inline'"],
        styleSrc:    ["'self'", "fonts.googleapis.com", "'unsafe-inline'"],
        fontSrc:     ["'self'", "fonts.gstatic.com"],
        imgSrc:      ["'self'", "data:"],
        connectSrc:  ["'self'"],
        objectSrc:   ["'none'"],
        frameSrc:    ["'none'"],
        baseUri:     ["'self'"],
      },
    },
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
    'POST /credits/payments':         ['Créances',   'Paiement Client'],
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
    etag: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
        // versioned with ?v= query strings — safe to cache 1 year
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // ── API Routes ──
  // Public (any authenticated user)
  app.use('/api/auth',      require('./routes/auth'));
  app.use('/api/shifts',    requireAuth, require('./routes/shifts'));
  app.use('/api/pumps',     requireAuth, require('./routes/pumps'));
  app.use('/api/credits',   requireAuth, require('./routes/credits'));
  app.use('/api/products',  requireAuth, require('./routes/products'));
  app.use('/api/dashboard', requireAuth, require('./routes/dashboard'));
  app.use('/api/expenses',  requireAuth, require('./routes/expenses'));
  app.use('/api/cafe',      requireAuth, require('./routes/cafe'));
  app.use('/api/tabac',     requireAuth, require('./routes/tabac'));
  app.use('/api/cuves',     requireAuth, require('./routes/cuves'));
  app.use('/api/ai',        requireAuth, require('./routes/ai'));

  // Gérant and above

  app.use('/api/reports',   requireAuth, requireMinRole('gerant'), require('./routes/reports'));
  app.use('/api/stock',     requireAuth, requireMinRole('gerant'), require('./routes/stock'));
  app.use('/api/factures',  requireAuth, requireMinRole('gerant'), require('./routes/factures'));

  // Patron only
  app.use('/api/bank',      requireAuth, requireMinRole('patron'), require('./routes/bank'));
  app.use('/api/patron',    requireAuth, requireMinRole('patron'), require('./routes/patron'));

  // Admin only
  app.use('/api/admin',     requireAuth, requireMinRole('admin'), require('./routes/admin'));

  // ── Logs API ──
  app.get('/api/logs', requireAuth, requireMinRole('gerant'), async (req, res, next) => {
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

  app.get('/api/logs/modules', requireAuth, requireMinRole('gerant'), async (_req, res, next) => {
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
  app.get('/admin',    page('admin.html'));
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

  // ── Daily WhatsApp summary at 22:00 ──
  startDailySummary();

  // ── DB keep-alive (prevents Neon cold starts) ──
  setInterval(async () => {
    try { await pool.query('SELECT 1'); } catch (_) {}
  }, 4 * 60 * 1000); // every 4 minutes

  // ── Anomaly detection (every hour) ──
  const { startAnomalyDetection } = require('./services/anomaly');
  startAnomalyDetection();

  // ── Automated backups (daily at 03:00) ──
  const { startScheduledBackups, runBackup, listBackups } = require('./services/backup');
  startScheduledBackups();

  // Backup API (patron only)
  app.get('/api/backups', requireAuth, requireMinRole('patron'), (_req, res) => {
    res.json(listBackups());
  });
  app.post('/api/backups/run', requireAuth, requireMinRole('patron'), async (_req, res, next) => {
    try {
      const result = await runBackup();
      if (result) res.json({ ok: true, ...result });
      else res.status(500).json({ error: 'Backup échoué — vérifiez les logs' });
    } catch(e) { next(e); }
  });

  // ── Manual anomaly trigger (patron only) ──
  app.get('/api/anomaly/check', requireAuth, requireMinRole('patron'), async (_req, res, next) => {
    try {
      const { runChecksNow } = require('./services/anomaly');
      const alerts = await runChecksNow();
      res.json({ alerts, count: alerts.length });
    } catch(e) { next(e); }
  });
}

function startDailySummary() {
  const { sendWhatsApp } = require('./services/whatsapp');
  let lastSentDate = '';

  setInterval(async () => {
    const now = new Date();
    const hm  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const today = now.toISOString().slice(0,10);
    const targetHour = process.env.DAILY_SUMMARY_HOUR || '22:00';
    if (hm !== targetHour || lastSentDate === today) return;
    lastSentDate = today;

    const ownerPhone = process.env.OWNER_PHONE;
    if (!ownerPhone) return;

    try {
      const { rows: shifts } = await pool.query(
        "SELECT SUM(total_fuel_revenue) as ca, SUM(net_cash) as cash, COUNT(*) as nb FROM shifts WHERE status='closed' AND DATE(closed_at)=CURRENT_DATE"
      );
      const { rows: credits } = await pool.query(
        "SELECT COALESCE(SUM(amount),0) as total FROM credit_sales WHERE DATE(sale_time)=CURRENT_DATE"
      );
      const { rows: expenses } = await pool.query(
        "SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date=CURRENT_DATE"
      );
      const { rows: tabac } = await pool.query(
        "SELECT COALESCE(SUM(montant),0) as total, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE vente_date=CURRENT_DATE"
      );

      const s = shifts[0];
      const ca       = parseFloat(s.ca||0).toFixed(2);
      const cash     = parseFloat(s.cash||0).toFixed(2);
      const cred     = parseFloat(credits[0].total).toFixed(2);
      const exp      = parseFloat(expenses[0].total).toFixed(2);
      const tabacCA  = parseFloat(tabac[0].total).toFixed(2);
      const tabacBen = parseFloat(tabac[0].benefice).toFixed(2);

      const msg = `📊 *Résumé MENASTA — ${today}*\n\n`
        + `⛽ CA Carburant : ${ca} MAD\n`
        + `💵 Caisse Nette : ${cash} MAD\n`
        + `🤝 Crédits du jour : ${cred} MAD\n`
        + `💸 Dépenses : ${exp} MAD\n`
        + `🚬 Tabac CA : ${tabacCA} MAD (bénéfice : ${tabacBen} MAD)\n\n`
        + `_Envoyé automatiquement par MENASTA_`;

      await sendWhatsApp(ownerPhone, msg);
      console.log(`[WhatsApp] Résumé journalier envoyé à ${ownerPhone}`);
    } catch(e) {
      console.error('[WhatsApp Daily]', e.message);
    }
  }, 60 * 1000);
}

start().catch(err => { console.error('Démarrage impossible:', err); process.exit(1); });
