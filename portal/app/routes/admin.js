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
