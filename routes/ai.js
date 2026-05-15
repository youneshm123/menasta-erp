const router  = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Fetch all business data ──────────────────────────────────────────────────
async function getBusinessData() {
  const today = new Date().toISOString().slice(0, 10);
  const ym    = today.slice(0, 7);

  const [
    { rows: [car] },
    { rows: [cafe] },
    { rows: [tabac] },
    { rows: [bs] },
    { rows: [{ bal }] },
    { rows: [factures] },
    { rows: [{ total_due, nb_clients }] },
    { rows: creditClients },
    { rows: recentShifts7 },
    { rows: daily30 },
    { rows: dailyCafe30 },
    { rows: dailyTabac30 },
    { rows: tabacProducts },
    { rows: cafeMenu },
    { rows: stockProducts },
    { rows: recentBankTxns },
    { rows: pumps },
  ] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_fuel_revenue),0) as ca, COALESCE(SUM(total_liters_sold),0) as liters,
                       COALESCE(SUM(net_cash),0) as net, COALESCE(SUM(avance),0) as avance,
                       COALESCE(SUM(total_credit_deducted),0) as credits, COUNT(*) as postes
                FROM shifts WHERE date(opened_at)=$1 AND status='closed'`, [today]),
    pool.query(`SELECT COALESCE(SUM(total),0) as revenue FROM cafe_sales WHERE sale_date=$1`, [today]),
    pool.query(`SELECT COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE vente_date=$1`, [today]),
    pool.query('SELECT initial_balance FROM bank_settings WHERE id=1'),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_recu','cheque_recu') THEN amount ELSE -amount END),0) as bal FROM bank_transactions`),
    pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(total_ttc),0) as total FROM factures WHERE strftime('%Y-%m', facture_date)=$1`, [ym]),
    pool.query(`SELECT COALESCE(SUM(balance_due),0) as total_due, COUNT(*) as nb_clients FROM credit_clients WHERE is_active=1 AND balance_due > 0`),
    pool.query(`SELECT name, balance_due, phone FROM credit_clients WHERE is_active=1 AND balance_due > 0 ORDER BY balance_due DESC`),
    pool.query(`SELECT date(opened_at) as day, COALESCE(SUM(total_fuel_revenue),0) as carburant,
                       COALESCE(SUM(total_liters_sold),0) as liters, COALESCE(SUM(net_cash),0) as net,
                       COALESCE(SUM(avance),0) as avance, COUNT(*) as postes
                FROM shifts WHERE date(opened_at) >= date('now','-6 days') AND status='closed'
                GROUP BY day ORDER BY day DESC`),
    pool.query(`SELECT date(opened_at) as day, COALESCE(SUM(total_fuel_revenue),0) as carburant,
                       COALESCE(SUM(total_liters_sold),0) as liters, COALESCE(SUM(net_cash),0) as net
                FROM shifts WHERE date(opened_at) >= date('now','-29 days') AND status='closed'
                GROUP BY day ORDER BY day DESC`),
    pool.query(`SELECT sale_date as day, COALESCE(SUM(total),0) as cafe FROM cafe_sales WHERE sale_date >= date('now','-29 days') GROUP BY sale_date`),
    pool.query(`SELECT vente_date as day, COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE vente_date >= date('now','-29 days') GROUP BY vente_date`),
    pool.query(`SELECT tp.name, COALESCE(SUM(tv.montant),0) as ca, COALESCE(SUM(tv.benefice),0) as benefice, COALESCE(SUM(tv.quantite),0) as qty
                FROM tabac_products tp LEFT JOIN tabac_ventes tv ON tv.product_id=tp.id AND tv.vente_date >= date('now','-29 days')
                WHERE tp.is_active=1 GROUP BY tp.id, tp.name ORDER BY ca DESC`),
    pool.query(`SELECT name, price FROM cafe_menu WHERE is_active=1 ORDER BY price DESC LIMIT 20`),
    pool.query(`SELECT name, stock_qty, stock_min, price FROM products WHERE is_active=1 ORDER BY name`),
    pool.query(`SELECT type, amount, description, txn_date FROM bank_transactions ORDER BY txn_date DESC, id DESC LIMIT 10`),
    pool.query(`SELECT p.name, ft.name as fuel, p.current_price FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.is_active=1`),
  ]);

  const bankBalance = parseFloat(bs?.initial_balance || 0) + parseFloat(bal || 0);
  const totalCA = parseFloat(car.ca) + parseFloat(cafe.revenue) + parseFloat(tabac.montant);

  // Merge 30-day data
  const cafeMap  = Object.fromEntries(dailyCafe30.map(r  => [r.day, parseFloat(r.cafe)]));
  const tabacMap = Object.fromEntries(dailyTabac30.map(r => [r.day, parseFloat(r.montant)]));
  const merged30 = daily30.map(r => ({
    day:       r.day,
    carburant: parseFloat(r.carburant),
    liters:    parseFloat(r.liters),
    net:       parseFloat(r.net),
    cafe:      cafeMap[r.day]  || 0,
    tabac:     tabacMap[r.day] || 0,
    total:     parseFloat(r.carburant) + (cafeMap[r.day]||0) + (tabacMap[r.day]||0),
  }));

  return { today, ym, car, cafe, tabac, bankBalance, totalCA, factures, total_due, nb_clients,
           creditClients, recentShifts7, merged30, tabacProducts, cafeMenu, stockProducts, recentBankTxns, pumps };
}

// ── Build system prompt ───────────────────────────────────────────────────────
function buildSystemPrompt(d) {
  const fmt  = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmt0 = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:0,maximumFractionDigits:0});
  const { today, ym, car, cafe, tabac, bankBalance, totalCA, factures, total_due, nb_clients,
          creditClients, recentShifts7, merged30, tabacProducts, cafeMenu, stockProducts, recentBankTxns, pumps } = d;

  let p = `Tu es MENASTA AI, l'assistant intelligent d'une station service au Maroc. Tu es très puissant, précis, et tu réponds toujours en français de manière claire et structurée. Tu as accès à toutes les données en temps réel de la station.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 AUJOURD'HUI : ${today}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⛽ CARBURANT
• CA carburant : ${fmt(car.ca)} MAD
• Litres vendus : ${fmt(car.liters)} L
• Net encaissé : ${fmt(car.net)} MAD
• Créances déduites : ${fmt(car.credits)} MAD
• Avance patron : ${fmt(car.avance)} MAD
• Postes fermés : ${car.postes}

☕ CAFÉ
• CA café : ${fmt(cafe.revenue)} MAD

🚬 TABAC
• CA tabac : ${fmt(tabac.montant)} MAD
• Bénéfice tabac : ${fmt(tabac.benefice)} MAD

💰 TOTAL CA JOURNALIER : ${fmt(totalCA)} MAD

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏦 BANQUE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Solde actuel : ${fmt(bankBalance)} MAD
`;

  if (recentBankTxns.length > 0) {
    p += `\nDernières transactions :\n`;
    recentBankTxns.forEach(t => {
      p += `• ${t.txn_date} | ${t.type} | ${fmt(t.amount)} MAD${t.description ? ' — ' + t.description : ''}\n`;
    });
  }

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤝 CRÉANCES CLIENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Total dettes : ${fmt(total_due)} MAD sur ${nb_clients} clients
`;
  creditClients.forEach(c => {
    p += `• ${c.name}${c.phone?' ('+c.phone+')':''} : ${fmt(c.balance_due)} MAD\n`;
  });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧾 FACTURES — MOIS ${ym}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ${factures.count} facture(s) émise(s) | Total TTC : ${fmt(factures.total)} MAD

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⛽ POMPES & PRIX
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  pumps.forEach(p2 => { p += `• ${p2.name} (${p2.fuel}) : ${parseFloat(p2.current_price).toFixed(3)} MAD/L\n`; });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 STOCK PRODUITS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  stockProducts.forEach(s => {
    const low = parseInt(s.stock_qty) <= parseInt(s.stock_min);
    p += `• ${s.name} : ${s.stock_qty} unités${low?' ⚠️ STOCK BAS':''} (min: ${s.stock_min})\n`;
  });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚬 TABAC — PERFORMANCES 30 JOURS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  tabacProducts.forEach(t => {
    p += `• ${t.name} : CA ${fmt(t.ca)} MAD | Bénéfice ${fmt(t.benefice)} MAD | Qté ${fmt0(t.qty)}\n`;
  });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
☕ MENU CAFÉ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  cafeMenu.forEach(m => { p += `• ${m.name} : ${fmt(m.price)} MAD\n`; });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 7 DERNIERS JOURS — CARBURANT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  recentShifts7.forEach(r => {
    p += `• ${r.day} : CA ${fmt(r.carburant)} MAD | ${fmt(r.liters)} L | Net ${fmt(r.net)} MAD\n`;
  });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 30 DERNIERS JOURS — TOUS MODULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  merged30.forEach(r => {
    p += `• ${r.day} : Total ${fmt(r.total)} MAD (Carb: ${fmt(r.carburant)} | Café: ${fmt(r.cafe)} | Tabac: ${fmt(r.tabac)}) | ${fmt(r.liters)} L\n`;
  });

  // Computed stats
  if (merged30.length > 0) {
    const avg = merged30.reduce((s,r) => s+r.total, 0) / merged30.length;
    const best = merged30.reduce((b,r) => r.total > b.total ? r : b, merged30[0]);
    const totalMonth = merged30.reduce((s,r) => s+r.total, 0);
    p += `\n📊 Statistiques 30j : Moyenne/jour ${fmt(avg)} MAD | Meilleur jour: ${best.day} (${fmt(best.total)} MAD) | Total période: ${fmt(totalMonth)} MAD\n`;
  }

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Réponds toujours en français, de façon claire, structurée, et professionnelle.
- Utilise des emojis avec modération pour aérer les réponses.
- Pour les calculs, sois précis. Pour les analyses, donne des recommandations concrètes.
- Tu peux comparer des périodes, identifier des tendances, détecter des anomalies.
- Si l'utilisateur demande un PDF ou rapport (mots: pdf, rapport, imprimer, exporter, télécharger le rapport), réponds UNIQUEMENT avec ce JSON exact sans aucun autre texte:
  {"action":"pdf","type":"daily"} pour rapport journalier
  {"action":"pdf","type":"weekly"} pour rapport hebdomadaire
  {"action":"pdf","type":"credits"} pour liste des créances
  {"action":"pdf","type":"monthly"} pour rapport mensuel`;

  return p;
}

// ── PDF: Daily ────────────────────────────────────────────────────────────────
function pdfDaily(res, d) {
  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const { today, car, cafe, tabac, bankBalance, totalCA, total_due, nb_clients, creditClients, recentShifts7, merged30 } = d;

  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="MENASTA_Journalier_${today}.pdf"`);
  doc.pipe(res);

  // Header bar
  doc.rect(0,0,595,75).fill('#0F172A');
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF').text('⛽  MENASTA', 50,18);
  doc.fontSize(10).font('Helvetica').fillColor('#94A3B8').text('Station Service — Rapport Journalier', 50,44);
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
  const kpis = [
    {l:'CA Total Jour', v:fmt(totalCA)+' MAD', c:'#2563EB', bg:'#EFF6FF'},
    {l:'Litres Vendus',  v:fmt(car.liters)+' L', c:'#059669', bg:'#ECFDF5'},
    {l:'Solde Banque',   v:fmt(bankBalance)+' MAD', c:'#0D9488', bg:'#F0FDFA'},
    {l:'Créances',       v:fmt(total_due)+' MAD', c:'#DC2626', bg:'#FEF2F2'},
  ];
  kpis.forEach((k,i) => {
    const bx=55+(i%2)*248, by=y+Math.floor(i/2)*52;
    doc.roundedRect(bx,by,235,44,5).fill(k.bg);
    doc.fontSize(8).font('Helvetica').fillColor(k.c).text(k.l.toUpperCase(),bx+10,by+7);
    doc.fontSize(14).font('Helvetica-Bold').fillColor(k.c).text(k.v,bx+10,by+21);
  });
  y += 120;

  secTitle('CARBURANT');
  col("Chiffre d'Affaires",fmt(car.ca)+' MAD',y,55,350,true); y+=16;
  col('Litres Vendus',fmt(car.liters)+' L',y); y+=16;
  col('Net Encaissé',fmt(car.net)+' MAD',y); y+=16;
  col('Avance Patron',fmt(car.avance)+' MAD',y); y+=16;
  col('Postes Fermés',car.postes+' poste(s)',y); y+=22;

  secTitle('CAFÉ & TABAC');
  col('Café — CA',fmt(cafe.revenue)+' MAD',y,55,350,true); y+=16;
  col('Tabac — CA',fmt(tabac.montant)+' MAD',y,55,350,true); y+=16;
  col('Tabac — Bénéfice',fmt(tabac.benefice)+' MAD',y); y+=22;

  secTitle('BANQUE & CRÉANCES');
  col('Solde Bancaire',fmt(bankBalance)+' MAD',y,55,350,true); y+=16;
  col('Total Créances',fmt(total_due)+' MAD',y); y+=16;
  col('Clients Débiteurs',nb_clients+' client(s)',y); y+=22;

  if (creditClients.length > 0) {
    secTitle('CLIENTS DÉBITEURS','#DC2626');
    creditClients.slice(0,10).forEach(c => { col(c.name,fmt(c.balance_due)+' MAD',y); y+=16; });
    y+=6;
  }

  if (recentShifts7.length > 0 && y < 660) {
    secTitle('7 DERNIERS JOURS — CARBURANT');
    recentShifts7.forEach(r => { col(r.day,`CA: ${fmt(r.carburant)} MAD | ${fmt(r.liters)} L`,y); y+=16; });
  }

  doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
    .text(`Généré le ${new Date().toLocaleString('fr-FR')} · MENASTA AI`,50,780,{align:'center',width:495});
  doc.end();
}

// ── PDF: Weekly ───────────────────────────────────────────────────────────────
function pdfWeekly(res, d) {
  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const { today, merged30, bankBalance, total_due } = d;
  const week = merged30.slice(0,7);

  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="MENASTA_Hebdo_${today}.pdf"`);
  doc.pipe(res);

  doc.rect(0,0,595,75).fill('#0F172A');
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF').text('⛽  MENASTA', 50,18);
  doc.fontSize(10).font('Helvetica').fillColor('#94A3B8').text('Rapport Hebdomadaire — 7 Derniers Jours', 50,44);
  doc.fontSize(10).fillColor('#CBD5E1').text(today, 460,44);

  let y = 95;
  const totalWeekCA    = week.reduce((s,r)=>s+r.total,0);
  const totalWeekCarb  = week.reduce((s,r)=>s+r.carburant,0);
  const totalWeekLiters= week.reduce((s,r)=>s+r.liters,0);
  const totalWeekCafe  = week.reduce((s,r)=>s+r.cafe,0);
  const totalWeekTabac = week.reduce((s,r)=>s+r.tabac,0);

  // KPI row
  const kpis = [
    {l:'CA Semaine',     v:fmt(totalWeekCA)+' MAD',    c:'#2563EB', bg:'#EFF6FF'},
    {l:'Litres Semaine', v:fmt(totalWeekLiters)+' L',  c:'#059669', bg:'#ECFDF5'},
    {l:'Café Semaine',   v:fmt(totalWeekCafe)+' MAD',  c:'#D97706', bg:'#FFFBEB'},
    {l:'Tabac Semaine',  v:fmt(totalWeekTabac)+' MAD', c:'#92400E', bg:'#FDF4EC'},
  ];
  kpis.forEach((k,i) => {
    const bx=55+(i%2)*248, by=y+Math.floor(i/2)*52;
    doc.roundedRect(bx,by,235,44,5).fill(k.bg);
    doc.fontSize(8).font('Helvetica').fillColor(k.c).text(k.l.toUpperCase(),bx+10,by+7);
    doc.fontSize(14).font('Helvetica-Bold').fillColor(k.c).text(k.v,bx+10,by+21);
  });
  y += 120;

  // Table header
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#2563EB').text('DÉTAIL PAR JOUR', 55,y);
  doc.moveTo(55,y+13).lineTo(540,y+13).lineWidth(0.4).strokeColor('#E2E8F0').stroke();
  y += 20;

  // Column headers
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#94A3B8');
  doc.text('DATE',55,y); doc.text('TOTAL',170,y); doc.text('CARBURANT',270,y); doc.text('LITRES',370,y); doc.text('CAFÉ',450,y); doc.text('TABAC',510,y);
  y += 14;
  doc.moveTo(55,y).lineTo(540,y).lineWidth(0.3).strokeColor('#E2E8F0').stroke();
  y += 6;

  const best = week.reduce((b,r)=>r.total>b.total?r:b, week[0]||{total:0});
  week.forEach(r => {
    const isBest = r.day === best.day;
    if (isBest) doc.roundedRect(52,y-3,490,16,3).fill('#EFF6FF');
    doc.fontSize(9).font(isBest?'Helvetica-Bold':'Helvetica').fillColor(isBest?'#1D4ED8':'#1E293B');
    doc.text(r.day,55,y);
    doc.text(fmt(r.total),155,y,{width:100,align:'right'});
    doc.text(fmt(r.carburant),255,y,{width:100,align:'right'});
    doc.text(fmt(r.liters)+' L',355,y,{width:90,align:'right'});
    doc.text(fmt(r.cafe),445,y,{width:60,align:'right'});
    doc.text(fmt(r.tabac),505,y,{width:65,align:'right'});
    y+=17;
  });

  y += 10;
  doc.moveTo(55,y).lineTo(540,y).lineWidth(0.6).strokeColor('#CBD5E1').stroke();
  y += 8;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#0F172A');
  doc.text('TOTAL',55,y);
  doc.text(fmt(totalWeekCA),155,y,{width:100,align:'right'});
  doc.text(fmt(totalWeekCarb),255,y,{width:100,align:'right'});
  doc.text(fmt(totalWeekLiters)+' L',355,y,{width:90,align:'right'});
  doc.text(fmt(totalWeekCafe),445,y,{width:60,align:'right'});
  doc.text(fmt(totalWeekTabac),505,y,{width:65,align:'right'});

  y += 30;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748B').text(`Moyenne journalière : ${fmt(totalWeekCA/Math.max(week.length,1))} MAD/jour`,55,y);
  doc.fontSize(9).font('Helvetica').fillColor('#64748B').text(`Solde banque : ${fmt(bankBalance)} MAD  |  Créances : ${fmt(total_due)} MAD`,55,y+16);

  doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
    .text(`Généré le ${new Date().toLocaleString('fr-FR')} · MENASTA AI`,50,780,{align:'center',width:495});
  doc.end();
}

// ── PDF: Credits ──────────────────────────────────────────────────────────────
function pdfCredits(res, d) {
  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const { today, creditClients, total_due, nb_clients } = d;

  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="MENASTA_Creances_${today}.pdf"`);
  doc.pipe(res);

  doc.rect(0,0,595,75).fill('#7F1D1D');
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF').text('⛽  MENASTA', 50,18);
  doc.fontSize(10).font('Helvetica').fillColor('#FCA5A5').text('Rapport Créances Clients', 50,44);
  doc.fontSize(10).fillColor('#FECACA').text(today, 460,44);

  let y = 95;
  doc.roundedRect(55,y,480,50,6).fill('#FEF2F2');
  doc.fontSize(10).font('Helvetica').fillColor('#DC2626').text('TOTAL CRÉANCES',65,y+8);
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#DC2626').text(fmt(total_due)+' MAD',65,y+22);
  doc.fontSize(10).font('Helvetica').fillColor('#94A3B8').text(nb_clients+' client(s) débiteur(s)',380,y+28);
  y += 70;

  doc.fontSize(8).font('Helvetica-Bold').fillColor('#94A3B8');
  doc.text('CLIENT',55,y); doc.text('TÉLÉPHONE',280,y); doc.text('MONTANT DÛ',400,y,{width:140,align:'right'});
  y+=14;
  doc.moveTo(55,y).lineTo(540,y).lineWidth(0.4).strokeColor('#E2E8F0').stroke();
  y+=6;

  creditClients.forEach((c,i) => {
    if (i%2===0) doc.rect(52,y-3,490,18).fill('#FFF7F7');
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1E293B').text(c.name,55,y,{width:220,ellipsis:true});
    doc.fontSize(10).font('Helvetica').fillColor('#64748B').text(c.phone||'—',280,y);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(fmt(c.balance_due)+' MAD',400,y,{width:140,align:'right'});
    y+=19;
    if (y>750) { doc.addPage(); y=50; }
  });

  doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
    .text(`Généré le ${new Date().toLocaleString('fr-FR')} · MENASTA AI`,50,780,{align:'center',width:495});
  doc.end();
}

// ── PDF: Monthly ──────────────────────────────────────────────────────────────
function pdfMonthly(res, d) {
  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const { today, ym, merged30, bankBalance, total_due, factures, tabacProducts } = d;

  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="MENASTA_Mensuel_${ym}.pdf"`);
  doc.pipe(res);

  doc.rect(0,0,595,75).fill('#0F172A');
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF').text('⛽  MENASTA', 50,18);
  doc.fontSize(10).font('Helvetica').fillColor('#94A3B8').text(`Rapport Mensuel — ${ym}`, 50,44);
  doc.fontSize(10).fillColor('#CBD5E1').text(today, 460,44);

  const totalCA    = merged30.reduce((s,r)=>s+r.total,0);
  const totalCarb  = merged30.reduce((s,r)=>s+r.carburant,0);
  const totalLit   = merged30.reduce((s,r)=>s+r.liters,0);
  const totalCafe  = merged30.reduce((s,r)=>s+r.cafe,0);
  const totalTabac = merged30.reduce((s,r)=>s+r.tabac,0);
  const avgDay     = totalCA/Math.max(merged30.length,1);
  const best       = merged30.reduce((b,r)=>r.total>b.total?r:b, merged30[0]||{total:0,day:'—'});

  let y = 95;
  const kpis = [
    {l:'CA Mensuel',    v:fmt(totalCA)+' MAD',   c:'#2563EB',bg:'#EFF6FF'},
    {l:'Litres Total',  v:fmt(totalLit)+' L',    c:'#059669',bg:'#ECFDF5'},
    {l:'Café Mensuel',  v:fmt(totalCafe)+' MAD', c:'#D97706',bg:'#FFFBEB'},
    {l:'Tabac Mensuel', v:fmt(totalTabac)+' MAD',c:'#92400E',bg:'#FDF4EC'},
  ];
  kpis.forEach((k,i) => {
    const bx=55+(i%2)*248, by=y+Math.floor(i/2)*52;
    doc.roundedRect(bx,by,235,44,5).fill(k.bg);
    doc.fontSize(8).font('Helvetica').fillColor(k.c).text(k.l.toUpperCase(),bx+10,by+7);
    doc.fontSize(14).font('Helvetica-Bold').fillColor(k.c).text(k.v,bx+10,by+21);
  });
  y += 120;

  doc.fontSize(9).font('Helvetica').fillColor('#64748B').text(`Moyenne/jour: ${fmt(avgDay)} MAD  |  Meilleur jour: ${best.day} (${fmt(best.total)} MAD)  |  Solde banque: ${fmt(bankBalance)} MAD`,55,y);
  y += 20;

  // Daily table
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#2563EB').text('DÉTAIL JOURNALIER',55,y);
  doc.moveTo(55,y+13).lineTo(540,y+13).lineWidth(0.4).strokeColor('#E2E8F0').stroke();
  y+=20;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#94A3B8');
  doc.text('DATE',55,y); doc.text('TOTAL',155,y,{width:100,align:'right'}); doc.text('CARBURANT',265,y,{width:100,align:'right'});
  doc.text('CAFÉ',375,y,{width:70,align:'right'}); doc.text('TABAC',455,y,{width:70,align:'right'}); doc.text('LITRES',530,y,{width:60,align:'right'});
  y+=14;
  doc.moveTo(55,y).lineTo(540,y).lineWidth(0.3).strokeColor('#E2E8F0').stroke(); y+=5;

  merged30.forEach((r,i) => {
    if (y>730) { doc.addPage(); y=50; }
    if (i%2===0) doc.rect(52,y-2,490,15).fill('#F8FAFC');
    doc.fontSize(8).font('Helvetica').fillColor('#1E293B');
    doc.text(r.day,55,y);
    doc.text(fmt(r.total),155,y,{width:100,align:'right'});
    doc.text(fmt(r.carburant),265,y,{width:100,align:'right'});
    doc.text(fmt(r.cafe),375,y,{width:70,align:'right'});
    doc.text(fmt(r.tabac),455,y,{width:70,align:'right'});
    doc.text(fmt(r.liters)+' L',530,y,{width:60,align:'right'});
    y+=14;
  });

  y+=10;
  doc.moveTo(55,y).lineTo(540,y).lineWidth(0.6).strokeColor('#CBD5E1').stroke(); y+=6;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#0F172A');
  doc.text('TOTAL',55,y); doc.text(fmt(totalCA),155,y,{width:100,align:'right'});
  doc.text(fmt(totalCarb),265,y,{width:100,align:'right'});
  doc.text(fmt(totalCafe),375,y,{width:70,align:'right'});
  doc.text(fmt(totalTabac),455,y,{width:70,align:'right'});
  doc.text(fmt(totalLit)+' L',530,y,{width:60,align:'right'});

  doc.fontSize(8).font('Helvetica').fillColor('#94A3B8')
    .text(`Généré le ${new Date().toLocaleString('fr-FR')} · MENASTA AI`,50,780,{align:'center',width:495});
  doc.end();
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Streaming chat
router.post('/chat', requireAuth, async (req, res, next) => {
  try {
    const { message, history = [] } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message requis' });

    const data = await getBusinessData();
    const systemPrompt = buildSystemPrompt(data);

    const messages = [
      ...history.slice(-14).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message.slice(0, 3000) }
    ];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullText = '';

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });

    stream.on('text', (text) => {
      fullText += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on('finalMessage', () => {
      // Detect PDF intent
      try {
        const trimmed = fullText.trim();
        const parsed = JSON.parse(trimmed);
        if (parsed.action === 'pdf') {
          res.write(`data: ${JSON.stringify({ pdf: parsed.type || 'daily' })}\n\n`);
        }
      } catch (_) {}
      res.write('data: [DONE]\n\n');
      res.end();
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

  } catch (err) { next(err); }
});

// PDF endpoints
router.get('/pdf/daily',   requireAuth, wrap(async (req, res) => { pdfDaily(res,   await getBusinessData()); }));
router.get('/pdf/weekly',  requireAuth, wrap(async (req, res) => { pdfWeekly(res,  await getBusinessData()); }));
router.get('/pdf/credits', requireAuth, wrap(async (req, res) => { pdfCredits(res, await getBusinessData()); }));
router.get('/pdf/monthly', requireAuth, wrap(async (req, res) => { pdfMonthly(res, await getBusinessData()); }));

module.exports = router;
