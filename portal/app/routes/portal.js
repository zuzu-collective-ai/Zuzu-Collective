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

router.get('/p/:slug/checklist', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    const [msRes, tasksRes] = await Promise.all([
      pool.query(
        'select * from checklist_milestones where couple_id = $1 order by position asc',
        [coupleId],
      ),
      pool.query(
        `select t.*
           from checklist_tasks t
           join checklist_milestones m on m.id = t.milestone_id
          where m.couple_id = $1
          order by t.position asc`,
        [coupleId],
      ),
    ]);

    const milestones = msRes.rows;
    const tasks = tasksRes.rows;

    const tasksByMilestone = new Map();
    for (const t of tasks) {
      const list = tasksByMilestone.get(t.milestone_id) || [];
      list.push(t);
      tasksByMilestone.set(t.milestone_id, list);
    }

    // Per-milestone progress + state. The first milestone that isn't
    // fully complete is the "active" one (gets the "You are here" badge);
    // every milestone before it that is complete is "done"; everything
    // after the active one is "upcoming".
    let foundActive = false;
    const milestoneState = new Map();
    for (const m of milestones) {
      const ts = tasksByMilestone.get(m.id) || [];
      const total = ts.length;
      const done = ts.filter(t => t.is_done).length;
      const inFlight = total - done;
      const allDone = total > 0 && done === total;

      let state;
      if (allDone) {
        state = 'done';
      } else if (!foundActive) {
        state = 'active';
        foundActive = true;
      } else {
        state = 'upcoming';
      }

      milestoneState.set(m.id, { total, done, inFlight, state });
    }

    // Page-level summary
    const tasksTotal = tasks.length;
    const tasksDone = tasks.filter(t => t.is_done).length;
    const pctDone = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;

    // Days to wedding — couple.wedding_date is stored as a date (no time),
    // so compare at UTC midnight to keep the count stable across the day.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const wd = new Date(res.locals.couple.wedding_date);
    wd.setUTCHours(0, 0, 0, 0);
    const daysToWedding = Math.max(0, Math.round((wd - today) / 86400000));

    res.render('checklist', {
      currentPage: 'checklist',
      milestones,
      tasksByMilestone,
      milestoneState,
      summary: {
        milestoneCount: milestones.length,
        tasksTotal,
        tasksDone,
        pctDone,
        daysToWedding,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/p/:slug/budget', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    // One round-trip per relation; categories first so empty categories
    // still render with their estimated number and progress bar.
    const [catsRes, linesRes] = await Promise.all([
      pool.query(
        'select * from budget_categories where couple_id = $1 order by position asc, category_number asc',
        [coupleId],
      ),
      pool.query(
        `select l.*
           from budget_line_items l
           join budget_categories c on c.id = l.category_id
          where c.couple_id = $1
          order by l.position asc`,
        [coupleId],
      ),
    ]);

    const categories = catsRes.rows;
    const lines = linesRes.rows;

    // Group lines by category for inline rendering.
    const linesByCategory = new Map();
    for (const l of lines) {
      const list = linesByCategory.get(l.category_id) || [];
      list.push(l);
      linesByCategory.set(l.category_id, list);
    }

    // Derive each category's actual + remaining from its line items so
    // the page is always honest about what's been paid. Categories with
    // no lines fall back to actual=0.
    const categoryStats = new Map();
    for (const c of categories) {
      const catLines = linesByCategory.get(c.id) || [];
      const actual = catLines.reduce((s, l) => s + (l.paid_cents || 0), 0);
      const estimated = c.estimated_cents || 0;
      const remaining = Math.max(0, estimated - actual);
      const pct = estimated > 0
        ? Math.min(100, Math.round((actual / estimated) * 1000) / 10)
        : 0;
      categoryStats.set(c.id, { estimated, actual, remaining, pct });
    }

    // Page-level summary stats.
    const totalBudget = res.locals.couple.budget_total_cents || 0;
    const totalSpent = Array.from(categoryStats.values())
      .reduce((s, x) => s + x.actual, 0);
    const totalRemaining = Math.max(0, totalBudget - totalSpent);
    const pctOfTotal = totalBudget > 0
      ? Math.round((totalSpent / totalBudget) * 100)
      : 0;
    const openCategories = Array.from(categoryStats.values())
      .filter(x => x.estimated > 0 && x.actual < x.estimated).length;

    res.render('budget', {
      currentPage: 'budget',
      categories,
      linesByCategory,
      categoryStats,
      summary: {
        totalBudget,
        totalSpent,
        totalRemaining,
        pctOfTotal,
        openCategories,
        categoryCount: categories.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/p/:slug/timeline', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    const [phasesRes, eventsRes] = await Promise.all([
      pool.query(
        'select * from timeline_phases where couple_id = $1 order by position asc, phase_number asc',
        [coupleId],
      ),
      pool.query(
        `select e.*
           from timeline_events e
           join timeline_phases p on p.id = e.phase_id
          where p.couple_id = $1
          order by e.position asc`,
        [coupleId],
      ),
    ]);

    const phases = phasesRes.rows;
    const events = eventsRes.rows;

    const eventsByPhase = new Map();
    for (const e of events) {
      const list = eventsByPhase.get(e.phase_id) || [];
      list.push(e);
      eventsByPhase.set(e.phase_id, list);
    }

    res.render('timeline', {
      currentPage: 'timeline',
      phases,
      eventsByPhase,
      summary: {
        eventCount: events.length,
        phaseCount: phases.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/p/:slug/floor-plan', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    const [spacesRes, zonesRes, keysRes] = await Promise.all([
      pool.query(
        'select * from floorplan_spaces where couple_id = $1 order by position asc',
        [coupleId],
      ),
      pool.query(
        `select z.*
           from floorplan_zones z
           join floorplan_spaces s on s.id = z.space_id
          where s.couple_id = $1
          order by z.position asc`,
        [coupleId],
      ),
      pool.query(
        `select k.*
           from floorplan_key_items k
           join floorplan_spaces s on s.id = k.space_id
          where s.couple_id = $1
          order by k.position asc`,
        [coupleId],
      ),
    ]);

    const spaces = spacesRes.rows;
    const zones = zonesRes.rows;
    const keys = keysRes.rows;

    const zonesBySpace = new Map();
    for (const z of zones) {
      const list = zonesBySpace.get(z.space_id) || [];
      list.push(z);
      zonesBySpace.set(z.space_id, list);
    }
    const keysBySpace = new Map();
    for (const k of keys) {
      const list = keysBySpace.get(k.space_id) || [];
      list.push(k);
      keysBySpace.set(k.space_id, list);
    }

    const totalFootprint = spaces.reduce((s, sp) => s + (sp.square_feet || 0), 0);

    res.render('floor-plan', {
      currentPage: 'floor-plan',
      spaces,
      zonesBySpace,
      keysBySpace,
      summary: {
        spaceCount: spaces.length,
        totalFootprint,
      },
    });
  } catch (err) {
    next(err);
  }
});

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
