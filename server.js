require('dotenv').config();

const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const { initDB, pool } = require('./db');
const { requireAuth, requireMinRole } = require('./middleware');

// Fail fast if critical env vars are missing
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
for (const v of REQUIRED_ENV) {
  if (!process.env[v]) { console.error(`[MENASTA] Env var manquant: ${v}`); process.exit(1); }
}

const START_TIME = Date.now();

async function start() {
  await initDB();

  const app = express();

  // ── Trust Railway's proxy ──
  app.set('trust proxy', 1);

  // ── Security headers ──
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "cdn.jsdelivr.net", "'unsafe-inline'"],
        scriptSrcAttr:  ["'unsafe-inline'"],
        styleSrc:       ["'self'", "fonts.googleapis.com", "'unsafe-inline'"],
        fontSrc:        ["'self'", "fonts.gstatic.com", "data:"],
        imgSrc:         ["'self'", "data:"],
        connectSrc:     ["'self'", "cdn.jsdelivr.net"],
        objectSrc:      ["'none'"],
        frameSrc:       ["'none'"],
        baseUri:        ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // ── Compression ──
  app.use(compression());

  // ── Request logging (correlation ID + structured JSON in prod) ──
  app.use((req, res, next) => {
    const t = Date.now();
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      const ms = Date.now() - t;
      const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
      if (process.env.NODE_ENV === 'production') {
        console.log(JSON.stringify({
          level, ts: new Date().toISOString(), reqId: req.id,
          method: req.method, path: req.originalUrl, status: res.statusCode,
          ms, user: req.user ? req.user.id : null, ip: req.ip,
        }));
      } else {
        console.log(`[${level}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms (${req.id.slice(0, 8)})`);
      }
    });
    next();
  });

  // ── Body parsing ──
  // Bank statement PDFs are sent as base64 for AI reading — allow a larger body
  // on that route only (must be registered before the global 1mb parser).
  app.use('/api/bank/import', express.json({ limit: '25mb' }));
  // Receipt photos are sent as base64 to the AI scanner — allow a larger body.
  app.use('/api/ai/scan-receipt', express.json({ limit: '15mb' }));
  // Saving a scanned facture archives the base64 photo too — larger body.
  app.use('/api/ai/factures', express.json({ limit: '15mb' }));
  // Graissage product photos are sent as base64 — allow a larger body.
  app.use('/api/graissage/products', express.json({ limit: '8mb' }));
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
    'POST /service/entries':         ['Service',    'Saisie Service'],
    'DELETE /service/entries/:id':   ['Service',    'Supprimer Service'],
    'POST /graissage/products':            ['Graissage', 'Ajouter Produit'],
    'PUT /graissage/products/:id':         ['Graissage', 'Modifier Produit'],
    'DELETE /graissage/products/:id':      ['Graissage', 'Supprimer Produit'],
    'POST /graissage/products/:id/reception': ['Graissage', 'Réception Dépôt'],
    'POST /graissage/products/:id/adjust': ['Graissage', 'Correction Stock'],
    'POST /graissage/handout':             ['Graissage', 'Remise à l\'employé'],
    'POST /graissage/return':              ['Graissage', 'Retour Stock'],
    'POST /graissage/scan-sell':           ['Graissage', 'Vente QR'],
    'POST /graissage/payments':            ['Graissage', 'Règlement'],
    'DELETE /graissage/payments/:id':      ['Graissage', 'Supprimer Règlement'],
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

  // ── Favicon (prevent 404 noise) ──
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  // ── Health check (no auth — for Railway / uptime monitors) ──
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, uptime: Math.floor((Date.now() - START_TIME) / 1000) });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // ── API Routes ──
  // Public (any authenticated user)
  app.use('/api/auth',      require('./routes/auth'));
  app.use('/api/shifts',    requireAuth, requireMinRole('caissier'), require('./routes/shifts'));
  app.use('/api/pumps',     requireAuth, requireMinRole('caissier'), require('./routes/pumps'));
  app.use('/api/credits',   requireAuth, requireMinRole('caissier'), require('./routes/credits'));
  app.use('/api/products',  requireAuth, require('./routes/products')); // scan role allowed on /:id + /scan-sell (guarded inside)
  app.use('/api/graissage', requireAuth, require('./routes/graissage')); // scan role allowed on /:id + /scan-sell (guarded inside)
  app.use('/api/dashboard', requireAuth, requireMinRole('caissier'), require('./routes/dashboard'));
  app.use('/api/expenses',  requireAuth, requireMinRole('caissier'), require('./routes/expenses'));
  app.use('/api/employees', requireAuth, requireMinRole('gerant'),   require('./routes/employees'));
  app.use('/api/fuelwd',    requireAuth, requireMinRole('gerant'),   require('./routes/fuelwd'));
  app.use('/api/cafe',      requireAuth, requireMinRole('caissier'), require('./routes/cafe'));
  app.use('/api/tabac',     requireAuth, requireMinRole('caissier'), require('./routes/tabac'));
  app.use('/api/service',   requireAuth, requireMinRole('caissier'), require('./routes/service'));
  app.use('/api/cuves',     requireAuth, requireMinRole('caissier'), require('./routes/cuves'));
  app.use('/api/ai',        requireAuth, requireMinRole('caissier'), require('./routes/ai'));

  // Pompiste app — submit routes allow the low-privilege pompiste role; review
  // routes enforce caissier+ internally, so no min-role gate at the mount.
  app.use('/api/pompiste',  require('./routes/pompiste'));

  // Gérant and above

  app.use('/api/reports',   requireAuth, requireMinRole('gerant'), require('./routes/reports'));
  app.use('/api/stock',     requireAuth, requireMinRole('gerant'), require('./routes/stock'));
  app.use('/api/factures',  requireAuth, requireMinRole('gerant'), require('./routes/factures'));
  app.use('/api/bank',      requireAuth, requireMinRole('gerant'), require('./routes/bank'));
  app.use('/api/alerts',    requireAuth, requireMinRole('gerant'), require('./routes/alerts'));

  // Patron only
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
  const page = f => (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Clear-Site-Data', '"cache"');
    res.sendFile(path.join(__dirname, 'public', f));
  };
  app.get('/',         page('login.html'));
  app.get('/home',     page('home.html'));
  app.get('/app',      page('app.html'));
  app.get('/cafe',     page('cafe.html'));
  app.get('/bank',     page('bank.html'));
  app.get('/tabac',    page('tabac.html'));
  app.get('/service',  page('service.html'));
  app.get('/factures', page('factures.html'));
  app.get('/patron',   page('patron.html'));
  app.get('/admin',    page('admin.html'));
  app.get('/cuves',    page('cuves.html'));
  app.get('/logs',     page('logs.html'));
  app.get('/ai',       page('ai-chat.html'));
  app.get('/boutique', page('boutique.html'));
  app.get('/scanner',  page('scanner.html'));
  app.get('/scan/:id', page('scan.html'));
  app.get('/graissage', page('graissage.html'));
  app.get('/gscan/:id', page('gscan.html'));
  app.get('/pompiste',        page('pompiste.html'));
  app.get('/pompiste-review', page('pompiste-review.html'));

  // ── Cache-buster route (token-protected) ──
  app.get('/clear', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Clear-Site-Data', '"cache", "storage"');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
<title>Clearing cache...</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;">
<h2>🔄 Clearing cache...</h2>
<p>You will be redirected automatically.</p>
<script>
(async function(){
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch(e) {}
  setTimeout(() => location.replace('/app'), 800);
})();
</script></body></html>`);
  });

  // ── Backup & anomaly routes (must be before error handler) ──
  const { startScheduledBackups, runBackup, listBackups } = require('./services/backup');
  startScheduledBackups();

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

  app.get('/api/anomaly/check', requireAuth, requireMinRole('patron'), async (_req, res, next) => {
    try {
      const { runChecksNow } = require('./services/anomaly');
      const alerts = await runChecksNow();
      res.json({ alerts, count: alerts.length });
    } catch(e) { next(e); }
  });

  // ── Error handler ──
  // Client errors (4xx) may surface their message; server errors (5xx) return a
  // generic message and log full detail server-side to avoid leaking internals.
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const ref = req.id || '-';
    if (status >= 500) {
      console.error(`[ERROR] [${ref}] ${req.method} ${req.originalUrl} —`, err.stack || err.message);
    } else {
      console.warn(`[WARN] [${ref}] ${req.method} ${req.originalUrl} — ${err.message}`);
    }
    const clientMsg = status < 500 ? (err.message || 'Requête invalide') : 'Erreur serveur interne';
    res.status(status).json({ error: clientMsg, ref });
  });

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`\n⛽  MENASTA v2 — http://localhost:${PORT}\n`);
  });

  // ── Graceful shutdown ──
  const shutdown = (signal) => {
    console.log(`[MENASTA] ${signal} reçu — arrêt propre...`);
    server.close(() => {
      console.log('[MENASTA] Serveur arrêté proprement.');
      process.exit(0);
    });
    setTimeout(() => { console.error('[MENASTA] Arrêt forcé.'); process.exit(1); }, 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // ── Daily WhatsApp summary at 22:00 ──
  startDailySummary();

  // ── DB keep-alive (prevents Neon cold starts) ──
  setInterval(async () => {
    try { await pool.query('SELECT 1'); } catch (_) {}
  }, 4 * 60 * 1000);

  // ── Anomaly detection (every hour) ──
  const { startAnomalyDetection } = require('./services/anomaly');
  startAnomalyDetection();
}

function startDailySummary() {
  const { sendWhatsApp } = require('./services/whatsapp');
  let lastSentDate = '';

  const TZ = process.env.SUMMARY_TZ || 'Africa/Casablanca';
  setInterval(async () => {
    // Wall-clock time in the station's timezone, not the server's (UTC on Railway)
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t).value;
    const hour = get('hour') === '24' ? '00' : get('hour');
    const hm = `${hour}:${get('minute')}`;
    const today = `${get('year')}-${get('month')}-${get('day')}`;
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
