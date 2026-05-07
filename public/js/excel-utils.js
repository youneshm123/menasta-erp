// ── Styled Excel export via ExcelJS ───────────────────────────
// Requires: <script src="https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"></script>

async function exportTableToExcel(tableId, filename, opts) {
  opts = opts || {};
  const table = typeof tableId === 'string' ? document.getElementById(tableId) : tableId;
  if (!table) return;
  const skip = opts.skipLastCols || 0;

  // ── Extract data ───────────────────────────────────────────
  const ths = [...table.querySelectorAll('thead th')].slice(0, -skip || undefined);
  const headers = ths.map(th => th.innerText.trim());

  const bodyRows = [];
  table.querySelectorAll('tbody tr').forEach(tr => {
    const tds = [...tr.querySelectorAll('td')];
    if (!tds.length) return;
    const cells = (skip ? tds.slice(0, -skip) : tds).map(td => {
      const t = (td.innerText || '').trim().replace(/\s+/g, ' ');
      const n = parseFloat(t.replace(/ /g, '').replace(/\s/g, '').replace(',', '.'));
      return isNaN(n) ? t : n;
    });
    bodyRows.push(cells);
  });

  const footRows = [];
  table.querySelectorAll('tfoot tr').forEach(tr => {
    const tds = [...tr.querySelectorAll('td')];
    if (!tds.length) return;
    const cells = (skip ? tds.slice(0, -skip) : tds).map(td => {
      const t = (td.innerText || '').trim().replace(/\s+/g, ' ');
      const n = parseFloat(t.replace(/ /g, '').replace(/\s/g, '').replace(',', '.'));
      return isNaN(n) ? t : n;
    });
    footRows.push(cells);
  });

  // ── Build workbook ─────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'YEX WEB';
  wb.created = new Date();

  const ws = wb.addWorksheet('Données', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
  });

  // ── Header row ─────────────────────────────────────────────
  if (headers.length) {
    const hr = ws.addRow(headers);
    hr.height = 30;
    hr.eachCell(cell => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D2D3E' } };
      cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = borders('FF0070F2');
    });
  }

  // ── Body rows ──────────────────────────────────────────────
  bodyRows.forEach((row, i) => {
    const er = ws.addRow(row);
    er.height = 20;
    const bg = i % 2 === 0 ? 'FFFFFFFF' : 'FFF5F7FA';
    er.eachCell({ includeEmpty: true }, (cell, ci) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.font = { size: 10, name: 'Calibri' };
      cell.border = borders('FFE5E5EA', 'hair');
      if (typeof cell.value === 'number') {
        cell.numFmt = '#,##0.00 MAD';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.alignment = { vertical: 'middle' };
      }
    });
  });

  // ── Footer rows ────────────────────────────────────────────
  footRows.forEach(row => {
    const er = ws.addRow(row);
    er.height = 24;
    er.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
      cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FF1D2D3E' } };
      cell.border = borders('FF1D2D3E', 'medium');
      if (typeof cell.value === 'number') {
        cell.numFmt = '#,##0.00 MAD';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.alignment = { vertical: 'middle' };
      }
    });
  });

  // ── Auto column widths ─────────────────────────────────────
  ws.columns.forEach((col, i) => {
    let max = headers[i] ? headers[i].length : 8;
    bodyRows.forEach(r => { const v = r[i] != null ? String(r[i]) : ''; if (v.length > max) max = v.length; });
    footRows.forEach(r => { const v = r[i] != null ? String(r[i]) : ''; if (v.length > max) max = v.length; });
    col.width = Math.min(Math.max(max + 4, 12), 45);
  });

  // ── Download ───────────────────────────────────────────────
  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = (filename || 'export') + '.xlsx'; a.click();
  URL.revokeObjectURL(url);
  if (opts.btnEl) showExportFeedback(opts.btnEl);
}

function borders(color, style) {
  style = style || 'thin';
  const s = { style, color: { argb: color } };
  return { top: s, bottom: s, left: s, right: s };
}

function showExportFeedback(btn) {
  const orig = btn.innerHTML;
  btn.innerHTML = '✅ Téléchargé !';
  btn.style.background = '#D1FAE5'; btn.style.color = '#065F46';
  setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; btn.style.color = ''; }, 2000);
}

// Auto-wire export buttons to all section tables
function attachExportBtns() {
  document.querySelectorAll('.section:not([data-excel-wired])').forEach(sec => {
    const tbl = sec.querySelector('table');
    const sh  = sec.querySelector('.s-head');
    if (!tbl || !sh) return;
    sec.setAttribute('data-excel-wired', '1');
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.style.cssText = 'font-size:11px;margin-left:8px';
    btn.innerHTML = '📊 Excel';
    const title = (sh.querySelector('h2,h3') || sh).innerText.trim().slice(0, 30) || 'export';
    btn.onclick = () => exportTableToExcel(tbl, title, { skipLastCols: 1, btnEl: btn });
    sh.appendChild(btn);
  });
}

// Parse TSV/CSV pasted from Excel (for import)
function parseExcelPaste(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  return lines.map(line => {
    const sep = line.includes('\t') ? '\t' : ';';
    return line.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
  });
}
