// Répartition des ventes carburant par type (Essence / Gazoil).
//
// Le CA d'un poste est stocké globalement dans shifts.total_fuel_revenue : on ne
// peut donc pas savoir, depuis les postes seuls, ce qui vient du gazoil et ce qui
// vient de l'essence. On le recalcule ici pompe par pompe, exactement comme
// calcShift() dans routes/shifts.js : litres = compteur fin − compteur début, au
// prix du poste, en découpant sur les changements de prix en cours de poste.
//
// Toutes les fonctions rendent des lignes { fuel_type_id, liters, revenue } que
// les routes agrègent ensuite par jour, par mois ou globalement.

// Litres et CA d'une pompe sur un poste, en tenant compte des changements
// de prix (segments de compteur : avant le changement / après).
function pumpTotals(startVal, endVal, price, changes) {
  const S = Number(startVal), E = Number(endVal);
  const liters = Math.max(0, E - S);
  if (!changes || !changes.length) return { liters, revenue: liters * Number(price) };
  let revenue = 0, prev = S;
  for (const c of changes) {
    const m = Math.min(Math.max(Number(c.meter_value), S), E);
    revenue += Math.max(0, m - prev) * Number(c.price_before);
    prev = Math.max(prev, m);
  }
  revenue += Math.max(0, E - prev) * Number(changes[changes.length - 1].price_after);
  return { liters, revenue };
}

// Lignes : une par (poste, pompe), avec le jour et le carburant.
//
// IMPORTANT — les totaux du poste (shifts.total_fuel_revenue / total_liters_sold)
// restent la référence : ce sont eux qui s'affichent partout depuis toujours.
// Les anciens postes n'enregistraient pas le prix au moment de l'ouverture, donc
// un simple recalcul les surestime (il applique le prix d'aujourd'hui). On ne
// recalcule donc pas le total : on le RÉPARTIT entre les carburants au prorata
// du CA calculé par pompe. Résultat : Essence + Gazoil = exactement le total
// déjà affiché, aucun chiffre existant ne bouge.
//
// opts : { from, to } (bornes de dates 'YYYY-MM-DD' incluses, optionnelles),
//        { shiftId } pour un seul poste (ouvert ou fermé).
async function fuelRows(db, opts = {}) {
  const params = [];
  let where = opts.shiftId ? 's.id=$1' : "s.status='closed'";
  if (opts.shiftId) params.push(opts.shiftId);
  if (!opts.shiftId) {
    if (opts.from) { params.push(opts.from); where += ` AND s.opened_at::date >= $${params.length}::date`; }
    if (opts.to)   { params.push(opts.to);   where += ` AND s.opened_at::date <= $${params.length}::date`; }
  }

  const { rows: readings } = await db.query(`
    SELECT s.id AS shift_id,
           to_char(s.opened_at,'YYYY-MM-DD') AS day,
           st.pump_id,
           p.fuel_type_id AS ftid,
           st.meter_value AS start_val,
           en.meter_value AS end_val,
           COALESCE(NULLIF(st.price_per_liter,0), ft.price_per_liter) AS price
    FROM shifts s
    JOIN pump_readings st ON st.shift_id=s.id AND st.reading_type='start'
    JOIN pump_readings en ON en.shift_id=s.id AND en.pump_id=st.pump_id AND en.reading_type='end'
    JOIN pumps p          ON p.id=st.pump_id
    JOIN fuel_types ft    ON ft.id=p.fuel_type_id
    WHERE ${where}
  `, params);
  if (!readings.length) return [];

  const shiftIds = [...new Set(readings.map(r => r.shift_id))];
  const { rows: changes } = await db.query(`
    SELECT shift_id, pump_id, meter_value, price_before, price_after
    FROM shift_price_changes WHERE shift_id = ANY($1) ORDER BY shift_id, pump_id, meter_value ASC
  `, [shiftIds]);
  const chMap = {};
  for (const c of changes) (chMap[c.shift_id + ':' + c.pump_id] = chMap[c.shift_id + ':' + c.pump_id] || []).push(c);

  const rows = readings.map(r => {
    const t = pumpTotals(r.start_val, r.end_val, r.price, chMap[r.shift_id + ':' + r.pump_id]);
    return {
      shift_id: r.shift_id, day: r.day, pump_id: r.pump_id,
      fuel_type_id: r.ftid, liters: t.liters, revenue: t.revenue,
    };
  });

  // Recalage sur les totaux enregistrés du poste (voir le commentaire ci-dessus).
  const { rows: stored } = await db.query(
    'SELECT id, total_fuel_revenue AS rev, total_liters_sold AS lit FROM shifts WHERE id = ANY($1)',
    [shiftIds]
  );
  const sum = {};
  for (const r of rows) {
    const a = sum[r.shift_id] || (sum[r.shift_id] = { rev: 0, lit: 0 });
    a.rev += r.revenue; a.lit += r.liters;
  }
  const factor = {};
  for (const s of stored) {
    const calc = sum[s.id];
    if (!calc) continue;
    const rev = s.rev == null ? null : parseFloat(s.rev);
    const lit = s.lit == null ? null : parseFloat(s.lit);
    factor[s.id] = {
      rev: rev != null && calc.rev > 0 ? rev / calc.rev : 1,
      lit: lit != null && calc.lit > 0 ? lit / calc.lit : 1,
    };
  }
  for (const r of rows) {
    const f = factor[r.shift_id];
    if (!f) continue;
    r.revenue *= f.rev;
    r.liters  *= f.lit;
  }
  return rows;
}

// Agrège des lignes fuelRows() en { [clé]: { [fuel_type_id]: {liters, revenue} } }.
// keyOf : ligne → clé de regroupement (jour, mois, id de poste…).
function groupBy(rows, keyOf) {
  const out = {};
  for (const r of rows) {
    const k = keyOf(r);
    const bucket = out[k] || (out[k] = {});
    const f = bucket[r.fuel_type_id] || (bucket[r.fuel_type_id] = { liters: 0, revenue: 0 });
    f.liters  += r.liters;
    f.revenue += r.revenue;
  }
  return out;
}

const byDay   = rows => groupBy(rows, r => r.day);
const byMonth = rows => groupBy(rows, r => r.day.slice(0, 7));
const byShift = rows => groupBy(rows, r => r.shift_id);

// Totaux tous jours confondus : { [fuel_type_id]: {liters, revenue} }
function totals(rows) {
  const t = {};
  for (const r of rows) {
    const f = t[r.fuel_type_id] || (t[r.fuel_type_id] = { liters: 0, revenue: 0 });
    f.liters += r.liters; f.revenue += r.revenue;
  }
  return t;
}

// Liste des carburants actifs, dans l'ordre d'affichage.
async function fuelTypes(db) {
  const { rows } = await db.query(
    'SELECT id, name, color_hex FROM fuel_types WHERE is_active=1 ORDER BY id'
  );
  return rows;
}

// Met en forme un bucket { ftid: {liters,revenue} } en tableau affichable,
// une entrée par carburant actif (0 si rien vendu), avec les coûts optionnels.
// costs : { [ftid]: montant } — coût d'achat des litres vendus dans ce bucket.
function shape(fuels, bucket, costs) {
  return fuels.map(f => {
    const v = (bucket && bucket[f.id]) || { liters: 0, revenue: 0 };
    const out = {
      id: f.id, name: f.name, color_hex: f.color_hex,
      liters:  +v.liters.toFixed(2),
      revenue: +v.revenue.toFixed(2),
    };
    if (costs) {
      const c = +(costs[f.id] || 0);
      out.cost   = +c.toFixed(2);
      out.profit = +(v.revenue - c).toFixed(2);
    }
    return out;
  });
}

module.exports = { fuelRows, byDay, byMonth, byShift, totals, fuelTypes, shape, pumpTotals };
