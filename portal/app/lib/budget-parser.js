/**
 * Budget workbook parser — xlsx, csv, and (via anthropic.js) pdf.
 *
 * Returns a ParsedBudget:
 *   { categories, payments, rentals, warnings }
 *
 * categories[]
 *   title, vendor, estimated_cents, lines[]
 *     line: { name, vendor_label, amount_cents, paid_cents, status_kind, due_date }
 *
 * payments[]  (from Payments tab)
 *   { budgetLineItem, categoryTitle, vendor, payment, amount_cents,
 *     status_kind, paid_by, date_paid, due_date, notes }
 *
 * rentals[]   (from Rentals tab)
 *   { phase, item, qty, unit_price_cents, flat_price_cents,
 *     total_cents, rental_company, price_basis, notes }
 *
 * warnings[]  — strings about uncertain or skipped values
 */

import XLSX from 'xlsx';

// ── Currency helpers ───────────────────────────────────────────────────────

function parseCents(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return Math.round(raw * 100);
  const s = String(raw).replace(/[$,\s]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function parseDate(raw) {
  if (!raw) return null;
  // SheetJS may return a Date object (when cellDates:true)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  // Excel serial number
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'paid') return 'paid';
  return 'upcoming';
}

// ── Column finder ──────────────────────────────────────────────────────────
// Finds a column by matching header text (case-insensitive, trimmed).
// Throws if required and not found.

function makeColFinder(headerRow) {
  const headers = headerRow.map(h => String(h ?? '').trim().toLowerCase());
  return function col(name, required = false) {
    // Try exact match first, then partial match
    let idx = headers.findIndex(h => h === name.toLowerCase());
    if (idx === -1) {
      idx = headers.findIndex(h => h.includes(name.toLowerCase()));
    }
    if (idx === -1 && required) {
      throw new Error(`Required column "${name}" not found. Headers found: ${headerRow.filter(Boolean).join(', ')}`);
    }
    return idx; // -1 when not found and not required
  };
}

function cellVal(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  return row[idx] ?? '';
}

// ── Budget Detail tab ──────────────────────────────────────────────────────

function parseBudgetDetail(sheet, warnings) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', cellDates: true, raw: false });

  // Headers in row 6 (index 5)
  if (rows.length < 6) throw new Error('Budget Detail tab: not enough rows (expected headers in row 6).');
  const headerRow = rows[5];
  const col = makeColFinder(headerRow);

  const iCategory    = col('Category',              true);
  const iLineItem    = col('Line Item',             true);
  const iVendor      = col('Vendor',                true);
  const iEstimate    = col('Estimate',              true);
  const iContracted  = col('Contracted',            true);
  const iPaid        = col('Paid',                  true);
  const iPaidOverride = col('Paid (type to override)', false);
  const iBudget100k  = col('In $100K Budget?',      true);

  const categoryMap = new Map(); // title → { vendor, rows[], estimatedCents, contractedCents }

  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    const categoryVal = String(cellVal(row, iCategory)).trim();

    // Stop at TOTALS
    if (categoryVal.toUpperCase() === 'TOTALS') break;

    const lineItem = String(cellVal(row, iLineItem)).trim();

    // Skip rows with empty Line Item or subtotal rows
    if (!lineItem) continue;
    if (lineItem.toLowerCase().endsWith('subtotal')) continue;

    // Only rows where In $100K Budget? is "Yes" (case-insensitive)
    const inBudget = String(cellVal(row, iBudget100k)).trim().toLowerCase();
    if (inBudget !== 'yes') continue;

    const vendor      = String(cellVal(row, iVendor)).trim();
    const estimate    = parseCents(cellVal(row, iEstimate));
    const contracted  = parseCents(cellVal(row, iContracted));
    const paidRaw     = parseCents(cellVal(row, iPaid));
    const paidOverride = iPaidOverride >= 0 ? parseCents(cellVal(row, iPaidOverride)) : 0;
    const effectivePaid = paidOverride > 0 ? paidOverride : paidRaw;

    const title = categoryVal || (categoryMap.size > 0 ? [...categoryMap.keys()].at(-1) : 'Uncategorized');

    if (!categoryMap.has(title)) {
      categoryMap.set(title, { vendor: vendor || '', rows: [], estimatedCents: 0, contractedCents: 0 });
    }
    const cat = categoryMap.get(title);
    if (!cat.vendor && vendor) cat.vendor = vendor;

    cat.estimatedCents  += estimate;
    cat.contractedCents += contracted;
    cat.rows.push({ lineItem, vendor, estimate, contracted, effectivePaid });
  }

  if (categoryMap.size === 0) {
    warnings.push('Budget Detail tab: no qualifying rows found (check "In $100K Budget?" column).');
  }

  return categoryMap;
}

// ── Payments tab ───────────────────────────────────────────────────────────

function parsePayments(sheet, warnings) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', cellDates: true, raw: false });

  if (rows.length < 6) {
    warnings.push('Payments tab: not enough rows; skipping.');
    return [];
  }

  const headerRow = rows[5];
  const col = makeColFinder(headerRow);

  const iBudgetLineItem = col('Budget Line Item', true);
  const iDueDate        = col('Due Date',         false);
  const iVendor         = col('Vendor',           false);
  const iPayment        = col('Payment',          false);
  const iAmount         = col('Amount',           true);
  const iStatus         = col('Status',           true);
  const iPaidBy         = col('Paid By',          false);
  const iDatePaid       = col('Date Paid',        false);
  const iMethod         = col('Method',           false);
  const iNotes          = col('Notes',            false);

  const payments = [];

  // Data rows 7–34 (index 6–33) but stop early if Budget Line Item is empty
  const end = Math.min(rows.length, 34);
  for (let i = 6; i < end; i++) {
    const row = rows[i];
    const budgetLineItem = String(cellVal(row, iBudgetLineItem)).trim();
    if (!budgetLineItem) continue;

    const amount    = parseCents(cellVal(row, iAmount));
    const statusRaw = String(cellVal(row, iStatus)).trim().toLowerCase();
    const statusKind = statusRaw === 'paid' ? 'paid' : 'upcoming';
    const paidCents  = statusKind === 'paid' ? amount : 0;

    payments.push({
      budgetLineItem,
      dueDate:    iDueDate  >= 0 ? parseDate(cellVal(row, iDueDate))             : null,
      vendor:     iVendor   >= 0 ? String(cellVal(row, iVendor)).trim()          : '',
      payment:    iPayment  >= 0 ? String(cellVal(row, iPayment)).trim()         : '',
      amount_cents: amount,
      paid_cents:   paidCents,
      status_kind:  statusKind,
      paid_by:    iPaidBy   >= 0 ? String(cellVal(row, iPaidBy)).trim()          : '',
      date_paid:  iDatePaid >= 0 ? parseDate(cellVal(row, iDatePaid))            : null,
      method:     iMethod   >= 0 ? String(cellVal(row, iMethod)).trim()          : '',
      notes:      iNotes    >= 0 ? String(cellVal(row, iNotes)).trim()           : '',
    });
  }

  return payments;
}

// ── Rentals tab ────────────────────────────────────────────────────────────

const RENTAL_PHASES = new Set([
  'CEREMONY', 'COCKTAIL HOUR', 'RECEPTION',
  'SITE ESSENTIALS', 'TAX DELIVERY & DAMAGE WAIVER BUFFER',
]);

function parseRentals(sheet, warnings) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', cellDates: true, raw: false });

  if (rows.length < 6) {
    warnings.push('Rentals tab: not enough rows; skipping.');
    return [];
  }

  const headerRow = rows[5];
  const col = makeColFinder(headerRow);

  const iItem          = col('Item',           true);
  const iQty           = col('Qty',            false);
  const iUnitPrice     = col('Unit Price',     false);
  const iFlatPrice     = col('Flat Price',     false);
  const iTotal         = col('Total',          true);
  const iRentalCompany = col('Rental Company', false);
  const iPriceBasis    = col('Price Basis',    false);
  const iNotes         = col('Notes',          false);

  const rentals = [];
  let currentPhase = '';

  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    const item = String(cellVal(row, iItem)).trim();

    if (!item) continue;

    // Stop at RENTAL TOTALS
    if (item.toUpperCase().includes('RENTAL TOTALS')) break;

    // Detect phase banner: all-caps item with all other key columns empty
    const isBanner = item === item.toUpperCase() && RENTAL_PHASES.has(item.toUpperCase());
    if (isBanner) {
      currentPhase = item.toUpperCase();
      continue;
    }

    // Skip subtotal rows — typically all-caps without being a known phase
    // or rows where total is empty
    const totalVal = cellVal(row, iTotal);
    if (!totalVal && !parseCents(totalVal)) continue;

    rentals.push({
      phase:            currentPhase,
      item,
      qty:              iQty          >= 0 ? Number(cellVal(row, iQty)) || null  : null,
      unit_price_cents: iUnitPrice    >= 0 ? parseCents(cellVal(row, iUnitPrice)) : 0,
      flat_price_cents: iFlatPrice    >= 0 ? parseCents(cellVal(row, iFlatPrice)) : 0,
      total_cents:      parseCents(totalVal),
      rental_company:   iRentalCompany >= 0 ? String(cellVal(row, iRentalCompany)).trim() : '',
      price_basis:      iPriceBasis   >= 0 ? String(cellVal(row, iPriceBasis)).trim()    : '',
      notes:            iNotes        >= 0 ? String(cellVal(row, iNotes)).trim()         : '',
    });
  }

  return rentals;
}

// ── Assemble parsed budget ─────────────────────────────────────────────────
// Merge Budget Detail, Payments, and Rentals into the ParsedBudget shape.

function assemble(categoryMap, payments, rentals, warnings) {
  // Build lookup: line item name → category title (for matching Payments)
  const lineItemToCategory = new Map();
  for (const [title, cat] of categoryMap) {
    for (const r of cat.rows) {
      lineItemToCategory.set(r.lineItem.toLowerCase(), title);
    }
  }

  // Group payments by category
  const paymentsByCategory = new Map();
  for (const p of payments) {
    const catTitle = lineItemToCategory.get(p.budgetLineItem.toLowerCase()) || null;
    if (!catTitle) {
      warnings.push(`Payment row "${p.budgetLineItem}" didn't match any Budget Detail line item — skipped.`);
      continue;
    }
    if (!paymentsByCategory.has(catTitle)) paymentsByCategory.set(catTitle, []);
    paymentsByCategory.get(catTitle).push(p);
  }

  // Group rentals by phase → synthetic category
  const rentalCategories = [];
  const rentalsByPhase = new Map();
  for (const r of rentals) {
    const phase = r.phase || 'GENERAL';
    if (!rentalsByPhase.has(phase)) rentalsByPhase.set(phase, []);
    rentalsByPhase.get(phase).push(r);
  }
  for (const [phase, items] of rentalsByPhase) {
    const phaseLabel = phase === 'GENERAL' ? 'Rentals' : `Rentals — ${toTitleCase(phase)}`;
    const firstCompany = items.find(i => i.rental_company)?.rental_company || '';
    rentalCategories.push({
      title: phaseLabel,
      vendor: firstCompany,
      estimated_cents: 0,
      lines: items.map((item, idx) => ({
        name: item.item + (item.qty ? ` (×${item.qty})` : ''),
        vendor_label: item.rental_company || null,
        amount_cents: item.total_cents,
        paid_cents: 0,
        status_kind: 'upcoming',
        due_date: null,
        position: idx + 1,
      })),
    });
  }

  // Build final categories from Budget Detail
  const categories = [];
  let position = 1;
  for (const [title, cat] of categoryMap) {
    const hasContracted = cat.contractedCents > 0;
    const catPayments = paymentsByCategory.get(title) || [];

    let lines;
    if (catPayments.length > 0) {
      // Use Payments tab entries as line items (they have due dates)
      lines = catPayments.map((p, idx) => ({
        name: p.payment || p.budgetLineItem,
        vendor_label: p.vendor || null,
        amount_cents: p.amount_cents,
        paid_cents: p.paid_cents,
        status_kind: p.status_kind,
        due_date: p.dueDate,
        position: idx + 1,
      }));
    } else {
      // No Payments tab entries — create one line item per Budget Detail row
      lines = cat.rows.map((r, idx) => ({
        name: r.lineItem,
        vendor_label: r.vendor !== cat.vendor ? r.vendor || null : null,
        amount_cents: r.contracted,
        paid_cents: r.effectivePaid,
        status_kind: r.effectivePaid >= r.contracted && r.contracted > 0 ? 'paid' : 'upcoming',
        due_date: null,
        position: idx + 1,
      }));
    }

    categories.push({
      title,
      vendor: cat.vendor,
      estimated_cents: hasContracted ? 0 : cat.estimatedCents,
      lines,
      position: position++,
    });
  }

  // Append rental categories at the end
  for (const rc of rentalCategories) {
    categories.push({ ...rc, position: position++ });
  }

  return { categories, warnings };
}

function toTitleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Public API ─────────────────────────────────────────────────────────────

export function parseBudgetExcel(buffer) {
  const warnings = [];
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  // Verify required tabs exist
  const sheetNames = wb.SheetNames.map(n => n.trim());
  const findSheet = name => {
    const match = sheetNames.find(n => n.toLowerCase() === name.toLowerCase());
    if (!match) throw new Error(`Required tab "${name}" not found. Tabs in file: ${sheetNames.join(', ')}`);
    return wb.Sheets[match];
  };

  const detailSheet  = findSheet('Budget Detail');
  const paymentsSheet = findSheet('Payments');
  let rentalsSheet;
  try { rentalsSheet = findSheet('Rentals'); }
  catch (_) { warnings.push('Rentals tab not found — rental items skipped.'); }

  const categoryMap = parseBudgetDetail(detailSheet, warnings);
  const payments    = parsePayments(paymentsSheet, warnings);
  const rentals     = rentalsSheet ? parseRentals(rentalsSheet, warnings) : [];

  const { categories } = assemble(categoryMap, payments, rentals, warnings);
  return { categories, warnings };
}

export function parseBudgetCsv(buffer) {
  const warnings = [];
  warnings.push('CSV import: only Budget Detail data is available. Payments and Rentals tabs require the full .xlsx file.');

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('CSV file appears to be empty.');

  const sheet = wb.Sheets[sheetName];
  const categoryMap = parseBudgetDetail(sheet, warnings);
  const { categories } = assemble(categoryMap, [], [], warnings);
  return { categories, warnings };
}

export function parseBudgetFile(buffer, mimeType) {
  // xlsx / Excel
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return parseBudgetExcel(buffer);
  }
  // csv
  if (mimeType === 'text/csv' || mimeType === 'text/plain') {
    return parseBudgetCsv(buffer);
  }
  throw new Error(`Unsupported file type: ${mimeType}. Upload .xlsx or .csv.`);
}

// ── Summary helpers (used by both preview and save) ────────────────────────

export function summarizeParsed(parsed) {
  let lineItems = 0;
  let plannedCents = 0;
  let paidCents = 0;
  let rentalLines = 0;

  for (const cat of parsed.categories) {
    if (cat.title.startsWith('Rentals')) {
      rentalLines += cat.lines.length;
    } else {
      lineItems += cat.lines.length;
    }
    for (const l of cat.lines) {
      plannedCents += l.amount_cents;
      paidCents    += l.paid_cents;
    }
    plannedCents += cat.estimated_cents;
  }

  return {
    categoryCount: parsed.categories.filter(c => !c.title.startsWith('Rentals')).length,
    rentalCategoryCount: parsed.categories.filter(c => c.title.startsWith('Rentals')).length,
    lineItemCount: lineItems,
    rentalLineCount: rentalLines,
    plannedCents,
    paidCents,
    owedCents: Math.max(0, plannedCents - paidCents),
  };
}
