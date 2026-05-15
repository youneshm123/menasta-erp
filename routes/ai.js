const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getBusinessContext() {
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
    { rows: dailyShifts },
  ] = await Promise.all([
    pool.query(`
      SELECT COALESCE(SUM(total_fuel_revenue),0) as ca,
             COALESCE(SUM(total_liters_sold),0)  as liters,
             COALESCE(SUM(net_cash),0)            as net,
             COUNT(*) as postes
      FROM shifts WHERE date(opened_at)=$1 AND status='closed'
    `, [today]),
    pool.query(`
      SELECT COALESCE(SUM(total),0) as revenue
      FROM cafe_sales WHERE sale_date=$1
    `, [today]),
    pool.query(`
      SELECT COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice
      FROM tabac_ventes WHERE vente_date=$1
    `, [today]),
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
    pool.query(`SELECT name, balance_due FROM credit_clients WHERE is_active=1 AND balance_due > 0 ORDER BY balance_due DESC LIMIT 10`),
    pool.query(`
      SELECT date(opened_at) as day,
             COALESCE(SUM(total_fuel_revenue),0) as ca,
             COALESCE(SUM(total_liters_sold),0)  as liters
      FROM shifts WHERE date(opened_at) >= date('now', '-29 days') AND status='closed'
      GROUP BY day ORDER BY day DESC
    `),
  ]);

  const bankBalance = parseFloat(bs?.initial_balance || 0) + parseFloat(bal || 0);

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
- Total dettes: ${fmt(total_due)} MAD sur ${nb_clients} clients
`;

  if (creditClients.length > 0) {
    ctx += `- Top débiteurs: ${creditClients.map(c => `${c.name} (${fmt(c.balance_due)} MAD)`).join(', ')}\n`;
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
Réponds toujours en français, de manière claire et concise. Tu peux faire des calculs, des comparaisons, des recommandations basées sur ces données. Si on te demande des données non disponibles ici, dis-le honnêtement.`;

  return ctx;
}

router.post('/chat', requireAuth, wrap(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message requis' });
  }

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

  res.json({ reply: response.content[0].text });
}));

module.exports = router;
