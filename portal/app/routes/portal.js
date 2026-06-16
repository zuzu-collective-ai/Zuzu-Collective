// Couple-facing portal routes — /p/:slug/*
//
// All eight pages read live from Postgres; the admin writes, the portal
// reflects immediately. Analytics are stored in portal_events (hashed IP).

import express from 'express';
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { pool } from '../db/pool.js';

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────

// Fire-and-forget POST to SendGrid when a couple's portal is viewed for
// the first time. Silently no-ops if SENDGRID_API_KEY / NOTIFY_EMAIL
// are not set — nothing breaks, Zoe just won't get the email.
function sendFirstViewNotification(couple, section) {
  const apiKey     = process.env.SENDGRID_API_KEY;
  const notifyTo   = process.env.NOTIFY_EMAIL;
  if (!apiKey || !notifyTo) return;

  const appUrl    = process.env.APP_URL || '';
  const adminLink = appUrl ? `${appUrl}/admin/couples/${couple.id}` : '';
  const bodyLines = [
    `${couple.display_name} opened their portal for the first time.`,
    `Page: ${section}`,
    adminLink,
  ].filter(Boolean).join('\n\n');

  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: notifyTo }] }],
    from: { email: notifyTo, name: 'Zuzu Collective' },
    subject: `${couple.display_name} just opened their portal`,
    content: [{ type: 'text/plain', value: bodyLines }],
  });

  const req = httpsRequest({
    hostname: 'api.sendgrid.com',
    path: '/v3/mail/send',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  });
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

async function getTeamMembers() {
  const { rows } = await pool.query(
    'select * from team_members order by sort_order asc',
  );
  return rows;
}

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
      return res.status(404).render('404');
    }
    res.locals.couple = couple;
    res.locals.formattedDate = formatWeddingDate(couple.wedding_date);
    next();
  } catch (err) {
    next(err);
  }
}

// Fire-and-forget analytics for every client page view.
// Uses sha256(ip + salt) so no raw IPs are stored.
function logPageView(req, res, next) {
  if (req.method !== 'GET') return next();
  try {
    const couple = res.locals.couple;
    const suffix = req.path.slice(`/p/${req.params.slug}`.length);
    const section = suffix.split('/').filter(Boolean)[0] || 'landing';
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const salt = process.env.ANALYTICS_SALT || 'zuzu-portal';
    const ipHash = createHash('sha256').update(ip + salt).digest('hex').slice(0, 16);
    pool.query(
      'insert into portal_events (couple_id, section, ip_hash) values ($1, $2, $3)',
      [couple.id, section, ipHash],
    ).then(async () => {
      try {
        const { rows } = await pool.query(
          'select count(*)::int as n from portal_events where couple_id = $1',
          [couple.id],
        );
        if (rows[0]?.n === 1) sendFirstViewNotification(couple, section);
      } catch {}
    }).catch(() => {});
  } catch {}
  next();
}

router.use('/p/:slug', loadCouple, logPageView);

// ── Pages ──────────────────────────────────────────────────────────────

router.get('/p/:slug', async (_req, res, next) => {
  try {
    const teamMembers = await getTeamMembers();
    res.render('landing', { currentPage: 'home', teamMembers });
  } catch (err) { next(err); }
});

router.get('/p/:slug/design', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    const [galleriesRes, tilesRes, materialsRes] = await Promise.all([
      pool.query(
        'select * from inspiration_galleries where couple_id = $1 and enabled order by position asc',
        [coupleId],
      ),
      pool.query(
        `select t.*
           from inspiration_tiles t
           join inspiration_galleries g on g.id = t.gallery_id
          where g.couple_id = $1 and g.enabled
          order by t.position asc`,
        [coupleId],
      ),
      pool.query(
        'select * from design_materials where couple_id = $1 order by position asc',
        [coupleId],
      ),
    ]);

    const galleries = galleriesRes.rows;
    const tiles = tilesRes.rows;
    const materials = materialsRes.rows;

    const tilesByGallery = new Map();
    for (const t of tiles) {
      const list = tilesByGallery.get(t.gallery_id) || [];
      list.push(t);
      tilesByGallery.set(t.gallery_id, list);
    }

    res.render('design', {
      currentPage: 'design',
      galleries,
      tilesByGallery,
      materials,
    });
  } catch (err) {
    next(err);
  }
});

function buildVendorGroups(vendors) {
  const counts = vendors.reduce(
    (acc, v) => { acc.total += 1; acc[v.status] = (acc[v.status] || 0) + 1; return acc; },
    { total: 0 },
  );
  const sections = [
    { status: 'booked',    label: 'Booked',         note: 'Contracts signed.' },
    { status: 'shortlist', label: 'Shortlisting',   note: 'In conversation.' },
    { status: 'pending',   label: 'To be confirmed', note: 'Slots still to fill.' },
  ].map(s => ({ ...s, vendors: vendors.filter(v => v.status === s.status) }))
   .filter(s => s.vendors.length > 0);
  return { counts, sections };
}

router.get('/p/:slug/vendors', async (req, res, next) => {
  try {
    const { rows: vendors } = await pool.query(
      'select * from vendors where couple_id = $1 and status != $2 order by position asc, vendor_type asc',
      [res.locals.couple.id, 'na'],
    );
    const { counts, sections } = buildVendorGroups(vendors);
    res.render('vendors', { currentPage: 'vendors', vendors, sections, counts });
  } catch (err) { next(err); }
});

router.get('/p/:slug/vendors/:vid/contract', async (req, res, next) => {
  try {
    const couple = await findCoupleBySlug(req.params.slug);
    if (!couple) return res.status(404).send('Not found.');
    const { rows: [vendor] } = await pool.query(
      'select contract_url from vendors where id=$1 and couple_id=$2 and status=$3',
      [req.params.vid, couple.id, 'booked'],
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

    // Days to wedding — used both for the summary stat and for date-based
    // milestone placement. Compare at UTC midnight to keep counts stable.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const wd = new Date(res.locals.couple.wedding_date);
    wd.setUTCHours(0, 0, 0, 0);
    const daysToWedding = Math.max(0, Math.round((wd - today) / 86400000));

    // Parse milestone target date from date_label ("12 Months Out", "Day Of").
    function parseMilestoneDate(dateLabel) {
      const m = dateLabel.match(/(\d+)\s+months?\s+out/i);
      if (m) {
        const d = new Date(wd);
        d.setUTCMonth(d.getUTCMonth() - parseInt(m[1], 10));
        d.setUTCDate(1);
        return d;
      }
      if (/day.?of/i.test(dateLabel)) return new Date(wd);
      return null;
    }

    // Determine the "active" milestone index based on today's date:
    // find the last milestone whose target date has passed, then advance
    // past any that are already fully done.
    let activeIdx = 0;
    for (let i = 0; i < milestones.length; i++) {
      const td = parseMilestoneDate(milestones[i].date_label);
      if (td && td <= today) activeIdx = i;
    }
    while (activeIdx < milestones.length - 1) {
      const ts = tasksByMilestone.get(milestones[activeIdx].id) || [];
      if (ts.length > 0 && ts.every(t => t.is_done)) activeIdx++;
      else break;
    }

    const milestoneState = new Map();
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      const ts = tasksByMilestone.get(m.id) || [];
      const total = ts.length;
      const done = ts.filter(t => t.is_done).length;
      const inFlight = total - done;
      const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'upcoming';
      milestoneState.set(m.id, { total, done, inFlight, state });
    }

    // Page-level summary
    const tasksTotal = tasks.length;
    const tasksDone = tasks.filter(t => t.is_done).length;
    const pctDone = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;

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

// Task toggle — clients check/uncheck directly from the portal.
// Validates ownership via the milestone → couple join so arbitrary
// task IDs from other couples can't be toggled.
router.post('/p/:slug/checklist/tasks/:tid/toggle', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;
    const { rows } = await pool.query(
      `update checklist_tasks t
          set is_done = not t.is_done, updated_at = now()
         from checklist_milestones m
        where t.id = $1
          and t.milestone_id = m.id
          and m.couple_id = $2
        returning t.is_done`,
      [req.params.tid, coupleId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ is_done: rows[0].is_done });
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

    // Derive each category's stats from its line items.
    // - contracted: total amount_cents (what you've committed to vendors)
    // - actual:     total paid_cents (what you've actually paid so far)
    // - remaining:  contracted − actual (what you still owe vendors)
    // Categories with no lines fall back to 0.
    const categoryStats = new Map();
    for (const c of categories) {
      const catLines = linesByCategory.get(c.id) || [];
      const contracted = catLines.reduce((s, l) => s + (l.amount_cents || 0), 0);
      const actual = catLines.reduce((s, l) => s + (l.paid_cents || 0), 0);
      const estimated = c.estimated_cents || 0;
      const remaining = Math.max(0, contracted - actual);
      const pct = contracted > 0
        ? Math.min(100, Math.round((actual / contracted) * 1000) / 10)
        : 0;
      categoryStats.set(c.id, { estimated, contracted, actual, remaining, pct });
    }

    // Page-level summary stats.
    const totalBudget = res.locals.couple.budget_total_cents || 0;
    const totalContracted = Array.from(categoryStats.values())
      .reduce((s, x) => s + x.contracted, 0);
    const totalSpent = Array.from(categoryStats.values())
      .reduce((s, x) => s + x.actual, 0);
    const totalOwed = Math.max(0, totalContracted - totalSpent);
    const pctOfTotal = totalBudget > 0
      ? Math.round((totalContracted / totalBudget) * 100)
      : 0;
    const openCategories = Array.from(categoryStats.values())
      .filter(x => x.contracted > 0 && x.actual < x.contracted).length;

    // Payment schedule — all line items with a due_date, sorted ascending.
    // Includes paid ones so clients see their full payment history.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const scheduledPayments = lines
      .filter(l => l.due_date)
      .map(l => {
        const cat = categories.find(c => c.id === l.category_id);
        const due = new Date(l.due_date);
        due.setUTCHours(0, 0, 0, 0);
        const daysUntil = Math.round((due - today) / 86400000);
        const isPaid    = l.status_kind === 'paid' || (l.paid_cents || 0) >= (l.amount_cents || 0);
        const statusBadge = isPaid ? 'paid'
          : daysUntil < 0   ? 'overdue'
          : daysUntil <= 14 ? 'soon'
          : 'upcoming';
        return { ...l, categoryTitle: cat?.title || '', daysUntil, isPaid, statusBadge };
      })
      .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

    res.render('budget', {
      currentPage: 'budget',
      categories,
      linesByCategory,
      categoryStats,
      scheduledPayments,
      summary: {
        totalBudget,
        totalContracted,
        totalSpent,
        totalOwed,
        pctOfTotal,
        openCategories,
        categoryCount: categories.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/p/:slug/payments', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;

    const [catsRes, linesRes] = await Promise.all([
      pool.query(
        'select * from budget_categories where couple_id = $1 order by position asc',
        [coupleId],
      ),
      pool.query(
        `select l.*
           from budget_line_items l
           join budget_categories c on c.id = l.category_id
          where c.couple_id = $1
          order by l.due_date asc nulls last, l.position asc`,
        [coupleId],
      ),
    ]);

    const categories = catsRes.rows;
    const lines      = linesRes.rows;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Attach category title and derived status to every line that has a due date.
    const payments = lines
      .filter(l => l.due_date)
      .map(l => {
        const cat      = categories.find(c => c.id === l.category_id);
        const due      = new Date(l.due_date);
        due.setUTCHours(0, 0, 0, 0);
        const daysUntil  = Math.round((due - today) / 86400000);
        const isPaid     = l.status_kind === 'paid' || (l.paid_cents || 0) >= (l.amount_cents || 0);
        const statusBadge = isPaid ? 'paid'
          : daysUntil < 0    ? 'overdue'
          : daysUntil <= 14  ? 'soon'
          : 'upcoming';
        return { ...l, categoryTitle: cat?.title || '', daysUntil, isPaid, statusBadge };
      });

    // Group payments by month label for the timeline.
    const monthGroups = [];
    for (const p of payments) {
      const due   = new Date(p.due_date);
      const label = due.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      let group   = monthGroups.find(g => g.label === label);
      if (!group) { group = { label, payments: [] }; monthGroups.push(group); }
      group.payments.push(p);
    }

    const totalContracted = lines.reduce((s, l) => s + (l.amount_cents || 0), 0);
    const totalPaid       = lines.reduce((s, l) => s + (l.paid_cents  || 0), 0);
    const totalDue        = Math.max(0, totalContracted - totalPaid);
    const pctPaid         = totalContracted > 0
      ? Math.min(100, Math.round((totalPaid / totalContracted) * 100))
      : 0;

    res.render('payments', {
      currentPage: 'payments',
      monthGroups,
      payments,
      summary: { totalContracted, totalPaid, totalDue, pctPaid, count: payments.length },
    });
  } catch (err) { next(err); }
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

// ── Proposal preview portal (/preview/:slug) ────────────────────────────
// The real portal landing page sent to prospects before they book.
// All nav tabs are visible but locked — they see exactly what they'll get.

router.use('/preview/:slug', loadCouple, logPageView, (req, res, next) => {
  res.locals.portalBase  = `/preview/${req.params.slug}`;
  res.locals.previewMode = true;
  next();
});

router.get('/preview/:slug', async (_req, res, next) => {
  try {
    const teamMembers = await getTeamMembers();
    res.render('landing', { currentPage: 'home', teamMembers });
  } catch (err) { next(err); }
});

// Any attempt to navigate to a locked tab redirects back to the landing.
router.get('/preview/:slug/*', (req, res) =>
  res.redirect(`/preview/${req.params.slug}`),
);

// ── Vendor-facing portal (/v/:slug/*) ───────────────────────────────────
// Same content as the full portal but without budget and guest-list.
// Share links to design, vendors, checklist, timeline, floor-plan.

const VENDOR_PORTAL_PAGES = ['home', 'design', 'vendors', 'checklist', 'timeline', 'floor-plan'];

router.use('/v/:slug', loadCouple, logPageView, (req, res, next) => {
  res.locals.portalBase = `/v/${req.params.slug}`;
  res.locals.allowedPortalPages = VENDOR_PORTAL_PAGES;
  next();
});

router.get('/v/:slug', async (_req, res, next) => {
  try {
    const teamMembers = await getTeamMembers();
    res.render('landing', { currentPage: 'home', teamMembers });
  } catch (err) { next(err); }
});

router.get('/v/:slug/design', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;
    const [galleriesRes, tilesRes, materialsRes] = await Promise.all([
      pool.query('select * from inspiration_galleries where couple_id = $1 order by position asc', [coupleId]),
      pool.query(`select t.* from inspiration_tiles t join inspiration_galleries g on g.id = t.gallery_id where g.couple_id = $1 order by t.position asc`, [coupleId]),
      pool.query('select * from design_materials where couple_id = $1 order by position asc', [coupleId]),
    ]);
    const tilesByGallery = new Map();
    for (const t of tilesRes.rows) {
      const list = tilesByGallery.get(t.gallery_id) || [];
      list.push(t);
      tilesByGallery.set(t.gallery_id, list);
    }
    res.render('design', { currentPage: 'design', galleries: galleriesRes.rows, tilesByGallery, materials: materialsRes.rows });
  } catch (err) { next(err); }
});

router.get('/v/:slug/vendors', async (req, res, next) => {
  try {
    const { rows: vendors } = await pool.query(
      'select * from vendors where couple_id = $1 and status != $2 order by position asc, vendor_type asc',
      [res.locals.couple.id, 'na'],
    );
    const { counts, sections } = buildVendorGroups(vendors);
    res.render('vendors', { currentPage: 'vendors', vendors, sections, counts });
  } catch (err) { next(err); }
});

router.get('/v/:slug/checklist', async (req, res, next) => {
  // Re-use the same route handler logic as /p/:slug/checklist by redirecting
  // internally — just render with the vendor portal locals already set.
  try {
    const coupleId = res.locals.couple.id;
    const [msRes, tasksRes] = await Promise.all([
      pool.query('select * from checklist_milestones where couple_id = $1 order by position asc', [coupleId]),
      pool.query(`select t.* from checklist_tasks t join checklist_milestones m on m.id = t.milestone_id where m.couple_id = $1 order by t.position asc`, [coupleId]),
    ]);
    const milestones = msRes.rows;
    const tasks = tasksRes.rows;
    const tasksByMilestone = new Map();
    for (const t of tasks) {
      const list = tasksByMilestone.get(t.milestone_id) || [];
      list.push(t);
      tasksByMilestone.set(t.milestone_id, list);
    }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const wd = new Date(res.locals.couple.wedding_date); wd.setUTCHours(0, 0, 0, 0);
    const daysToWedding = Math.max(0, Math.round((wd - today) / 86400000));
    function parseMsDate(dl) {
      const m = dl.match(/(\d+)\s+months?\s+out/i);
      if (m) { const d = new Date(wd); d.setUTCMonth(d.getUTCMonth() - parseInt(m[1], 10)); d.setUTCDate(1); return d; }
      if (/day.?of/i.test(dl)) return new Date(wd);
      return null;
    }
    let activeIdx = 0;
    for (let i = 0; i < milestones.length; i++) { const td = parseMsDate(milestones[i].date_label); if (td && td <= today) activeIdx = i; }
    while (activeIdx < milestones.length - 1) { const ts = tasksByMilestone.get(milestones[activeIdx].id) || []; if (ts.length > 0 && ts.every(t => t.is_done)) activeIdx++; else break; }
    const milestoneState = new Map();
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i]; const ts = tasksByMilestone.get(m.id) || [];
      const total = ts.length; const done = ts.filter(t => t.is_done).length;
      milestoneState.set(m.id, { total, done, inFlight: total - done, state: i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'upcoming' });
    }
    const tasksTotal = tasks.length; const tasksDone = tasks.filter(t => t.is_done).length;
    res.render('checklist', { currentPage: 'checklist', milestones, tasksByMilestone, milestoneState, summary: { milestoneCount: milestones.length, tasksTotal, tasksDone, pctDone: tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0, daysToWedding } });
  } catch (err) { next(err); }
});

router.get('/v/:slug/timeline', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;
    const [phasesRes, eventsRes] = await Promise.all([
      pool.query('select * from timeline_phases where couple_id = $1 order by position asc, phase_number asc', [coupleId]),
      pool.query(`select e.* from timeline_events e join timeline_phases p on p.id = e.phase_id where p.couple_id = $1 order by e.position asc`, [coupleId]),
    ]);
    const phases = phasesRes.rows; const events = eventsRes.rows;
    const eventsByPhase = new Map();
    for (const e of events) { const list = eventsByPhase.get(e.phase_id) || []; list.push(e); eventsByPhase.set(e.phase_id, list); }
    res.render('timeline', { currentPage: 'timeline', phases, eventsByPhase, summary: { eventCount: events.length, phaseCount: phases.length } });
  } catch (err) { next(err); }
});

router.get('/v/:slug/floor-plan', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;
    const [spacesRes, zonesRes, keysRes] = await Promise.all([
      pool.query('select * from floorplan_spaces where couple_id = $1 order by position asc', [coupleId]),
      pool.query(`select z.* from floorplan_zones z join floorplan_spaces s on s.id = z.space_id where s.couple_id = $1 order by z.position asc`, [coupleId]),
      pool.query(`select k.* from floorplan_key_items k join floorplan_spaces s on s.id = k.space_id where s.couple_id = $1 order by k.position asc`, [coupleId]),
    ]);
    const spaces = spacesRes.rows;
    const zonesBySpace = new Map(); for (const z of zonesRes.rows) { const l = zonesBySpace.get(z.space_id) || []; l.push(z); zonesBySpace.set(z.space_id, l); }
    const keysBySpace = new Map(); for (const k of keysRes.rows) { const l = keysBySpace.get(k.space_id) || []; l.push(k); keysBySpace.set(k.space_id, l); }
    res.render('floor-plan', { currentPage: 'floor-plan', spaces, zonesBySpace, keysBySpace, summary: { spaceCount: spaces.length, totalFootprint: spaces.reduce((s, sp) => s + (sp.square_feet || 0), 0) } });
  } catch (err) { next(err); }
});

// ── Day-of portal (/t/:slug) ─────────────────────────────────────────────
// Shared link for vendors and day-of staff. Shows landing, timeline,
// and floor plan — no budget, guest list, checklist, or design.

const DAY_OF_PAGES = ['home', 'timeline', 'floor-plan'];

router.use('/t/:slug', loadCouple, logPageView, (req, res, next) => {
  res.locals.portalBase = `/t/${req.params.slug}`;
  res.locals.allowedPortalPages = DAY_OF_PAGES;
  next();
});

router.get('/t/:slug', async (_req, res, next) => {
  try {
    const teamMembers = await getTeamMembers();
    res.render('landing', { currentPage: 'home', teamMembers });
  } catch (err) { next(err); }
});

router.get('/t/:slug/timeline', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;
    const [phasesRes, eventsRes] = await Promise.all([
      pool.query('select * from timeline_phases where couple_id = $1 order by position asc, phase_number asc', [coupleId]),
      pool.query(`select e.* from timeline_events e join timeline_phases p on p.id = e.phase_id where p.couple_id = $1 order by e.position asc`, [coupleId]),
    ]);
    const phases = phasesRes.rows;
    const events = eventsRes.rows;
    const eventsByPhase = new Map();
    for (const e of events) { const list = eventsByPhase.get(e.phase_id) || []; list.push(e); eventsByPhase.set(e.phase_id, list); }
    res.render('timeline', { currentPage: 'timeline', phases, eventsByPhase, summary: { eventCount: events.length, phaseCount: phases.length } });
  } catch (err) { next(err); }
});

router.get('/t/:slug/floor-plan', async (req, res, next) => {
  try {
    const coupleId = res.locals.couple.id;
    const [spacesRes, zonesRes, keysRes] = await Promise.all([
      pool.query('select * from floorplan_spaces where couple_id = $1 order by position asc', [coupleId]),
      pool.query(`select z.* from floorplan_zones z join floorplan_spaces s on s.id = z.space_id where s.couple_id = $1 order by z.position asc`, [coupleId]),
      pool.query(`select k.* from floorplan_key_items k join floorplan_spaces s on s.id = k.space_id where s.couple_id = $1 order by k.position asc`, [coupleId]),
    ]);
    const spaces = spacesRes.rows;
    const zonesBySpace = new Map();
    for (const z of zonesRes.rows) { const list = zonesBySpace.get(z.space_id) || []; list.push(z); zonesBySpace.set(z.space_id, list); }
    const keysBySpace = new Map();
    for (const k of keysRes.rows) { const list = keysBySpace.get(k.space_id) || []; list.push(k); keysBySpace.set(k.space_id, list); }
    res.render('floor-plan', { currentPage: 'floor-plan', spaces, zonesBySpace, keysBySpace, summary: { spaceCount: spaces.length, totalFootprint: spaces.reduce((s, sp) => s + (sp.square_feet || 0), 0) } });
  } catch (err) { next(err); }
});

export default router;
