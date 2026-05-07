// ── Excel copy/paste utilities ────────────────────────────────

// Copy any HTML table to clipboard as TSV (Excel-compatible)
function copyTableToExcel(tableId, opts = {}) {
  const table = typeof tableId === 'string' ? document.getElementById(tableId) : tableId;
  if (!table) return;

  const skipLastCols = opts.skipLastCols || 0; // skip action columns at end
  const rows = [];

  // Header
  const ths = table.querySelectorAll('thead th');
  if (ths.length) {
    const hdr = [...ths].slice(0, ths.length - skipLastCols).map(th => cellText(th));
    rows.push(hdr.join('\t'));
  }

  // Body
  table.querySelectorAll('tbody tr').forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (!tds.length) return;
    const cells = [...tds].slice(0, tds.length - skipLastCols).map(td => cellText(td));
    rows.push(cells.join('\t'));
  });

  // Footer
  table.querySelectorAll('tfoot tr').forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (!tds.length) return;
    const cells = [...tds].slice(0, tds.length - skipLastCols).map(td => cellText(td));
    rows.push(cells.join('\t'));
  });

  const tsv = rows.join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    showCopyFeedback(opts.btnEl);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = tsv;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showCopyFeedback(opts.btnEl);
  });
}

function cellText(el) {
  // Strip HTML, trim, remove MAD suffix for numbers, keep clean text
  let t = (el.innerText || el.textContent || '').trim();
  t = t.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
  return t;
}

function showCopyFeedback(btn) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = '✅ Copié !';
  btn.style.background = '#D1FAE5';
  btn.style.color = '#065F46';
  setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 2000);
}

// Parse TSV/CSV pasted from Excel
function parseExcelPaste(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  return lines.map(line => {
    // Handle both tab-separated and semicolon-separated (French Excel uses ;)
    const sep = line.includes('\t') ? '\t' : ';';
    return line.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
  });
}

// Render a preview table from parsed rows
function renderPastePreview(rows, container) {
  if (!rows.length) { container.innerHTML = ''; return; }
  const header = rows[0];
  const body   = rows.slice(1);
  container.innerHTML = `
    <div style="overflow-x:auto;max-height:220px;border:1px solid #E5E5EA;border-radius:6px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr>${header.map(h=>`<th style="padding:6px 10px;background:#F5F5F7;border-bottom:2px solid #E5E5EA;text-align:left;font-weight:700;color:#6A6D70;white-space:nowrap">${h}</th>`).join('')}</tr></thead>
        <tbody>${body.map(r=>`<tr>${r.map(c=>`<td style="padding:5px 10px;border-bottom:1px solid #F0F0F0">${c||'—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:#6A6D70;margin-top:6px">${body.length} ligne(s) détectée(s)</div>`;
}

// Add a copy button before a table's parent section heading
function addCopyBtn(tableId, skipLastCols = 1) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost btn-sm';
  btn.innerHTML = '📋 Copier Excel';
  btn.style.cssText = 'font-size:11px;padding:4px 10px';
  btn.onclick = () => copyTableToExcel(tableId, { skipLastCols, btnEl: btn });

  // Insert before the table's closest section head, or just above
  const sHead = table.closest('.section')?.querySelector('.s-head');
  if (sHead) {
    sHead.appendChild(btn);
  } else {
    table.parentNode.insertBefore(btn, table);
  }
}
