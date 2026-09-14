// Imports budget data from a Zuzu Collective Google Sheet into the DB format.
//
// Uses the Google Visualization (gviz) API — no API key required as long as
// the sheet is shared as "Anyone with the link can view".
//
// Expects the sheet to have two tabs named "Budget Detail" and "Payments"
// matching the standard Zuzu budget template.

const GVIZ_BASE = 'https://docs.google.com/spreadsheets/d';

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error('Invalid Google Sheets URL — could not find spreadsheet ID.');
  return m[1];
}

async function fetchSheetRows(sheetId, sheetName) {
  const url = `${GVIZ_BASE}/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Could not fetch sheet "${sheetName}" (HTTP ${res.status}). Make sure the sheet is shared as "Anyone with the link can view".`);

  const text = await res.text();
  const match = text.match(/setResponse\(([\s\S]+?)\)\s*;?\s*$/);
  if (!match) throw new Error(`Unexpected response from Google for sheet "${sheetName}".`);

  const payload = JSON.parse(match[1]);
  if (payload.status !== 'ok') {
    const msg = payload.errors?.[0]?.detailed_message || payload.errors?.[0]?.message || 'Unknown error';
    throw new Error(`Google Sheets error for "${sheetName}": ${msg}`);
  }

  // Convert gviz table to a simple 2D string array.
  return (payload.table?.rows || []).map(row =>
    (row.c || []).map(cell => {
      if (!cell) return '';
      // Prefer the formatted string value (f); fall back to raw value (v).
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
  // Shift by timezone offset so "Aug 28, 2027" doesn't become Aug 27 in UTC
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function findHeaderRow(rows, col0Value) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === col0Value) return i;
  }
  return -1;
}

function parseBudgetDetail(rows) {
  const headerIdx = findHeaderRow(rows, 'Category');
  if (headerIdx === -1) throw new Error('Cannot find the "Category" header row in the Budget Detail sheet. Make sure the tab is named "Budget Detail".');

  const h = rows[headerIdx];
  const col = {
    category:  0,
    lineItem:  h.indexOf('Line Item'),
    status:    h.indexOf('Status'),
    estimate:  h.indexOf('Estimate'),
    contracted: h.indexOf('Contracted'),
    inBudget:  h.indexOf('In $100K Budget?'),
  };

  const catMap  = new Map(); // title → { contracted_cents, estimated_cents, lineItemNames[] }
  const catOrder = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const catName  = row[0] || '';
    const lineItem = row[col.lineItem] || '';

    // Stop at the totals block
    if (lineItem.toLowerCase().includes('counted toward') ||
        lineItem.toLowerCase().includes('tracked outside')) break;
    // Skip subtotal rows
    if (lineItem.toLowerCase().includes('subtotal')) continue;
    // Skip rows without both a category and a line item
    if (!catName || !lineItem) continue;
    // Skip items outside the main budget
    if (col.inBudget >= 0 && row[col.inBudget] !== 'Yes') continue;

    if (!catMap.has(catName)) {
      catMap.set(catName, { contracted_cents: 0, estimated_cents: 0, lineItemNames: [] });
      catOrder.push(catName);
    }

    const cat = catMap.get(catName);
    const contracted = parseCents(row[col.contracted]);
    const estimate   = parseCents(row[col.estimate]);

    if (contracted > 0) {
      cat.contracted_cents += contracted;
    } else {
      cat.estimated_cents += estimate;
    }
    cat.lineItemNames.push(lineItem);
  }

  return { catMap, catOrder };
}

function parsePayments(rows) {
  const headerIdx = findHeaderRow(rows, 'Budget Line Item');
  if (headerIdx === -1) throw new Error('Cannot find the "Budget Line Item" header row in the Payments sheet. Make sure the tab is named "Payments".');

  const h   = rows[headerIdx];
  const col = {
    lineItem: 0,
    dueDate:  h.indexOf('Due Date'),
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
    if (lineItem === 'Total scheduled' || lineItem === 'Paid' || lineItem === 'Still to pay') break;
    if (!lineItem || !amount) continue;

    const isPaid = (row[col.status] || '').toLowerCase() === 'paid';
    payments.push({
      lineItemName: lineItem,
      name:         row[col.payment] || lineItem,
      due_date:     parseDate(row[col.dueDate]),
      amount_cents: amount,
      paid_cents:   isPaid ? amount : 0,
      status_kind:  isPaid ? 'paid' : 'upcoming',
    });
  }

  return payments;
}

// Public API — returns an array of category objects ready for DB insertion.
export async function importBudgetFromSheet(spreadsheetUrl) {
  const sheetId = extractSheetId(spreadsheetUrl);

  const [detailRows, paymentRows] = await Promise.all([
    fetchSheetRows(sheetId, 'Budget Detail'),
    fetchSheetRows(sheetId, 'Payments'),
  ]);

  const { catMap, catOrder } = parseBudgetDetail(detailRows);
  const payments = parsePayments(paymentRows);

  // Match each payment row to its category via the line item name.
  const catPayments = new Map();
  for (const p of payments) {
    let found = null;
    for (const [catTitle, catData] of catMap) {
      if (catData.lineItemNames.includes(p.lineItemName)) { found = catTitle; break; }
    }
    if (!found) continue;
    if (!catPayments.has(found)) catPayments.set(found, []);
    catPayments.get(found).push(p);
  }

  return catOrder.map((title, i) => {
    const cat = catMap.get(title);
    return {
      title,
      category_number: i + 1,
      position:        i + 1,
      contracted_cents: cat.contracted_cents,
      estimated_cents:  cat.estimated_cents,
      lines: catPayments.get(title) || [],
    };
  });
}
