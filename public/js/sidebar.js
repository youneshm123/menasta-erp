/* MENASTA DS Sidebar v2 — injects sidebar + topbar shell on every module page
   v2 : recherche instantanée (Ctrl+K ou /), groupes repliables mémorisés,
        favoris épinglés, lignes compactes, info-bulles en mode réduit. */
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
    '/graissage':'Graissage',
    '/boutique': 'Boutique',
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
  const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  const SEARCH_IC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const CHEV = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  // ── Modules disponibles selon le rôle ──────────────────────
  const GROUPS = [
    { key: 'general', label: 'Général', items: [
      { icon: 'layout-dashboard', text: 'Launchpad',    href: '/home' },
      { icon: 'fuel',             text: 'Carburant',    href: '/app' },
      { icon: 'coffee',           text: 'Café',         href: '/cafe' },
      { icon: 'cigarette',        text: 'Tabac',        href: '/tabac' },
      { icon: 'droplets',         text: 'Service',      href: '/service' },
      { icon: 'droplet',          text: 'Graissage',    href: '/graissage' },
      { icon: 'scan-line',        text: 'Scanner reçu', href: '/scanner' },
    ]},
    { key: 'finances', label: 'Finances', items: [
      { icon: 'landmark',     text: 'Banque',   href: '/bank' },
      { icon: 'receipt-text', text: 'Factures', href: '/factures' },
    ]},
    { key: 'direction', label: 'Direction', items: [
      { icon: 'crown',          text: 'Patron',         href: '/patron', min: 3 },
      { icon: 'settings-2',     text: 'Administration', href: '/admin',  admin: true },
      { icon: 'bot',            text: 'Assistant IA',   href: '/ai' },
      { icon: 'clipboard-list', text: 'Journal',        href: '/logs',   min: 3 },
    ]},
  ];

  const allowed = it => (!it.min || lvl >= it.min) && (!it.admin || role === 'admin');
  const ALL_ITEMS = GROUPS.flatMap(g => g.items.filter(allowed));

  // ── Favoris épinglés ───────────────────────────────────────
  const readPins = () => { try { return JSON.parse(localStorage.getItem('ds_pins') || '[]'); } catch { return []; } };
  let pins = readPins().filter(h => ALL_ITEMS.some(i => i.href === h));
  const savePins = () => localStorage.setItem('ds_pins', JSON.stringify(pins));

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function navLink(it) {
    const active = path === it.href ? ' ds-active-link' : '';
    const pinned = pins.includes(it.href) ? ' ds-pinned' : '';
    return '<a href="' + it.href + '" class="ds-nav-item' + active + pinned + '" data-href="' + it.href + '"' +
      ' data-name="' + esc(it.text) + '" data-tip="' + esc(it.text) + '">' +
      '<span class="ds-ni-ic"><i data-lucide="' + it.icon + '"></i></span>' +
      '<span class="ds-ni-lbl">' + esc(it.text) + '</span>' +
      '<span class="ds-ni-pin" role="button" tabindex="-1" title="Épingler en favori" data-pin="' + it.href + '">' + STAR + '</span>' +
      '</a>';
  }

  function groupHTML(key, label, items) {
    if (!items.length) return '';
    const closed = localStorage.getItem('ds_grp_' + key) === '0' ? ' ds-grp-closed' : '';
    return '<div class="ds-nav-grp' + closed + '" data-grp="' + key + '">' +
      '<button class="ds-nav-grp-lbl" data-grp-btn="' + key + '">' + label +
        '<span class="ds-nav-grp-ch">' + CHEV + '</span></button>' +
      items.map(navLink).join('') +
      '</div>';
  }

  function navHTML() {
    const favItems = pins.map(h => ALL_ITEMS.find(i => i.href === h)).filter(Boolean);
    return groupHTML('fav', 'Favoris', favItems) +
      GROUPS.map(g => groupHTML(g.key, g.label, g.items.filter(allowed))).join('') +
      '<div class="ds-nav-empty" id="ds-nav-empty">Aucun module trouvé</div>';
  }

  const shellHTML =
    '<aside class="ds-sidebar" id="ds-sidebar">' +
    '  <div class="ds-sb-hd">' +
    '    <a href="/home" class="ds-sb-logo">' +
    '      <div class="ds-sb-mark"><i data-lucide="fuel"></i></div>' +
    '      <span class="ds-sb-brand">MENASTA</span>' +
    '    </a>' +
    '    <button class="ds-sb-col-btn" id="ds-col-btn" title="Réduire le menu (Alt+B)">«</button>' +
    '  </div>' +
    '  <div class="ds-sb-search">' +
    '    <span class="ds-sb-search-ic">' + SEARCH_IC + '</span>' +
    '    <input id="ds-sb-q" type="text" placeholder="Rechercher un module…" autocomplete="off" spellcheck="false"/>' +
    '    <span class="ds-sb-kbd">Ctrl K</span>' +
    '  </div>' +
    '  <button class="ds-sb-search-col" id="ds-sb-search-col" title="Rechercher (Ctrl+K)">' + SEARCH_IC + '</button>' +
    '  <div class="ds-sb-store">' +
    '    <div class="ds-sb-store-item" title="Station Hmimidi">' +
    '      <div class="ds-sb-store-ic">SH</div>' +
    '      <span class="ds-sb-store-nm">Station Hmimidi</span>' +
    '      <span class="ds-sb-store-ch"><i data-lucide="chevron-down"></i></span>' +
    '    </div>' +
    '  </div>' +
    '  <nav class="ds-sb-nav" id="ds-sb-nav">' + navHTML() + '</nav>' +
    '  <div class="ds-sb-bot">' +
    '    <button class="ds-nav-item" id="ds-dm-sb-btn" data-tip="Mode sombre" onclick="toggleDarkMode()">' +
    '      <span class="ds-ni-ic" id="ds-dm-sb-ic"><i data-lucide="moon"></i></span>' +
    '      <span class="ds-ni-lbl" id="ds-dm-sb-lbl">Mode sombre</span>' +
    '    </button>' +
    '    <button class="ds-nav-item" data-tip="Déconnexion" onclick="logout()">' +
    '      <span class="ds-ni-ic"><i data-lucide="log-out"></i></span>' +
    '      <span class="ds-ni-lbl">Déconnexion</span>' +
    '    </button>' +
    '  </div>' +
    '  <div class="ds-sb-user" title="' + esc(uname) + ' — ' + esc(role) + '">' +
    '    <div class="ds-sb-av" id="ds-sb-av">' + ini + '</div>' +
    '    <div class="ds-sb-user-info">' +
    '      <div class="ds-sb-user-nm" id="ds-sb-nm">' + esc(uname) + '</div>' +
    '      <div class="ds-sb-user-rl" id="ds-sb-rl">' + esc(role) + '</div>' +
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
    '    <span class="ds-breadcrumb">Accueil <span>/</span> <strong>' + esc(label) + '</strong></span>' +
    '  </div>' +
    '  <div class="ds-tb-right">' +
    '    <button class="ds-tb-icon-btn" id="ds-dm-tb-btn" onclick="toggleDarkMode()" title="Mode sombre"></button>' +
    '    <div class="ds-tb-av-wrap">' +
    '      <div class="ds-tb-av" id="ds-tb-av">' + ini + '</div>' +
    '      <span class="ds-tb-av-name" id="ds-tb-nm">' + esc(uname) + '</span>' +
    '      <span class="ds-tb-av-ch"><i data-lucide="chevron-down"></i></span>' +
    '    </div>' +
    '  </div>' +
    '</header>';

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const isDark = t === 'dark';
    const sbIc  = document.getElementById('ds-dm-sb-ic');
    const sbLbl = document.getElementById('ds-dm-sb-lbl');
    const sbBtn = document.getElementById('ds-dm-sb-btn');
    const tbBtn = document.getElementById('ds-dm-tb-btn');
    if (sbIc)  sbIc.innerHTML  = isDark ? SUN : MOON;
    if (sbLbl) sbLbl.textContent = isDark ? 'Mode clair' : 'Mode sombre';
    if (sbBtn) sbBtn.setAttribute('data-tip', isDark ? 'Mode clair' : 'Mode sombre');
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

  // Recherche insensible aux accents et à la casse.
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function init() {
    document.body.insertAdjacentHTML('afterbegin', shellHTML);
    document.body.classList.add('ds-active');

    const sidebar = document.getElementById('ds-sidebar');
    const nav     = document.getElementById('ds-sb-nav');
    const qInput  = document.getElementById('ds-sb-q');
    const empty   = document.getElementById('ds-nav-empty');

    // ── Mode réduit (mémorisé) ──
    function setCollapsed(col) {
      sidebar.classList.toggle('ds-col', col);
      document.body.classList.toggle('ds-col', col);
      localStorage.setItem('sb_col', col ? '1' : '0');
      if (!col) clearSearch();
    }
    if (localStorage.getItem('sb_col') === '1') setCollapsed(true);
    document.getElementById('ds-col-btn').addEventListener('click', function () {
      setCollapsed(!sidebar.classList.contains('ds-col'));
    });
    document.getElementById('ds-sb-search-col').addEventListener('click', function () {
      setCollapsed(false);
      setTimeout(() => qInput.focus(), 210);
    });

    // ── Recherche instantanée ──
    function clearSearch() {
      if (!qInput.value) return;
      qInput.value = '';
      applySearch();
    }
    function applySearch() {
      const q = norm(qInput.value.trim());
      nav.classList.toggle('ds-searching', !!q);
      let shown = 0;
      nav.querySelectorAll('.ds-nav-item').forEach(function (a) {
        const name = a.getAttribute('data-name') || '';
        const hit  = !q || norm(name).includes(q);
        a.classList.toggle('ds-hide', !hit);
        const lbl = a.querySelector('.ds-ni-lbl');
        if (!q) { lbl.textContent = name; }
        else if (hit) {
          const i = norm(name).indexOf(q);
          lbl.innerHTML = esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
        }
        if (hit) shown++;
      });
      // Un groupe sans résultat disparaît ; pendant une recherche on ouvre tout.
      nav.querySelectorAll('.ds-nav-grp').forEach(function (g) {
        const visible = g.querySelectorAll('.ds-nav-item:not(.ds-hide)').length;
        g.classList.toggle('ds-hide', q ? visible === 0 : false);
        if (q) g.classList.remove('ds-grp-closed');
        else g.classList.toggle('ds-grp-closed', localStorage.getItem('ds_grp_' + g.dataset.grp) === '0');
      });
      empty.style.display = q && shown === 0 ? 'block' : 'none';
    }
    qInput.addEventListener('input', applySearch);
    qInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { clearSearch(); qInput.blur(); }
      if (e.key === 'Enter') {
        const first = nav.querySelector('.ds-nav-item:not(.ds-hide)');
        if (first) location.href = first.getAttribute('href');
      }
    });

    // ── Raccourcis clavier ──
    document.addEventListener('keydown', function (e) {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (sidebar.classList.contains('ds-col')) setCollapsed(false);
        qInput.focus(); qInput.select();
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        if (sidebar.classList.contains('ds-col')) setCollapsed(false);
        qInput.focus();
      } else if (e.altKey && e.key.toLowerCase() === 'b' && !typing) {
        e.preventDefault();
        setCollapsed(!sidebar.classList.contains('ds-col'));
      }
    });

    // ── Groupes repliables + épinglage (délégation) ──
    nav.addEventListener('click', function (e) {
      const pinBtn = e.target.closest('.ds-ni-pin');
      if (pinBtn) {
        e.preventDefault(); e.stopPropagation();
        const href = pinBtn.getAttribute('data-pin');
        pins = pins.includes(href) ? pins.filter(h => h !== href) : pins.concat([href]);
        savePins();
        nav.innerHTML = navHTML();
        if (typeof lucide !== 'undefined') lucide.createIcons();
        applySearch();
        return;
      }
      const grpBtn = e.target.closest('.ds-nav-grp-lbl');
      if (grpBtn) {
        const key = grpBtn.getAttribute('data-grp-btn');
        const grp = nav.querySelector('.ds-nav-grp[data-grp="' + key + '"]');
        const closed = grp.classList.toggle('ds-grp-closed');
        localStorage.setItem('ds_grp_' + key, closed ? '0' : '1');
      }
    });

    // ── Tiroir mobile ──
    const overlay = document.getElementById('ds-overlay');
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

    applyTheme(localStorage.getItem('fm_theme') || 'light');

    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
