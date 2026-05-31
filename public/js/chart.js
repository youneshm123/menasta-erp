/* MENASTA — lightweight, dependency-free SVG charts for the AI assistant.
 *
 * Pure function: buildChartSvg(spec) -> SVG markup string.
 * No DOM, no browser APIs, no external libraries. It runs unchanged in the
 * browser (attaches buildChartSvg to window) AND under Node via module.exports,
 * so the geometry can be unit-tested with `node --test` without a browser.
 *
 * Spec shape (what the AI emits inside a ```chart fenced block):
 *   { "type": "bar" | "line" | "hbar",
 *     "title": "Short title",
 *     "unit":  "MAD",
 *     "series": [ { "label": "Lun", "value": 12500 }, ... ] }   // max 12 points
 */
(function (root) {
  'use strict';

  // ── helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Coerce a value to a finite number (tolerates numeric strings).
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  // Round to 2 decimals (keeps SVG coordinates short & deterministic).
  function r2(n) { return Math.round(n * 100) / 100; }

  function trunc(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
  }

  // Compact label for axes / values: 1234 -> "1.2k", 2500000 -> "2.5M".
  function fmtShort(n) {
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n * 100) / 100);
  }

  // Round a positive max up to a "nice" axis ceiling (1/2/5 * 10^n).
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / pow;
    var nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nice * pow;
  }

  function normalize(spec) {
    var s = (spec && typeof spec === 'object') ? spec : {};
    var type = String(s.type || 'bar').toLowerCase();
    if (type !== 'line' && type !== 'hbar') type = 'bar';
    var series = Array.isArray(s.series) ? s.series : [];
    var points = series.slice(0, 12).map(function (p) {
      return {
        label: String(p && p.label != null ? p.label : ''),
        value: num(p && p.value),
      };
    });
    return {
      type: type,
      title: s.title != null ? String(s.title) : '',
      unit: s.unit != null ? String(s.unit) : '',
      points: points,
    };
  }

  // Scoped <style> — every selector is prefixed with .menasta-chart so the
  // rules can never leak onto the surrounding document when injected inline.
  var STYLE =
    '<style>' +
    '.menasta-chart{font-family:inherit;overflow:visible}' +
    '.menasta-chart .ct-title{font-size:13px;font-weight:700;fill:#2563EB}' +
    '.menasta-chart .cbar{fill:#2563EB}' +
    '.menasta-chart .cbar.alt{fill:#7C3AED}' +
    '.menasta-chart .cgrid{stroke:#E2E8F0;stroke-width:1}' +
    '.menasta-chart .cbase{stroke:#CBD5E1;stroke-width:1}' +
    '.menasta-chart .cline{stroke:#2563EB;stroke-width:2.5;fill:none}' +
    '.menasta-chart .carea{fill:#2563EB;opacity:.10}' +
    '.menasta-chart .cdot{fill:#2563EB}' +
    '.menasta-chart .ct-xlab,.menasta-chart .ct-ylab{font-size:10px;fill:#64748B}' +
    '.menasta-chart .ct-val{font-size:9.5px;fill:#475569;font-weight:600}' +
    '.menasta-chart .ct-empty{font-size:12px;fill:#94A3B8}' +
    '</style>';

  function svgWrap(W, H, body) {
    return '<svg class="menasta-chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" ' +
      'preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg">' +
      STYLE + body + '</svg>';
  }

  function titleSvg(d, x) {
    if (!d.title) return '';
    return '<text x="' + x + '" y="18" class="ct-title">' +
      esc(d.title) + (d.unit ? ' (' + esc(d.unit) + ')' : '') + '</text>';
  }

  // ── main ─────────────────────────────────────────────────────────────────
  function buildChartSvg(spec) {
    var d = normalize(spec);
    var W = 480, H = 248;

    if (d.points.length === 0) {
      var body0 = titleSvg(d, 44) +
        '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" class="ct-empty">Aucune donnée</text>';
      return svgWrap(W, H, body0);
    }

    if (d.type === 'hbar') return hbar(d, W, H);
    return vchart(d, W, H); // bar + line share the same axis frame
  }

  // Vertical bar / line chart.
  function vchart(d, W, H) {
    var padL = 44, padR = 14, padT = d.title ? 30 : 14, padB = 40;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var n = d.points.length;
    var maxV = Math.max.apply(null, [0].concat(d.points.map(function (p) { return p.value; })));
    var top = niceMax(maxV);

    var body = titleSvg(d, padL);

    // gridlines + y labels at 0 / 50% / 100%
    [0, 0.5, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      body += '<line class="' + (f === 0 ? 'cbase' : 'cgrid') + '" x1="' + padL + '" y1="' + r2(y) +
        '" x2="' + (padL + plotW) + '" y2="' + r2(y) + '"/>';
      body += '<text class="ct-ylab" x="' + (padL - 6) + '" y="' + r2(y + 3) +
        '" text-anchor="end">' + esc(fmtShort(f * top)) + '</text>';
    });

    if (d.type === 'line') {
      var step = n > 1 ? plotW / (n - 1) : 0;
      var pts = d.points.map(function (p, i) {
        var x = padL + (n > 1 ? i * step : plotW / 2);
        var y = padT + plotH - (top ? Math.max(0, p.value) / top * plotH : 0);
        return [r2(x), r2(y)];
      });
      var coords = pts.map(function (pt) { return pt[0] + ',' + pt[1]; }).join(' ');
      // area under the line
      var area = padL + ',' + r2(padT + plotH) + ' ' + coords + ' ' +
        r2(pts[pts.length - 1][0]) + ',' + r2(padT + plotH);
      body += '<polygon class="carea" points="' + area + '"/>';
      body += '<polyline class="cline" points="' + coords + '"/>';
      pts.forEach(function (pt, i) {
        body += '<circle class="cdot" cx="' + pt[0] + '" cy="' + pt[1] + '" r="3"/>';
        body += '<text class="ct-xlab" x="' + pt[0] + '" y="' + (padT + plotH + 14) +
          '" text-anchor="middle">' + esc(trunc(d.points[i].label, 8)) + '</text>';
      });
      return svgWrap(W, H, body);
    }

    // bars
    var bstep = plotW / n;
    var barW = Math.min(46, bstep * 0.6);
    d.points.forEach(function (p, i) {
      var h = top ? Math.max(0, p.value) / top * plotH : 0;
      var x = padL + i * bstep + (bstep - barW) / 2;
      var y = padT + plotH - h;
      body += '<rect class="cbar" x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(barW) +
        '" height="' + r2(h) + '" rx="3"/>';
      body += '<text class="ct-val" x="' + r2(x + barW / 2) + '" y="' + r2(y - 4) +
        '" text-anchor="middle">' + esc(fmtShort(p.value)) + '</text>';
      body += '<text class="ct-xlab" x="' + r2(x + barW / 2) + '" y="' + (padT + plotH + 14) +
        '" text-anchor="middle">' + esc(trunc(p.label, 8)) + '</text>';
    });
    return svgWrap(W, H, body);
  }

  // Horizontal bar chart (rankings / top lists).
  function hbar(d, W, H) {
    var padL = 96, padR = 40, padT = d.title ? 30 : 14, padB = 14;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var n = d.points.length;
    var maxV = Math.max.apply(null, [0].concat(d.points.map(function (p) { return p.value; })));
    var rowH = plotH / n;
    var barH = Math.min(22, rowH * 0.62);

    var body = titleSvg(d, 12);
    body += '<line class="cbase" x1="' + padL + '" y1="' + padT + '" x2="' + padL +
      '" y2="' + (padT + plotH) + '"/>';

    d.points.forEach(function (p, i) {
      var w = maxV > 0 ? Math.max(0, p.value) / maxV * plotW : 0;
      var y = padT + i * rowH + (rowH - barH) / 2;
      body += '<rect class="cbar" x="' + padL + '" y="' + r2(y) + '" width="' + r2(w) +
        '" height="' + r2(barH) + '" rx="3"/>';
      body += '<text class="ct-ylab" x="' + (padL - 8) + '" y="' + r2(y + barH / 2) +
        '" text-anchor="end" dominant-baseline="middle">' + esc(trunc(p.label, 16)) + '</text>';
      body += '<text class="ct-val" x="' + r2(padL + w + 5) + '" y="' + r2(y + barH / 2) +
        '" dominant-baseline="middle">' + esc(fmtShort(p.value)) + '</text>';
    });
    return svgWrap(W, H, body);
  }

  // ── export (dual environment) ──────────────────────────────────────────────
  var api = {
    buildChartSvg: buildChartSvg,
    niceMax: niceMax,
    fmtShort: fmtShort,
    normalize: normalize,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.buildChartSvg = buildChartSvg;
  }
})(typeof self !== 'undefined' ? self : this);
