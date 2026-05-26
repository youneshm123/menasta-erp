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

  const q = (sql, params) => pool.query(sql, params).catch(e => { console.error('[AI DATA]', e.message); return { rows: [] }; });
  const q1 = (sql, params, def) => pool.query(sql, params).catch(e => { console.error('[AI DATA]', e.message); return { rows: [def] }; });

  const [
    rCar, rCafe, rTabac, rBs, rBal, rFact, rDebt,
    rCredClients, rShifts7, rDaily30, rCafe30, rTabac30,
    rTabacProd, rCafeMenu, rStock, rBankTxns, rPumps, rExp, rCuves,
  ] = await Promise.all([
    q1(`SELECT COALESCE(SUM(total_fuel_revenue),0) as ca, COALESCE(SUM(total_liters_sold),0) as liters,
               COALESCE(SUM(net_cash),0) as net, COALESCE(SUM(avance),0) as avance,
               COALESCE(SUM(total_credit_deducted),0) as credits, COUNT(*) as postes
        FROM shifts WHERE date(opened_at)=$1 AND status='closed'`, [today],
       { ca:0, liters:0, net:0, avance:0, credits:0, postes:0 }),
    q1(`SELECT COALESCE(SUM(total),0) as revenue FROM cafe_sales WHERE sale_date=$1`, [today], { revenue:0 }),
    q1(`SELECT COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE vente_date=$1`, [today], { montant:0, benefice:0 }),
    q(`SELECT initial_balance FROM bank_settings WHERE id=1`),
    q1(`SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END),0) as bal FROM bank_transactions`, [], { bal:0 }),
    q1(`SELECT COUNT(*) as count, COALESCE(SUM(total_ttc),0) as total FROM factures WHERE TO_CHAR(facture_date,'YYYY-MM')=$1`, [ym], { count:0, total:0 }),
    q1(`SELECT COALESCE(SUM(balance_due),0) as total_due, COUNT(*) as nb_clients FROM credit_clients WHERE is_active=1 AND balance_due > 0`, [], { total_due:0, nb_clients:0 }),
    q(`SELECT name, balance_due, credit_limit, phone FROM credit_clients WHERE is_active=1 AND balance_due > 0 ORDER BY balance_due DESC`),
    q(`SELECT (opened_at)::date as day, COALESCE(SUM(total_fuel_revenue),0) as carburant,
              COALESCE(SUM(total_liters_sold),0) as liters, COALESCE(SUM(net_cash),0) as net,
              COALESCE(SUM(avance),0) as avance, COUNT(*) as postes
       FROM shifts WHERE (opened_at)::date >= CURRENT_DATE - INTERVAL '6 days' AND status='closed'
       GROUP BY (opened_at)::date ORDER BY (opened_at)::date DESC`),
    q(`SELECT (opened_at)::date as day, COALESCE(SUM(total_fuel_revenue),0) as carburant,
              COALESCE(SUM(total_liters_sold),0) as liters, COALESCE(SUM(net_cash),0) as net
       FROM shifts WHERE (opened_at)::date >= CURRENT_DATE - INTERVAL '29 days' AND status='closed'
       GROUP BY (opened_at)::date ORDER BY (opened_at)::date DESC`),
    q(`SELECT sale_date as day, COALESCE(SUM(total),0) as cafe FROM cafe_sales WHERE sale_date >= CURRENT_DATE - INTERVAL '29 days' GROUP BY sale_date`),
    q(`SELECT vente_date as day, COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE vente_date >= CURRENT_DATE - INTERVAL '29 days' GROUP BY vente_date`),
    q(`SELECT tp.name, COALESCE(SUM(tv.montant),0) as ca, COALESCE(SUM(tv.benefice),0) as benefice, COALESCE(SUM(tv.quantite),0) as qty
       FROM tabac_products tp LEFT JOIN tabac_ventes tv ON tv.product_id=tp.id AND tv.vente_date >= CURRENT_DATE - INTERVAL '29 days'
       WHERE tp.is_active=1 GROUP BY tp.id, tp.name ORDER BY ca DESC`),
    q(`SELECT name, price FROM cafe_menu WHERE is_active=1 ORDER BY price DESC LIMIT 20`),
    q(`SELECT name, stock_qty, stock_min, price FROM products WHERE is_active=1 ORDER BY name`),
    q(`SELECT type, amount, description, txn_date FROM bank_transactions ORDER BY txn_date DESC, id DESC LIMIT 10`),
    q(`SELECT p.name, ft.name as fuel, ft.price_per_liter FROM pumps p JOIN fuel_types ft ON ft.id=p.fuel_type_id WHERE p.status != 'inactive' ORDER BY p.id`),
    q(`SELECT category, COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date >= CURRENT_DATE - INTERVAL '29 days' GROUP BY category ORDER BY total DESC`),
    q(`SELECT c.name, ft.name as fuel_name, c.capacite_max, c.niveau_alerte,
              (SELECT niveau_litres FROM cuve_lectures WHERE cuve_id=c.id ORDER BY lecture_date DESC LIMIT 1) as niveau_litres,
              (SELECT lecture_date FROM cuve_lectures WHERE cuve_id=c.id ORDER BY lecture_date DESC LIMIT 1) as lecture_date
       FROM cuves c JOIN fuel_types ft ON ft.id=c.fuel_type_id WHERE c.is_active=1 ORDER BY c.id`),
  ]);

  const car           = rCar.rows[0]    || { ca:0, liters:0, net:0, avance:0, credits:0, postes:0 };
  const cafe          = rCafe.rows[0]   || { revenue:0 };
  const tabac         = rTabac.rows[0]  || { montant:0, benefice:0 };
  const bs            = rBs.rows[0];
  const bal           = (rBal.rows[0]   || {}).bal || 0;
  const factures      = rFact.rows[0]   || { count:0, total:0 };
  const { total_due=0, nb_clients=0 } = rDebt.rows[0] || {};
  const creditClients  = rCredClients.rows;
  const recentShifts7  = rShifts7.rows;
  const daily30        = rDaily30.rows;
  const dailyCafe30    = rCafe30.rows;
  const dailyTabac30   = rTabac30.rows;
  const tabacProducts  = rTabacProd.rows;
  const cafeMenu       = rCafeMenu.rows;
  const stockProducts  = rStock.rows;
  const recentBankTxns = rBankTxns.rows;
  const pumps          = rPumps.rows;
  const expenses30     = rExp.rows;
  const cuves          = rCuves.rows;

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
           creditClients, recentShifts7, merged30, tabacProducts, cafeMenu, stockProducts, recentBankTxns, pumps,
           expenses30, cuves };
}

// ── Build system prompt ───────────────────────────────────────────────────────
function buildSystemPrompt(d, language = 'fr') {
  const fmt  = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmt0 = n => parseFloat(n||0).toLocaleString('fr-FR',{minimumFractionDigits:0,maximumFractionDigits:0});
  const { today, ym, car, cafe, tabac, bankBalance, totalCA, factures, total_due, nb_clients,
          creditClients, recentShifts7, merged30, tabacProducts, cafeMenu, stockProducts, recentBankTxns, pumps,
          expenses30, cuves } = d;

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
    const lim = c.credit_limit ? ` / limite ${fmt(c.credit_limit)} MAD` : '';
    const pct = c.credit_limit ? ` (${Math.round(parseFloat(c.balance_due)/parseFloat(c.credit_limit)*100)}%)` : '';
    p += `• ${c.name}${c.phone?' ('+c.phone+')':''} : ${fmt(c.balance_due)} MAD${lim}${pct}\n`;
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
  pumps.forEach(p2 => { p += `• ${p2.name} (${p2.fuel}) : ${parseFloat(p2.price_per_liter).toFixed(3)} MAD/L\n`; });

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
🛢️ NIVEAUX CUVES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  cuves.forEach(c => {
    const niv = c.niveau_litres ? parseFloat(c.niveau_litres) : null;
    const pct = niv !== null && c.capacite_max ? Math.round(niv / parseFloat(c.capacite_max) * 100) : null;
    const alerte = niv !== null && niv <= parseFloat(c.niveau_alerte) ? ' ⚠️ ALERTE' : '';
    p += `• ${c.name} (${c.fuel_name}) : ${niv !== null ? fmt0(niv)+' L ('+pct+'%)' : 'Pas de lecture'} — Capacité ${fmt0(c.capacite_max)} L${alerte}${c.lecture_date ? ' · Dernière lecture: '+c.lecture_date : ''}\n`;
  });

  p += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💸 DÉPENSES — 30 DERNIERS JOURS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  if (expenses30.length) {
    const totalExp = expenses30.reduce((s,e) => s+parseFloat(e.total), 0);
    p += `• Total dépenses : ${fmt(totalExp)} MAD\n`;
    expenses30.forEach(e => { p += `• ${e.category} : ${fmt(e.total)} MAD\n`; });
  } else {
    p += `• Aucune dépense enregistrée sur 30 jours\n`;
  }

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
INSTRUCTIONS LANGUE & STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 🌍 DÉTECTION AUTOMATIQUE DE LANGUE : Identifie la langue de chaque message de l'utilisateur et réponds EXACTEMENT dans la même langue.
  Exemples:
  • L'utilisateur écrit en français → tu réponds en français
  • The user writes in English → you respond in English
  • المستخدم يكتب بالعربية الفصحى → تجاوب بالعربية الفصحى
  • المستخدم يكتب بالدارجة المغربية → تجاوب بالدارجة (ماباسش تخلط فرنسية أو عربية فصحى)
  • El usuario escribe en español → responde en español
  • Der Benutzer schreibt auf Deutsch → antworte auf Deutsch
  • L'utente scrive in italiano → rispondi in italiano
  • O utilizador escreve em português → responde em português
  • Any other language → detect and respond in that exact language
- Ne change JAMAIS de langue en cours de conversation sauf si l'utilisateur change de langue.
- Si le message mélange plusieurs langues, utilise la langue dominante.
- Utilise des emojis avec modération pour aérer les réponses.
- Pour les calculs, sois précis. Pour les analyses, donne des recommandations concrètes.
- Tu peux comparer des périodes, identifier des tendances, détecter des anomalies.
- Si l'utilisateur demande un PDF ou rapport (mots-clés dans n'importe quelle langue: pdf, rapport, report, تقرير, تحميل, imprimir, bericht), réponds UNIQUEMENT avec ce JSON exact sans aucun autre texte:
  {"action":"pdf","type":"daily"} — rapport journalier
  {"action":"pdf","type":"weekly"} — rapport hebdomadaire
  {"action":"pdf","type":"credits"} — liste des créances
  {"action":"pdf","type":"monthly"} — rapport mensuel`;

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
    const { message, history = [], language = 'fr' } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message requis' });

    const data = await getBusinessData();
    const systemPrompt = buildSystemPrompt(data, language);

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
      max_tokens: 8192,
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
      console.error('[AI STREAM ERROR]', err.status, err.message, err.error);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error('[AI ROUTE ERROR]', err.status, err.message, err.error || err);
    next(err);
  }
});

// ── Text-to-SQL: natural language → SQL → answer ─────────────────────────────
const DB_SCHEMA = `
Tables PostgreSQL disponibles:
- users(id, full_name, username, role, is_active, created_at)
- shifts(id, opened_by, opened_at, closed_at, status, total_liters_sold, total_fuel_revenue, total_credit_deducted, total_product_sales, net_cash, avance, pompiste, heure_debut, heure_fin, notes)
- pump_readings(id, shift_id, pump_id, reading_type, meter_value, recorded_by, created_at)
- pumps(id, name, fuel_type_id, status)
- fuel_types(id, name, price_per_liter, color_hex, is_active)
- fuel_deliveries(id, fuel_type_id, delivery_date, liters_delivered, price_per_liter, cost, notes, numero_cheque, recorded_by, created_at)
- credit_clients(id, name, phone, company, balance_due, credit_limit, ice, adresse, is_active, notes, created_at)
- credit_sales(id, shift_id, credit_client_id, pump_id, liters, price_per_liter, amount, product_type, sale_time, recorded_by, notes)
- credit_payments(id, credit_client_id, shift_id, amount, payment_time, recorded_by, notes)
- products(id, reference, name, category, unit, price, stock_qty, stock_min, is_active)
- product_sales(id, shift_id, product_id, quantity, unit_price, total_amount, sale_time, recorded_by)
- expenses(id, expense_date, category, description, amount, notes, recorded_by, created_at)
- cafe_menu(id, name, emoji, price, is_active)
- cafe_sales(id, sale_date, menu_item_id, quantity, unit_price, total, recorded_by)
- cafe_stock_items(id, name, unit, cost_per_unit, is_active)
- cafe_stock_usage(id, usage_date, stock_item_id, quantity_used, cost_per_unit, total_cost, recorded_by)
- tabac_products(id, name, prix_achat, prix_vente, is_active, created_at)
- tabac_ventes(id, vente_date, product_id, quantite, prix_vente, prix_achat, montant, benefice, recorded_by, created_at)
- tabac_achats(id, product_id, quantite, prix_achat, achat_date, notes, recorded_by, created_at)
- bank_settings(id, account_name, initial_balance)
- bank_transactions(id, txn_date, type, category, description, amount, check_number, beneficiary, due_date, check_status, notes, recorded_by, is_reconciled, reconciled_at, created_at)
- factures(id, numero, facture_date, client_name, client_adresse, client_ice, total_ht, montant_tva, total_ttc, notes, recorded_by, created_at)
- facture_lignes(id, facture_id, code_produit, designation, quantite, prix_ht, taux_tva, total_ht, montant_tva, montant_ttc)
- cuves(id, name, fuel_type_id, capacite_max, niveau_alerte, is_active, created_at)
- cuve_lectures(id, cuve_id, lecture_date, niveau_litres, recorded_by, notes, created_at)
- cuve_livraisons(id, cuve_id, livraison_date, litres_recus, fournisseur, prix_unitaire, bon_livraison, recorded_by, notes, created_at)
- activity_logs(id, user_id, username, module, action, details, ip_addr, created_at)
`;

router.post('/query', requireAuth, wrap(async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Question requise' });

  // Step 1: Claude generates the SQL
  const sqlResp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Tu es un expert SQL PostgreSQL pour un ERP de station service marocaine (MENASTA).
Génère UNE SEULE requête SQL SELECT valide pour répondre à cette question: "${question}"

Schéma:
${DB_SCHEMA}

RÈGLES STRICTES:
- Génère UNIQUEMENT le SQL, sans explication, sans markdown, sans \`\`\`
- Utilise ONLY SELECT (jamais INSERT/UPDATE/DELETE/DROP)
- Limite à 100 résultats maximum (LIMIT 100)
- Utilise COALESCE pour éviter les NULL
- Les dates sont en TIMESTAMPTZ ou DATE
- Utilise TO_CHAR pour formater les dates si nécessaire`
    }]
  });

  const sql = sqlResp.content[0]?.text?.trim();
  if (!sql || !sql.toUpperCase().startsWith('SELECT')) {
    return res.status(400).json({ error: 'Impossible de générer une requête SQL valide' });
  }

  // Block queries that could expose sensitive columns
  const BLOCKED_PATTERNS = /password_hash|password_reset|secret|jwt|token\b/i;
  if (BLOCKED_PATTERNS.test(sql)) {
    return res.status(403).json({ error: 'Requête non autorisée: colonnes sensibles détectées' });
  }

  // Step 2: Execute the SQL
  let rows;
  try {
    const result = await pool.query(sql);
    // Strip sensitive columns defensively even if they slip through
    rows = result.rows.map(r => {
      const clean = { ...r };
      delete clean.password_hash;
      delete clean.password;
      return clean;
    });
  } catch (e) {
    return res.status(400).json({ error: `Erreur SQL: ${e.message}`, sql });
  }

  // Step 3: Claude interprets the results in natural language
  const interpretResp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Question posée: "${question}"
SQL exécuté: ${sql}
Résultats (${rows.length} ligne(s)): ${JSON.stringify(rows.slice(0, 20))}

Réponds à la question en français de manière claire et concise, comme si tu parlais à un gérant de station service. Utilise des chiffres précis. Sois direct.`
    }]
  });

  const answer = interpretResp.content[0]?.text?.trim();

  res.json({ question, sql, rows, answer, count: rows.length });
}));

// PDF endpoints
router.get('/pdf/daily',   requireAuth, wrap(async (req, res) => { pdfDaily(res,   await getBusinessData()); }));
router.get('/pdf/weekly',  requireAuth, wrap(async (req, res) => { pdfWeekly(res,  await getBusinessData()); }));
router.get('/pdf/credits', requireAuth, wrap(async (req, res) => {
  let data = await getBusinessData();
  if (req.query.ids) {
    const ids = req.query.ids.split(',').map(Number).filter(Boolean);
    data = { ...data, creditClients: data.creditClients.filter(c => ids.includes(parseInt(c.id))) };
  }
  pdfCredits(res, data);
}));
router.get('/pdf/monthly', requireAuth, wrap(async (req, res) => { pdfMonthly(res, await getBusinessData()); }));

module.exports = router;
