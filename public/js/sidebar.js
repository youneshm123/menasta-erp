/* MENASTA DS Sidebar v1 — injects sidebar + topbar shell on every module page */
(function () {
  'use strict';

  const TOKEN = localStorage.getItem('fm_token');
  const USER  = (() => { try { return JSON.parse(localStorage.getItem('fm_user') || 'null'); } catch { return null; } })();

  if (!TOKEN || !USER) {
    if (!location.pathname.endsWith('/') && location.pathname !== '/login') {
      location.href = '/';
    }
    return;
  }

  const PAGE_MAP = {
    '/home':     'Launchpad',
    '/app':      'Carburant',
    '/bank':     'Banque',
    '/cafe':     'Café',
    '/service':  'Service',
    '/cuves':    'Cuves',
    '/factures': 'Factures',
    '/patron':   'Patron',
    '/tabac':    'Tabac',
    '/ai':       'Assistant IA',
    '/admin':    'Administration',
    '/logs':     'Journal',
    '/scanner':  'Scanner reçu',
  };

  const path  = location.pathname;
  const label = PAGE_MAP[path] || 'MENASTA';

  const uname = USER.full_name || USER.username || '';
  const ini   = uname.split(' ').map(w => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || '?';
  const role  = USER.role || '';
  const LEVELS = { caissier: 1, gerant: 2, patron: 3, admin: 99 };
  const lvl   = LEVELS[role] || 1;

  const SUN  = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';

  function navLink(icon, text, href, id) {
    const active = path === href ? ' ds-active-link' : '';
    const idAttr = id ? ' id="' + id + '"' : '';
    return '<a href="' + href + '" class="ds-nav-item' + active + '"' + idAttr + '>' +
      '<span class="ds-ni-ic"><i data-lucide="' + icon + '"></i></span>' +
      '<span class="ds-ni-lbl">' + text + '</span>' +
      '</a>';
  }

  const patronLink = lvl >= 3 ? navLink('crown',      'Patron',        '/patron', 'ds-sb-patron') : '';
  const adminLink  = role === 'admin' ? navLink('settings-2', 'Administration', '/admin',  'ds-sb-admin')  : '';
  const logsLink   = lvl >= 3 ? navLink('clipboard-list', 'Journal', '/logs', 'ds-sb-logs') : '';

  const shellHTML =
    '<aside class="ds-sidebar" id="ds-sidebar">' +
    '  <div class="ds-sb-hd">' +
    '    <a href="/home" class="ds-sb-logo">' +
    '      <div class="ds-sb-mark"><i data-lucide="fuel"></i></div>' +
    '      <span class="ds-sb-brand">MENASTA</span>' +
    '    </a>' +
    '    <button class="ds-sb-col-btn" id="ds-col-btn" title="Réduire">«</button>' +
    '  </div>' +
    '  <div class="ds-sb-store">' +
    '    <div class="ds-sb-store-lbl">Ma station</div>' +
    '    <div class="ds-sb-store-item">' +
    '      <div class="ds-sb-store-ic">SH</div>' +
    '      <span class="ds-sb-store-nm">Station Hmimidi</span>' +
    '      <span class="ds-sb-store-ch"><i data-lucide="chevron-down"></i></span>' +
    '    </div>' +
    '  </div>' +
    '  <nav class="ds-sb-nav">' +
    '    <div class="ds-nav-grp">' +
    '      <div class="ds-nav-grp-lbl">Général</div>' +
    navLink('layout-dashboard', 'Launchpad',  '/home') +
    navLink('fuel',             'Carburant',  '/app') +
    navLink('coffee',           'Café',       '/cafe') +
    navLink('cigarette',        'Tabac',      '/tabac') +
    navLink('droplets',         'Service',    '/service') +
    navLink('qr-code',          'Boutique QR','/boutique') +
    navLink('scan-line',        'Scanner reçu','/scanner') +
    '    </div>' +
    '    <div class="ds-nav-grp">' +
    '      <div class="ds-nav-grp-lbl">Finances</div>' +
    navLink('landmark',     'Banque',    '/bank') +
    navLink('receipt-text', 'Factures',  '/factures') +
    '    </div>' +
    '    <div class="ds-nav-grp">' +
    '      <div class="ds-nav-grp-lbl">Direction</div>' +
    patronLink +
    adminLink +
    navLink('bot', 'Assistant IA', '/ai') +
    logsLink +
    '    </div>' +
    '  </nav>' +
    '  <div class="ds-sb-bot">' +
    '    <button class="ds-nav-item" id="ds-dm-sb-btn" onclick="toggleDarkMode()">' +
    '      <span class="ds-ni-ic" id="ds-dm-sb-ic"><i data-lucide="moon"></i></span>' +
    '      <span class="ds-ni-lbl" id="ds-dm-sb-lbl">Mode sombre</span>' +
    '    </button>' +
    '    <button class="ds-nav-item" onclick="logout()">' +
    '      <span class="ds-ni-ic"><i data-lucide="log-out"></i></span>' +
    '      <span class="ds-ni-lbl">Déconnexion</span>' +
    '    </button>' +
    '  </div>' +
    '  <div class="ds-sb-user">' +
    '    <div class="ds-sb-av" id="ds-sb-av">' + ini + '</div>' +
    '    <div class="ds-sb-user-info">' +
    '      <div class="ds-sb-user-nm" id="ds-sb-nm">' + uname + '</div>' +
    '      <div class="ds-sb-user-rl" id="ds-sb-rl">' + role + '</div>' +
    '    </div>' +
    '    <span class="ds-sb-user-ch"><i data-lucide="chevrons-up-down"></i></span>' +
    '  </div>' +
    '</aside>' +
    '<div class="ds-overlay" id="ds-overlay"></div>' +
    '<header class="ds-topbar" id="ds-topbar">' +
    '  <div class="ds-tb-left">' +
    '    <button class="ds-tb-ham" id="ds-tb-ham"><i data-lucide="menu"></i></button>' +
    '    <button class="ds-tb-nav-btn" onclick="history.back()" title="Retour"><i data-lucide="chevron-left"></i></button>' +
    '    <button class="ds-tb-nav-btn" onclick="history.forward()" title="Suivant"><i data-lucide="chevron-right"></i></button>' +
    '    <span class="ds-breadcrumb">Accueil <span>/</span> <strong>' + label + '</strong></span>' +
    '  </div>' +
    '  <div class="ds-tb-right">' +
    '    <button class="ds-tb-icon-btn" id="ds-dm-tb-btn" onclick="toggleDarkMode()" title="Mode sombre"></button>' +
    '    <div class="ds-tb-av-wrap">' +
    '      <div class="ds-tb-av" id="ds-tb-av">' + ini + '</div>' +
    '      <span class="ds-tb-av-name" id="ds-tb-nm">' + uname + '</span>' +
    '      <span class="ds-tb-av-ch"><i data-lucide="chevron-down"></i></span>' +
    '    </div>' +
    '  </div>' +
    '</header>';

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const isDark = t === 'dark';
    const sbIc  = document.getElementById('ds-dm-sb-ic');
    const sbLbl = document.getElementById('ds-dm-sb-lbl');
    const tbBtn = document.getElementById('ds-dm-tb-btn');
    if (sbIc)  sbIc.innerHTML  = isDark ? SUN : MOON;
    if (sbLbl) sbLbl.textContent = isDark ? 'Mode clair' : 'Mode sombre';
    if (tbBtn) {
      tbBtn.innerHTML = isDark ? SUN : MOON;
      tbBtn.title = isDark ? 'Mode clair' : 'Mode sombre';
    }
    // keep existing dm-toggle elements in sync (for pages that still have them)
    document.querySelectorAll('.dm-toggle').forEach(function (btn) {
      btn.innerHTML = isDark ? SUN : MOON;
      btn.title = isDark ? 'Passer en mode clair' : 'Passer en mode sombre';
    });
  }

  window.toggleDarkMode = function () {
    var next = (document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fm_theme', next);
    applyTheme(next);
  };

  window.logout = function () {
    localStorage.removeItem('fm_token');
    localStorage.removeItem('fm_user');
    location.href = '/';
  };

  function init() {
    // Inject sidebar + topbar at very start of body
    document.body.insertAdjacentHTML('afterbegin', shellHTML);

    // Mark body as DS-active for CSS layout
    document.body.classList.add('ds-active');

    var sidebar = document.getElementById('ds-sidebar');

    // Restore collapsed state
    if (localStorage.getItem('sb_col') === '1') {
      sidebar.classList.add('ds-col');
      document.body.classList.add('ds-col');
    }

    // Collapse toggle
    document.getElementById('ds-col-btn').addEventListener('click', function () {
      var col = sidebar.classList.toggle('ds-col');
      document.body.classList.toggle('ds-col', col);
      localStorage.setItem('sb_col', col ? '1' : '0');
    });

    // Mobile sidebar (Rule 3)
    var overlay = document.getElementById('ds-overlay');
    function openSb() {
      sidebar.classList.add('ds-mob-open');
      overlay.style.opacity = '1';
      overlay.style.pointerEvents = 'all';
    }
    function closeSb() {
      sidebar.classList.remove('ds-mob-open');
      overlay.style.opacity = '';
      overlay.style.pointerEvents = '';
    }
    document.getElementById('ds-tb-ham').addEventListener('click', openSb);
    overlay.addEventListener('click', closeSb);
    window.addEventListener('resize', function () { if (window.innerWidth > 768) closeSb(); });

    // Apply saved theme
    applyTheme(localStorage.getItem('fm_theme') || 'light');

    // Render Lucide icons (CDN must be loaded in page head)
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
