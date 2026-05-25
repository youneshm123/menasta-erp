/* MENASTA — Shell init v3
   Auth guard · Avatar · Role visibility · Mobile sidebar toggle */
(function () {
  'use strict';

  const token = localStorage.getItem('fm_token');
  const user  = (() => { try { return JSON.parse(localStorage.getItem('fm_user') || 'null'); } catch { return null; } })();

  // Auth guard — redirect to login on every protected page
  if (!token || !user) {
    if (!location.pathname.endsWith('/') && location.pathname !== '/login') {
      location.href = '/';
    }
    return;
  }

  // ── Avatar & name ──
  const name     = user.full_name || user.username || '';
  const initials = name.split(' ').map(w => w[0]).filter(Boolean).join('').slice(0, 2).toUpperCase() || '?';
  const role     = user.role || '';
  const LEVELS   = { caissier: 1, gerant: 2, patron: 3, admin: 99 };
  const lvl      = LEVELS[role] || 1;

  function applyAvatar() {
    document.querySelectorAll('#fs-av, .fs-avatar, #sh-av, #sb-av').forEach(el => {
      if (!el.textContent || el.textContent === '?') el.textContent = initials;
      el.title = name + (role ? ' · ' + role : '');
    });
    document.querySelectorAll('#sb-name, #sb-uname').forEach(el => { el.textContent = name; });
    document.querySelectorAll('#sb-role, #sb-urole').forEach(el => { el.textContent = role; });
  }

  // ── Role-based nav visibility ──
  function applyRoleVisibility() {
    if (lvl < 3) {
      ['/patron', '/logs'].forEach(href => {
        document.querySelectorAll(`.fs-nav-item[href="${href}"], #nav-patron, #nav-logs, #tile-patron, #tile-logs`)
          .forEach(el => el?.remove());
      });
    }
    if (role !== 'admin') {
      document.querySelectorAll('.fs-nav-item[href="/admin"], #tile-admin').forEach(el => el?.remove());
    }
  }

  // ── Mobile sidebar toggle ──
  function initMobileSidebar() {
    const shell = document.querySelector('.fiori-shell');
    const sidebar = document.querySelector('.sidebar');
    if (!shell || !sidebar) return;

    // Inject hamburger button before the divider
    const btn = document.createElement('button');
    btn.className = 'sb-hamburger';
    btn.setAttribute('aria-label', 'Menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '&#9776;';
    shell.insertBefore(btn, shell.children[1] || null);

    // Inject overlay div
    const overlay = document.createElement('div');
    overlay.className = 'sb-overlay';
    document.body.appendChild(overlay);

    function openSidebar() {
      document.body.classList.add('sb-open');
      btn.setAttribute('aria-expanded', 'true');
      btn.innerHTML = '&times;';
    }
    function closeSidebar() {
      document.body.classList.remove('sb-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '&#9776;';
    }

    btn.addEventListener('click', () =>
      document.body.classList.contains('sb-open') ? closeSidebar() : openSidebar()
    );
    overlay.addEventListener('click', closeSidebar);

    // Close on nav item click (mobile)
    sidebar.querySelectorAll('.nav-item, .sb-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 768) closeSidebar();
      });
    });

    // Close on resize back to desktop
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) closeSidebar();
    });
  }

  // ── Dark mode toggle ──
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const sunSvg  = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
    const moonSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
    document.querySelectorAll('.dm-toggle').forEach(btn => {
      btn.innerHTML = theme === 'dark' ? sunSvg : moonSvg;
      btn.title = theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
    });
  }

  const savedTheme = localStorage.getItem('fm_theme') || 'light';
  applyTheme(savedTheme);

  window.toggleDarkMode = function () {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fm_theme', next);
    applyTheme(next);
  };

  // ── Global logout ──
  window.logout = function () {
    localStorage.removeItem('fm_token');
    localStorage.removeItem('fm_user');
    location.href = '/';
  };

  // ── Init ──
  function init() {
    applyAvatar();
    applyRoleVisibility();
    initMobileSidebar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
