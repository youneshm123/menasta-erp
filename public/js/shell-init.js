/* MENASTA — Fiori shell init v2
   Auth guard + avatar + role-based nav visibility */
(function () {
  const token = localStorage.getItem('fm_token');
  const user  = (() => { try { return JSON.parse(localStorage.getItem('fm_user') || 'null'); } catch { return null; } })();

  if (!token && !location.pathname.endsWith('/') && location.pathname !== '/login') {
    location.href = '/';
    return;
  }
  if (!user) return;

  const name     = user.full_name || user.username || '';
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const role     = user.role || '';
  // caissier=1, gérant=2, patron=3
  const lvl = { caissier: 1, gerant: 2, patron: 3 }[role] || 1;

  function setAv() {
    document.querySelectorAll('#fs-av, .fs-avatar, #sh-av').forEach(el => {
      if (!el.textContent || el.textContent === '?') el.textContent = initials;
      el.title = name + (role ? ' · ' + role : '');
    });
    document.querySelectorAll('#sb-name').forEach(el => el.textContent = name);
    document.querySelectorAll('#sb-av').forEach(el => el.textContent = initials);
  }

  function applyRoleVisibility() {
    // Caissier (lvl 1): hide admin-only routes
    if (lvl < 2) {
      ['/patron', '/logs', '/bank', '/factures'].forEach(href => {
        document.querySelectorAll(`.fs-nav-item[href="${href}"]`).forEach(el => el.style.display = 'none');
      });
    }
    // Gérant (lvl 2): hide patron-only
    if (lvl < 3) {
      ['/patron'].forEach(href => {
        document.querySelectorAll(`.fs-nav-item[href="${href}"]`).forEach(el => el.style.display = 'none');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { setAv(); applyRoleVisibility(); });
  } else {
    setAv(); applyRoleVisibility();
  }
})();
