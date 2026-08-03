#!/usr/bin/env node
/**
 * Split one lumped credit sale (a "bon" entered entirely as gazoil) into its
 * real parts — e.g. 950 MAD = 700 gazoil + 250 vidange.
 *
 *   node scripts/split-bon.js 1069 gazoil=300 vidange=100          # preview
 *   node scripts/split-bon.js 1069 gazoil=300 vidange=100 --apply  # write
 *
 * Optional note per part:  vidange=100:HUILE+FILTRE
 *
 * The parts MUST add up to the original amount, so the client's balance_due
 * never moves — this only re-labels how the same money is described.
 * The original row keeps its id/date/poste and becomes the first part; the
 * other parts are inserted as sibling rows on the same date and poste.
 */
const { pool } = require('../db');

const TYPES = ['gazoil', 'essence', 'lubrifiant', 'vidange', 'service', 'espece'];
const FUEL  = ['gazoil', 'essence'];

async function main() {
  const argv  = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const args  = argv.filter(a => a !== '--apply');
  const saleId = parseInt(args[0]);
  if (!saleId || args.length < 2) {
    console.error('usage: node scripts/split-bon.js <saleId> type=montant [type=montant ...] [--apply]');
    console.error('types:', TYPES.join(', '));
    process.exit(1);
  }

  const parts = args.slice(1).map(a => {
    const [type, rest] = a.split('=');
    if (!TYPES.includes(type)) throw new Error(`type inconnu: ${type} (attendu: ${TYPES.join(', ')})`);
    const [amt, ...noteBits] = String(rest).split(':');
    const amount = parseFloat(amt);
    if (!isFinite(amount) || amount <= 0) throw new Error(`montant invalide pour ${type}: ${amt}`);
    return { type, amount, note: noteBits.join(':') || null };
  });

  const { rows } = await pool.query(
    `SELECT cs.*, cc.name AS client_name, s.opened_at AS shift_date
     FROM credit_sales cs
     JOIN credit_clients cc ON cc.id = cs.credit_client_id
     LEFT JOIN shifts s ON s.id = cs.shift_id
     WHERE cs.id = $1`, [saleId]);
  const sale = rows[0];
  if (!sale) throw new Error(`vente #${saleId} introuvable`);

  const original = parseFloat(sale.amount);
  const sum = parts.reduce((t, p) => t + p.amount, 0);
  if (Math.abs(sum - original) > 0.01)
    throw new Error(`les parts totalisent ${sum.toFixed(2)} mais le bon vaut ${original.toFixed(2)} — le solde du client changerait. Corrige les montants.`);

  const ppl = parseFloat(sale.price_per_liter) || 0;
  const dateStr = String(sale.shift_date || sale.sale_time).slice(0, 10);

  console.log(`\nBon #${saleId} — ${sale.client_name} — ${dateStr}`);
  console.log(`Actuel : ${original.toFixed(2)} MAD  [${sale.product_type}]${sale.notes ? '  note: ' + sale.notes : ''}`);
  console.log('Après  :');
  for (const p of parts) {
    const isFuel = FUEL.includes(p.type);
    p.liters  = isFuel && ppl > 0 ? +(p.amount / ppl).toFixed(2) : 0;
    p.pump_id = isFuel ? sale.pump_id : null;
    p.ppl     = isFuel ? ppl : 0;
    console.log(`  - ${p.type.padEnd(11)} ${p.amount.toFixed(2).padStart(10)} MAD` +
                (p.liters ? `  (${p.liters} L)` : '') + (p.note ? `  note: ${p.note}` : ''));
  }
  console.log(`  ${''.padEnd(11)} ${sum.toFixed(2).padStart(10)} MAD  = total inchangé, solde client intact`);

  if (!apply) {
    console.log('\n(prévisualisation — relance avec --apply pour écrire)\n');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [first, ...others] = parts;
    // The original row becomes the first part — keeps id, date and poste.
    await client.query(
      `UPDATE credit_sales
       SET amount=$1, product_type=$2, pump_id=$3, liters=$4, price_per_liter=$5, notes=COALESCE($6, notes)
       WHERE id=$7`,
      [first.amount, first.type, first.pump_id, first.liters, first.ppl, first.note, saleId]);
    // Remaining parts become sibling rows on the same date / poste / client.
    for (const p of others)
      await client.query(
        `INSERT INTO credit_sales
           (shift_id, credit_client_id, pump_id, liters, price_per_liter, amount, recorded_by, notes, product_type, sale_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sale.shift_id, sale.credit_client_id, p.pump_id, p.liters, p.ppl, p.amount,
         sale.recorded_by, p.note, p.type, sale.sale_time]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { rows: after } = await pool.query(
    'SELECT COALESCE(SUM(amount),0) t FROM credit_sales WHERE credit_client_id=$1', [sale.credit_client_id]);
  console.log(`\n✓ Bon #${saleId} séparé en ${parts.length} lignes.`);
  console.log(`  Total achats du client : ${parseFloat(after[0].t).toFixed(2)} MAD (inchangé par la séparation)\n`);
}

main().then(() => process.exit(0)).catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
