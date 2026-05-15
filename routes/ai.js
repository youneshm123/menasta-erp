const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getBusinessData() {
  const today = new Date().toISOString().slice(0, 10);
  const ym = today.slice(0, 7);

  const [
    { rows: [car] },
    { rows: [cafe] },
    { rows: [tabac] },
    { rows: [bs] },
    { rows: [{ bal }] },
    { rows: [factures] },
    { rows: [{ total_due, nb_clients }] },
    { rows: recentShifts },
    { rows: creditClients },
  ] = await Promise.all([
    pool.query(`
      SELECT COALESCE(SUM(total_fuel_revenue),0) as ca,
             COALESCE(SUM(total_liters_sold),0)  as liters,
             COALESCE(SUM(net_cash),0)            as net,
             COALESCE(SUM(avance),0)              as avance,
             COUNT(*) as postes
      FROM shifts WHERE date(opened_at)=$1 AND status='closed'
    `, [today]),
    pool.query(`SELECT COALESCE(SUM(total),0) as revenue FROM cafe_sales WHERE sale_date=$1`, [today]),
    pool.query(`SELECT COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE vente_date=$1`, [today]),
    pool.query('SELECT initial_balance FROM bank_settings WHERE id=1'),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_recu','cheque_recu') THEN amount ELSE -amount END),0) as bal FROM bank_transactions`),
    pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_ttc),0) as total FROM factures WHERE strftime('%Y-%m', facture_date)=$1`, [ym]),
    pool.query(`SELECT COALESCE(SUM(balance_due),0) as total_due, COUNT(*) as nb_clients FROM credit_clients WHERE is_active=1 AND balance_due > 0`),
    pool.query(`
      SELECT date(opened_at) as day,
             COALESCE(SUM(total_fuel_revenue),0) as carburant,
             COALESCE(SUM(total_liters_sold),0)  as liters,
             COALESCE(SUM(net_cash),0)           as net
      FROM shifts WHERE date(opened_at) >= date('now', '-6 days') AND status='closed'
      GROUP BY day ORDER BY day DESC
    `),
    pool.query(`SELECT name, balance_due FROM credit_clients WHERE is_active=1 AND balance_due > 0 ORDER BY balance_due DESC LIMIT 20`),
  ]);

  const bankBalance = parseFloat(bs?.initial_balance || 0) + parseFloat(bal || 0);
  return { today, ym, car, cafe, tabac, bankBalance, factures, total_due, nb_clients, recentShifts, creditClients };
}

async function getBusinessContext() {
  const { today, ym, car, cafe, tabac, bankBalance, factures, total_due, nb_clients, recentShifts, creditClients } = await getBusinessData();
  const fmt = n => parseFloat(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let ctx = `Tu es l'assistant IA de MENASTA, une station service au Maroc. Voici les données actuelles de la station en temps réel (date: ${today}) :

## AUJOURD'HUI (${today})
- Carburant CA: ${fmt(car.ca)} MAD | Litres vendus: ${fmt(car.liters)} L | Encaissé net: ${fmt(car.net)} MAD | Postes fermés: ${car.postes}
- Café CA: ${fmt(cafe.revenue)} MAD
- Tabac CA: ${fmt(tabac.montant)} MAD | Bénéfice tabac: ${fmt(tabac.benefice)} MAD
- CA Total jour: ${fmt(parseFloat(car.ca) + parseFloat(cafe.revenue) + parseFloat(tabac.montant))} MAD

## BANQUE
- Solde actuel: ${fmt(bankBalance)} MAD

## CRÉANCES CLIENTS
- Total dettes: ${fmt(total_due)} MAD sur ${nb_clients} clients`;

  if (creditClients.length > 0) {
    ctx += `\n- Top débiteurs: ${creditClients.map(c => `${c.name} (${fmt(c.balance_due)} MAD)`).join(', ')}`;
  }

  ctx += `

## FACTURES (mois ${ym})
- ${factures.count} facture(s) | Total TTC: ${fmt(factures.total)} MAD

## DERNIERS 7 JOURS (Carburant)
`;
  for (const r of recentShifts) {
    ctx += `- ${r.day}: CA ${fmt(r.carburant)} MAD | ${fmt(r.liters)} L | Net ${fmt(r.net)} MAD\n`;
  }

  ctx += `
Réponds toujours en français, de manière claire et concise. Tu peux faire des calculs, des comparaisons, des recommandations basées sur ces données.
Si l'utilisateur demande un PDF ou un rapport (mots clés: pdf, rapport, imprimer, télécharger, exporter), réponds UNIQUEMENT avec ce JSON exact (rien d'autre):
{"action":"pdf","type":"daily"}
Si on te demande des données non disponibles ici, dis-le honnêtement.`;

  return ctx;
}

// ── PDF Generation ──
function generateDailyPDF(res, data) {
  const { today, car, cafe, tabac, bankBalance, total_due, nb_clients, creditClients, recentShifts } = data;
  const fmt = n => parseFloat(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalCA = parseFloat(car.ca) + parseFloat(cafe.revenue) + parseFloat(tabac.montant);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="MENASTA_Rapport_${today}.pdf"`);
  doc.pipe(res);

  // Header
  doc.rect(0, 0, 595, 80).fill('#0F172A');
  doc.fontSize(22).font('Helvetica-Bold').fillColor('#FFFFFF').text('⛽ MENASTA', 50, 20);
  doc.fontSize(11).font('Helvetica').fillColor('#94A3B8').text('Station Service — Rapport Journalier', 50, 48);
  doc.fontSize(11).fillColor('#CBD5E1').text(today, 440, 34);

  doc.fillColor('#1E293B').rect(0, 80, 595, 4).fill();

  let y = 104;

  // Section helper
  const section = (title, color = '#2563EB') => {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(color).text(title.toUpperCase(), 50, y);
    doc.moveTo(50, y + 14).lineTo(545, y + 14).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
    y += 22;
  };

  const row = (label, value, highlight = false) => {
    doc.fontSize(10).font('Helvetica').fillColor('#64748B').text(label, 60, y);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(highlight ? '#2563EB' : '#1E293B').text(value, 350, y, { align: 'right', width: 195 });
    y += 18;
  };

  // KPI boxes
  const kpiBoxes = [
    { label: "CA Total Jour", value: fmt(totalCA) + " MAD", color: '#2563EB', bg: '#EFF6FF' },
    { label: "Litres Vendus", value: fmt(car.liters) + " L", color: '#059669', bg: '#ECFDF5' },
    { label: "Solde Banque", value: fmt(bankBalance) + " MAD", color: '#0D9488', bg: '#F0FDFA' },
    { label: "Créances", value: fmt(total_due) + " MAD", color: '#DC2626', bg: '#FEF2F2' },
  ];
  kpiBoxes.forEach((k, i) => {
    const x = 50 + (i % 2) * 248;
    const ky = y + Math.floor(i / 2) * 56;
    doc.roundedRect(x, ky, 235, 46, 6).fill(k.bg);
    doc.fontSize(9).font('Helvetica').fillColor(k.color).text(k.label.toUpperCase(), x + 12, ky + 8);
    doc.fontSize(15).font('Helvetica-Bold').fillColor(k.color).text(k.value, x + 12, ky + 22);
  });
  y += 130;

  // Carburant
  section('Carburant');
  row('Chiffre d\'Affaires', fmt(car.ca) + ' MAD', true);
  row('Litres Vendus', fmt(car.liters) + ' L');
  row('Encaissé Net', fmt(car.net) + ' MAD');
  row('Avance Patron', fmt(car.avance) + ' MAD');
  row('Postes Fermés', car.postes + ' poste(s)');
  y += 8;

  // Café & Tabac
  section('Café & Tabac');
  row('Café — CA Journalier', fmt(cafe.revenue) + ' MAD', true);
  row('Tabac — CA Journalier', fmt(tabac.montant) + ' MAD', true);
  row('Tabac — Bénéfice', fmt(tabac.benefice) + ' MAD');
  y += 8;

  // Banque & Créances
  section('Banque & Créances');
  row('Solde Bancaire', fmt(bankBalance) + ' MAD', true);
  row('Total Créances', fmt(total_due) + ' MAD');
  row('Nombre de Clients Débiteurs', nb_clients + ' client(s)');
  y += 8;

  // Top debtors
  if (creditClients.length > 0) {
    section('Top Clients Débiteurs', '#DC2626');
    creditClients.slice(0, 8).forEach(c => {
      row(c.name, fmt(c.balance_due) + ' MAD');
    });
    y += 8;
  }

  // Last 7 days
  if (recentShifts.length > 0 && y < 680) {
    section('Carburant — 7 Derniers Jours');
    recentShifts.forEach(r => {
      row(r.day, `CA: ${fmt(r.carburant)} MAD | ${fmt(r.liters)} L`);
    });
  }

  // Footer
  doc.fontSize(9).font('Helvetica').fillColor('#94A3B8')
    .text(`Généré le ${new Date().toLocaleString('fr-FR')} par MENASTA Assistant IA`, 50, 780, { align: 'center', width: 495 });

  doc.end();
}

// ── Routes ──
router.post('/chat', requireAuth, wrap(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message requis' });

  const systemPrompt = await getBusinessContext();
  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message.slice(0, 2000) }
  ];

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const text = response.content[0].text.trim();

  // Check if AI wants to generate a PDF
  try {
    const parsed = JSON.parse(text);
    if (parsed.action === 'pdf') {
      return res.json({ reply: null, pdf_action: 'daily' });
    }
  } catch (_) {}

  res.json({ reply: text });
}));

router.get('/pdf/daily', requireAuth, wrap(async (req, res) => {
  const data = await getBusinessData();
  generateDailyPDF(res, data);
}));

module.exports = router;
