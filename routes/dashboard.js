const router = require('express').Router();
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const { pctDelta, fillDailySeries, estMargin } = require('../lib/analytics');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', requireAuth, wrap(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: [openShift] } = await pool.query("SELECT * FROM shifts WHERE status='open'");

  const { rows: [tr] } = await pool.query(`
    SELECT COALESCE(SUM(total_fuel_revenue),0) as fuel,
           COALESCE(SUM(total_product_sales),0) as products,
           COALESCE(SUM(total_credit_deducted),0) as credits,
           COALESCE(SUM(net_cash),0) as net,
           COALESCE(SUM(total_liters_sold),0) as liters
    FROM shifts WHERE date(opened_at)=$1 AND status='closed'
  `, [today]);

  const { rows: [{ t: debt }] }    = await pool.query('SELECT COALESCE(SUM(balance_due),0) as t FROM credit_clients WHERE is_active=1');
  const { rows: [{ c: low }] }     = await pool.query('SELECT COUNT(*) as c FROM products WHERE stock_qty<=stock_min AND is_active=1');
  const { rows: [{ c: clients }] } = await pool.query('SELECT COUNT(*) as c FROM credit_clients WHERE is_active=1');

  res.json({
    open_shift:    openShift || null,
    today: {
      fuel_revenue:    parseFloat(tr.fuel),
      product_revenue: parseFloat(tr.products),
      credit_deducted: parseFloat(tr.credits),
      net_cash:        parseFloat(tr.net),
      liters_sold:     parseFloat(tr.liters),
    },
    total_debt:    parseFloat(debt),
    low_stock:     parseInt(low),
    total_clients: parseInt(clients),
  });
}));

router.get('/weekly', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT date(opened_at) as day,
      COALESCE(SUM(total_fuel_revenue),0) as fuel,
      COALESCE(SUM(total_product_sales),0) as products,
      COALESCE(SUM(net_cash),0) as net
    FROM shifts
    WHERE date(opened_at) >= date('now', '-6 days') AND status='closed'
    GROUP BY day ORDER BY day
  `);
  res.json(rows);
}));

router.get('/fuel-split', requireAuth, wrap(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT ft.name, ft.color_hex,
      COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as liters
    FROM fuel_types ft
    JOIN pumps p          ON p.fuel_type_id=ft.id
    JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
    JOIN pump_readings pr_end   ON pr_end.pump_id=p.id   AND pr_end.reading_type='end'
                                AND pr_end.shift_id=pr_start.shift_id
    JOIN shifts s ON s.id=pr_start.shift_id
    WHERE date(s.opened_at)=$1 AND s.status='closed'
    GROUP BY ft.id, ft.name, ft.color_hex
  `, [today]);
  res.json(rows);
}));

// All-in-one home page summary — single DB round-trip bundle
router.get('/summary', requireAuth, wrap(async (_req, res) => {
  const [shifts, bank, cuves, credits, logs, weeklyRaw] = await Promise.all([
    pool.query('SELECT total_fuel_revenue, opened_at FROM shifts ORDER BY opened_at DESC LIMIT 1'),
    pool.query(`
      SELECT
        (SELECT COALESCE(initial_balance,0) FROM bank_settings WHERE id=1) +
        COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in')  THEN amount ELSE -amount END),0)
        AS total
      FROM bank_transactions
    `),
    pool.query('SELECT COALESCE(SUM(niveau_litres),0) as vol, COALESCE(SUM(capacite_max),0) as cap FROM (SELECT DISTINCT ON (cuve_id) cuve_id, niveau_litres FROM cuve_lectures ORDER BY cuve_id, lecture_date DESC) latest JOIN cuves c ON c.id=latest.cuve_id WHERE c.is_active=1'),
    pool.query("SELECT COALESCE(SUM(balance_due),0) as total, COUNT(*) as clients FROM credit_clients WHERE is_active=1 AND balance_due > 0"),
    pool.query('SELECT COUNT(*) as total FROM activity_logs'),
    pool.query(`
      SELECT (opened_at::date)::text as day,
             COALESCE(SUM(COALESCE(total_fuel_revenue,0)),0) as revenue
      FROM shifts
      WHERE opened_at >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY day ORDER BY day
    `),
  ]);

  const lastShift = shifts.rows[0];
  const lastShiftRevenue = lastShift ? (parseFloat(lastShift.total_fuel_revenue)||0) : 0;

  // Build 7-day array with zeros for missing days
  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    const found = weeklyRaw.rows.find(r => r.day === key);
    weekly.push({ day: key, revenue: found ? parseFloat(found.revenue) : 0 });
  }

  res.json({
    last_shift_revenue:  lastShiftRevenue,
    bank_balance:        parseFloat(bank.rows[0]?.total || 0),
    cuves_volume:        parseFloat(cuves.rows[0]?.vol  || 0),
    cuves_capacity:      parseFloat(cuves.rows[0]?.cap  || 0),
    credits_outstanding: parseFloat(credits.rows[0]?.total   || 0),
    credits_clients:     parseInt(credits.rows[0]?.clients   || 0),
    logs_total:          parseInt(logs.rows[0]?.total        || 0),
    weekly_revenue:      weekly,
  });
}));

// Advanced analytics — period comparisons, 30-day trend, top credit clients.
// Shared by the JSON route (GET /analytics) and the PDF/CSV exports. Numbers come
// straight from shifts; fuel margin uses a blended purchase cost
// (fuel_deliveries + cuve_livraisons) and degrades to null when no cost is known.
async function computeAnalytics() {
  const [agg, cost, trend, topClients] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_today,
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE - INTERVAL '1 day'
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_yesterday,
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_today,
        COALESCE(SUM(CASE WHEN opened_at::date = CURRENT_DATE - INTERVAL '1 day'
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_yesterday,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE)
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_mtd,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                       AND opened_at::date <= (CURRENT_DATE - INTERVAL '1 month')::date
              THEN COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0) ELSE 0 END),0) AS rev_last_month,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE)
              THEN COALESCE(total_fuel_revenue,0) ELSE 0 END),0) AS fuel_rev_mtd,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE)
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_mtd,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                       AND opened_at::date <= (CURRENT_DATE - INTERVAL '1 month')::date
              THEN COALESCE(total_fuel_revenue,0) ELSE 0 END),0) AS fuel_rev_last_month,
        COALESCE(SUM(CASE WHEN opened_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                       AND opened_at::date <= (CURRENT_DATE - INTERVAL '1 month')::date
              THEN COALESCE(total_liters_sold,0) ELSE 0 END),0) AS liters_last_month
      FROM shifts
    `),
    pool.query(`
      SELECT CASE WHEN SUM(qty) > 0 THEN SUM(cost*qty)/SUM(qty) ELSE NULL END AS avg_cost
      FROM (
        SELECT cost_per_liter AS cost, quantity_liters AS qty
          FROM fuel_deliveries WHERE cost_per_liter IS NOT NULL AND quantity_liters > 0
        UNION ALL
        SELECT prix_unitaire AS cost, litres_recus AS qty
          FROM cuve_livraisons WHERE prix_unitaire IS NOT NULL AND litres_recus > 0
      ) x
    `),
    pool.query(`
      SELECT opened_at::date AS day,
             COALESCE(SUM(COALESCE(total_fuel_revenue,0)+COALESCE(total_product_sales,0)),0) AS revenue
      FROM shifts
      WHERE opened_at >= CURRENT_DATE - INTERVAL '29 days'
      GROUP BY day ORDER BY day
    `),
    pool.query(`
      SELECT name, COALESCE(company,'') AS company,
             COALESCE(balance_due,0) AS balance, credit_limit
      FROM credit_clients
      WHERE is_active=1 AND balance_due > 0
      ORDER BY balance_due DESC
      LIMIT 5
    `),
  ]);

  const a = agg.rows[0] || {};
  const num = v => parseFloat(v) || 0;
  const avgCost = (cost.rows[0] && cost.rows[0].avg_cost != null) ? parseFloat(cost.rows[0].avg_cost) : null;

  const revToday = num(a.rev_today), revYest = num(a.rev_yesterday);
  const revMtd   = num(a.rev_mtd),   revLast = num(a.rev_last_month);
  const litToday = num(a.liters_today), litYest = num(a.liters_yesterday);
  const litMtd   = num(a.liters_mtd),   litLast = num(a.liters_last_month);

  const marginMtd  = estMargin(num(a.fuel_rev_mtd),        litMtd,  avgCost);
  const marginLast = estMargin(num(a.fuel_rev_last_month), litLast, avgCost);

  return {
    revenue: {
      today: revToday, yesterday: revYest, delta_pct: pctDelta(revToday, revYest),
      mtd: revMtd, last_month_same: revLast, mtd_delta_pct: pctDelta(revMtd, revLast),
    },
    liters: {
      today: litToday, yesterday: litYest, delta_pct: pctDelta(litToday, litYest),
      mtd: litMtd, last_month_same: litLast, mtd_delta_pct: pctDelta(litMtd, litLast),
    },
    margin: {
      mtd: marginMtd, last_month: marginLast,
      delta_pct: (marginMtd != null && marginLast != null) ? pctDelta(marginMtd, marginLast) : null,
      avg_cost_per_liter: avgCost,
    },
    trend_30d: fillDailySeries(trend.rows, 30),
    top_credit_clients: topClients.rows.map(r => ({
      name: r.name,
      company: r.company || '',
      balance: num(r.balance),
      credit_limit: r.credit_limit != null ? num(r.credit_limit) : null,
    })),
  };
}

router.get('/analytics', requireAuth, wrap(async (_req, res) => {
  res.json(await computeAnalytics());
}));

// CSV export — French-Excel dialect: UTF-8 BOM, semicolon delimiter, CRLF rows.
router.get('/analytics/export.csv', requireAuth, wrap(async (_req, res) => {
  const d = await computeAnalytics();
  const today = new Date().toISOString().slice(0, 10);

  const nf = n => (n == null ? '' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pf = p => (p == null ? '' : (p > 0 ? '+' : '') + Number(p).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %');
  const esc = v => {
    const s = String(v == null ? '' : v);
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [];
  const push = (...cells) => rows.push(cells.map(esc).join(';'));

  push('MENASTA — Analyse avancée', today);
  push('');
  push('Indicateur', 'Valeur', 'Référence', 'Variation');
  push("Revenu du jour", nf(d.revenue.today), nf(d.revenue.yesterday) + ' (hier)', pf(d.revenue.delta_pct));
  push('Revenu du mois', nf(d.revenue.mtd), nf(d.revenue.last_month_same) + ' (mois préc.)', pf(d.revenue.mtd_delta_pct));
  push("Litres du jour", nf(d.liters.today), nf(d.liters.yesterday) + ' (hier)', pf(d.liters.delta_pct));
  push('Litres du mois', nf(d.liters.mtd), nf(d.liters.last_month_same) + ' (mois préc.)', pf(d.liters.mtd_delta_pct));
  push('Marge carburant (mois)', nf(d.margin.mtd), nf(d.margin.last_month) + ' (mois préc.)', pf(d.margin.delta_pct));
  push('Coût moyen / litre', nf(d.margin.avg_cost_per_liter));
  push('');
  push('Top clients crédit');
  push('Client', 'Société', 'Solde dû', 'Plafond');
  d.top_credit_clients.forEach(c => push(c.name, c.company, nf(c.balance), nf(c.credit_limit)));
  push('');
  push('Tendance 30 jours');
  push('Jour', 'Revenu');
  d.trend_30d.forEach(p => push(p.day, nf(p.revenue)));

  const csv = '﻿' + rows.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="MENASTA_Analyse_${today}.csv"`);
  res.send(csv);
}));

// PDF export — same house style as the AI reports (routes/ai.js).
router.get('/analytics/export.pdf', requireAuth, wrap(async (_req, res) => {
  const d = await computeAnalytics();
  pdfAnalytics(res, d);
}));

function pdfAnalytics(res, d) {
  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct = p => (p == null ? '—' : (p > 0 ? '+' : '') + Number(p).toLocaleString('fr-FR',{maximumFractionDigits:1}) + ' %');
  const today = new Date().toISOString().slice(0,10);

  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="MENASTA_Analyse_${today}.pdf"`);
  doc.pipe(res);

  // Header bar
  doc.rect(0,0,595,75).fill('#0F172A');
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF').text('⛽  MENASTA', 50,18);
  doc.fontSize(10).font('Helvetica').fillColor('#94A3B8').text('Station Service — Analyse Avancée', 50,44);
  doc.fontSize(10).fillColor('#CBD5E1').text(today, 460,44);

  let y = 95;
  const col = (label,val,yy,x1=55,x2=350,highlight=false) => {
    doc.fontSize(10).font('Helvetica').fillColor('#64748B').text(label,x1,yy);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(highlight?'#2563EB':'#0F172A').text(val,x2,yy,{align:'right',width:190});
  };
  const secTitle = (title,color='#2563EB') => {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(color).text(title,55,y);
    doc.moveTo(55,y+13).lineTo(540,y+13).lineWidth(0.4).strokeColor('#E2E8F0').stroke();
    y+=20;
  };

  // KPI row
  const marginTxt = d.margin.mtd != null ? fmt(d.margin.mtd)+' MAD' : '—';
  const kpis = [
    {l:'Revenu du jour',          v:fmt(d.revenue.today)+' MAD', c:'#2563EB', bg:'#EFF6FF'},
    {l:'Revenu du mois',          v:fmt(d.revenue.mtd)+' MAD',   c:'#0D9488', bg:'#F0FDFA'},
    {l:'Marge carburant (mois)',  v:marginTxt,                   c:'#059669', bg:'#ECFDF5'},
    {l:'Litres du mois',          v:fmt(d.liters.mtd)+' L',      c:'#7C3AED', bg:'#F5F3FF'},
  ];
  kpis.forEach((k,i) => {
    const bx=55+(i%2)*248, by=y+Math.floor(i/2)*52;
    doc.roundedRect(bx,by,235,44,5).fill(k.bg);
    doc.fontSize(8).font('Helvetica').fillColor(k.c).text(k.l.toUpperCase(),bx+10,by+7);
    doc.fontSize(14).font('Helvetica-Bold').fillColor(k.c).text(k.v,bx+10,by+21);
  });
  y += 120;

  secTitle('REVENU');
  col("Aujourd'hui",fmt(d.revenue.today)+' MAD',y,55,350,true); y+=16;
  col('Hier',fmt(d.revenue.yesterday)+' MAD',y); y+=16;
  col('Variation vs hier',pct(d.revenue.delta_pct),y); y+=16;
  col('Mois en cours',fmt(d.revenue.mtd)+' MAD',y,55,350,true); y+=16;
  col('Même période mois préc.',fmt(d.revenue.last_month_same)+' MAD',y); y+=16;
  col('Variation vs mois préc.',pct(d.revenue.mtd_delta_pct),y); y+=22;

  secTitle('LITRES VENDUS');
  col("Aujourd'hui",fmt(d.liters.today)+' L',y,55,350,true); y+=16;
  col('Hier',fmt(d.liters.yesterday)+' L',y); y+=16;
  col('Variation vs hier',pct(d.liters.delta_pct),y); y+=16;
  col('Mois en cours',fmt(d.liters.mtd)+' L',y,55,350,true); y+=16;
  col('Variation vs mois préc.',pct(d.liters.mtd_delta_pct),y); y+=22;

  secTitle('MARGE CARBURANT (ESTIMÉE)');
  if (d.margin.mtd != null) {
    col('Marge mois en cours',fmt(d.margin.mtd)+' MAD',y,55,350,true); y+=16;
    col('Marge mois préc.',d.margin.last_month != null ? fmt(d.margin.last_month)+' MAD' : '—',y); y+=16;
    col('Variation',pct(d.margin.delta_pct),y); y+=16;
    col('Coût moyen / litre',d.margin.avg_cost_per_liter != null ? fmt(d.margin.avg_cost_per_liter)+' MAD' : '—',y); y+=22;
  } else {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#94A3B8')
      .text("Aucun coût d'achat connu — marge indisponible.",55,y); y+=22;
  }

  if (d.top_credit_clients.length > 0) {
    secTitle('TOP CLIENTS CRÉDIT','#DC2626');
    d.top_credit_clients.forEach(c => {
      const label = c.company ? `${c.name} (${c.company})` : c.name;
      col(label,fmt(c.balance)+' MAD',y); y+=16;
    });
  }

  doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
    .text(`Généré le ${new Date().toLocaleString('fr-FR')} · MENASTA AI`,50,780,{align:'center',width:495});
  doc.end();
}

module.exports = router;
