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

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

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
