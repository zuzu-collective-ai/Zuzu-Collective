#!/usr/bin/env node
/**
 * Budget integrity scan
 * Run from portal/ directory:  node scripts/budget-scan.mjs
 *
 * Finds budget categories where contracted = a single payment installment
 * rather than the full signed contract total — the most common data-entry
 * mistake when only the deposit is entered rather than the full contract value.
 *
 * Does NOT modify any data.
 */

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\.render\.com/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

const SQL = `
WITH category_stats AS (
  SELECT
    bc.id            AS cat_id,
    bc.couple_id,
    bc.title         AS category_title,
    bc.category_number,
    bc.position,
    COUNT(li.id)                                        AS line_count,
    COALESCE(SUM(li.amount_cents), 0)                   AS contracted_cents,
    COALESCE(SUM(li.paid_cents),   0)                   AS paid_cents,
    COALESCE(SUM(li.amount_cents), 0)
      - COALESCE(SUM(li.paid_cents), 0)                 AS balance_cents,
    BOOL_AND(li.status_kind = 'paid')                   AS all_items_paid,
    (COUNT(li.id) = 1)                                  AS single_item,
    string_agg(
      '  • ' || li.name
        || '  contracted=$' || ROUND(li.amount_cents::numeric / 100, 2)::text
        || '  paid=$'       || ROUND(li.paid_cents::numeric   / 100, 2)::text
        || '  status='      || COALESCE(li.status_kind, 'upcoming')
        || CASE WHEN li.due_date IS NOT NULL
             THEN '  due=' || to_char(li.due_date, 'YYYY-MM-DD')
             ELSE '' END,
      E'\\n' ORDER BY li.position
    ) AS items_detail
  FROM budget_categories bc
  LEFT JOIN budget_line_items li ON li.category_id = bc.id
  GROUP BY bc.id, bc.couple_id, bc.title, bc.category_number, bc.position
  HAVING COUNT(li.id) >= 1
)
SELECT
  c.display_name                                        AS couple,
  cs.category_title                                     AS category,
  cs.line_count,
  '$' || ROUND(cs.contracted_cents::numeric / 100, 0)::text  AS contracted,
  '$' || ROUND(cs.paid_cents::numeric       / 100, 0)::text  AS paid,
  '$' || ROUND(cs.balance_cents::numeric    / 100, 0)::text  AS balance_due,
  CASE
    WHEN cs.single_item
      AND cs.paid_cents  > 0
      AND cs.paid_cents  = cs.contracted_cents
      AND cs.contracted_cents > 0
      THEN 'FLAG — single item, fully paid; may be deposit-only'
    WHEN cs.single_item
      AND cs.paid_cents  > 0
      AND cs.paid_cents  < cs.contracted_cents
      THEN 'FLAG — single item, partially paid; may be deposit-only'
    WHEN NOT cs.single_item
      AND cs.all_items_paid
      AND cs.contracted_cents > 0
      THEN 'NOTE — all items marked paid; verify no remaining balance'
    ELSE ''
  END                                                   AS flag,
  cs.items_detail                                       AS line_items
FROM category_stats cs
JOIN couples c ON c.id = cs.couple_id
ORDER BY
  CASE WHEN cs.single_item AND cs.paid_cents > 0 THEN 0 ELSE 1 END,
  c.display_name,
  cs.position;
`;

const { rows } = await pool.query(SQL);
await pool.end();

if (rows.length === 0) {
  console.log('No budget data found.');
  process.exit(0);
}

const flagged = rows.filter(r => r.flag.startsWith('FLAG'));
const noted   = rows.filter(r => r.flag.startsWith('NOTE'));
const clean   = rows.filter(r => !r.flag);

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  BUDGET INTEGRITY SCAN');
console.log(`  ${rows.length} categories scanned · ${flagged.length} flagged · ${noted.length} noted`);
console.log('═══════════════════════════════════════════════════════════════');

if (flagged.length > 0) {
  console.log('');
  console.log('── FLAGGED (possible installment-only entries) ─────────────────');
  for (const r of flagged) {
    console.log('');
    console.log(`  Couple:      ${r.couple}`);
    console.log(`  Category:    ${r.category}`);
    console.log(`  Items:       ${r.line_count}`);
    console.log(`  Contracted:  ${r.contracted}`);
    console.log(`  Paid:        ${r.paid}`);
    console.log(`  Balance due: ${r.balance_due}`);
    console.log(`  ⚠  ${r.flag}`);
    console.log(`  Line items:`);
    console.log(r.line_items);
  }
}

if (noted.length > 0) {
  console.log('');
  console.log('── NOTED (worth reviewing) ─────────────────────────────────────');
  for (const r of noted) {
    console.log('');
    console.log(`  Couple:      ${r.couple}`);
    console.log(`  Category:    ${r.category}`);
    console.log(`  Items:       ${r.line_count}`);
    console.log(`  Contracted:  ${r.contracted}`);
    console.log(`  Paid:        ${r.paid}`);
    console.log(`  Balance due: ${r.balance_due}`);
    console.log(`  ℹ  ${r.flag}`);
    console.log(`  Line items:`);
    console.log(r.line_items);
  }
}

if (clean.length > 0) {
  console.log('');
  console.log('── CLEAN ───────────────────────────────────────────────────────');
  for (const r of clean) {
    console.log(`  ${r.couple.padEnd(30)} ${r.category.padEnd(25)} ${r.contracted.padStart(10)} contracted  ${r.balance_due.padStart(10)} due`);
  }
}

console.log('');
console.log('Scan complete. No data was modified.');
console.log('');
