// Couple-facing portal routes — /p/:slug/...
//
// Phase 1 only handles the landing page. Phase 2 will add /design,
// /vendors, /checklist, /budget, /timeline, /guest-list off the same
// :slug prefix.

import express from 'express';
import { pool } from '../db/pool.js';

const router = express.Router();

// Helper — fetch a couple by slug or null. Centralized so every page
// route uses the same lookup and the same "not found" semantics.
async function findCoupleBySlug(slug) {
  const { rows } = await pool.query(
    'select * from couples where slug = $1 limit 1',
    [slug],
  );
  return rows[0] ?? null;
}

// Format a date column as "October 10, 2026" using the wedding venue's
// local conventions (US English for now — when we go international,
// move this into a per-couple locale field).
function formatWeddingDate(d) {
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

router.get('/p/:slug', async (req, res, next) => {
  try {
    const couple = await findCoupleBySlug(req.params.slug);
    if (!couple) {
      return res.status(404).send('Portal not found.');
    }

    res.render('landing', {
      couple,
      currentPage: 'home',
      formattedDate: formatWeddingDate(couple.wedding_date),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
