// Couple-facing portal routes — /p/:slug/...
//
// Phase 2: all eight pages render. Each page reuses the same couple
// lookup and a single render call into its own EJS template. Per-page
// data (vendor rows, budget categories, checklist tasks, etc.) is
// hardcoded in the templates for now — Phase 3 migrates each section
// into its own table and wires admin forms to write them.

import express from 'express';
import { pool } from '../db/pool.js';

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────

async function findCoupleBySlug(slug) {
  const { rows } = await pool.query(
    'select * from couples where slug = $1 limit 1',
    [slug],
  );
  return rows[0] ?? null;
}

function formatWeddingDate(d) {
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Middleware — every /p/:slug/* route loads the couple once and stashes
// it on res.locals so partials and templates can read it without each
// route handler doing the lookup itself.
async function loadCouple(req, res, next) {
  try {
    const couple = await findCoupleBySlug(req.params.slug);
    if (!couple) {
      return res.status(404).send('Portal not found.');
    }
    res.locals.couple = couple;
    res.locals.formattedDate = formatWeddingDate(couple.wedding_date);
    next();
  } catch (err) {
    next(err);
  }
}

router.use('/p/:slug', loadCouple);

// ── Pages ──────────────────────────────────────────────────────────────

router.get('/p/:slug', (_req, res) =>
  res.render('landing', { currentPage: 'home' }),
);

router.get('/p/:slug/design', (_req, res) =>
  res.render('design', { currentPage: 'design' }),
);

router.get('/p/:slug/vendors', (_req, res) =>
  res.render('vendors', { currentPage: 'vendors' }),
);

router.get('/p/:slug/checklist', (_req, res) =>
  res.render('checklist', { currentPage: 'checklist' }),
);

router.get('/p/:slug/budget', (_req, res) =>
  res.render('budget', { currentPage: 'budget' }),
);

router.get('/p/:slug/timeline', (_req, res) =>
  res.render('timeline', { currentPage: 'timeline' }),
);

router.get('/p/:slug/floor-plan', (_req, res) =>
  res.render('floor-plan', { currentPage: 'floor-plan' }),
);

router.get('/p/:slug/guest-list', (_req, res) =>
  res.render('guest-list', { currentPage: 'guest-list' }),
);

export default router;
