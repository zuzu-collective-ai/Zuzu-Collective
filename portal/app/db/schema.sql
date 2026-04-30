-- Zuzu Collective portal — Postgres schema
--
-- Phase 1: just `couples`, the row that backs the landing page. Every
-- subsequent table (vendors, guests, budget, checklist, timeline) keys
-- back to couples.id so one database serves every wedding.
--
-- This file is idempotent — `IF NOT EXISTS` everywhere — so the app
-- runs it on every boot without breaking existing data.

create extension if not exists "pgcrypto";

create table if not exists couples (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,             -- url segment, e.g. alicia-and-jack-2026
  display_name    text not null,                    -- "Alicia & Jack"
  wedding_date    date not null,                    -- 2026-10-10

  -- Venue
  venue_name      text,                             -- "La Playa"
  venue_location  text,                             -- "Carmel-by-the-Sea"

  -- Couple palette — 4 colors with optional friendly names. Defaults to
  -- the Alicia & Jack ivory/chartreuse so a new row renders sensibly.
  palette_color_1       text not null default '#EFEDE1',
  palette_color_1_name  text default 'Ivory',
  palette_color_2       text not null default '#64690C',
  palette_color_2_name  text default 'Chartreuse',
  palette_color_3       text not null default '#FFFFFF',
  palette_color_3_name  text default 'Crisp White',
  palette_color_4       text not null default '#F5F0E4',
  palette_color_4_name  text default 'Cream',

  -- Tone & feeling — used on the design page, previewed on landing
  tone_keywords   text default 'Elegant · Coastal · Candlelit · Californian · Timeless · Intentional',
  tone_statement  text default 'All warmth reliant on candlelight.',

  -- Landing-page copy
  hero_subtitle   text default 'Wedding Portal',
  intro_text      text,
  intro_tagline   text default 'escape the mundane.',

  -- Budget total — top-of-page number on /budget, in *cents* so all
  -- arithmetic is integer. Zoe enters dollars on the admin form; the
  -- pick function converts before storing.
  budget_total_cents integer not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Older Postgres rows that existed before this column was added need the
-- default to be backfilled — `add column if not exists` skips the column
-- entirely on re-run, so we make sure the column is here for fresh
-- installs and add it to existing tables on Render.
alter table couples add column if not exists budget_total_cents integer not null default 0;

create index if not exists couples_slug_idx on couples(slug);

-- ── Vendors ──────────────────────────────────────────────────────────────
--
-- One row per vendor *slot* per couple. The 17 vendor types from Zoe's
-- spreadsheet (Venue, Caterer, Photographer, Videographer, Florist, DJ,
-- Band, Wedding Planner, Officiant, Hair Stylist, Makeup Artist,
-- Transportation, Baker/Cake, Hotel Room Block, Rehearsal Dinner Venue,
-- Honeymoon Hotel, Honeymoon Airline) all live in the same table; the
-- type is just a string so Zoe can rename or add new types without
-- touching the schema.
--
-- A vendor with display_name = null and status = 'pending' is a TBC slot
-- with the `note` field describing what's being looked for.

create table if not exists vendors (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null references couples(id) on delete cascade,

  vendor_type   text not null,                -- "Venue" / "Photographer" / ...
  display_name  text,                          -- "La Playa Hotel"; null when TBC
  contact_name  text,
  phone         text,
  email         text,
  address       text,

  status        text not null default 'pending',  -- booked | shortlist | pending | n/a
  note          text,                              -- TBC blurb, or follow-up reminder

  position      integer not null default 0,        -- ordering within the list
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists vendors_couple_id_idx on vendors(couple_id);
create index if not exists vendors_couple_position_idx on vendors(couple_id, position);

-- ── Reception tables ─────────────────────────────────────────────────────
--
-- Round (or oval) tables in the reception room. The head table is just
-- a row with role='head'. Capacity is the seat count; how many of those
-- seats are filled is computed by joining against guests.

create table if not exists tables (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null references couples(id) on delete cascade,

  table_number  integer not null,            -- 1, 2, 3...; surfaces as "01", "02"
  table_name    text,                         -- "Cypress" / "Bay" / "Olive" / ...
  capacity      integer not null default 8,
  role          text not null default 'standard', -- standard | head | kids
  note          text,                          -- "Parents and the couple. Closest to the dance floor."

  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists tables_couple_id_idx on tables(couple_id);
create unique index if not exists tables_couple_number_uq on tables(couple_id, table_number);

-- ── Households ───────────────────────────────────────────────────────────
--
-- One row per invitation. status is the household-level RSVP — for v1
-- everyone in the same household shares the same status. (Real-world
-- weddings sometimes track per-guest RSVP; we'll add that if Zoe asks.)

create table if not exists households (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null references couples(id) on delete cascade,

  display_name  text not null,                -- "The Bennetts" or "Eleanor Bennett"
  side          text,                          -- "Bride's parents" / "Groom's side · college"
  status        text not null default 'awaiting',  -- accepted | awaiting | declined
  note          text,                          -- italic blurb on the household card

  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists households_couple_id_idx on households(couple_id);
create index if not exists households_couple_status_idx on households(couple_id, status);

-- ── Guests ───────────────────────────────────────────────────────────────
--
-- One row per individual person. Belongs to a household (their
-- invitation unit) and optionally to a table (their seat). guest_type
-- distinguishes adults / children / plus-ones for display.
--
-- Plus-ones whose name isn't known yet show as "Plus one — name TBC"
-- in the public list. Decline a plus-one by deleting their row or
-- leaving guest_type='plus_one' with display_name='Plus one declined'.

create table if not exists guests (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  table_id      uuid references tables(id) on delete set null,  -- nullable: unseated guests

  display_name  text not null,
  guest_type    text not null default 'adult',   -- adult | child | plus_one

  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists guests_household_id_idx on guests(household_id);
create index if not exists guests_table_id_idx on guests(table_id);

-- ── Budget categories ────────────────────────────────────────────────────
--
-- Editorial categories on /budget — one row per "Category 01 · Venue",
-- "Category 02 · Catering" etc. The numbered eyebrow on the public page
-- comes from `category_number`, which is unique per couple so Zoe can
-- reorder by changing positions without renumbering.
--
-- `title_emphasis` is the optional italic suffix used in the typography
-- (e.g. "Catering" + "(food & bar)"; "Florals & " + "Decor"). Keeping
-- it as a separate column is simpler than parsing markup, and preserves
-- the magazine-style title rendering across both static and dynamic.
--
-- `estimated_cents` is the couple's target for the whole category. The
-- "Actual" number on the page is computed live as SUM(line.paid_cents).

create table if not exists budget_categories (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references couples(id) on delete cascade,

  category_number integer not null,            -- 1, 2, 3...; surfaces as "01"
  title           text not null,               -- "Catering"
  title_emphasis  text,                         -- "(food & bar)" — italic on render

  estimated_cents integer not null default 0,

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists budget_categories_couple_id_idx on budget_categories(couple_id);
create unique index if not exists budget_categories_couple_number_uq on budget_categories(couple_id, category_number);

-- ── Budget line items ────────────────────────────────────────────────────
--
-- One row per line under a category. `amount_cents` is the line total
-- (e.g. $5,500 for "Wedding-day coverage"); `paid_cents` is how much of
-- that has been paid so far. Status is split in two:
--   • `status_kind` drives the colored pill on the public page
--     (paid / deposited / upcoming).
--   • `status_label` is the free-text caption inside that pill
--     ("Paid in full", "$10,000 deposit", "Quote requested", etc.)
-- so Zoe can write whatever's most accurate without us inventing labels.

create table if not exists budget_line_items (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references budget_categories(id) on delete cascade,

  name          text not null,                  -- "Plated dinner"
  vendor_label  text,                            -- "100 guests · La Playa catering"
  amount_cents  integer not null default 0,
  paid_cents    integer not null default 0,

  status_kind   text not null default 'upcoming',  -- paid | deposited | upcoming
  status_label  text,                              -- "$10,000 deposit"

  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists budget_line_items_category_id_idx on budget_line_items(category_id);

-- ── Checklist milestones ─────────────────────────────────────────────────
--
-- Editorial milestones on /checklist — "12 Months Out · The foundation",
-- "6–8 Months Out · Filling in the canvas", etc. Whether a milestone is
-- "Complete" / "You are here" / "Upcoming" is derived from its tasks at
-- render time (first not-fully-complete milestone is the active one),
-- so milestone rows only carry display copy.

create table if not exists checklist_milestones (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references couples(id) on delete cascade,

  date_label      text not null,        -- "October 2025 · 12 Months Out"
  title           text not null,         -- "The foundation"

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists checklist_milestones_couple_id_idx on checklist_milestones(couple_id);

-- ── Checklist tasks ──────────────────────────────────────────────────────
--
-- One row per checkbox under a milestone. `sub_text` is the small italic
-- caption underneath the task name on the public page (e.g. the booked
-- vendor's name, a follow-up reminder).

create table if not exists checklist_tasks (
  id              uuid primary key default gen_random_uuid(),
  milestone_id    uuid not null references checklist_milestones(id) on delete cascade,

  name            text not null,        -- "Book the venue"
  sub_text        text,                  -- "La Playa Hotel · Carmel-by-the-Sea"
  is_done         boolean not null default false,

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists checklist_tasks_milestone_id_idx on checklist_tasks(milestone_id);
