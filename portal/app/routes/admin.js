// Admin routes — Zoe-facing, /admin/*.
//
// Phase 3a only handles couples (login, list, create, edit, delete).
// Phases 3b–3g add per-section CRUD (vendors, guests, budget, etc.)
// off the same /admin/couples/:id/* prefix.
//
// One user, one password (env: ADMIN_PASSWORD), session-cookie auth
// (express-session, signed with SESSION_SECRET).

import express from 'express';
import { pool } from '../db/pool.js';
import { requireAdmin, passwordsMatch } from '../middleware/auth.js';

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

// Pull the flash off the session at render time so it only shows once.
function consumeFlash(req) {
  const flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  return flash;
}

// Single source of truth for what the admin can edit on a couple. Used
// for both create and update — keeps the form, validation, and the SQL
// in sync.
const COUPLE_FIELDS = [
  'slug',
  'display_name',
  'wedding_date',
  'venue_name',
  'venue_location',
  'palette_color_1', 'palette_color_1_name',
  'palette_color_2', 'palette_color_2_name',
  'palette_color_3', 'palette_color_3_name',
  'palette_color_4', 'palette_color_4_name',
  'tone_keywords',
  'tone_statement',
  'hero_subtitle',
  'intro_text',
  'intro_tagline',
  'budget_total_cents',
  'timeline_ceremony_time',
  'timeline_ceremony_note',
  'timeline_lastcall_time',
  'timeline_lastcall_note',
];

// Currency parsing — admin enters dollars (e.g. "120000", "$120,000",
// "1234.56"); database stores integer cents. Empty / unparseable input
// resolves to 0 so the not-null default holds.
function dollarsToCents(input) {
  if (input === '' || input === null || input === undefined) return 0;
  const cleaned = String(input).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

// Coerce empty strings on optional fields back to null so the database
// keeps its NULLs honest. Required fields (slug, display_name,
// wedding_date) get validated before this runs.
function pickCoupleFields(body) {
  const out = {};
  for (const f of COUPLE_FIELDS) {
    const v = body[f];
    if (f === 'budget_total_cents') {
      out[f] = dollarsToCents(v);
    } else {
      out[f] = v === '' || v === undefined ? null : v;
    }
  }
  return out;
}

// ── Login / logout ─────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin');
  res.render('admin/login', {
    next: req.query.next || '/admin',
    error: null,
    flash: consumeFlash(req),
  });
});

router.post('/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return res
      .status(500)
      .send('ADMIN_PASSWORD is not set on the server. Set it in Render env vars and redeploy.');
  }

  const submitted = req.body.password ?? '';
  if (!passwordsMatch(submitted, expected)) {
    return res.status(401).render('admin/login', {
      next: req.body.next || '/admin',
      error: 'Wrong password.',
      flash: null,
    });
  }

  req.session.isAdmin = true;
  // Regenerate the session id on login to harden against fixation.
  req.session.save(() => {
    res.redirect(req.body.next || '/admin');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ── Everything below requires admin ─────────────────────────────────────

router.use(requireAdmin);

// Couples list — the admin's home page.
router.get('/', async (_req, res, next) => {
  try {
    const { rows: couples } = await pool.query(
      'select id, slug, display_name, wedding_date, venue_name, venue_location, updated_at from couples order by wedding_date asc',
    );
    res.render('admin/couples-list', {
      couples,
      flash: consumeFlash(_req),
    });
  } catch (err) {
    next(err);
  }
});

// New couple form
router.get('/couples/new', (req, res) => {
  res.render('admin/couple-form', {
    couple: null,                 // null => "new" mode
    formAction: '/admin/couples',
    error: null,
    flash: consumeFlash(req),
  });
});

// Create couple
router.post('/couples', async (req, res, next) => {
  try {
    const data = pickCoupleFields(req.body);
    if (!data.slug || !data.display_name || !data.wedding_date) {
      return res.status(400).render('admin/couple-form', {
        couple: { ...data },
        formAction: '/admin/couples',
        error: 'Slug, display name, and wedding date are required.',
        flash: null,
      });
    }

    const cols = COUPLE_FIELDS.join(', ');
    const placeholders = COUPLE_FIELDS.map((_, i) => `$${i + 1}`).join(', ');
    const values = COUPLE_FIELDS.map(f => data[f]);

    const { rows } = await pool.query(
      `insert into couples (${cols}) values (${placeholders}) returning id, slug`,
      values,
    );
    setFlash(req, 'success', `Created portal for ${data.display_name}.`);
    res.redirect(`/admin/couples/${rows[0].id}`);
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation on slug
      return res.status(400).render('admin/couple-form', {
        couple: { ...req.body },
        formAction: '/admin/couples',
        error: 'That slug is already in use. Pick a different one.',
        flash: null,
      });
    }
    next(err);
  }
});

// Edit couple form
router.get('/couples/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from couples where id = $1', [
      req.params.id,
    ]);
    if (!rows[0]) return res.status(404).send('Couple not found.');
    res.render('admin/couple-form', {
      couple: rows[0],
      formAction: `/admin/couples/${rows[0].id}`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

// Update couple
router.post('/couples/:id', async (req, res, next) => {
  try {
    const data = pickCoupleFields(req.body);
    if (!data.slug || !data.display_name || !data.wedding_date) {
      return res.status(400).render('admin/couple-form', {
        couple: { id: req.params.id, ...data },
        formAction: `/admin/couples/${req.params.id}`,
        error: 'Slug, display name, and wedding date are required.',
        flash: null,
      });
    }

    const setClause = COUPLE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = [...COUPLE_FIELDS.map(f => data[f]), req.params.id];

    const { rowCount } = await pool.query(
      `update couples set ${setClause}, updated_at = now() where id = $${COUPLE_FIELDS.length + 1}`,
      values,
    );
    if (rowCount === 0) return res.status(404).send('Couple not found.');

    setFlash(req, 'success', `Saved changes to ${data.display_name}.`);
    res.redirect(`/admin/couples/${req.params.id}`);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('admin/couple-form', {
        couple: { id: req.params.id, ...req.body },
        formAction: `/admin/couples/${req.params.id}`,
        error: 'That slug is already in use by another couple.',
        flash: null,
      });
    }
    next(err);
  }
});

// ── Vendors (per couple) ──────────────────────────────────────────────

// Helper — confirm a couple exists for the given id, return it or null.
async function findCoupleById(id) {
  const { rows } = await pool.query('select * from couples where id = $1', [id]);
  return rows[0] ?? null;
}

const VENDOR_FIELDS = [
  'vendor_type',
  'display_name',
  'contact_name',
  'phone',
  'email',
  'address',
  'status',
  'note',
  'position',
];

const VENDOR_STATUSES = ['booked', 'shortlist', 'pending', 'na'];

const COMMON_VENDOR_TYPES = [
  'Venue', 'Caterer', 'Photographer', 'Videographer', 'Florist', 'DJ',
  'Band', 'Wedding Planner', 'Officiant', 'Hair Stylist', 'Makeup Artist',
  'Transportation', 'Baker / Cake', 'Hotel (Room Block)',
  'Rehearsal Dinner Venue', 'Honeymoon Hotel', 'Honeymoon Airline',
];

function pickVendorFields(body) {
  const out = {};
  for (const f of VENDOR_FIELDS) {
    let v = body[f];
    if (f === 'position') {
      v = parseInt(v, 10);
      if (Number.isNaN(v)) v = 0;
    } else {
      v = v === '' || v === undefined ? null : v;
    }
    out[f] = v;
  }
  if (!VENDOR_STATUSES.includes(out.status)) out.status = 'pending';
  return out;
}

// List vendors for a couple
router.get('/couples/:id/vendors', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: vendors } = await pool.query(
      'select * from vendors where couple_id = $1 order by position asc, vendor_type asc',
      [couple.id],
    );
    res.render('admin/vendors-list', {
      couple,
      vendors,
      flash: consumeFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

// New vendor form
router.get('/couples/:id/vendors/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    res.render('admin/vendor-form', {
      couple,
      vendor: null,
      formAction: `/admin/couples/${couple.id}/vendors`,
      vendorTypes: COMMON_VENDOR_TYPES,
      statuses: VENDOR_STATUSES,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

// Create vendor
router.post('/couples/:id/vendors', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const data = pickVendorFields(req.body);
    if (!data.vendor_type) {
      return res.status(400).render('admin/vendor-form', {
        couple,
        vendor: { ...data },
        formAction: `/admin/couples/${couple.id}/vendors`,
        vendorTypes: COMMON_VENDOR_TYPES,
        statuses: VENDOR_STATUSES,
        error: 'Vendor type is required.',
        flash: null,
      });
    }

    const cols = ['couple_id', ...VENDOR_FIELDS];
    const values = [couple.id, ...VENDOR_FIELDS.map(f => data[f])];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    await pool.query(
      `insert into vendors (${cols.join(', ')}) values (${placeholders})`,
      values,
    );
    setFlash(req, 'success', `Added ${data.display_name || data.vendor_type}.`);
    res.redirect(`/admin/couples/${couple.id}/vendors`);
  } catch (err) {
    next(err);
  }
});

// Edit vendor form
router.get('/couples/:id/vendors/:vid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows } = await pool.query(
      'select * from vendors where id = $1 and couple_id = $2',
      [req.params.vid, couple.id],
    );
    if (!rows[0]) return res.status(404).send('Vendor not found.');

    res.render('admin/vendor-form', {
      couple,
      vendor: rows[0],
      formAction: `/admin/couples/${couple.id}/vendors/${rows[0].id}`,
      vendorTypes: COMMON_VENDOR_TYPES,
      statuses: VENDOR_STATUSES,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) {
    next(err);
  }
});

// Update vendor
router.post('/couples/:id/vendors/:vid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const data = pickVendorFields(req.body);
    const setClause = VENDOR_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = [...VENDOR_FIELDS.map(f => data[f]), req.params.vid, couple.id];

    const { rowCount } = await pool.query(
      `update vendors set ${setClause}, updated_at = now() where id = $${VENDOR_FIELDS.length + 1} and couple_id = $${VENDOR_FIELDS.length + 2}`,
      values,
    );
    if (rowCount === 0) return res.status(404).send('Vendor not found.');

    setFlash(req, 'success', `Saved changes to ${data.display_name || data.vendor_type}.`);
    res.redirect(`/admin/couples/${couple.id}/vendors`);
  } catch (err) {
    next(err);
  }
});

// Delete vendor
router.post('/couples/:id/vendors/:vid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from vendors where id = $1 and couple_id = $2 returning vendor_type, display_name',
      [req.params.vid, req.params.id],
    );
    if (rows[0]) {
      const label = rows[0].display_name || rows[0].vendor_type;
      setFlash(req, 'success', `Removed ${label}.`);
    }
    res.redirect(`/admin/couples/${req.params.id}/vendors`);
  } catch (err) {
    next(err);
  }
});

// ── Tables (per couple) ───────────────────────────────────────────────

const TABLE_FIELDS = ['table_number', 'table_name', 'capacity', 'role', 'note', 'position'];
const TABLE_ROLES = ['standard', 'head', 'kids'];

function pickTableFields(body) {
  const out = {};
  for (const f of TABLE_FIELDS) {
    let v = body[f];
    if (f === 'table_number' || f === 'capacity' || f === 'position') {
      v = parseInt(v, 10);
      if (Number.isNaN(v)) v = f === 'capacity' ? 8 : 0;
    } else {
      v = v === '' || v === undefined ? null : v;
    }
    out[f] = v;
  }
  if (!TABLE_ROLES.includes(out.role)) out.role = 'standard';
  return out;
}

router.get('/couples/:id/tables', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: tables } = await pool.query(
      `select t.*,
              (select count(*)::int from guests g where g.table_id = t.id) as filled
         from tables t
        where t.couple_id = $1
        order by t.position asc, t.table_number asc`,
      [couple.id],
    );
    res.render('admin/tables-list', {
      couple,
      tables,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/tables/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    res.render('admin/table-form', {
      couple,
      table: null,
      formAction: `/admin/couples/${couple.id}/tables`,
      roles: TABLE_ROLES,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/tables', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const data = pickTableFields(req.body);
    if (!data.table_number) {
      return res.status(400).render('admin/table-form', {
        couple, table: { ...data },
        formAction: `/admin/couples/${couple.id}/tables`,
        roles: TABLE_ROLES,
        error: 'Table number is required.',
        flash: null,
      });
    }

    const cols = ['couple_id', ...TABLE_FIELDS];
    const values = [couple.id, ...TABLE_FIELDS.map(f => data[f])];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    await pool.query(`insert into tables (${cols.join(', ')}) values (${placeholders})`, values);
    setFlash(req, 'success', `Added Table ${String(data.table_number).padStart(2, '0')}${data.table_name ? ' · ' + data.table_name : ''}.`);
    res.redirect(`/admin/couples/${couple.id}/tables`);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('admin/table-form', {
        couple: await findCoupleById(req.params.id),
        table: { ...req.body },
        formAction: `/admin/couples/${req.params.id}/tables`,
        roles: TABLE_ROLES,
        error: 'That table number is already in use for this couple.',
        flash: null,
      });
    }
    next(err);
  }
});

router.get('/couples/:id/tables/:tid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows } = await pool.query(
      'select * from tables where id = $1 and couple_id = $2',
      [req.params.tid, couple.id],
    );
    if (!rows[0]) return res.status(404).send('Table not found.');

    res.render('admin/table-form', {
      couple,
      table: rows[0],
      formAction: `/admin/couples/${couple.id}/tables/${rows[0].id}`,
      roles: TABLE_ROLES,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/tables/:tid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const data = pickTableFields(req.body);
    const setClause = TABLE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = [...TABLE_FIELDS.map(f => data[f]), req.params.tid, couple.id];

    const { rowCount } = await pool.query(
      `update tables set ${setClause}, updated_at = now() where id = $${TABLE_FIELDS.length + 1} and couple_id = $${TABLE_FIELDS.length + 2}`,
      values,
    );
    if (rowCount === 0) return res.status(404).send('Table not found.');

    setFlash(req, 'success', `Saved changes to Table ${String(data.table_number).padStart(2, '0')}.`);
    res.redirect(`/admin/couples/${couple.id}/tables`);
  } catch (err) { next(err); }
});

router.post('/couples/:id/tables/:tid/delete', async (req, res, next) => {
  try {
    await pool.query(
      'delete from tables where id = $1 and couple_id = $2',
      [req.params.tid, req.params.id],
    );
    setFlash(req, 'success', 'Table removed. Anyone seated there is now unseated.');
    res.redirect(`/admin/couples/${req.params.id}/tables`);
  } catch (err) { next(err); }
});

// ── Households (per couple, with embedded guests) ─────────────────────

const HOUSEHOLD_STATUSES = ['accepted', 'awaiting', 'declined'];
const GUEST_TYPES = ['adult', 'child', 'plus_one'];

router.get('/couples/:id/guests', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: households } = await pool.query(
      `select h.*,
              coalesce((select count(*)::int from guests g where g.household_id = h.id), 0) as guest_count
         from households h
        where h.couple_id = $1
        order by h.position asc`,
      [couple.id],
    );
    res.render('admin/households-list', {
      couple,
      households,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/guests/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: tables } = await pool.query(
      'select id, table_number, table_name from tables where couple_id = $1 order by position asc',
      [couple.id],
    );

    res.render('admin/household-form', {
      couple,
      household: null,
      guests: [],
      tables,
      formAction: `/admin/couples/${couple.id}/guests`,
      statuses: HOUSEHOLD_STATUSES,
      guestTypes: GUEST_TYPES,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/guests/:hid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: householdRows } = await pool.query(
      'select * from households where id = $1 and couple_id = $2',
      [req.params.hid, couple.id],
    );
    if (!householdRows[0]) return res.status(404).send('Household not found.');

    const [{ rows: guests }, { rows: tables }] = await Promise.all([
      pool.query('select * from guests where household_id = $1 order by position asc', [householdRows[0].id]),
      pool.query('select id, table_number, table_name from tables where couple_id = $1 order by position asc', [couple.id]),
    ]);

    res.render('admin/household-form', {
      couple,
      household: householdRows[0],
      guests,
      tables,
      formAction: `/admin/couples/${couple.id}/guests/${householdRows[0].id}`,
      statuses: HOUSEHOLD_STATUSES,
      guestTypes: GUEST_TYPES,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// Body shape from the household form:
//   display_name, side, status, note, position
//   guests[] = array of { id?, display_name, guest_type, table_id, position }
// Empty guest rows (display_name blank) are skipped.
function parseGuestsFromBody(body) {
  // express.urlencoded with extended:true returns guest rows as arrays
  // when named guests[0][field], guests[1][field], etc.
  const raw = body.guests || {};
  const indices = Object.keys(raw).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(g => g && g.display_name && g.display_name.trim().length > 0)
    .map((g, idx) => ({
      id: g.id || null,
      display_name: g.display_name.trim(),
      guest_type: GUEST_TYPES.includes(g.guest_type) ? g.guest_type : 'adult',
      table_id: g.table_id && g.table_id !== '' ? g.table_id : null,
      position: idx + 1,
    }));
}

router.post('/couples/:id/guests', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const householdData = {
      display_name: req.body.display_name?.trim() || '',
      side: req.body.side?.trim() || null,
      status: HOUSEHOLD_STATUSES.includes(req.body.status) ? req.body.status : 'awaiting',
      note: req.body.note?.trim() || null,
      position: parseInt(req.body.position, 10) || 0,
    };
    const guests = parseGuestsFromBody(req.body);

    if (!householdData.display_name) {
      return res.status(400).render('admin/household-form', {
        couple,
        household: householdData,
        guests,
        tables: (await pool.query(
          'select id, table_number, table_name from tables where couple_id = $1 order by position asc',
          [couple.id],
        )).rows,
        formAction: `/admin/couples/${couple.id}/guests`,
        statuses: HOUSEHOLD_STATUSES,
        guestTypes: GUEST_TYPES,
        error: 'Household display name is required.',
        flash: null,
      });
    }

    await client.query('begin');
    const { rows } = await client.query(
      `insert into households (couple_id, display_name, side, status, note, position)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [couple.id, householdData.display_name, householdData.side, householdData.status, householdData.note, householdData.position],
    );
    const householdId = rows[0].id;

    for (const g of guests) {
      await client.query(
        `insert into guests (household_id, display_name, guest_type, table_id, position)
         values ($1, $2, $3, $4, $5)`,
        [householdId, g.display_name, g.guest_type, g.table_id, g.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Added ${householdData.display_name} (${guests.length} guest${guests.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/guests`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/guests/:hid', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const householdData = {
      display_name: req.body.display_name?.trim() || '',
      side: req.body.side?.trim() || null,
      status: HOUSEHOLD_STATUSES.includes(req.body.status) ? req.body.status : 'awaiting',
      note: req.body.note?.trim() || null,
      position: parseInt(req.body.position, 10) || 0,
    };
    const guests = parseGuestsFromBody(req.body);

    if (!householdData.display_name) {
      return res.status(400).redirect(`/admin/couples/${couple.id}/guests/${req.params.hid}`);
    }

    await client.query('begin');

    const { rowCount } = await client.query(
      `update households set
         display_name = $1, side = $2, status = $3, note = $4,
         position = $5, updated_at = now()
       where id = $6 and couple_id = $7`,
      [householdData.display_name, householdData.side, householdData.status, householdData.note, householdData.position, req.params.hid, couple.id],
    );
    if (rowCount === 0) {
      await client.query('rollback');
      return res.status(404).send('Household not found.');
    }

    // Replace the full guest list — simpler than diffing. Cascade
    // protects the household, only its guests get re-inserted.
    await client.query('delete from guests where household_id = $1', [req.params.hid]);
    for (const g of guests) {
      await client.query(
        `insert into guests (household_id, display_name, guest_type, table_id, position)
         values ($1, $2, $3, $4, $5)`,
        [req.params.hid, g.display_name, g.guest_type, g.table_id, g.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved ${householdData.display_name}.`);
    res.redirect(`/admin/couples/${couple.id}/guests`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/guests/:hid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from households where id = $1 and couple_id = $2 returning display_name',
      [req.params.hid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].display_name}.`);
    res.redirect(`/admin/couples/${req.params.id}/guests`);
  } catch (err) { next(err); }
});

// ── Budget (per couple — categories with inline line items) ───────────

const BUDGET_STATUS_KINDS = ['paid', 'deposited', 'upcoming'];

// Body shape from the category form:
//   category_number, title, title_emphasis, estimated_cents (as dollars), position
//   lines[i] = { id?, name, vendor_label, amount_cents (dollars),
//                paid_cents (dollars), status_kind, status_label, position }
// Empty rows (no name) are dropped.
function parseLinesFromBody(body) {
  const raw = body.lines || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(l => l && l.name && l.name.trim().length > 0)
    .map((l, idx) => ({
      id: l.id || null,
      name: l.name.trim(),
      vendor_label: l.vendor_label?.trim() || null,
      amount_cents: dollarsToCents(l.amount_cents),
      paid_cents: dollarsToCents(l.paid_cents),
      status_kind: BUDGET_STATUS_KINDS.includes(l.status_kind) ? l.status_kind : 'upcoming',
      status_label: l.status_label?.trim() || null,
      position: idx + 1,
    }));
}

// List categories — the budget tab's index page for a couple.
router.get('/couples/:id/budget', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: categories } = await pool.query(
      `select c.*,
              coalesce(sums.line_count, 0)::int as line_count,
              coalesce(sums.actual_cents, 0)::int as actual_cents
         from budget_categories c
         left join (
           select category_id,
                  count(*) as line_count,
                  sum(paid_cents) as actual_cents
             from budget_line_items
            group by category_id
         ) sums on sums.category_id = c.id
        where c.couple_id = $1
        order by c.position asc, c.category_number asc`,
      [couple.id],
    );
    res.render('admin/budget-categories-list', {
      couple,
      categories,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// New category form
router.get('/couples/:id/budget/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    // Suggest the next available category number so Zoe doesn't have
    // to look up where the list ends.
    const { rows } = await pool.query(
      'select coalesce(max(category_number), 0) + 1 as next_num from budget_categories where couple_id = $1',
      [couple.id],
    );

    res.render('admin/budget-category-form', {
      couple,
      category: null,
      lines: [],
      suggestedNumber: rows[0].next_num,
      formAction: `/admin/couples/${couple.id}/budget`,
      statusKinds: BUDGET_STATUS_KINDS,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// Edit category form
router.get('/couples/:id/budget/:cid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: catRows } = await pool.query(
      'select * from budget_categories where id = $1 and couple_id = $2',
      [req.params.cid, couple.id],
    );
    if (!catRows[0]) return res.status(404).send('Category not found.');

    const { rows: lines } = await pool.query(
      'select * from budget_line_items where category_id = $1 order by position asc',
      [catRows[0].id],
    );

    res.render('admin/budget-category-form', {
      couple,
      category: catRows[0],
      lines,
      suggestedNumber: catRows[0].category_number,
      formAction: `/admin/couples/${couple.id}/budget/${catRows[0].id}`,
      statusKinds: BUDGET_STATUS_KINDS,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// Create category (with inline line items)
router.post('/couples/:id/budget', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const categoryData = {
      category_number: parseInt(req.body.category_number, 10),
      title: req.body.title?.trim() || '',
      title_emphasis: req.body.title_emphasis?.trim() || null,
      estimated_cents: dollarsToCents(req.body.estimated_cents),
      position: parseInt(req.body.position, 10) || 0,
    };
    const lines = parseLinesFromBody(req.body);

    if (!categoryData.title || !categoryData.category_number) {
      return res.status(400).render('admin/budget-category-form', {
        couple,
        category: categoryData,
        lines,
        suggestedNumber: categoryData.category_number || 1,
        formAction: `/admin/couples/${couple.id}/budget`,
        statusKinds: BUDGET_STATUS_KINDS,
        error: 'Category number and title are required.',
        flash: null,
      });
    }

    await client.query('begin');
    const { rows } = await client.query(
      `insert into budget_categories
         (couple_id, category_number, title, title_emphasis, estimated_cents, position)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [couple.id, categoryData.category_number, categoryData.title,
       categoryData.title_emphasis, categoryData.estimated_cents, categoryData.position],
    );
    const categoryId = rows[0].id;

    for (const l of lines) {
      await client.query(
        `insert into budget_line_items
           (category_id, name, vendor_label, amount_cents, paid_cents,
            status_kind, status_label, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [categoryId, l.name, l.vendor_label, l.amount_cents, l.paid_cents,
         l.status_kind, l.status_label, l.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Added ${categoryData.title} (${lines.length} line item${lines.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/budget`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err.code === '23505') {
      return res.status(400).render('admin/budget-category-form', {
        couple: await findCoupleById(req.params.id),
        category: { ...req.body, estimated_cents: dollarsToCents(req.body.estimated_cents) },
        lines: parseLinesFromBody(req.body),
        suggestedNumber: parseInt(req.body.category_number, 10) || 1,
        formAction: `/admin/couples/${req.params.id}/budget`,
        statusKinds: BUDGET_STATUS_KINDS,
        error: 'That category number is already in use for this couple.',
        flash: null,
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// Update category (replace line items wholesale — same approach as households)
router.post('/couples/:id/budget/:cid', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const categoryData = {
      category_number: parseInt(req.body.category_number, 10),
      title: req.body.title?.trim() || '',
      title_emphasis: req.body.title_emphasis?.trim() || null,
      estimated_cents: dollarsToCents(req.body.estimated_cents),
      position: parseInt(req.body.position, 10) || 0,
    };
    const lines = parseLinesFromBody(req.body);

    if (!categoryData.title || !categoryData.category_number) {
      return res.status(400).redirect(`/admin/couples/${couple.id}/budget/${req.params.cid}`);
    }

    await client.query('begin');
    const { rowCount } = await client.query(
      `update budget_categories set
         category_number = $1, title = $2, title_emphasis = $3,
         estimated_cents = $4, position = $5, updated_at = now()
       where id = $6 and couple_id = $7`,
      [categoryData.category_number, categoryData.title, categoryData.title_emphasis,
       categoryData.estimated_cents, categoryData.position, req.params.cid, couple.id],
    );
    if (rowCount === 0) {
      await client.query('rollback');
      return res.status(404).send('Category not found.');
    }

    await client.query('delete from budget_line_items where category_id = $1', [req.params.cid]);
    for (const l of lines) {
      await client.query(
        `insert into budget_line_items
           (category_id, name, vendor_label, amount_cents, paid_cents,
            status_kind, status_label, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [req.params.cid, l.name, l.vendor_label, l.amount_cents, l.paid_cents,
         l.status_kind, l.status_label, l.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved ${categoryData.title}.`);
    res.redirect(`/admin/couples/${couple.id}/budget`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err.code === '23505') {
      setFlash(req, 'error', 'That category number is already in use for this couple.');
      return res.redirect(`/admin/couples/${req.params.id}/budget/${req.params.cid}`);
    }
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/budget/:cid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from budget_categories where id = $1 and couple_id = $2 returning title',
      [req.params.cid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].title}.`);
    res.redirect(`/admin/couples/${req.params.id}/budget`);
  } catch (err) { next(err); }
});

// ── Checklist (per couple — milestones with inline tasks) ─────────────

// Body shape matches budget: lines[i] = task fields. Empty rows skipped.
function parseTasksFromBody(body) {
  const raw = body.tasks || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(t => t && t.name && t.name.trim().length > 0)
    .map((t, idx) => ({
      id: t.id || null,
      name: t.name.trim(),
      sub_text: t.sub_text?.trim() || null,
      // Checkbox inputs only post a value when checked, so presence in
      // the body (any non-empty value) means done.
      is_done: !!(t.is_done && t.is_done !== '' && t.is_done !== 'false'),
      position: idx + 1,
    }));
}

router.get('/couples/:id/checklist', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: milestones } = await pool.query(
      `select m.*,
              coalesce(sums.task_count, 0)::int  as task_count,
              coalesce(sums.done_count, 0)::int  as done_count
         from checklist_milestones m
         left join (
           select milestone_id,
                  count(*) as task_count,
                  count(*) filter (where is_done) as done_count
             from checklist_tasks
            group by milestone_id
         ) sums on sums.milestone_id = m.id
        where m.couple_id = $1
        order by m.position asc`,
      [couple.id],
    );
    res.render('admin/checklist-milestones-list', {
      couple,
      milestones,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/checklist/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows } = await pool.query(
      'select coalesce(max(position), 0) + 1 as next_pos from checklist_milestones where couple_id = $1',
      [couple.id],
    );

    res.render('admin/checklist-milestone-form', {
      couple,
      milestone: null,
      tasks: [],
      suggestedPosition: rows[0].next_pos,
      formAction: `/admin/couples/${couple.id}/checklist`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/checklist/:mid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: msRows } = await pool.query(
      'select * from checklist_milestones where id = $1 and couple_id = $2',
      [req.params.mid, couple.id],
    );
    if (!msRows[0]) return res.status(404).send('Milestone not found.');

    const { rows: tasks } = await pool.query(
      'select * from checklist_tasks where milestone_id = $1 order by position asc',
      [msRows[0].id],
    );

    res.render('admin/checklist-milestone-form', {
      couple,
      milestone: msRows[0],
      tasks,
      suggestedPosition: msRows[0].position,
      formAction: `/admin/couples/${couple.id}/checklist/${msRows[0].id}`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/checklist', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const milestoneData = {
      date_label: req.body.date_label?.trim() || '',
      title: req.body.title?.trim() || '',
      position: parseInt(req.body.position, 10) || 0,
    };
    const tasks = parseTasksFromBody(req.body);

    if (!milestoneData.date_label || !milestoneData.title) {
      return res.status(400).render('admin/checklist-milestone-form', {
        couple,
        milestone: milestoneData,
        tasks,
        suggestedPosition: milestoneData.position || 1,
        formAction: `/admin/couples/${couple.id}/checklist`,
        error: 'Date label and title are required.',
        flash: null,
      });
    }

    await client.query('begin');
    const { rows } = await client.query(
      `insert into checklist_milestones (couple_id, date_label, title, position)
       values ($1, $2, $3, $4) returning id`,
      [couple.id, milestoneData.date_label, milestoneData.title, milestoneData.position],
    );
    const milestoneId = rows[0].id;
    for (const t of tasks) {
      await client.query(
        `insert into checklist_tasks (milestone_id, name, sub_text, is_done, position)
         values ($1, $2, $3, $4, $5)`,
        [milestoneId, t.name, t.sub_text, t.is_done, t.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Added ${milestoneData.title} (${tasks.length} task${tasks.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/checklist`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/checklist/:mid', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const milestoneData = {
      date_label: req.body.date_label?.trim() || '',
      title: req.body.title?.trim() || '',
      position: parseInt(req.body.position, 10) || 0,
    };
    const tasks = parseTasksFromBody(req.body);

    if (!milestoneData.date_label || !milestoneData.title) {
      return res.status(400).redirect(`/admin/couples/${couple.id}/checklist/${req.params.mid}`);
    }

    await client.query('begin');
    const { rowCount } = await client.query(
      `update checklist_milestones set
         date_label = $1, title = $2, position = $3, updated_at = now()
       where id = $4 and couple_id = $5`,
      [milestoneData.date_label, milestoneData.title, milestoneData.position, req.params.mid, couple.id],
    );
    if (rowCount === 0) {
      await client.query('rollback');
      return res.status(404).send('Milestone not found.');
    }

    await client.query('delete from checklist_tasks where milestone_id = $1', [req.params.mid]);
    for (const t of tasks) {
      await client.query(
        `insert into checklist_tasks (milestone_id, name, sub_text, is_done, position)
         values ($1, $2, $3, $4, $5)`,
        [req.params.mid, t.name, t.sub_text, t.is_done, t.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved ${milestoneData.title}.`);
    res.redirect(`/admin/couples/${couple.id}/checklist`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/checklist/:mid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from checklist_milestones where id = $1 and couple_id = $2 returning title',
      [req.params.mid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].title}.`);
    res.redirect(`/admin/couples/${req.params.id}/checklist`);
  } catch (err) { next(err); }
});

// ── Timeline (per couple — phases with inline events) ─────────────────

const TIMELINE_VARIANTS = ['standard', 'ceremony', 'sendoff'];

// events[i] = { id?, time_text, meridiem, title, where_label, lead_label,
//               with_label, note_text, position }. Empty rows (no title) skipped.
function parseEventsFromBody(body) {
  const raw = body.events || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(e => e && e.title && e.title.trim().length > 0)
    .map((e, idx) => ({
      id: e.id || null,
      time_text: e.time_text?.trim() || '',
      meridiem: e.meridiem?.trim() || null,
      title: e.title.trim(),
      where_label: e.where_label?.trim() || null,
      lead_label: e.lead_label?.trim() || null,
      with_label: e.with_label?.trim() || null,
      note_text: e.note_text?.trim() || null,
      position: idx + 1,
    }));
}

router.get('/couples/:id/timeline', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: phases } = await pool.query(
      `select p.*,
              coalesce(sums.event_count, 0)::int as event_count
         from timeline_phases p
         left join (
           select phase_id, count(*) as event_count
             from timeline_events
            group by phase_id
         ) sums on sums.phase_id = p.id
        where p.couple_id = $1
        order by p.position asc, p.phase_number asc`,
      [couple.id],
    );
    res.render('admin/timeline-phases-list', {
      couple,
      phases,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/timeline/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows } = await pool.query(
      'select coalesce(max(phase_number), 0) + 1 as next_num from timeline_phases where couple_id = $1',
      [couple.id],
    );

    res.render('admin/timeline-phase-form', {
      couple,
      phase: null,
      events: [],
      suggestedNumber: rows[0].next_num,
      formAction: `/admin/couples/${couple.id}/timeline`,
      variants: TIMELINE_VARIANTS,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/timeline/:pid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: phaseRows } = await pool.query(
      'select * from timeline_phases where id = $1 and couple_id = $2',
      [req.params.pid, couple.id],
    );
    if (!phaseRows[0]) return res.status(404).send('Phase not found.');

    const { rows: events } = await pool.query(
      'select * from timeline_events where phase_id = $1 order by position asc',
      [phaseRows[0].id],
    );

    res.render('admin/timeline-phase-form', {
      couple,
      phase: phaseRows[0],
      events,
      suggestedNumber: phaseRows[0].phase_number,
      formAction: `/admin/couples/${couple.id}/timeline/${phaseRows[0].id}`,
      variants: TIMELINE_VARIANTS,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/timeline', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const phaseData = {
      phase_number: parseInt(req.body.phase_number, 10),
      title: req.body.title?.trim() || '',
      window_text: req.body.window_text?.trim() || null,
      note_text: req.body.note_text?.trim() || null,
      variant: TIMELINE_VARIANTS.includes(req.body.variant) ? req.body.variant : 'standard',
      position: parseInt(req.body.position, 10) || 0,
    };
    const events = parseEventsFromBody(req.body);

    if (!phaseData.title || !phaseData.phase_number) {
      return res.status(400).render('admin/timeline-phase-form', {
        couple,
        phase: phaseData,
        events,
        suggestedNumber: phaseData.phase_number || 1,
        formAction: `/admin/couples/${couple.id}/timeline`,
        variants: TIMELINE_VARIANTS,
        error: 'Phase number and title are required.',
        flash: null,
      });
    }

    await client.query('begin');
    const { rows } = await client.query(
      `insert into timeline_phases
         (couple_id, phase_number, title, window_text, note_text, variant, position)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [couple.id, phaseData.phase_number, phaseData.title, phaseData.window_text,
       phaseData.note_text, phaseData.variant, phaseData.position],
    );
    const phaseId = rows[0].id;
    for (const ev of events) {
      await client.query(
        `insert into timeline_events
           (phase_id, time_text, meridiem, title, where_label, lead_label,
            with_label, note_text, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [phaseId, ev.time_text, ev.meridiem, ev.title, ev.where_label,
         ev.lead_label, ev.with_label, ev.note_text, ev.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Added ${phaseData.title} (${events.length} event${events.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/timeline`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err.code === '23505') {
      return res.status(400).render('admin/timeline-phase-form', {
        couple: await findCoupleById(req.params.id),
        phase: { ...req.body },
        events: parseEventsFromBody(req.body),
        suggestedNumber: parseInt(req.body.phase_number, 10) || 1,
        formAction: `/admin/couples/${req.params.id}/timeline`,
        variants: TIMELINE_VARIANTS,
        error: 'That phase number is already in use for this couple.',
        flash: null,
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/timeline/:pid', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const phaseData = {
      phase_number: parseInt(req.body.phase_number, 10),
      title: req.body.title?.trim() || '',
      window_text: req.body.window_text?.trim() || null,
      note_text: req.body.note_text?.trim() || null,
      variant: TIMELINE_VARIANTS.includes(req.body.variant) ? req.body.variant : 'standard',
      position: parseInt(req.body.position, 10) || 0,
    };
    const events = parseEventsFromBody(req.body);

    if (!phaseData.title || !phaseData.phase_number) {
      return res.status(400).redirect(`/admin/couples/${couple.id}/timeline/${req.params.pid}`);
    }

    await client.query('begin');
    const { rowCount } = await client.query(
      `update timeline_phases set
         phase_number = $1, title = $2, window_text = $3, note_text = $4,
         variant = $5, position = $6, updated_at = now()
       where id = $7 and couple_id = $8`,
      [phaseData.phase_number, phaseData.title, phaseData.window_text, phaseData.note_text,
       phaseData.variant, phaseData.position, req.params.pid, couple.id],
    );
    if (rowCount === 0) {
      await client.query('rollback');
      return res.status(404).send('Phase not found.');
    }

    await client.query('delete from timeline_events where phase_id = $1', [req.params.pid]);
    for (const ev of events) {
      await client.query(
        `insert into timeline_events
           (phase_id, time_text, meridiem, title, where_label, lead_label,
            with_label, note_text, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [req.params.pid, ev.time_text, ev.meridiem, ev.title, ev.where_label,
         ev.lead_label, ev.with_label, ev.note_text, ev.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved ${phaseData.title}.`);
    res.redirect(`/admin/couples/${couple.id}/timeline`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err.code === '23505') {
      setFlash(req, 'error', 'That phase number is already in use for this couple.');
      return res.redirect(`/admin/couples/${req.params.id}/timeline/${req.params.pid}`);
    }
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/timeline/:pid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from timeline_phases where id = $1 and couple_id = $2 returning title',
      [req.params.pid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].title}.`);
    res.redirect(`/admin/couples/${req.params.id}/timeline`);
  } catch (err) { next(err); }
});

// ── Couple delete (kept at the bottom so vendor routes match first) ───

// Delete couple
router.post('/couples/:id/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from couples where id = $1 returning display_name',
      [req.params.id],
    );
    if (rows[0]) {
      setFlash(req, 'success', `Deleted ${rows[0].display_name}.`);
    }
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

export default router;
