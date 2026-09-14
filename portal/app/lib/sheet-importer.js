// Imports budget data from a Zuzu Collective Google Sheet into the DB format.
//
// Uses the Google Visualization (gviz) API — no API key required as long as
// the sheet is shared as "Anyone with the link can view".
//
// Reads two tabs from the standard Zuzu budget template:
//   "Overview"  — the BY CATEGORY summary table (one row per category)
//   "Payments"  — the payment schedule (deposits, finals, etc.)
//
// Intentionally NOT reading Budget Detail — we only want category-level
// totals and the payment schedule, not every individual line item.

const GVIZ_BASE = 'https://docs.google.com/spreadsheets/d';

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error('Invalid Google Sheets URL — could not find spreadsheet ID.');
  return m[1];
}

async function fetchSheetRows(sheetId, sheetName) {
  const url = `${GVIZ_BASE}/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Could not read the sheet (HTTP ${res.status}). Make sure it is shared as "Anyone with the link can view".`);
  }

  const text = await res.text();
  const match = text.match(/setResponse\(([\s\S]+?)\)\s*;?\s*$/);
  if (!match) throw new Error('Unexpected response from Google Sheets.');

  const payload = JSON.parse(match[1]);
  if (payload.status !== 'ok') {
    const msg = payload.errors?.[0]?.detailed_message || payload.errors?.[0]?.message || 'Unknown error';
    throw new Error(`Google Sheets error for "${sheetName}": ${msg}`);
  }

  return (payload.table?.rows || []).map(row =>
    (row.c || []).map(cell => {
      if (!cell) return '';
      const val = cell.f ?? cell.v;
      return val === null || val === undefined ? '' : String(val);
    })
  );
}

function parseCents(s) {
  if (!s || s === '-') return 0;
  const n = parseFloat(String(s).replace(/[$,%\s,]/g, ''));
  return isNaN(n) || n <= 0 ? 0 : Math.round(n * 100);
}

function parseDate(s) {
  if (!s || s === '-') return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Returns { rowIdx, offset } where offset is the column index where col0Value was found.
// The sheet template has a blank column A, so headers start at column B (offset 1).
function findHeaderRow(rows, col0Value, col1Value) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let off = 0; off < Math.min(row.length, 3); off++) {
      if (row[off] === col0Value && (!col1Value || row[off + 1] === col1Value)) {
        return { rowIdx: i, offset: off };
      }
    }
  }
  return { rowIdx: -1, offset: 0 };
}

// Parse the BY CATEGORY summary table from the Overview tab.
// Returns [{ title, contracted_cents, estimated_cents }]
function parseOverviewCategories(rows) {
  // Header row looks like: [blank] Category | Target | Planned | ... | Contracted | Paid | Balance Due | ...
  const { rowIdx: headerIdx, offset } = findHeaderRow(rows, 'Category', 'Target');
  if (headerIdx === -1) throw new Error('Cannot find the "BY CATEGORY" table in the Overview sheet. Make sure the tab is named "Overview".');

  const h = rows[headerIdx];
  const col = {
    category:   offset,
    planned:    h.indexOf('Planned'),
    contracted: h.indexOf('Contracted'),
  };

  const categories = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row  = rows[i];
    const name = row[col.category] || '';
    if (!name || name.toLowerCase() === 'total') break;

    const contracted = parseCents(row[col.contracted]);
    const planned    = parseCents(row[col.planned]);

    // For the portal: if contracted > 0, mark it booked.
    // Otherwise use the planned amount as an estimate.
    categories.push({
      title:            name,
      contracted_cents: contracted,
      estimated_cents:  contracted > 0 ? 0 : planned,
    });
  }

  if (categories.length === 0) throw new Error('No categories found in the Overview sheet.');
  return categories;
}

// Parse the payment schedule from the Payments tab.
// Returns only the vendor payment rows (not the hair & makeup breakdown at the bottom).
function parsePayments(rows) {
  // Header: [blank] Budget Line Item | Due Date | Vendor | Payment | Amount | Status | ...
  const { rowIdx: headerIdx, offset } = findHeaderRow(rows, 'Budget Line Item', 'Due Date');
  if (headerIdx === -1) throw new Error('Cannot find the payment schedule in the Payments sheet. Make sure the tab is named "Payments".');

  const h   = rows[headerIdx];
  const col = {
    lineItem: offset,
    dueDate:  h.indexOf('Due Date'),
    vendor:   h.indexOf('Vendor'),
    payment:  h.indexOf('Payment'),
    amount:   h.indexOf('Amount'),
    status:   h.indexOf('Status'),
  };

  const payments = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row      = rows[i];
    const lineItem = row[col.lineItem] || '';
    const amount   = parseCents(row[col.amount]);

    // Stop at the summary footer
    if (['Total scheduled', 'Paid', 'Still to pay'].includes(lineItem)) break;
    if (!lineItem || !amount) continue;

    const isPaid = (row[col.status] || '').toLowerCase() === 'paid';
    payments.push({
      lineItemName: lineItem,
      vendor:       row[col.vendor] || '',
      name:         row[col.payment] || lineItem,
      due_date:     parseDate(row[col.dueDate]),
      amount_cents: amount,
      paid_cents:   isPaid ? amount : 0,
      status_kind:  isPaid ? 'paid' : 'upcoming',
    });
  }

  return payments;
}

// Assign payments to categories.
// Payment rows reference line items (e.g. "Zuzu Collective planning"); we need
// to figure out which category each belongs to. We do this by fetching the
// Budget Detail tab purely for its category→lineItem mapping — we don't use
// any amounts from it.
async function buildLineItemCategoryMap(sheetId) {
  let rows;
  try {
    rows = await fetchSheetRows(sheetId, 'Budget Detail');
  } catch {
    return new Map(); // If Budget Detail tab is missing, fall back to vendor matching
  }

  const { rowIdx: headerIdx, offset } = findHeaderRow(rows, 'Category', 'Line Item');
  if (headerIdx === -1) return new Map();

  const h   = rows[headerIdx];
  const col = { category: offset, lineItem: h.indexOf('Line Item') };

  const map = new Map(); // lineItemName → categoryTitle
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row      = rows[i];
    const catName  = row[col.category] || '';
    const lineItem = row[col.lineItem] || '';
    if (lineItem.toLowerCase().includes('subtotal') || lineItem.toLowerCase().includes('counted toward')) break;
    if (catName && lineItem && !lineItem.toLowerCase().includes('subtotal')) {
      map.set(lineItem, catName);
    }
  }
  return map;
}

// Public API — returns an array of category objects ready for DB insertion.
export async function importBudgetFromSheet(spreadsheetUrl) {
  const sheetId = extractSheetId(spreadsheetUrl);

  // Fetch everything in parallel
  const [overviewRows, paymentRows, lineItemCatMap] = await Promise.all([
    fetchSheetRows(sheetId, 'Overview'),
    fetchSheetRows(sheetId, 'Payments'),
    buildLineItemCategoryMap(sheetId),
  ]);

  const categories = parseOverviewCategories(overviewRows);
  const payments   = parsePayments(paymentRows);

  // Build a quick lookup: category title → category object
  const catByTitle = new Map(categories.map(c => [c.title, c]));
  for (const c of categories) c.lines = [];

  for (const p of payments) {
    // Find the category for this payment via the line item → category map.
    const catTitle = lineItemCatMap.get(p.lineItemName);
    const cat = catTitle ? catByTitle.get(catTitle) : null;
    if (cat) cat.lines.push(p);
  }

  return categories.map((cat, i) => ({
    ...cat,
    category_number: i + 1,
    position:        i + 1,
  }));
}
