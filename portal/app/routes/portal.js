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

router.get('/p/:slug/vendors', async (req, res, next) => {
  try {
    const { rows: vendors } = await pool.query(
      'select * from vendors where couple_id = $1 order by position asc, vendor_type asc',
      [res.locals.couple.id],
    );

    // Aggregate counts for the summary stats strip at the top of the
    // vendors page. Done in JS rather than SQL so the page can show
    // every status bucket the schema allows.
    const counts = vendors.reduce(
      (acc, v) => {
        acc.total += 1;
        acc[v.status] = (acc[v.status] || 0) + 1;
        return acc;
      },
      { total: 0 },
    );

    res.render('vendors', {
      currentPage: 'vendors',
      vendors,
      counts,
    });
  } catch (err) {
    next(err);
  }
});

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

router.get('/p/:slug/guest-list', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    const [tablesRes, householdsRes, guestsRes] = await Promise.all([
      pool.query(
        'select * from tables where couple_id = $1 order by position asc, table_number asc',
        [coupleId],
      ),
      pool.query(
        'select * from households where couple_id = $1 order by position asc',
        [coupleId],
      ),
      pool.query(
        `select g.*, h.status as household_status
           from guests g
           join households h on h.id = g.household_id
          where h.couple_id = $1
          order by g.position asc`,
        [coupleId],
      ),
    ]);

    const tables = tablesRes.rows;
    const households = householdsRes.rows;
    const guests = guestsRes.rows;

    // Group guests by household so the household card can list them.
    const guestsByHousehold = new Map();
    for (const g of guests) {
      const list = guestsByHousehold.get(g.household_id) || [];
      list.push(g);
      guestsByHousehold.set(g.household_id, list);
    }

    // Group seated guests by table for the seating chart.
    const guestsByTable = new Map();
    for (const g of guests) {
      if (!g.table_id) continue;
      const list = guestsByTable.get(g.table_id) || [];
      list.push(g);
      guestsByTable.set(g.table_id, list);
    }

    // Households grouped by status, in the order Awaiting → Accepted →
    // Declined to match the static mockup.
    const STATUS_ORDER = ['awaiting', 'accepted', 'declined'];
    const householdsByStatus = Object.fromEntries(
      STATUS_ORDER.map(s => [s, []]),
    );
    for (const h of households) {
      if (householdsByStatus[h.status]) {
        householdsByStatus[h.status].push(h);
      }
    }

    // Summary stats
    const acceptedHouseholds = householdsByStatus.accepted.length;
    const acceptedGuests = guests.filter(g => g.household_status === 'accepted').length;
    const awaitingGuests = guests.filter(g => g.household_status === 'awaiting').length;
    const declinedGuests = guests.filter(g => g.household_status === 'declined').length;
    const seatedGuests = guests.filter(g => g.table_id).length;
    const unseatedAccepted = guests
      .filter(g => g.household_status === 'accepted' && !g.table_id);

    const summary = {
      invited: guests.length,
      households: households.length,
      acceptedHouseholds,
      accepted: acceptedGuests,
      awaiting: awaitingGuests,
      declined: declinedGuests,
      declinedHouseholds: householdsByStatus.declined.length,
      awaitingHouseholds: householdsByStatus.awaiting.length,
      seated: seatedGuests,
      unseated: unseatedAccepted.length,
    };

    res.render('guest-list', {
      currentPage: 'guest-list',
      tables,
      households,
      householdsByStatus,
      guestsByHousehold,
      guestsByTable,
      unseatedAccepted,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
