// Admin routes — Zoe-facing, /admin/*.
//
// Phase 3a only handles couples (login, list, create, edit, delete).
// Phases 3b–3g add per-section CRUD (vendors, guests, budget, etc.)
// off the same /admin/couples/:id/* prefix.
//
// One user, one password (env: ADMIN_PASSWORD), session-cookie auth
// (express-session, signed with SESSION_SECRET).

import express from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { requireAdmin, passwordsMatch } from '../middleware/auth.js';
import { generateAllocation, generatePalette, generateChecklist, generateVendorOutreach, extractVendorInfo, describeTileImage, generateTimeline, importGuestList, generateVendorSearchQueries, parseVendorSearchResults, isConfigured as anthropicConfigured, STANDARD_CATEGORIES } from '../lib/anthropic.js';
import { serperConfigured, serperSearch } from '../lib/serper.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || ['text/plain', 'application/pdf'].includes(file.mimetype);
    cb(null, ok);
  },
});

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
  'palette_color_5', 'palette_color_5_name',
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
  'floorplan_walkthrough_date',
  'floorplan_walkthrough_note',
  'design_subtitle',
  'design_tone_title',
  'design_materials_title',
  'design_materials_note',
  'hero_photo_url',
  'hero_text_color',
  'couple_phone',
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
    } else if (f === 'tone_keywords') {
      // Normalize any separator (comma, dash, pipe, slash, existing ·) to " · "
      const raw = (v || '').trim();
      if (!raw) { out[f] = null; continue; }
      const words = raw.split(/\s*[,\-·|\/]\s*/).map(w => w.trim()).filter(Boolean);
      out[f] = words.length > 0 ? words.join(' · ') : null;
    } else if (f === 'couple_phone') {
      out[f] = v ? normalizePhone(v) : null;
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
    // Restrict redirect to same-origin paths only — never follow external URLs.
    const raw = req.body.next || '';
    const safePath = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')
      ? raw
      : '/admin';
    res.redirect(safePath);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ── Everything below requires admin ─────────────────────────────────────

router.use(requireAdmin);

// Keep-alive ping — called every 30 s from admin pages to prevent Render free-tier spin-down.
router.get('/ping', (_req, res) => res.sendStatus(204));

// Couples list — the admin's home page.
router.get('/', async (_req, res, next) => {
  try {
    const { rows: couples } = await pool.query(
      `select c.id, c.slug, c.display_name, c.wedding_date, c.venue_name, c.venue_location, c.updated_at,
              (select max(e.created_at) from portal_events e where e.couple_id = c.id) as last_viewed_at,
              (select count(*) from portal_events e where e.couple_id = c.id
                and e.created_at > now() - interval '7 days')::int as views_7d,
              -- Vendor stats
              (select count(*) from vendors v where v.couple_id = c.id)::int as vendor_total,
              (select count(*) from vendors v where v.couple_id = c.id and v.status = 'booked')::int as vendor_booked,
              -- Checklist stats
              (select count(*) from checklist_tasks t
                 join checklist_milestones m on m.id = t.milestone_id
                where m.couple_id = c.id)::int as task_total,
              (select count(*) from checklist_tasks t
                 join checklist_milestones m on m.id = t.milestone_id
                where m.couple_id = c.id and t.is_done = true)::int as task_done
         from couples c
        order by c.wedding_date asc`,
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
    couple: null,
    activity: null,
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
        activity: null,
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
        activity: null,
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
    const [coupleRes, activityRes] = await Promise.all([
      pool.query('select * from couples where id = $1', [req.params.id]),
      pool.query(
        `select
           count(*)::int                                                     as views_7d,
           count(distinct ip_hash)::int                                      as unique_7d,
           max(created_at)                                                   as last_viewed_at,
           count(*) filter (where created_at > now() - interval '1 day')::int as views_24h
         from portal_events
        where couple_id = $1
          and created_at > now() - interval '7 days'`,
        [req.params.id],
      ),
    ]);
    if (!coupleRes.rows[0]) return res.status(404).send('Couple not found.');
    res.render('admin/couple-form', {
      couple: coupleRes.rows[0],
      activity: activityRes.rows[0],
      formAction: `/admin/couples/${coupleRes.rows[0].id}`,
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
        activity: null,
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
        activity: null,
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
  'website_url',
  'instagram_url',
  'status',
  'note',
  'contract_url',
  'contract_status',
  'position',
];

const CONTRACT_STATUSES = ['not_started', 'pending', 'signed'];

function normalizePhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  return input.trim() || null;
}

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
  if (!CONTRACT_STATUSES.includes(out.contract_status)) out.contract_status = 'not_started';
  if (out.phone) out.phone = normalizePhone(out.phone);
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
      contractStatuses: CONTRACT_STATUSES,
      configured: anthropicConfigured(),
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
        contractStatuses: CONTRACT_STATUSES,
        configured: anthropicConfigured(),
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

// ── AI vendor smart import ────────────────────────────────────────────
// POST a photo or text file, get back extracted fields as JSON.
// The vendor form JS reads the JSON and pre-fills the inputs.
router.post('/couples/:id/vendors/import', upload.single('file'), async (req, res) => {
  if (!anthropicConfigured()) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  try {
    const data = await extractVendorInfo({
      buffer:   req.file.buffer,
      mimeType: req.file.mimetype,
    });
    res.json(data);
  } catch (err) {
    console.error('[vendor-import]', err);
    res.status(500).json({ error: 'Extraction failed. Try again or fill in manually.' });
  }
});

// ── AI vendor search ──────────────────────────────────────────────────
// Static routes must appear before `/:vid`.

router.get('/couples/:id/vendors/search', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    res.render('admin/vendor-search-form', {
      couple,
      configured: anthropicConfigured() && serperConfigured(),
      flash: consumeFlash(req),
      error: null,
      candidates: null,
      query: {},
    });
  } catch (err) { next(err); }
});

const CURATED_SITE_DOMAINS = {
  style_me_pretty:     'stylemepretty.com',
  carats_and_cake:     'caratsandcake.com',
  junebug:             'junebugweddings.com',
  green_wedding_shoes: 'greenweddingshoes.com',
  once_wed:            'oncewed.com',
};

router.post('/couples/:id/vendors/search', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { vendor_type, location, style } = req.body;
    const sources = [].concat(req.body.sources || ['general']);
    const query = { vendor_type, location, style, sources };

    const renderForm = (extra) => res.status(extra.error ? 400 : 200).render('admin/vendor-search-form', {
      couple, flash: null, candidates: null, query,
      configured: anthropicConfigured() && serperConfigured(),
      ...extra,
    });

    if (!vendor_type?.trim()) return renderForm({ error: 'Vendor type is required.' });
    if (!anthropicConfigured()) return renderForm({ error: 'ANTHROPIC_API_KEY not set.' });
    if (!serperConfigured()) return renderForm({ error: 'SERPER_API_KEY not set — add it in Render → Environment.' });

    const resolvedLocation = location?.trim() || couple.venue_location || 'San Diego, CA';
    const styleDesc = style?.trim() || 'elegant, refined';
    const allResults = [];

    // General web search via Claude-generated queries
    if (sources.includes('general')) {
      const { queries } = await generateVendorSearchQueries({
        styleDescription: styleDesc,
        vendorType: vendor_type.trim(),
        location: resolvedLocation,
      });
      const results = (await Promise.all(
        queries.map(q => serperSearch(q, 5).catch(() => []))
      )).flat();
      allResults.push(...results);
    }

    // Curated site searches — one targeted query per selected site
    const curatedSites = sources.filter(s => s !== 'general' && CURATED_SITE_DOMAINS[s]);
    for (const siteKey of curatedSites) {
      const domain = CURATED_SITE_DOMAINS[siteKey];
      // Style keywords condensed to top 3 words so the query isn't too long
      const styleKw = styleDesc.split(/[,\s]+/).slice(0, 3).join(' ');
      const q = `site:${domain} ${vendor_type.trim()} ${resolvedLocation} ${styleKw}`;
      const results = await serperSearch(q, 8).catch(() => []);
      allResults.push(...results);
    }

    const { candidates } = await parseVendorSearchResults({
      results: allResults,
      vendorType: vendor_type.trim(),
      styleDescription: styleDesc,
      location: resolvedLocation,
    });

    // Enrich candidates that are missing a website or Instagram by doing a
    // targeted follow-up search for their direct web presence.
    const DIRECTORY_DOMAINS = Object.values(CURATED_SITE_DOMAINS)
      .concat(['theknot.com', 'weddingwire.com', 'yelp.com', 'weddingpro.com']);

    await Promise.all(candidates.map(async (c) => {
      const needsWebsite = !c.website;
      const needsIg = !c.instagram_url;
      if (!needsWebsite && !needsIg) return;

      try {
        const enrichResults = await serperSearch(
          `"${c.display_name}" ${vendor_type.trim()} ${resolvedLocation}`,
          5,
        );
        for (const r of enrichResults) {
          const domain = r.link.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
          const isDirectory = DIRECTORY_DOMAINS.some(d => domain.endsWith(d));
          const isInstagram = domain === 'instagram.com';

          if (needsWebsite && !isDirectory && !isInstagram && r.link) {
            c.website = r.link.split('/').slice(0, 3).join('/'); // keep just the root domain URL
          }
          if (needsIg && isInstagram && r.link) {
            c.instagram_url = r.link;
          }
        }
      } catch (_) { /* enrichment is best-effort */ }
    }));

    res.render('admin/vendor-search-form', {
      couple,
      configured: true,
      flash: null,
      error: null,
      candidates,
      query,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/vendors/search/add', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const selected = [].concat(req.body.selected || []);
    if (!selected.length) {
      setFlash(req, 'error', 'No vendors selected.');
      return res.redirect(`/admin/couples/${couple.id}/vendors/search`);
    }

    const rawCandidates = JSON.parse(req.body.candidates_json || '[]');
    const toAdd = rawCandidates.filter((_, i) => selected.includes(String(i)));

    const { rows: existing } = await pool.query(
      `select coalesce(max(position), 0) as max_pos from vendors where couple_id = $1`,
      [couple.id],
    );
    let pos = (existing[0]?.max_pos || 0) + 1;

    for (const c of toAdd) {
      const name = c.display_name;
      const websiteUrl = c.website || null;
      const instagramUrl = c.instagram_url || null;

      // If a vendor with this name already exists for this couple, just
      // update their links rather than create a duplicate.
      const { rows: existingVendor } = await pool.query(
        `select id from vendors where couple_id = $1 and lower(display_name) = lower($2) limit 1`,
        [couple.id, name],
      );

      if (existingVendor.length > 0) {
        await pool.query(
          `update vendors set
             website_url   = coalesce($1, website_url),
             instagram_url = coalesce($2, instagram_url),
             updated_at    = now()
           where id = $3`,
          [websiteUrl, instagramUrl, existingVendor[0].id],
        );
      } else {
        await pool.query(
          `insert into vendors (couple_id, vendor_type, display_name, phone, email, address, note, website_url, instagram_url, status, position)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'shortlist',$10)`,
          [couple.id, c.vendor_type || req.body.vendor_type, name, c.phone || null,
           c.email || null, c.address || null, c.description || null,
           websiteUrl, instagramUrl, pos++],
        );
      }
    }

    setFlash(req, 'success', `Added ${toAdd.length} vendor${toAdd.length === 1 ? '' : 's'} to shortlist.`);
    res.redirect(`/admin/couples/${couple.id}/vendors`);
  } catch (err) { next(err); }
});

// ── AI vendor outreach generator (Phase 4d) ───────────────────────────
// Static `/vendors/outreach` must appear before `/:vid`.

router.get('/couples/:id/vendors/outreach', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    const { rows: vendors } = await pool.query(
      `select * from vendors where couple_id = $1
         and status in ('pending', 'shortlist')
       order by position asc`,
      [couple.id],
    );
    res.render('admin/vendor-outreach-form', {
      couple, vendors,
      configured: anthropicConfigured(),
      proposal: null, submitted: null, error: null,
      flash: consumeFlash(req),
      formAction: `/admin/couples/${couple.id}/vendors/outreach`,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/vendors/outreach', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: allPending } = await pool.query(
      `select * from vendors where couple_id = $1
         and status in ('pending', 'shortlist')
       order by position asc`,
      [couple.id],
    );

    const renderForm = (extra) => res.status(extra.error ? 400 : 200).render('admin/vendor-outreach-form', {
      couple, vendors: allPending,
      configured: anthropicConfigured(),
      proposal: null, submitted: req.body,
      flash: consumeFlash(req),
      formAction: `/admin/couples/${couple.id}/vendors/outreach`,
      ...extra,
    });

    if (!anthropicConfigured()) {
      return renderForm({ error: 'ANTHROPIC_API_KEY is not set. Add it under Render → Environment.' });
    }

    // Which vendor IDs did Zoe select?
    const selectedIds = new Set(
      Array.isArray(req.body.vendor_ids) ? req.body.vendor_ids : [req.body.vendor_ids].filter(Boolean),
    );
    const selected = allPending.filter(v => selectedIds.has(v.id));
    if (selected.length === 0) {
      return renderForm({ error: 'Select at least one vendor to generate outreach for.' });
    }

    let result;
    try {
      result = await generateVendorOutreach({
        displayName:    couple.display_name,
        weddingDate:    couple.wedding_date
          ? new Date(couple.wedding_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
          : undefined,
        venueName:      couple.venue_name,
        venueLocation:  couple.venue_location,
        toneKeywords:   couple.tone_keywords,
        vendors:        selected.map(v => ({ id: v.id, vendor_type: v.vendor_type, note: v.note })),
        brief:          (req.body.brief || '').trim() || undefined,
      });
    } catch (err) {
      console.error('[outreach-gen] Claude API error:', err);
      return renderForm({ error: `AI call failed: ${err.message}` });
    }

    // Merge generated drafts back with vendor rows for the preview
    const draftMap = new Map(result.drafts.map(d => [d.vendor_type, d]));
    const rows = selected.map(v => ({
      ...v,
      draft: draftMap.get(v.vendor_type) || { subject: '', body: '' },
    }));

    res.render('admin/vendor-outreach-form', {
      couple, vendors: allPending,
      configured: true,
      proposal: { rows, usage: result.usage },
      submitted: req.body, error: null,
      flash: consumeFlash(req),
      formAction: `/admin/couples/${couple.id}/vendors/outreach`,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/vendors/outreach/apply', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    // Save each selected draft to vendor.note
    const raw = req.body.drafts || {};
    let saved = 0;
    for (const [vid, d] of Object.entries(raw)) {
      if (req.body[`save_${vid}`] !== 'true') continue;
      const note = `=== Outreach draft ===\nSubject: ${(d.subject || '').trim()}\n\n${(d.body || '').trim()}`;
      await pool.query(
        'update vendors set note = $1, updated_at = now() where id = $2 and couple_id = $3',
        [note, vid, couple.id],
      );
      saved++;
    }

    if (saved === 0) {
      setFlash(req, 'info', 'Nothing saved — no drafts were selected.');
    } else {
      setFlash(req, 'success', `Saved ${saved} outreach draft${saved === 1 ? '' : 's'} to vendor notes.`);
    }
    res.redirect(`/admin/couples/${couple.id}/vendors`);
  } catch (err) { next(err); }
});

// Contract PDF upload — server-side signed Cloudinary upload.
// Accepts a PDF from the browser, re-uploads to Cloudinary using
// API credentials so unsigned-preset restrictions don't apply.
// Supports CLOUDINARY_URL (cloudinary://key:secret@cloud) OR the three
// separate vars CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET / CLOUDINARY_CLOUD_NAME
// that Render's Cloudinary add-on sets.
router.post('/couples/:id/vendors/upload-contract', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    // Resolve credentials — try combined URL first, then individual vars
    let apiKey, apiSecret, cloudName;
    const rawUrl = process.env.CLOUDINARY_URL || '';
    const m = rawUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) {
      [, apiKey, apiSecret, cloudName] = m;
    } else {
      apiKey    = process.env.CLOUDINARY_API_KEY;
      apiSecret = process.env.CLOUDINARY_API_SECRET;
      cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    }
    if (!apiKey || !apiSecret || !cloudName) {
      return res.status(503).json({ error: 'Cloudinary credentials not configured. Set CLOUDINARY_URL (format: cloudinary://key:secret@cloudname) or CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET + CLOUDINARY_CLOUD_NAME on Render.' });
    }

    // Build signed upload params
    const timestamp = Math.round(Date.now() / 1000);
    const sigString = `timestamp=${timestamp}${apiSecret}`;
    const signature = createHash('sha1').update(sigString).digest('hex');

    const fd = new FormData();
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'contract.pdf');
    fd.append('timestamp', String(timestamp));
    fd.append('api_key', apiKey);
    fd.append('signature', signature);

    const cldRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
      method: 'POST',
      body: fd,
    });
    const data = await cldRes.json();
    if (!cldRes.ok) return res.status(502).json({ error: data.error?.message || 'Cloudinary upload failed.' });

    res.json({ url: data.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Floor plan layout image upload — Cloudinary image upload.
router.post('/couples/:id/floor-plan/upload-layout', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    let apiKey, apiSecret, cloudName;
    const rawUrl = process.env.CLOUDINARY_URL || '';
    const m = rawUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) {
      [, apiKey, apiSecret, cloudName] = m;
    } else {
      apiKey    = process.env.CLOUDINARY_API_KEY;
      apiSecret = process.env.CLOUDINARY_API_SECRET;
      cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    }
    if (!apiKey || !apiSecret || !cloudName) {
      return res.status(503).json({ error: 'Cloudinary credentials not configured.' });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const sigString = `timestamp=${timestamp}${apiSecret}`;
    const signature = createHash('sha1').update(sigString).digest('hex');

    const fd = new FormData();
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'layout');
    fd.append('timestamp', String(timestamp));
    fd.append('api_key', apiKey);
    fd.append('signature', signature);

    const cldRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: fd,
    });
    const data = await cldRes.json();
    if (!cldRes.ok) return res.status(502).json({ error: data.error?.message || 'Cloudinary upload failed.' });

    res.json({ url: data.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contract PDF proxy — must appear before /:vid
router.get('/couples/:id/vendors/:vid/contract', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Not found.');
    const { rows: [vendor] } = await pool.query(
      'select contract_url from vendors where id=$1 and couple_id=$2',
      [req.params.vid, couple.id],
    );
    if (!vendor?.contract_url) return res.status(404).send('No contract on file.');
    const r = await fetch(vendor.contract_url);
    if (!r.ok) return res.status(502).send('Could not retrieve contract.');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="contract.pdf"');
    res.set('Cache-Control', 'private, max-age=3600');
    r.body.pipe(res);
  } catch (err) { next(err); }
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
      contractStatuses: CONTRACT_STATUSES,
      configured: anthropicConfigured(),
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

// ── AI guest list import ───────────────────────────────────────────────
router.get('/couples/:id/guests/import', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    res.render('admin/guest-import-form', {
      couple, configured: anthropicConfigured(),
      flash: consumeFlash(req), error: null,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/guests/import', upload.single('file'), async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    if (!anthropicConfigured()) return res.status(503).send('ANTHROPIC_API_KEY not set.');
    if (!req.file) return res.status(400).render('admin/guest-import-form', {
      couple, configured: true, flash: null, error: 'No file uploaded.',
    });

    let result;
    try {
      result = await importGuestList({ buffer: req.file.buffer, mimeType: req.file.mimetype });
    } catch (err) {
      console.error('[guest-import]', err);
      return res.status(502).render('admin/guest-import-form', {
        couple, configured: true, flash: null, error: `Claude API failed: ${err.message}`,
      });
    }

    const client = await pool.connect();
    let householdCount = 0, guestCount = 0;
    try {
      await client.query('begin');
      const skipDuplicates = req.body.on_conflict !== 'append';
      for (const h of result.households || []) {
        const side = ['bride','groom','both','bridal_party'].includes(h.side) ? h.side : 'both';
        if (skipDuplicates) {
          const { rows: existing } = await client.query(
            `select id from households where couple_id=$1 and lower(display_name)=lower($2) limit 1`,
            [couple.id, h.display_name],
          );
          if (existing.length > 0) continue;
        }
        const { rows: [hh] } = await client.query(
          `insert into households (couple_id, display_name, side, status, position)
           values ($1, $2, $3, 'awaiting', (select coalesce(max(position),0)+1 from households where couple_id=$1))
           returning id`,
          [couple.id, h.display_name, side],
        );
        householdCount++;
        for (let i = 0; i < (h.guests || []).length; i++) {
          const g = h.guests[i];
          const gt = ['adult','child','plus_one'].includes(g.guest_type) ? g.guest_type : 'adult';
          await client.query(
            `insert into guests (household_id, display_name, guest_type, position) values ($1,$2,$3,$4)`,
            [hh.id, g.display_name, gt, i + 1],
          );
          guestCount++;
        }
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally { client.release(); }

    setFlash(req, 'success', `Imported ${householdCount} households and ${guestCount} guests — review and edit below.`);
    res.redirect(`/admin/couples/${couple.id}/guests`);
  } catch (err) { next(err); }
});

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
    .filter(l => l && (l.name?.trim() || dollarsToCents(l.amount_cents) || dollarsToCents(l.paid_cents)))
    .map((l, idx) => ({
      id: l.id || null,
      name: l.name?.trim() || 'Payment',
      vendor_label: l.vendor_label?.trim() || null,
      amount_cents: dollarsToCents(l.amount_cents),
      paid_cents: dollarsToCents(l.paid_cents),
      status_kind: BUDGET_STATUS_KINDS.includes(l.status_kind) ? l.status_kind : 'upcoming',
      status_label: l.status_label?.trim() || null,
      due_date: l.due_date?.trim() || null,
      position: idx + 1,
    }));
}

// List categories — the budget tab's index page for a couple.
router.get('/couples/:id/budget', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const [{ rows: categories }, { rows: upcoming }] = await Promise.all([
      pool.query(
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
      ),
      pool.query(
        `select l.*, c.title as category_title
           from budget_line_items l
           join budget_categories c on c.id = l.category_id
          where c.couple_id = $1
            and l.due_date is not null
            and l.status_kind != 'paid'
          order by l.due_date asc
          limit 20`,
        [couple.id],
      ),
    ]);
    res.render('admin/budget-categories-list', {
      couple,
      categories,
      upcoming,
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
  if (!isUuid(req.params.cid)) return next();  // let static paths like /budget/allocate fall through
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
            status_kind, status_label, due_date, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [categoryId, l.name, l.vendor_label, l.amount_cents, l.paid_cents,
         l.status_kind, l.status_label, l.due_date || null, l.position],
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
  if (!isUuid(req.params.cid)) return next();
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
            status_kind, status_label, due_date, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [req.params.cid, l.name, l.vendor_label, l.amount_cents, l.paid_cents,
         l.status_kind, l.status_label, l.due_date || null, l.position],
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
  if (!isUuid(req.params.cid)) return next();
  try {
    const { rows } = await pool.query(
      'delete from budget_categories where id = $1 and couple_id = $2 returning title',
      [req.params.cid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].title}.`);
    res.redirect(`/admin/couples/${req.params.id}/budget`);
  } catch (err) { next(err); }
});

// ── Payments tab ──────────────────────────────────────────────────────
// Shows all budget line items for a couple in one editable list,
// grouped by category. Each row can be updated individually.

router.get('/couples/:id/payments', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: items } = await pool.query(
      `select l.*, c.title as category_title, c.id as category_id
         from budget_line_items l
         join budget_categories c on c.id = l.category_id
        where c.couple_id = $1
        order by c.position asc, c.category_number asc, l.position asc`,
      [couple.id],
    );

    // Group by category
    const grouped = [];
    const seen = new Map();
    for (const item of items) {
      if (!seen.has(item.category_id)) {
        seen.set(item.category_id, { title: item.category_title, id: item.category_id, items: [] });
        grouped.push(seen.get(item.category_id));
      }
      seen.get(item.category_id).items.push(item);
    }

    res.render('admin/payments-list', {
      couple,
      grouped,
      currentTab: 'payments',
      statusKinds: BUDGET_STATUS_KINDS,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// Update a single line item from the payments tab
router.post('/couples/:id/payments/:lid', async (req, res, next) => {
  if (!isUuid(req.params.lid)) return next();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const status_kind = BUDGET_STATUS_KINDS.includes(req.body.status_kind)
      ? req.body.status_kind : 'upcoming';

    await pool.query(
      `update budget_line_items set
         name         = $1,
         vendor_label = $2,
         amount_cents = $3,
         paid_cents   = $4,
         status_kind  = $5,
         status_label = $6,
         due_date     = $7,
         updated_at   = now()
       where id = $8
         and category_id in (
           select id from budget_categories where couple_id = $9
         )`,
      [
        req.body.name?.trim() || 'Payment',
        req.body.vendor_label?.trim() || null,
        dollarsToCents(req.body.amount_cents),
        dollarsToCents(req.body.paid_cents),
        status_kind,
        req.body.status_label?.trim() || null,
        req.body.due_date?.trim() || null,
        req.params.lid,
        couple.id,
      ],
    );

    setFlash(req, 'success', 'Payment updated.');
    res.redirect(`/admin/couples/${couple.id}/payments`);
  } catch (err) { next(err); }
});

// Add a new line item from the payments tab
router.post('/couples/:id/payments', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const category_id = req.body.category_id;
    if (!isUuid(category_id)) {
      setFlash(req, 'error', 'Please select a category.');
      return res.redirect(`/admin/couples/${couple.id}/payments`);
    }

    // Verify category belongs to this couple
    const { rows } = await pool.query(
      'select id from budget_categories where id = $1 and couple_id = $2',
      [category_id, couple.id],
    );
    if (!rows.length) return res.status(404).send('Category not found.');

    const { rows: posRows } = await pool.query(
      'select coalesce(max(position), 0) + 1 as next_pos from budget_line_items where category_id = $1',
      [category_id],
    );

    const status_kind = BUDGET_STATUS_KINDS.includes(req.body.status_kind)
      ? req.body.status_kind : 'upcoming';

    await pool.query(
      `insert into budget_line_items
         (category_id, name, vendor_label, amount_cents, paid_cents,
          status_kind, status_label, due_date, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        category_id,
        req.body.name?.trim() || 'Payment',
        req.body.vendor_label?.trim() || null,
        dollarsToCents(req.body.amount_cents),
        dollarsToCents(req.body.paid_cents),
        status_kind,
        req.body.status_label?.trim() || null,
        req.body.due_date?.trim() || null,
        posRows[0].next_pos,
      ],
    );

    setFlash(req, 'success', 'Payment added.');
    res.redirect(`/admin/couples/${couple.id}/payments`);
  } catch (err) { next(err); }
});

// Delete a single line item from the payments tab
router.post('/couples/:id/payments/:lid/delete', async (req, res, next) => {
  if (!isUuid(req.params.lid)) return next();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    await pool.query(
      `delete from budget_line_items
        where id = $1
          and category_id in (
            select id from budget_categories where couple_id = $2
          )`,
      [req.params.lid, couple.id],
    );

    setFlash(req, 'success', 'Payment removed.');
    res.redirect(`/admin/couples/${couple.id}/payments`);
  } catch (err) { next(err); }
});

// ── AI budget allocator (Phase 4a) ────────────────────────────────────
//
// NOTE on route ordering: these handlers must be declared BEFORE the
// generic `/budget/:cid` routes above — Express matches in declaration
// order, so `/budget/allocate` would otherwise be intercepted by the
// `:cid` route with cid="allocate" and 500 on the non-UUID lookup. They
// stay here in this file because they're conceptually part of the budget
// admin surface; the route order is enforced by an explicit route-level
// guard at the top of each `/budget/:cid` handler that 404s on non-UUID
// `:cid` values.

// GET — show the input form. Pre-fills from the couple's existing fields
// (total budget, venue, guest count from accepted households) so Zoe can
// click Generate without retyping anything she's already entered.
router.get('/couples/:id/budget/allocate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: guestRows } = await pool.query(
      `select count(g.*)::int as guest_count
         from guests g
         join households h on h.id = g.household_id
        where h.couple_id = $1 and h.status = 'accepted'`,
      [couple.id],
    );

    res.render('admin/budget-allocate-form', {
      couple,
      configured: anthropicConfigured(),
      guestCountSuggestion: guestRows[0]?.guest_count || null,
      proposal: null,
      submitted: null,
      formAction: `/admin/couples/${couple.id}/budget/allocate`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// POST — call Claude, render the same view with the proposal.
router.post('/couples/:id/budget/allocate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    if (!anthropicConfigured()) {
      return res.status(400).render('admin/budget-allocate-form', {
        couple,
        configured: false,
        guestCountSuggestion: null,
        proposal: null,
        submitted: null,
        formAction: `/admin/couples/${couple.id}/budget/allocate`,
        error: 'ANTHROPIC_API_KEY is not set on the server. Add it under Render → Environment to enable the allocator.',
        flash: null,
      });
    }

    const submitted = {
      total_dollars: req.body.total_dollars?.trim() || '',
      guest_count: req.body.guest_count?.trim() || '',
      notes: req.body.notes?.trim() || '',
    };

    const totalCents = dollarsToCents(submitted.total_dollars);
    if (totalCents <= 0) {
      return res.status(400).render('admin/budget-allocate-form', {
        couple,
        configured: true,
        guestCountSuggestion: null,
        proposal: null,
        submitted,
        formAction: `/admin/couples/${couple.id}/budget/allocate`,
        error: 'Total budget is required and must be greater than zero.',
        flash: null,
      });
    }

    const guestCount = parseInt(submitted.guest_count, 10) || null;
    const weddingDate = couple.wedding_date
      ? new Date(couple.wedding_date).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
        })
      : null;

    let result;
    try {
      result = await generateAllocation({
        totalCents,
        displayName: couple.display_name,
        weddingDate,
        venueName: couple.venue_name,
        venueLocation: couple.venue_location,
        guestCount,
        notes: submitted.notes || null,
      });
    } catch (err) {
      console.error('[allocator] Claude API call failed:', err);
      return res.status(502).render('admin/budget-allocate-form', {
        couple,
        configured: true,
        guestCountSuggestion: null,
        proposal: null,
        submitted,
        formAction: `/admin/couples/${couple.id}/budget/allocate`,
        error: `Claude API call failed: ${err.message}. Try again, or save the figures manually on the budget tab.`,
        flash: null,
      });
    }

    // Reconcile the proposal against the standard category list and any
    // existing categories on the couple. Fall back to the standard order
    // so a malformed response from the model doesn't break the preview.
    const { rows: existing } = await pool.query(
      'select id, category_number, title, estimated_cents from budget_categories where couple_id = $1',
      [couple.id],
    );
    const existingByNumber = new Map(existing.map(c => [c.category_number, c]));

    const proposalRows = STANDARD_CATEGORIES.map(std => {
      const fromAi = result.categories.find(c => c.category_number === std.number);
      const current = existingByNumber.get(std.number) || null;
      return {
        category_number: std.number,
        title: std.title,
        emphasis: std.emphasis,
        proposed_cents: fromAi ? Math.max(0, parseInt(fromAi.estimated_cents, 10) || 0) : 0,
        rationale: fromAi ? fromAi.rationale : '(not generated)',
        current_cents: current ? current.estimated_cents : null,
        exists: !!current,
      };
    });

    const proposedTotal = proposalRows.reduce((s, r) => s + r.proposed_cents, 0);

    res.render('admin/budget-allocate-form', {
      couple,
      configured: true,
      guestCountSuggestion: null,
      proposal: {
        rationale_summary: result.rationale_summary,
        rows: proposalRows,
        proposedTotal,
        requestedTotal: totalCents,
        usage: result.usage,
      },
      submitted,
      formAction: `/admin/couples/${couple.id}/budget/allocate`,
      error: null,
      flash: null,
    });
  } catch (err) { next(err); }
});

// POST /apply — write the proposal to budget_categories. For matching
// existing categories it updates `estimated_cents` only (leaves line items
// alone); for missing categories it creates them with no line items. Does
// NOT delete categories outside the proposal — Zoe stays in control of
// removals.
router.post('/couples/:id/budget/allocate/apply', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    // Body shape: rows[i] = { category_number, title, estimated_dollars, apply }
    // Only rows with apply=true get persisted.
    const raw = req.body.rows || {};
    const indices = Object.keys(raw).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
    const toApply = indices
      .map(i => raw[i])
      .filter(r => r && r.apply)
      .map(r => ({
        category_number: parseInt(r.category_number, 10),
        title: r.title?.trim() || '',
        estimated_cents: dollarsToCents(r.estimated_dollars),
      }))
      .filter(r => r.category_number && r.title);

    if (toApply.length === 0) {
      setFlash(req, 'info', 'Nothing was selected to apply.');
      return res.redirect(`/admin/couples/${couple.id}/budget`);
    }

    // Need each standard category's emphasis + position when creating new
    // rows. Look the standards up by number.
    const stdByNumber = new Map(STANDARD_CATEGORIES.map(c => [c.number, c]));

    await client.query('begin');
    let updated = 0;
    let created = 0;
    for (const r of toApply) {
      const { rowCount } = await client.query(
        `update budget_categories
            set estimated_cents = $1, updated_at = now()
          where couple_id = $2 and category_number = $3`,
        [r.estimated_cents, couple.id, r.category_number],
      );
      if (rowCount > 0) {
        updated += 1;
        continue;
      }
      const std = stdByNumber.get(r.category_number);
      await client.query(
        `insert into budget_categories
           (couple_id, category_number, title, title_emphasis, estimated_cents, position)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          couple.id,
          r.category_number,
          std?.title || r.title,
          std?.emphasis || null,
          r.estimated_cents,
          r.category_number,
        ],
      );
      created += 1;
    }
    await client.query('commit');

    const parts = [];
    if (updated > 0) parts.push(`updated ${updated} estimate${updated === 1 ? '' : 's'}`);
    if (created > 0) parts.push(`created ${created} categor${created === 1 ? 'y' : 'ies'}`);
    setFlash(req, 'success', `Applied AI allocation — ${parts.join(', ')}.`);
    res.redirect(`/admin/couples/${couple.id}/budget`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
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

// ── AI checklist generator (Phase 4c) ─────────────────────────────────
// Static paths `/checklist/generate` declared before `/:mid` so Express
// doesn't swallow them as the parameterized milestone-id route.

router.get('/couples/:id/checklist/generate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    res.render('admin/checklist-generate-form', {
      couple,
      configured: anthropicConfigured(),
      proposal:   null,
      submitted:  null,
      error:      null,
      flash:      consumeFlash(req),
      formAction: `/admin/couples/${couple.id}/checklist/generate`,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/checklist/generate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const renderForm = (extra) => res.status(extra.error ? 400 : 200).render('admin/checklist-generate-form', {
      couple,
      configured: anthropicConfigured(),
      proposal:   null,
      submitted:  req.body,
      flash:      consumeFlash(req),
      formAction: `/admin/couples/${couple.id}/checklist/generate`,
      ...extra,
    });

    if (!anthropicConfigured()) {
      return renderForm({ error: 'ANTHROPIC_API_KEY is not set. Add it under Render → Environment.' });
    }

    const weddingDate = couple.wedding_date
      ? new Date(couple.wedding_date).toISOString().split('T')[0]
      : null;
    if (!weddingDate) {
      return renderForm({ error: 'This couple has no wedding date set. Add one in the couple form first.' });
    }

    const { rows: guestRows } = await pool.query(
      `select count(*) as cnt from guests g
         join households h on h.id = g.household_id
        where h.couple_id = $1 and h.status = 'accepted'`,
      [couple.id],
    );
    const guestCount = Number(guestRows[0]?.cnt) || null;

    let result;
    try {
      result = await generateChecklist({
        weddingDate,
        weddingDateFormatted: couple.wedding_date
          ? new Date(couple.wedding_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
          : undefined,
        displayName:   couple.display_name,
        venueName:     couple.venue_name,
        venueLocation: couple.venue_location,
        guestCount,
        brief: (req.body.brief || '').trim() || undefined,
      });
    } catch (err) {
      console.error('[checklist-gen] Claude API error:', err);
      return renderForm({ error: `AI call failed: ${err.message}` });
    }

    const totalTasks = result.milestones.reduce((s, m) => s + m.tasks.length, 0);
    res.render('admin/checklist-generate-form', {
      couple,
      configured: true,
      proposal: { ...result, totalTasks },
      submitted: req.body,
      error: null,
      flash: consumeFlash(req),
      formAction: `/admin/couples/${couple.id}/checklist/generate`,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/checklist/generate/apply', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    // Parse milestones from hidden form fields: milestones[i][*] and milestones[i][tasks][j][*]
    const raw = req.body.milestones || {};
    const milestones = Object.keys(raw)
      .map(Number)
      .sort((a, b) => a - b)
      .map(i => {
        const m = raw[i];
        const tasksRaw = m.tasks || {};
        const tasks = Object.keys(tasksRaw)
          .map(Number)
          .sort((a, b) => a - b)
          .map(j => ({
            position: Number(tasksRaw[j].position),
            name:     (tasksRaw[j].name     || '').trim(),
            sub_text: (tasksRaw[j].sub_text || '').trim() || null,
          }))
          .filter(t => t.name);
        return {
          position:   Number(m.position),
          date_label: (m.date_label || '').trim(),
          title:      (m.title      || '').trim(),
          tasks,
        };
      })
      .filter(m => m.title);

    if (milestones.length === 0) {
      setFlash(req, 'info', 'Nothing to apply — no milestones received.');
      return res.redirect(`/admin/couples/${couple.id}/checklist`);
    }

    // Replace all existing milestones + tasks for this couple in a transaction.
    await pool.query('begin');
    try {
      await pool.query(
        'delete from checklist_milestones where couple_id = $1',
        [couple.id],
      );
      for (const m of milestones) {
        const { rows: [ms] } = await pool.query(
          `insert into checklist_milestones (couple_id, date_label, title, position)
           values ($1, $2, $3, $4) returning id`,
          [couple.id, m.date_label, m.title, m.position],
        );
        for (const t of m.tasks) {
          await pool.query(
            `insert into checklist_tasks (milestone_id, name, sub_text, position)
             values ($1, $2, $3, $4)`,
            [ms.id, t.name, t.sub_text, t.position],
          );
        }
      }
      await pool.query('commit');
    } catch (err) {
      await pool.query('rollback');
      throw err;
    }

    const totalTasks = milestones.reduce((s, m) => s + m.tasks.length, 0);
    setFlash(req, 'success', `Applied AI checklist — ${milestones.length} milestones, ${totalTasks} tasks.`);
    res.redirect(`/admin/couples/${couple.id}/checklist`);
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

// ── AI timeline generator ──────────────────────────────────────────────
router.get('/couples/:id/timeline/generate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    const { rows: phases } = await pool.query(
      'select count(*)::int as count from timeline_phases where couple_id = $1', [couple.id],
    );
    res.render('admin/timeline-generate-form', {
      couple, configured: anthropicConfigured(),
      existingCount: phases[0].count,
      flash: consumeFlash(req), error: null,
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/timeline/generate', upload.single('file'), async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');
    if (!anthropicConfigured()) return res.status(503).send('ANTHROPIC_API_KEY not set.');

    const ceremonyTime = req.body.ceremony_time?.trim() || couple.timeline_ceremony_time || '';
    const guestCount   = parseInt(req.body.guest_count, 10) || null;
    const notes        = req.body.notes?.trim() || '';
    const weddingDate  = couple.wedding_date
      ? new Date(couple.wedding_date).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric', timeZone:'UTC' })
      : null;

    let result;
    try {
      result = await generateTimeline({
        ceremonyTime, weddingDate,
        venueName: couple.venue_name, venueLocation: couple.venue_location,
        guestCount, notes: notes || null,
        fileBuffer:   req.file?.buffer   || null,
        fileMimeType: req.file?.mimetype || null,
      });
    } catch (err) {
      console.error('[timeline-generate]', err);
      return res.status(502).render('admin/timeline-generate-form', {
        couple, configured: true, existingCount: 0,
        flash: null, error: `Claude API failed: ${err.message}`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      if (req.body.replace === 'yes') {
        await client.query('delete from timeline_phases where couple_id = $1', [couple.id]);
      }
      for (let pi = 0; pi < result.phases.length; pi++) {
        const p = result.phases[pi];
        const { rows: [phase] } = await client.query(
          `insert into timeline_phases (couple_id, phase_number, title, window_text, note_text, variant, position)
           values ($1, (select coalesce(max(phase_number),0)+1 from timeline_phases where couple_id=$1), $2, $3, $4, $5, $6)
           returning id`,
          [couple.id, p.title, p.window_text || '', p.note_text || '', p.variant || 'standard', pi],
        );
        for (let ei = 0; ei < (p.events || []).length; ei++) {
          const e = p.events[ei];
          await client.query(
            `insert into timeline_events (phase_id, time_text, meridiem, title, where_label, lead_label, with_label, note_text, position)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [phase.id, e.time_text, e.meridiem || '', e.title, e.where_label || '', e.lead_label || '', e.with_label || '', e.note_text || '', ei],
          );
        }
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally { client.release(); }

    setFlash(req, 'success', `Generated ${result.phases.length} timeline phases — review and edit below.`);
    res.redirect(`/admin/couples/${couple.id}/timeline`);
  } catch (err) { next(err); }
});

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

// Reorder phases via drag-and-drop (called via fetch from the list page)
router.post('/couples/:id/timeline/reorder', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).json({ error: 'not found' });

    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.some(id => !isUuid(id))) {
      return res.status(400).json({ error: 'invalid ids' });
    }

    await client.query('begin');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        'update timeline_phases set position = $1 where id = $2 and couple_id = $3',
        [i + 1, ids[i], couple.id],
      );
    }
    await client.query('commit');
    res.json({ ok: true });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
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

// ── Floor plan (per couple — spaces with inline zones + key items) ────

const FLOORPLAN_ZONE_KINDS = [
  'arch', 'stage', 'chairs', 'aisle', 'service',
  'bar', 'hightop', 'dance', 'table', 'head-table', 'door',
];
const FLOORPLAN_EDGE_ANCHORS = ['', 'bottom-edge'];

function nullIfEmpty(s) {
  return (s === undefined || s === null || s === '') ? null : String(s).trim() || null;
}

function intOrNull(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = parseInt(String(s).replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// UUID guard — used in `/.../:something` routes that share a prefix with
// hardcoded paths (e.g. `/budget/:cid` vs `/budget/allocate`). Express
// matches declaration order; this check lets static paths fall through
// to their own handlers without triggering a UUID-lookup 500 first.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

function parseFpZonesFromBody(body) {
  const raw = body.zones || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(z => z && (z.kind || z.label))
    .map((z, idx) => ({
      id: z.id || null,
      kind: FLOORPLAN_ZONE_KINDS.includes(z.kind) ? z.kind : 'service',
      label: nullIfEmpty(z.label),
      position_top:    nullIfEmpty(z.position_top),
      position_left:   nullIfEmpty(z.position_left),
      position_right:  nullIfEmpty(z.position_right),
      position_bottom: nullIfEmpty(z.position_bottom),
      size_width:      nullIfEmpty(z.size_width),
      size_height:     nullIfEmpty(z.size_height),
      is_circle: !!(z.is_circle && z.is_circle !== '' && z.is_circle !== 'false'),
      edge_anchor: z.edge_anchor && FLOORPLAN_EDGE_ANCHORS.includes(z.edge_anchor) && z.edge_anchor !== ''
                   ? z.edge_anchor : null,
      position: idx + 1,
    }));
}

function parseFpKeysFromBody(body) {
  const raw = body.keys || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(k => k && k.name && k.name.trim().length > 0)
    .map((k, idx) => ({
      id: k.id || null,
      name: k.name.trim(),
      detail: nullIfEmpty(k.detail),
      position: idx + 1,
    }));
}

router.get('/couples/:id/floor-plan', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: spaces } = await pool.query(
      `select s.*,
              coalesce((select count(*) from floorplan_zones z where z.space_id = s.id), 0)::int     as zone_count,
              coalesce((select count(*) from floorplan_key_items k where k.space_id = s.id), 0)::int as key_count
         from floorplan_spaces s
        where s.couple_id = $1
        order by s.position asc`,
      [couple.id],
    );
    res.render('admin/floorplan-spaces-list', {
      couple,
      spaces,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/floor-plan/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows } = await pool.query(
      'select coalesce(max(position), 0) + 1 as next_pos from floorplan_spaces where couple_id = $1',
      [couple.id],
    );

    res.render('admin/floorplan-space-form', {
      couple,
      space: null,
      zones: [],
      keys: [],
      suggestedPosition: rows[0].next_pos,
      formAction: `/admin/couples/${couple.id}/floor-plan`,
      zoneKinds: FLOORPLAN_ZONE_KINDS,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/floor-plan/:sid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: spaceRows } = await pool.query(
      'select * from floorplan_spaces where id = $1 and couple_id = $2',
      [req.params.sid, couple.id],
    );
    if (!spaceRows[0]) return res.status(404).send('Space not found.');

    const [{ rows: zones }, { rows: keys }] = await Promise.all([
      pool.query('select * from floorplan_zones where space_id = $1 order by position asc', [spaceRows[0].id]),
      pool.query('select * from floorplan_key_items where space_id = $1 order by position asc', [spaceRows[0].id]),
    ]);

    res.render('admin/floorplan-space-form', {
      couple,
      space: spaceRows[0],
      zones,
      keys,
      suggestedPosition: spaceRows[0].position,
      formAction: `/admin/couples/${couple.id}/floor-plan/${spaceRows[0].id}`,
      zoneKinds: FLOORPLAN_ZONE_KINDS,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/floor-plan', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const spaceData = {
      eyebrow: nullIfEmpty(req.body.eyebrow),
      title: req.body.title?.trim() || '',
      capacity: intOrNull(req.body.capacity),
      square_feet: intOrNull(req.body.square_feet),
      location_label: nullIfEmpty(req.body.location_label),
      edge_top_label: nullIfEmpty(req.body.edge_top_label),
      layout_image_url: nullIfEmpty(req.body.layout_image_url),
      position: parseInt(req.body.position, 10) || 0,
    };
    const zones = parseFpZonesFromBody(req.body);
    const keys  = parseFpKeysFromBody(req.body);

    if (!spaceData.title) {
      return res.status(400).render('admin/floorplan-space-form', {
        couple,
        space: spaceData,
        zones,
        keys,
        suggestedPosition: spaceData.position || 1,
        formAction: `/admin/couples/${couple.id}/floor-plan`,
        zoneKinds: FLOORPLAN_ZONE_KINDS,
        error: 'Space title is required.',
        flash: null,
      });
    }

    await client.query('begin');
    const { rows } = await client.query(
      `insert into floorplan_spaces
         (couple_id, eyebrow, title, capacity, square_feet, location_label, edge_top_label, layout_image_url, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [couple.id, spaceData.eyebrow, spaceData.title, spaceData.capacity,
       spaceData.square_feet, spaceData.location_label, spaceData.edge_top_label,
       spaceData.layout_image_url, spaceData.position],
    );
    const spaceId = rows[0].id;

    for (const z of zones) {
      await client.query(
        `insert into floorplan_zones
           (space_id, kind, label, position_top, position_left, position_right,
            position_bottom, size_width, size_height, is_circle, edge_anchor, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [spaceId, z.kind, z.label, z.position_top, z.position_left, z.position_right,
         z.position_bottom, z.size_width, z.size_height, z.is_circle, z.edge_anchor, z.position],
      );
    }
    for (const k of keys) {
      await client.query(
        `insert into floorplan_key_items (space_id, name, detail, position)
         values ($1, $2, $3, $4)`,
        [spaceId, k.name, k.detail, k.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Added ${spaceData.title} (${zones.length} zone${zones.length === 1 ? '' : 's'}, ${keys.length} key item${keys.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/floor-plan`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/floor-plan/:sid', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const spaceData = {
      eyebrow: nullIfEmpty(req.body.eyebrow),
      title: req.body.title?.trim() || '',
      capacity: intOrNull(req.body.capacity),
      square_feet: intOrNull(req.body.square_feet),
      location_label: nullIfEmpty(req.body.location_label),
      edge_top_label: nullIfEmpty(req.body.edge_top_label),
      layout_image_url: nullIfEmpty(req.body.layout_image_url),
      position: parseInt(req.body.position, 10) || 0,
    };
    const zones = parseFpZonesFromBody(req.body);
    const keys  = parseFpKeysFromBody(req.body);

    if (!spaceData.title) {
      return res.status(400).redirect(`/admin/couples/${couple.id}/floor-plan/${req.params.sid}`);
    }

    await client.query('begin');
    const { rowCount } = await client.query(
      `update floorplan_spaces set
         eyebrow = $1, title = $2, capacity = $3, square_feet = $4,
         location_label = $5, edge_top_label = $6, layout_image_url = $7, position = $8,
         updated_at = now()
       where id = $9 and couple_id = $10`,
      [spaceData.eyebrow, spaceData.title, spaceData.capacity, spaceData.square_feet,
       spaceData.location_label, spaceData.edge_top_label, spaceData.layout_image_url,
       spaceData.position, req.params.sid, couple.id],
    );
    if (rowCount === 0) {
      await client.query('rollback');
      return res.status(404).send('Space not found.');
    }

    // Replace zones + keys wholesale — same approach as households/budget.
    await client.query('delete from floorplan_zones where space_id = $1', [req.params.sid]);
    await client.query('delete from floorplan_key_items where space_id = $1', [req.params.sid]);
    for (const z of zones) {
      await client.query(
        `insert into floorplan_zones
           (space_id, kind, label, position_top, position_left, position_right,
            position_bottom, size_width, size_height, is_circle, edge_anchor, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [req.params.sid, z.kind, z.label, z.position_top, z.position_left, z.position_right,
         z.position_bottom, z.size_width, z.size_height, z.is_circle, z.edge_anchor, z.position],
      );
    }
    for (const k of keys) {
      await client.query(
        `insert into floorplan_key_items (space_id, name, detail, position)
         values ($1, $2, $3, $4)`,
        [req.params.sid, k.name, k.detail, k.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved ${spaceData.title}.`);
    res.redirect(`/admin/couples/${couple.id}/floor-plan`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/floor-plan/:sid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'delete from floorplan_spaces where id = $1 and couple_id = $2 returning title',
      [req.params.sid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].title}.`);
    res.redirect(`/admin/couples/${req.params.id}/floor-plan`);
  } catch (err) { next(err); }
});

// ── Design (per couple — galleries + materials) ───────────────────────

const DESIGN_SWATCH_KINDS = [
  'silver', 'gold', 'brass', 'white', 'ivory', 'clear',
  'palette-1', 'palette-2', 'palette-3', 'palette-4',
];

function parseTilesFromBody(body) {
  const raw = body.tiles || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(t => t && (t.title?.trim() || t.image_url?.trim()))
    .map((t, idx) => ({
      id: t.id || null,
      label: t.label?.trim() || '',
      title: t.title?.trim() || '',
      note: nullIfEmpty(t.note),
      image_url: nullIfEmpty(t.image_url),
      is_hero: !!(t.is_hero && t.is_hero !== '' && t.is_hero !== 'false'),
      bg_position_x: Math.max(0, Math.min(100, parseInt(t.bg_position_x, 10) || 50)),
      bg_position_y: Math.max(0, Math.min(100, parseInt(t.bg_position_y, 10) || 50)),
      position: idx + 1,
    }));
}

// Design landing — shows both sub-sections (galleries + materials) so
// Zoe can reach either without clicking through twice.
router.get('/couples/:id/design', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const [{ rows: galleries }, { rows: materials }] = await Promise.all([
      pool.query(
        `select g.*,
                coalesce((select count(*) from inspiration_tiles t where t.gallery_id = g.id), 0)::int  as tile_count,
                coalesce((select count(*) from inspiration_tiles t where t.gallery_id = g.id and t.is_hero), 0)::int as hero_count
           from inspiration_galleries g
          where g.couple_id = $1
          order by g.position asc`,
        [couple.id],
      ),
      pool.query(
        'select * from design_materials where couple_id = $1 order by position asc',
        [couple.id],
      ),
    ]);

    res.render('admin/design-overview', {
      couple,
      galleries,
      materials,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// ── Galleries (with inline tiles) ─────────────────────────────────────

// AI tile description — POST an image, get back label/title/note JSON.
router.post('/couples/:id/design/galleries/describe-tile', upload.single('file'), async (req, res) => {
  if (!anthropicConfigured()) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const data = await describeTileImage({ buffer: req.file.buffer, mimeType: req.file.mimetype });
    res.json(data);
  } catch (err) {
    console.error('[tile-describe]', err);
    res.status(500).json({ error: 'Description failed — fill in manually.' });
  }
});

router.get('/couples/:id/design/galleries/new', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows } = await pool.query(
      'select coalesce(max(position), 0) + 1 as next_pos from inspiration_galleries where couple_id = $1',
      [couple.id],
    );

    res.render('admin/design-gallery-form', {
      couple,
      gallery: null,
      tiles: [],
      suggestedPosition: rows[0].next_pos,
      formAction: `/admin/couples/${couple.id}/design/galleries`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.get('/couples/:id/design/galleries/:gid', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: galleryRows } = await pool.query(
      'select * from inspiration_galleries where id = $1 and couple_id = $2',
      [req.params.gid, couple.id],
    );
    if (!galleryRows[0]) return res.status(404).send('Gallery not found.');

    const { rows: tiles } = await pool.query(
      'select * from inspiration_tiles where gallery_id = $1 order by position asc',
      [galleryRows[0].id],
    );

    res.render('admin/design-gallery-form', {
      couple,
      gallery: galleryRows[0],
      tiles,
      suggestedPosition: galleryRows[0].position,
      formAction: `/admin/couples/${couple.id}/design/galleries/${galleryRows[0].id}`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/couples/:id/design/galleries', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const galleryData = {
      eyebrow: nullIfEmpty(req.body.eyebrow),
      title: req.body.title?.trim() || '',
      description: nullIfEmpty(req.body.description),
      position: parseInt(req.body.position, 10) || 0,
    };
    const tiles = parseTilesFromBody(req.body);

    if (!galleryData.title) {
      return res.status(400).render('admin/design-gallery-form', {
        couple,
        gallery: galleryData,
        tiles,
        suggestedPosition: galleryData.position || 1,
        formAction: `/admin/couples/${couple.id}/design/galleries`,
        error: 'Gallery title is required.',
        flash: null,
      });
    }

    await client.query('begin');
    const { rows } = await client.query(
      `insert into inspiration_galleries (couple_id, eyebrow, title, description, position)
       values ($1, $2, $3, $4, $5) returning id`,
      [couple.id, galleryData.eyebrow, galleryData.title, galleryData.description, galleryData.position],
    );
    const galleryId = rows[0].id;
    for (const t of tiles) {
      await client.query(
        `insert into inspiration_tiles (gallery_id, label, title, note, image_url, is_hero, bg_position_x, bg_position_y, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [galleryId, t.label, t.title, t.note, t.image_url, t.is_hero, t.bg_position_x, t.bg_position_y, t.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Added ${galleryData.title} (${tiles.length} tile${tiles.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/design`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/design/galleries/:gid', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const galleryData = {
      eyebrow: nullIfEmpty(req.body.eyebrow),
      title: req.body.title?.trim() || '',
      description: nullIfEmpty(req.body.description),
      position: parseInt(req.body.position, 10) || 0,
    };
    const tiles = parseTilesFromBody(req.body);

    if (!galleryData.title) {
      return res.status(400).redirect(`/admin/couples/${couple.id}/design/galleries/${req.params.gid}`);
    }

    await client.query('begin');
    const { rowCount } = await client.query(
      `update inspiration_galleries set
         eyebrow = $1, title = $2, description = $3, position = $4, updated_at = now()
       where id = $5 and couple_id = $6`,
      [galleryData.eyebrow, galleryData.title, galleryData.description, galleryData.position, req.params.gid, couple.id],
    );
    if (rowCount === 0) {
      await client.query('rollback');
      return res.status(404).send('Gallery not found.');
    }

    await client.query('delete from inspiration_tiles where gallery_id = $1', [req.params.gid]);
    for (const t of tiles) {
      await client.query(
        `insert into inspiration_tiles (gallery_id, label, title, note, image_url, is_hero, position)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [req.params.gid, t.label, t.title, t.note, t.image_url, t.is_hero, t.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved ${galleryData.title}.`);
    res.redirect(`/admin/couples/${couple.id}/design`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/couples/:id/design/galleries/:gid/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `delete from inspiration_galleries
        where id = $1 and couple_id = $2 returning title`,
      [req.params.gid, req.params.id],
    );
    if (rows[0]) setFlash(req, 'success', `Removed ${rows[0].title}.`);
    res.redirect(`/admin/couples/${req.params.id}/design`);
  } catch (err) { next(err); }
});

// ── Materials (a single bulk-edit form for the whole list) ────────────

router.get('/couples/:id/design/materials', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const { rows: materials } = await pool.query(
      'select * from design_materials where couple_id = $1 order by position asc',
      [couple.id],
    );
    res.render('admin/design-materials-form', {
      couple,
      materials,
      swatchKinds: DESIGN_SWATCH_KINDS,
      formAction: `/admin/couples/${couple.id}/design/materials`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

function parseMaterialsFromBody(body) {
  const raw = body.materials || {};
  const indices = Object.keys(raw)
    .map(Number)
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return indices
    .map(i => raw[i])
    .filter(m => m && m.name && m.name.trim().length > 0)
    .map((m, idx) => ({
      name: m.name.trim(),
      detail: nullIfEmpty(m.detail),
      swatch_kind: DESIGN_SWATCH_KINDS.includes(m.swatch_kind) ? m.swatch_kind : 'silver',
      image_url: nullIfEmpty(m.image_url),
      position: idx + 1,
    }));
}

router.post('/couples/:id/design/materials', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    const materials = parseMaterialsFromBody(req.body);

    await client.query('begin');
    await client.query('delete from design_materials where couple_id = $1', [couple.id]);
    for (const m of materials) {
      await client.query(
        `insert into design_materials (couple_id, name, detail, swatch_kind, image_url, position)
         values ($1, $2, $3, $4, $5, $6)`,
        [couple.id, m.name, m.detail, m.swatch_kind, m.image_url, m.position],
      );
    }
    await client.query('commit');

    setFlash(req, 'success', `Saved materials (${materials.length} row${materials.length === 1 ? '' : 's'}).`);
    res.redirect(`/admin/couples/${couple.id}/design`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── AI palette + tone generator (Phase 4b) ────────────────────────────

// GET — show the input form. Pre-fills brief from the couple's existing
// tone fields so re-runs feel like iteration on what's there.
router.get('/couples/:id/design/generate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    res.render('admin/design-generate-form', {
      couple,
      configured: anthropicConfigured(),
      proposal: null,
      submitted: null,
      formAction: `/admin/couples/${couple.id}/design/generate`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

// POST — call Claude, render the same view with the proposal preview.
router.post('/couples/:id/design/generate', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    if (!anthropicConfigured()) {
      return res.status(400).render('admin/design-generate-form', {
        couple,
        configured: false,
        proposal: null,
        submitted: null,
        formAction: `/admin/couples/${couple.id}/design/generate`,
        error: 'ANTHROPIC_API_KEY is not set on the server. Add it under Render → Environment to enable the generator.',
        flash: null,
      });
    }

    const submitted = {
      season: req.body.season?.trim() || '',
      brief: req.body.brief?.trim() || '',
    };

    const weddingDate = couple.wedding_date
      ? new Date(couple.wedding_date).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
        })
      : null;

    let result;
    try {
      result = await generatePalette({
        displayName: couple.display_name,
        weddingDate,
        venueName: couple.venue_name,
        venueLocation: couple.venue_location,
        season: submitted.season || null,
        brief: submitted.brief || null,
      });
    } catch (err) {
      console.error('[palette] Claude API call failed:', err);
      return res.status(502).render('admin/design-generate-form', {
        couple,
        configured: true,
        proposal: null,
        submitted,
        formAction: `/admin/couples/${couple.id}/design/generate`,
        error: `Claude API call failed: ${err.message}. Try again, or edit the palette directly on the Basics tab.`,
        flash: null,
      });
    }

    res.render('admin/design-generate-form', {
      couple,
      configured: true,
      proposal: result,
      submitted,
      formAction: `/admin/couples/${couple.id}/design/generate`,
      error: null,
      flash: null,
    });
  } catch (err) { next(err); }
});

// POST /apply — write the palette + tone to the couple row. The form
// uses checkboxes per field so Zoe can selectively apply (e.g. take the
// palette but keep the existing tone keywords).
router.post('/couples/:id/design/generate/apply', async (req, res, next) => {
  try {
    const couple = await findCoupleById(req.params.id);
    if (!couple) return res.status(404).send('Couple not found.');

    // Field-level apply checkboxes. For palette colors we apply hex +
    // name as a pair so the database doesn't end up with a hex from a
    // new proposal next to a name from the previous one.
    const updates = {};
    const wantsPalette = (n) => req.body[`apply_palette_${n}`] === 'true';
    const wantsTone    = req.body.apply_tone === 'true';

    for (const n of [1, 2, 3, 4, 5]) {
      if (wantsPalette(n)) {
        const hex  = (req.body[`palette_color_${n}`] || '').trim();
        const name = (req.body[`palette_color_${n}_name`] || '').trim() || null;
        if (hex) {
          updates[`palette_color_${n}`] = hex;
          updates[`palette_color_${n}_name`] = name;
        }
      }
    }
    if (wantsTone) {
      const kw  = (req.body.tone_keywords || '').trim() || null;
      const stm = (req.body.tone_statement || '').trim() || null;
      updates.tone_keywords = kw;
      updates.tone_statement = stm;
    }

    const fields = Object.keys(updates);
    if (fields.length === 0) {
      setFlash(req, 'info', 'Nothing was selected to apply.');
      return res.redirect(`/admin/couples/${couple.id}/design`);
    }

    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = [...fields.map(f => updates[f]), couple.id];
    await pool.query(
      `update couples set ${setClause}, updated_at = now() where id = $${fields.length + 1}`,
      values,
    );

    const summary = [];
    const paletteCount = [1, 2, 3, 4].filter(wantsPalette).length;
    if (paletteCount > 0) summary.push(`${paletteCount} palette color${paletteCount === 1 ? '' : 's'}`);
    if (wantsTone) summary.push('tone copy');
    setFlash(req, 'success', `Applied AI palette — updated ${summary.join(' + ')}.`);
    res.redirect(`/admin/couples/${couple.id}/design`);
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

// ── Team members ─────────────────────────────────────────────────────────
// Global (not per-couple). Edit name, role, bio, and photo for Zoe & Amanda.

router.get('/team', requireAdmin, async (req, res, next) => {
  try {
    const { rows: members } = await pool.query(
      'select * from team_members order by sort_order asc',
    );
    res.render('admin/team-list', { members, flash: consumeFlash(req) });
  } catch (err) { next(err); }
});

router.get('/team/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const { rows: [member] } = await pool.query(
      'select * from team_members where id = $1', [req.params.id],
    );
    if (!member) return res.status(404).send('Team member not found.');
    res.render('admin/team-form', {
      member,
      formAction: `/admin/team/${member.id}`,
      error: null,
      flash: consumeFlash(req),
    });
  } catch (err) { next(err); }
});

router.post('/team/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, role, bio, photo_url, sort_order } = req.body;
    if (!name?.trim()) {
      const { rows: [member] } = await pool.query('select * from team_members where id = $1', [req.params.id]);
      return res.status(400).render('admin/team-form', {
        member: { ...member, name, role, bio, photo_url, sort_order },
        formAction: `/admin/team/${req.params.id}`,
        error: 'Name is required.',
        flash: null,
      });
    }
    await pool.query(
      `update team_members
          set name = $1, role = $2, bio = $3, photo_url = $4,
              sort_order = $5, updated_at = now()
        where id = $6`,
      [
        name.trim(),
        role?.trim() || null,
        bio?.trim()  || null,
        photo_url?.trim() || null,
        parseInt(sort_order, 10) || 0,
        req.params.id,
      ],
    );
    setFlash(req, 'success', `Saved ${name.trim()}.`);
    res.redirect('/admin/team');
  } catch (err) { next(err); }
});

// Photo upload for a team member — same Cloudinary pattern as layout images.
router.post('/team/:id/upload-photo', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    let apiKey, apiSecret, cloudName;
    const rawUrl = process.env.CLOUDINARY_URL || '';
    const m = rawUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) {
      [, apiKey, apiSecret, cloudName] = m;
    } else {
      apiKey    = process.env.CLOUDINARY_API_KEY;
      apiSecret = process.env.CLOUDINARY_API_SECRET;
      cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    }
    if (!apiKey || !apiSecret || !cloudName) {
      return res.status(503).json({ error: 'Cloudinary credentials not configured.' });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const signature = createHash('sha1').update(`timestamp=${timestamp}${apiSecret}`).digest('hex');

    const fd = new FormData();
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'photo');
    fd.append('timestamp', String(timestamp));
    fd.append('api_key', apiKey);
    fd.append('signature', signature);

    const cldRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST', body: fd,
    });
    const data = await cldRes.json();
    if (!cldRes.ok) return res.status(502).json({ error: data.error?.message || 'Upload failed.' });

    res.json({ url: data.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new team member
router.post('/team', requireAdmin, async (req, res, next) => {
  try {
    const { name, role, bio } = req.body;
    if (!name?.trim()) return res.redirect('/admin/team');
    const { rows: [{ max_order }] } = await pool.query(
      'select coalesce(max(sort_order), -1) as max_order from team_members',
    );
    await pool.query(
      'insert into team_members (name, role, bio, sort_order) values ($1,$2,$3,$4)',
      [name.trim(), role?.trim() || null, bio?.trim() || null, max_order + 1],
    );
    setFlash(req, 'success', `Added ${name.trim()}.`);
    res.redirect('/admin/team');
  } catch (err) { next(err); }
});

// Delete a team member
router.post('/team/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    const { rows: [m] } = await pool.query(
      'delete from team_members where id = $1 returning name', [req.params.id],
    );
    if (m) setFlash(req, 'success', `Removed ${m.name}.`);
    res.redirect('/admin/team');
  } catch (err) { next(err); }
});

export default router;
