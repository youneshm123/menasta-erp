const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/summary', requireAuth, wrap(async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // ── Carburant ──
  const { rows: [car] } = await pool.query(`
    SELECT COALESCE(SUM(total_fuel_revenue),0) as ca,
           COALESCE(SUM(total_liters_sold),0)  as liters,
           COALESCE(SUM(total_credit_deducted),0) as credits,
           COALESCE(SUM(total_product_sales),0) as products,
           COALESCE(SUM(net_cash),0)            as net,
           COALESCE(SUM(avance),0)              as avance,
           COUNT(*) as postes
    FROM shifts WHERE date(opened_at)=$1 AND status='closed'
  `, [today]);

  const { rows: [openShift] } = await pool.query(
    "SELECT s.*, u.full_name as opened_by_name FROM shifts s LEFT JOIN users u ON u.id=s.opened_by WHERE s.status='open'"
  );

  // ── Café ──
  const { rows: [cafe] } = await pool.query(`
    SELECT COALESCE(SUM(cs.total),0) as revenue,
           COALESCE(SUM(cs.total),0) - COALESCE(SUM(cu.total_cost),0) as benefice
    FROM cafe_sales cs
    LEFT JOIN (SELECT usage_date, SUM(total_cost) as total_cost FROM cafe_stock_usage GROUP BY usage_date) cu
      ON cu.usage_date=cs.sale_date
    WHERE cs.sale_date=$1
  `, [today]);

  // ── Tabac ──
  const { rows: [tabac] } = await pool.query(`
    SELECT COALESCE(SUM(montant),0)  as montant,
           COALESCE(SUM(benefice),0) as benefice
    FROM tabac_ventes WHERE vente_date=$1
  `, [today]);

  // ── Banque ──
  const { rows: [bs] } = await pool.query('SELECT initial_balance FROM bank_settings WHERE id=1');
  const { rows: [{ bal }] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN type IN ('depot','virement_in','cheque_in') THEN amount ELSE -amount END),0) as bal
    FROM bank_transactions
  `);
  const bankBalance = parseFloat(bs?.initial_balance || 0) + parseFloat(bal || 0);

  const { rows: recentTxns } = await pool.query(`
    SELECT * FROM bank_transactions ORDER BY txn_date DESC, id DESC LIMIT 5
  `);

  // ── Factures ce mois ──
  const ym = today.slice(0, 7);
  const { rows: [factures] } = await pool.query(`
    SELECT COUNT(*) as count, COALESCE(SUM(total_ttc),0) as total
    FROM factures WHERE TO_CHAR(facture_date,'YYYY-MM')=$1
  `, [ym]);

  // ── Créances ──
  const { rows: [{ total_due, nb_clients }] } = await pool.query(`
    SELECT COALESCE(SUM(balance_due),0) as total_due, COUNT(*) as nb_clients
    FROM credit_clients WHERE is_active=1 AND balance_due > 0
  `);

  // ── Derniers postes (7 jours) ──
  const { rows: recentShifts } = await pool.query(`
    SELECT s.*, u.full_name as opened_by_name
    FROM shifts s LEFT JOIN users u ON u.id=s.opened_by
    WHERE date(opened_at) >= date('now', '-6 days')
    ORDER BY opened_at DESC LIMIT 14
  `);

  // ── Stock Produits (acheté vs vendu) ──
  const { rows: stockProducts } = await pool.query(`
    SELECT p.name, p.reference, p.category, p.price, p.stock_qty, p.stock_min,
           COALESCE(SUM(ps.quantity),0)      as total_sold,
           COALESCE(SUM(ps.total_amount),0)  as revenue_sold
    FROM products p
    LEFT JOIN product_sales ps ON ps.product_id=p.id
    WHERE p.is_active=1
    GROUP BY p.id, p.name, p.reference, p.category, p.price, p.stock_qty, p.stock_min
    ORDER BY revenue_sold DESC
  `);

  // ── Dépenses (aujourd'hui + ce mois + par catégorie + récentes) ──
  const { rows: [exp] } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN expense_date=$1 THEN amount ELSE 0 END),0) as today,
           COALESCE(SUM(CASE WHEN TO_CHAR(expense_date,'YYYY-MM')=$2 THEN amount ELSE 0 END),0) as month
    FROM expenses
  `, [today, ym]);
  const { rows: expByCat } = await pool.query(`
    SELECT category, COALESCE(SUM(amount),0) as total
    FROM expenses WHERE TO_CHAR(expense_date,'YYYY-MM')=$1
    GROUP BY category ORDER BY total DESC
  `, [ym]);
  const { rows: recentExpenses } = await pool.query(`
    SELECT e.*, u.full_name as recorded_by_name
    FROM expenses e LEFT JOIN users u ON u.id=e.recorded_by
    ORDER BY e.expense_date DESC, e.id DESC LIMIT 100
  `);

  // ── Créances détaillées (qui doit combien) ──
  const { rows: creancesList } = await pool.query(`
    SELECT name, phone, company, balance_due
    FROM credit_clients WHERE is_active=1 AND balance_due > 0
    ORDER BY balance_due DESC
  `);

  // ── Cumul du mois (Month-to-date) par module ──
  const { rows: [mtdCar] } = await pool.query(`
    SELECT COALESCE(SUM(total_fuel_revenue),0)    as ca,
           COALESCE(SUM(total_product_sales),0)   as products,
           COALESCE(SUM(net_cash),0)              as net,
           COALESCE(SUM(total_liters_sold),0)     as liters,
           COALESCE(SUM(total_credit_deducted),0) as credits,
           COALESCE(SUM(avance),0)                as avance,
           COUNT(*)                               as postes
    FROM shifts WHERE TO_CHAR(opened_at,'YYYY-MM')=$1 AND status='closed'
  `, [ym]);
  const { rows: [mtdCafe] } = await pool.query(
    `SELECT COALESCE(SUM(total),0) as rev FROM cafe_sales WHERE TO_CHAR(sale_date,'YYYY-MM')=$1`, [ym]);
  const { rows: [mtdTabac] } = await pool.query(
    `SELECT COALESCE(SUM(montant),0) as montant, COALESCE(SUM(benefice),0) as benefice FROM tabac_ventes WHERE TO_CHAR(vente_date,'YYYY-MM')=$1`, [ym]);

  // ── Cuves (niveau actuel + remplissage + dernier écart) ──
  const { rows: cuvesRows } = await pool.query(`
    SELECT c.*, ft.name as fuel_name, ft.color_hex
    FROM cuves c JOIN fuel_types ft ON ft.id=c.fuel_type_id
    WHERE c.is_active=1 ORDER BY c.id
  `);
  const cuves = [];
  for (const cuve of cuvesRows) {
    const { rows: lecs } = await pool.query(
      `SELECT * FROM cuve_lectures WHERE cuve_id=$1 ORDER BY lecture_date DESC LIMIT 2`, [cuve.id]);
    let niveau = null, ecart = null, ecart_date = null;
    if (lecs.length) {
      niveau = parseFloat(lecs[0].niveau_litres);
      if (lecs.length === 2) {
        const cur = lecs[0], prev = lecs[1];
        const { rows: [{ liv }] } = await pool.query(`
          SELECT COALESCE(SUM(litres_recus),0) as liv FROM cuve_livraisons
          WHERE cuve_id=$1 AND livraison_date > $2 AND livraison_date <= $3
        `, [cuve.id, prev.lecture_date, cur.lecture_date]);
        const { rows: [{ sold }] } = await pool.query(`
          SELECT COALESCE(SUM(pr_end.meter_value - pr_start.meter_value), 0) as sold
          FROM pumps p
          JOIN pump_readings pr_start ON pr_start.pump_id=p.id AND pr_start.reading_type='start'
          JOIN pump_readings pr_end   ON pr_end.pump_id=p.id AND pr_end.reading_type='end'
                                      AND pr_end.shift_id=pr_start.shift_id
          JOIN shifts s ON s.id=pr_start.shift_id AND s.status='closed'
          WHERE p.fuel_type_id=$1 AND date(s.opened_at) > $2 AND date(s.opened_at) <= $3
        `, [cuve.fuel_type_id, prev.lecture_date, cur.lecture_date]);
        const theorique = parseFloat(prev.niveau_litres) + parseFloat(liv) - parseFloat(sold);
        ecart = Math.round(parseFloat(cur.niveau_litres) - theorique);
        ecart_date = cur.lecture_date;
      }
    }
    const cap = parseFloat(cuve.capacite_max) || 0;
    const alerte = parseFloat(cuve.niveau_alerte) || 0;
    cuves.push({
      name: cuve.name, fuel_name: cuve.fuel_name, color: cuve.color_hex,
      capacite: cap, niveau,
      fill_pct: (niveau != null && cap > 0) ? Math.round(niveau / cap * 100) : null,
      alerte, low: niveau != null && niveau <= alerte,
      ecart, ecart_date,
    });
  }

  // ── Comparaison journalière (30 jours) ──
  const { rows: dailyShifts } = await pool.query(`
    SELECT date(opened_at) as day,
           COALESCE(SUM(total_fuel_revenue),0)   as carburant,
           COALESCE(SUM(total_product_sales),0)  as produits,
           COALESCE(SUM(total_credit_deducted),0) as credits,
           COALESCE(SUM(avance),0)               as avance,
           COALESCE(SUM(net_cash),0)             as net,
           COALESCE(SUM(total_liters_sold),0)    as liters,
           COUNT(*)                              as nb_postes
    FROM shifts
    WHERE date(opened_at) >= date('now', '-29 days') AND status='closed'
    GROUP BY day ORDER BY day DESC
  `);

  const { rows: dailyCafe } = await pool.query(`
    SELECT sale_date as day, COALESCE(SUM(total),0) as cafe
    FROM cafe_sales
    WHERE sale_date >= date('now', '-29 days')
    GROUP BY sale_date
  `);

  const { rows: dailyTabac } = await pool.query(`
    SELECT vente_date as day,
           COALESCE(SUM(montant),0)  as montant,
           COALESCE(SUM(benefice),0) as benefice
    FROM tabac_ventes
    WHERE vente_date >= date('now', '-29 days')
    GROUP BY vente_date
  `);

  // merge daily data by date
  const cafeMap  = Object.fromEntries(dailyCafe.map(r  => [r.day, parseFloat(r.cafe)]));
  const tabacMap = Object.fromEntries(dailyTabac.map(r => [r.day, { montant: parseFloat(r.montant), benefice: parseFloat(r.benefice) }]));
  const daily = dailyShifts.map(r => ({
    day:       r.day,
    carburant: parseFloat(r.carburant),
    produits:  parseFloat(r.produits),
    credits:   parseFloat(r.credits),
    avance:    parseFloat(r.avance),
    net:       parseFloat(r.net),
    liters:    parseFloat(r.liters),
    nb_postes: parseInt(r.nb_postes),
    cafe:      cafeMap[r.day]  || 0,
    tabac:     tabacMap[r.day]?.montant  || 0,
    total:     parseFloat(r.carburant) + (cafeMap[r.day] || 0) + (tabacMap[r.day]?.montant || 0),
  }));

  res.json({
    today,
    carburant: {
      ca: parseFloat(car.ca), liters: parseFloat(car.liters),
      credits: parseFloat(car.credits), products: parseFloat(car.products),
      net: parseFloat(car.net), avance: parseFloat(car.avance),
      postes: parseInt(car.postes), open_shift: openShift || null
    },
    cafe: {
      revenue: parseFloat(cafe.revenue),
      benefice: parseFloat(cafe.benefice)
    },
    tabac: {
      montant: parseFloat(tabac.montant),
      benefice: parseFloat(tabac.benefice)
    },
    banque: {
      balance: bankBalance,
      recent: recentTxns
    },
    factures: {
      count: parseInt(factures.count),
      total: parseFloat(factures.total)
    },
    credits: {
      total_due: parseFloat(total_due),
      nb_clients: parseInt(nb_clients),
      list: creancesList.map(c => ({
        name: c.name, phone: c.phone, company: c.company,
        balance_due: parseFloat(c.balance_due)
      }))
    },
    depenses: {
      today: parseFloat(exp.today),
      month: parseFloat(exp.month),
      by_cat: expByCat.map(c => ({ category: c.category, total: parseFloat(c.total) })),
      recent: recentExpenses.map(e => ({
        category: e.category, description: e.description,
        amount: parseFloat(e.amount), expense_date: e.expense_date,
        recorded_by_name: e.recorded_by_name
      }))
    },
    mois: {
      carburant: parseFloat(mtdCar.ca),
      products:  parseFloat(mtdCar.products),
      net:       parseFloat(mtdCar.net),
      liters:    parseFloat(mtdCar.liters),
      credits:   parseFloat(mtdCar.credits),
      avance:    parseFloat(mtdCar.avance),
      postes:    parseInt(mtdCar.postes),
      cafe:      parseFloat(mtdCafe.rev),
      tabac:     parseFloat(mtdTabac.montant),
      tabac_benefice: parseFloat(mtdTabac.benefice),
      depenses:  parseFloat(exp.month),
    },
    cuves,
    recent_shifts: recentShifts,
    stock: stockProducts.map(p => ({
      name:         p.name,
      reference:    p.reference,
      category:     p.category,
      price:        parseFloat(p.price),
      stock_qty:    parseInt(p.stock_qty),
      stock_min:    parseInt(p.stock_min),
      total_sold:   parseInt(p.total_sold),
      revenue_sold: parseFloat(p.revenue_sold),
      total_bought: parseInt(p.stock_qty) + parseInt(p.total_sold),
      low:          parseInt(p.stock_qty) <= parseInt(p.stock_min),
    })),
    daily
  });
}));

module.exports = router;
