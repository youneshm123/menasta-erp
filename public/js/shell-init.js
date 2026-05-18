/* MENASTA — Fiori shell init
   Sets user avatar and protects auth on all module pages */
(function () {
  const token = localStorage.getItem('fm_token');
  const user  = (() => { try { return JSON.parse(localStorage.getItem('fm_user') || 'null'); } catch { return null; } })();

  if (!token && !location.pathname.endsWith('/') && location.pathname !== '/login' && !location.pathname.includes('login.html')) {
    location.href = '/';
    return;
  }

  if (!user) return;

  const name     = user.full_name || user.username || '';
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const role     = user.role || '';
  const lvl      = { caissier: 1, gerant: 2, patron: 3 }[role] || 0;

  function setAv() {
    document.querySelectorAll('#fs-av, .fs-avatar').forEach(el => {
      if (!el.textContent || el.textContent === '?' || el.textContent === '…') {
        el.textContent = initials;
      }
      el.title = name + (role ? ' · ' + role : '');
    });
  }

  // Hide nav items based on role
  function applyRoleVisibility() {
    if (lvl < 2) {
      document.querySelectorAll('.fs-nav-item[href="/bank"], .fs-nav-item[href="/factures"], .fs-nav-item[href="/logs"], .fs-nav-item[href="/patron"]')
        .forEach(el => el.style.display = 'none');
    }
    if (lvl < 3) {
      document.querySelectorAll('.fs-nav-item[href="/bank"], .fs-nav-item[href="/patron"]')
        .forEach(el => el.style.display = 'none');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { setAv(); applyRoleVisibility(); });
  } else {
    setAv();
    applyRoleVisibility();
  }
})();
