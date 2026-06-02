/* table-tools.js — universal search + pagination for every data table (.t).
 * Auto-applies on load and re-applies when a table's rows change (async loads).
 * - Reuses an existing search box in the table's section (no duplicate bars).
 * - Pagination footer appears only when there is more than one page.
 * Opt out per table with  data-no-tools  ; override size with  data-page-size .
 */
(function () {
  const DEFAULT_PAGE_SIZE = 15;

  // ── inject styles once ──
  const css = `
    .tt-searchbar{padding:10px 16px 4px}
    .tt-search{width:100%;max-width:440px;padding:8px 12px 8px 12px;border:1.5px solid var(--border,#d0d7de);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface,#fff);color:var(--text,#1a2332);box-sizing:border-box;outline:none}
    .tt-search:focus{border-color:var(--blue,#2563eb)}
    .tt-pager{display:flex;align-items:center;justify-content:center;gap:14px;padding:12px 16px;flex-wrap:wrap}
    .tt-info{font-size:12.5px;color:var(--muted,#6b7280);font-weight:600;min-width:150px;text-align:center;font-variant-numeric:tabular-nums}
    .tt-btn{padding:6px 14px;border:1px solid var(--border,#d0d7de);border-radius:7px;background:var(--surface,#fff);color:var(--text,#1a2332);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
    .tt-btn:hover:not(:disabled){background:var(--bg2,#f3f4f6)}
    .tt-btn:disabled{opacity:.4;cursor:default}
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  function findExistingSearch(table) {
    const sec = table.closest('.section') || table.parentElement;
    if (!sec) return null;
    for (const inp of sec.querySelectorAll('input')) {
      const p  = (inp.placeholder || '').toLowerCase();
      const oi = (inp.getAttribute('oninput') || '');
      if (p.includes('recher') || oi.includes('searchTable') || oi.includes('filter') || oi.includes('search'))
        return inp;
    }
    return null;
  }

  function initTable(table) {
    if (table.__tt || table.hasAttribute('data-no-tools')) return;
    const tbody = table.tBodies && table.tBodies[0];
    if (!tbody) return;
    table.__tt = true;

    const pageSize = parseInt(table.getAttribute('data-page-size')) || DEFAULT_PAGE_SIZE;
    const state = { page: 1, q: '' };

    // anchor = scroll wrapper if present, else the table itself
    let anchor = table;
    if (table.parentElement && table.parentElement.classList.contains('s-body-flush'))
      anchor = table.parentElement;

    // ── search input: reuse existing or inject one ──
    let searchInput = findExistingSearch(table);
    if (!searchInput) {
      const bar = document.createElement('div');
      bar.className = 'tt-searchbar';
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'tt-search';
      searchInput.placeholder = '🔍 Rechercher…';
      bar.appendChild(searchInput);
      anchor.parentNode.insertBefore(bar, anchor);
    } else {
      // take over its handler so we control filtering + paging together
      searchInput.oninput = null;
      searchInput.removeAttribute('oninput');
    }
    searchInput.addEventListener('input', () => {
      state.q = searchInput.value.toLowerCase().trim();
      state.page = 1;
      render();
    });

    // ── pagination footer ──
    const foot = document.createElement('div');
    foot.className = 'tt-pager';
    foot.style.display = 'none';
    anchor.parentNode.insertBefore(foot, anchor.nextSibling);

    function dataRows() {
      return Array.from(tbody.rows).filter(r =>
        !r.hasAttribute('data-tt-empty') && !(r.id && r.id.endsWith('-no-results')));
    }

    function mkBtn(label, fn) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tt-btn'; b.textContent = label; b.onclick = fn;
      return b;
    }

    function render() {
      const rows = dataRows();
      const filtered = rows.filter(r => !state.q || r.textContent.toLowerCase().includes(state.q));
      rows.forEach(r => { r.style.display = 'none'; });

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (state.page > totalPages) state.page = totalPages;

      const start = (state.page - 1) * pageSize;
      filtered.slice(start, start + pageSize).forEach(r => { r.style.display = ''; });

      if (totalPages <= 1) { foot.style.display = 'none'; return; }
      foot.style.display = 'flex';
      foot.innerHTML = '';
      const prev = mkBtn('‹ Précédent', () => { if (state.page > 1) { state.page--; render(); } });
      const next = mkBtn('Suivant ›',  () => { if (state.page < totalPages) { state.page++; render(); } });
      prev.disabled = state.page <= 1;
      next.disabled = state.page >= totalPages;
      const info = document.createElement('span');
      info.className = 'tt-info';
      info.textContent = `${total} résultat${total > 1 ? 's' : ''} · page ${state.page} / ${totalPages}`;
      foot.append(prev, info, next);
    }

    // re-apply whenever the page repopulates this table (async data load)
    let raf = null;
    const obs = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; state.page = 1; render(); });
    });
    obs.observe(tbody, { childList: true });

    render();
  }

  function initAll() {
    document.querySelectorAll('table.t').forEach(initTable);
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initAll);
  else
    initAll();

  window.TableTools = { initAll, initTable };
})();
