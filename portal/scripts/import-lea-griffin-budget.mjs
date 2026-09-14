#!/usr/bin/env node
/**
 * One-time import of Lea & Griffin's budget from their Google Sheet.
 * Run from portal/ directory:
 *   DATABASE_URL="..." node scripts/import-lea-griffin-budget.mjs
 *
 * Set DRY_RUN=1 to preview without writing:
 *   DRY_RUN=1 DATABASE_URL="..." node scripts/import-lea-griffin-budget.mjs
 */

import pg from 'pg';

const { Pool } = pg;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const isRenderManagedDb = /\.render\.com/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRenderManagedDb ? { rejectUnauthorized: false } : false,
});

// ── Budget data from Google Sheet ────────────────────────────────────────────

const CATEGORIES = [
  {
    category_number: 1,
    title: 'Planning',
    title_emphasis: null,
    contracted_cents: 550000,   // $5,500
    estimated_cents: 0,
    position: 1,
    lines: [
      { name: 'Deposit',       amount_cents: 275000, paid_cents: 275000, status_kind: 'paid',     due_date: null },
      { name: 'Installment 2', amount_cents: 137500, paid_cents: 137500, status_kind: 'paid',     due_date: null },
      { name: 'Final payment', amount_cents: 137500, paid_cents: 0,      status_kind: 'upcoming', due_date: '2027-08-28' },
    ],
  },
  {
    category_number: 2,
    title: 'Catering',
    title_emphasis: '(Classic Culinaire)',
    contracted_cents: 2238300,  // $22,383
    estimated_cents: 0,
    position: 2,
    lines: [
      { name: 'Deposit',       amount_cents: 150000,  paid_cents: 150000,  status_kind: 'paid',     due_date: null },
      { name: 'Final payment', amount_cents: 2088300, paid_cents: 0,       status_kind: 'upcoming', due_date: '2027-09-03' },
    ],
  },
  {
    category_number: 3,
    title: 'Bar & Alcohol',
    title_emphasis: null,
    contracted_cents: 0,
    estimated_cents: 360000,   // $3,600
    position: 3,
    lines: [],
  },
  {
    category_number: 4,
    title: 'Photography & Video',
    title_emphasis: '(Dennis Roy Coronel)',
    contracted_cents: 1050000,  // $10,500
    estimated_cents: 0,
    position: 4,
    lines: [
      { name: 'Deposit',       amount_cents: 525000,  paid_cents: 525000,  status_kind: 'paid',     due_date: null },
      { name: 'Final payment', amount_cents: 525000,  paid_cents: 0,       status_kind: 'upcoming', due_date: '2027-08-10' },
    ],
  },
  {
    category_number: 5,
    title: 'Music',
    title_emphasis: '(Hip Service)',
    contracted_cents: 1475000,  // $14,750
    estimated_cents: 0,
    position: 5,
    lines: [
      { name: 'Deposit',       amount_cents: 737500,  paid_cents: 737500,  status_kind: 'paid',     due_date: '2026-07-16' },
      { name: 'Final payment', amount_cents: 737500,  paid_cents: 0,       status_kind: 'upcoming', due_date: '2027-09-04' },
    ],
  },
  {
    category_number: 6,
    title: 'Florals & Decor',
    title_emphasis: '(Blonde Bouquet)',
    contracted_cents: 952000,   // $9,520
    estimated_cents: 0,
    position: 6,
    lines: [
      { name: 'Deposit',       amount_cents: 50000,   paid_cents: 50000,   status_kind: 'paid',     due_date: null },
      { name: 'Final payment', amount_cents: 902000,  paid_cents: 0,       status_kind: 'upcoming', due_date: '2027-08-28' },
    ],
  },
  {
    category_number: 7,
    title: 'Rentals',
    title_emphasis: null,
    contracted_cents: 0,
    estimated_cents: 2741000,   // $27,410
    position: 7,
    lines: [],
  },
  {
    category_number: 8,
    title: 'Hair & Makeup',
    title_emphasis: '(Beauty on Set)',
    contracted_cents: 429000,   // $4,290
    estimated_cents: 0,
    position: 8,
    lines: [
      { name: 'Retainer',      amount_cents: 214500,  paid_cents: 214500,  status_kind: 'paid',     due_date: '2026-02-12' },
      { name: 'Final payment', amount_cents: 214500,  paid_cents: 0,       status_kind: 'upcoming', due_date: '2027-08-12' },
    ],
  },
  {
    category_number: 9,
    title: 'Cake & Desserts',
    title_emphasis: null,
    contracted_cents: 0,
    estimated_cents: 100000,   // $1,000
    position: 9,
    lines: [],
  },
  {
    category_number: 10,
    title: 'Ceremony',
    title_emphasis: null,
    contracted_cents: 0,
    estimated_cents: 0,
    position: 10,
    lines: [],
  },
  {
    category_number: 11,
    title: 'Stationery & Favors',
    title_emphasis: null,
    contracted_cents: 0,
    estimated_cents: 200000,   // $2,000
    position: 11,
    lines: [],
  },
];

const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1pi6hYLYShvZVyjJvUX4X7TuI-ATil_03RcinkHdWAgY/edit';

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();
  try {
    // Find Lea & Griffin
    const coupleRes = await client.query(
      `SELECT id, display_name, slug FROM couples
       WHERE lower(display_name) LIKE '%lea%' AND lower(display_name) LIKE '%griffin%'
       ORDER BY id LIMIT 1`
    );
    if (coupleRes.rows.length === 0) {
      console.error("Could not find a couple matching 'Lea' + 'Griffin'. Check display_name in DB.");
      process.exit(1);
    }
    const couple = coupleRes.rows[0];
    console.log(`Found couple: id=${couple.id} display_name="${couple.display_name}" slug="${couple.slug}"`);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Would import:');
      for (const cat of CATEGORIES) {
        const status = cat.contracted_cents > 0 ? `contracted $${(cat.contracted_cents/100).toLocaleString()}` : `estimated $${(cat.estimated_cents/100).toLocaleString()}`;
        console.log(`  ${String(cat.category_number).padStart(2,'0')}. ${cat.title}${cat.title_emphasis ? ' ' + cat.title_emphasis : ''} — ${status} — ${cat.lines.length} payment(s)`);
      }
      console.log('\n[DRY RUN] No changes written.');
      return;
    }

    await client.query('BEGIN');

    // Clear existing categories (cascades to line_items if FK is set, else clear manually)
    const existing = await client.query(
      'SELECT id FROM budget_categories WHERE couple_id = $1', [couple.id]
    );
    if (existing.rows.length > 0) {
      const ids = existing.rows.map(r => r.id);
      await client.query(
        `DELETE FROM budget_line_items WHERE category_id = ANY($1::int[])`, [ids]
      );
      await client.query(
        `DELETE FROM budget_categories WHERE couple_id = $1`, [couple.id]
      );
      console.log(`Deleted ${existing.rows.length} existing categories.`);
    }

    // Insert categories and their line items
    for (const cat of CATEGORIES) {
      const catRes = await client.query(
        `INSERT INTO budget_categories
           (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
         RETURNING id`,
        [couple.id, cat.category_number, cat.title, cat.title_emphasis, cat.contracted_cents, cat.estimated_cents, cat.position]
      );
      const catId = catRes.rows[0].id;

      for (let i = 0; i < cat.lines.length; i++) {
        const l = cat.lines[i];
        await client.query(
          `INSERT INTO budget_line_items
             (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
          [catId, couple.id, l.name, l.amount_cents, l.paid_cents, l.status_kind, l.due_date, i + 1]
        );
      }

      const status = cat.contracted_cents > 0
        ? `contracted $${(cat.contracted_cents/100).toLocaleString()}`
        : `estimated $${(cat.estimated_cents/100).toLocaleString()}`;
      console.log(`  ✓ ${cat.title} — ${status} — ${cat.lines.length} payment(s)`);
    }

    // Update spreadsheet URL and import timestamp
    await client.query(
      `UPDATE couples SET budget_spreadsheet_url = $1, budget_last_imported_at = now() WHERE id = $2`,
      [SPREADSHEET_URL, couple.id]
    );
    console.log('Updated spreadsheet URL.');

    await client.query('COMMIT');
    console.log('\nDone! Budget imported successfully.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error — rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
