const { pool } = require('../db');
const { sendWhatsApp } = require('./whatsapp');

// Run anomaly checks every hour
function startAnomalyDetection() {
  const interval = parseInt(process.env.ANOMALY_INTERVAL_MS) || 60 * 60 * 1000;
  setInterval(runAllChecks, interval);
  // Also run once 30 seconds after startup
  setTimeout(runAllChecks, 30000);
  console.log('[Anomaly] Detection engine started');
}

async function runAllChecks() {
  const alerts = [];
  try {
    const [revenueAlerts, debtAlerts, tankAlerts, creditAlerts] = await Promise.all([
      checkRevenueAnomaly(),
      checkHighDebtClients(),
      checkTankLevels(),
      checkCreditSpike(),
    ]);
    alerts.push(...revenueAlerts, ...debtAlerts, ...tankAlerts, ...creditAlerts);
  } catch (e) {
    console.error('[Anomaly] Check failed:', e.message);
    return;
  }

  if (!alerts.length) return;

  const phone = process.env.OWNER_PHONE;
  if (!phone) return;

  const msg = `🚨 *MENASTA — Alertes Détectées*\n\n`
    + alerts.map((a, i) => `${i + 1}. ${a}`).join('\n\n')
    + `\n\n_${new Date().toLocaleString('fr-MA')} · Détection automatique_`;

  try {
    await sendWhatsApp(phone, msg);
    console.log(`[Anomaly] ${alerts.length} alerte(s) envoyée(s) via WhatsApp`);
  } catch (e) {
    console.error('[Anomaly] WhatsApp send failed:', e.message);
  }
}

// Check 1: Today's revenue is >30% below 7-day average
async function checkRevenueAnomaly() {
  const alerts = [];
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(AVG(net_cash),0) as avg_7d,
        COALESCE(
          (SELECT SUM(net_cash) FROM shifts WHERE status='closed' AND DATE(closed_at)=CURRENT_DATE),
          0
        ) as today
      FROM shifts
      WHERE status='closed'
        AND DATE(closed_at) >= CURRENT_DATE - INTERVAL '7 days'
        AND DATE(closed_at) < CURRENT_DATE
    `);
    const { avg_7d, today } = rows[0];
    const avg = parseFloat(avg_7d);
    const tod = parseFloat(today);
    if (avg > 500 && tod < avg * 0.7) {
      const drop = Math.round((1 - tod / avg) * 100);
      alerts.push(`⛽ *Baisse de CA carburant*\nAujourd'hui: ${tod.toFixed(0)} MAD vs moyenne 7j: ${avg.toFixed(0)} MAD (-${drop}%)`);
    }
  } catch (e) { console.error('[Anomaly] Revenue check:', e.message); }
  return alerts;
}

// Check 2: Credit clients with debt > 10,000 MAD and no payment in 30 days
async function checkHighDebtClients() {
  const alerts = [];
  try {
    const { rows } = await pool.query(`
      SELECT cc.name, cc.balance_due,
        MAX(cp.payment_time) as last_payment
      FROM credit_clients cc
      LEFT JOIN credit_payments cp ON cp.credit_client_id = cc.id
      WHERE cc.is_active = 1 AND cc.balance_due > 10000
      GROUP BY cc.id, cc.name, cc.balance_due
      HAVING MAX(cp.payment_time) < NOW() - INTERVAL '30 days'
         OR MAX(cp.payment_time) IS NULL
      ORDER BY cc.balance_due DESC
      LIMIT 5
    `);
    for (const r of rows) {
      const days = r.last_payment
        ? Math.floor((Date.now() - new Date(r.last_payment)) / 86400000)
        : '30+';
      alerts.push(`🤝 *Créance élevée sans paiement*\n${r.name}: ${parseFloat(r.balance_due).toFixed(0)} MAD — dernier paiement il y a ${days} jours`);
    }
  } catch (e) { console.error('[Anomaly] Debt check:', e.message); }
  return alerts;
}

// Check 3: Tank levels below alert threshold
async function checkTankLevels() {
  const alerts = [];
  try {
    const { rows } = await pool.query(`
      SELECT c.name, c.niveau_alerte, cl.niveau_litres,
        ft.name as fuel_name
      FROM cuves c
      JOIN fuel_types ft ON ft.id = c.fuel_type_id
      LEFT JOIN cuve_lectures cl ON cl.cuve_id = c.id
        AND cl.lecture_date = (
          SELECT MAX(lecture_date) FROM cuve_lectures WHERE cuve_id = c.id
        )
      WHERE c.is_active = 1
        AND cl.niveau_litres IS NOT NULL
        AND cl.niveau_litres <= c.niveau_alerte
    `);
    for (const r of rows) {
      alerts.push(`🛢️ *Niveau cuve critique*\n${r.name} (${r.fuel_name}): ${r.niveau_litres}L restants (seuil: ${r.niveau_alerte}L)`);
    }
  } catch (e) { console.error('[Anomaly] Tank check:', e.message); }
  return alerts;
}

// Check 4: Today's credit sales are 2x above daily average (possible fraud)
async function checkCreditSpike() {
  const alerts = [];
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(AVG(daily_total), 0) as avg_30d,
        COALESCE(
          (SELECT SUM(amount) FROM credit_sales WHERE DATE(sale_time) = CURRENT_DATE),
          0
        ) as today
      FROM (
        SELECT DATE(sale_time) as d, SUM(amount) as daily_total
        FROM credit_sales
        WHERE sale_time >= NOW() - INTERVAL '30 days'
          AND DATE(sale_time) < CURRENT_DATE
        GROUP BY DATE(sale_time)
      ) sub
    `);
    const avg = parseFloat(rows[0].avg_30d);
    const tod = parseFloat(rows[0].today);
    if (avg > 200 && tod > avg * 2) {
      alerts.push(`⚠️ *Pic de ventes crédit anormal*\nAujourd'hui: ${tod.toFixed(0)} MAD vs moyenne 30j: ${avg.toFixed(0)} MAD (x${(tod/avg).toFixed(1)})`);
    }
  } catch (e) { console.error('[Anomaly] Credit spike check:', e.message); }
  return alerts;
}

// Expose manual trigger for testing via API
async function runChecksNow() {
  const alerts = [];
  const [a, b, c, d] = await Promise.all([
    checkRevenueAnomaly(),
    checkHighDebtClients(),
    checkTankLevels(),
    checkCreditSpike(),
  ]);
  alerts.push(...a, ...b, ...c, ...d);
  return alerts;
}

module.exports = { startAnomalyDetection, runChecksNow };
