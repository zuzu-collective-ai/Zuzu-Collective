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
];

// Coerce empty strings on optional fields back to null so the database
// keeps its NULLs honest. Required fields (slug, display_name,
// wedding_date) get validated before this runs.
function pickCoupleFields(body) {
  const out = {};
  for (const f of COUPLE_FIELDS) {
    const v = body[f];
    out[f] = v === '' || v === undefined ? null : v;
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
