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

  -- Timeline editorial copy — the four stat-notes at the top of /timeline.
  -- Stored as plain text so Zoe can write whatever's most accurate
  -- ("4:00" / "Sunset 6:32 PM" / "10:30" / "Sparkler send-off"). Keeping
  -- these here rather than deriving from events lets the headline read
  -- as flavor copy independent of the run-of-show timing.
  timeline_ceremony_time   text,
  timeline_ceremony_note   text,
  timeline_lastcall_time   text,
  timeline_lastcall_note   text,

  -- Floor-plan editorial copy — the "Walkthrough" stat at the top of
  -- /floor-plan ("9.26" + "Final at 10 AM"). The Venue, Spaces, and
  -- Footprint stats are derived from the venue_* columns above and
  -- the floorplan_spaces rows.
  floorplan_walkthrough_date text,
  floorplan_walkthrough_note text,

  -- Design page editorial copy. Most of /design is data-backed
  -- (palette colors above, tone keywords/statement above, inspiration
  -- galleries + materials below). These four fields cover the bits of
  -- prose that aren't generic enough to hardcode in the template.
  design_subtitle         text,   -- the long page intro under the H1
  design_tone_title       text,   -- "Intimate and considered. Nothing overdone."
  design_materials_title  text,   -- "Polished silver. Matte white. Clear glass."
  design_materials_note   text,   -- "All warmth reliant on candlelight."

  -- Landing page hero photo — hosted URL (Cloudinary etc.). When set, the
  -- hero section shows the photo as a background; when absent, the
  -- couple-palette gradient renders instead.
  hero_photo_url          text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Older Postgres rows that existed before this column was added need the
-- default to be backfilled — `add column if not exists` skips the column
-- entirely on re-run, so we make sure the column is here for fresh
-- installs and add it to existing tables on Render.
alter table couples add column if not exists budget_total_cents integer not null default 0;
alter table couples add column if not exists timeline_ceremony_time text;
alter table couples add column if not exists timeline_ceremony_note text;
alter table couples add column if not exists timeline_lastcall_time text;
alter table couples add column if not exists timeline_lastcall_note text;
alter table couples add column if not exists floorplan_walkthrough_date text;
alter table couples add column if not exists floorplan_walkthrough_note text;
alter table couples add column if not exists design_subtitle text;
alter table couples add column if not exists design_tone_title text;
alter table couples add column if not exists design_materials_title text;
alter table couples add column if not exists design_materials_note text;
alter table couples add column if not exists hero_photo_url text;
alter table couples add column if not exists hero_text_color text default 'dark';
alter table couples add column if not exists couple_phone text;

alter table vendors add column if not exists contract_url text;
alter table vendors add column if not exists contract_status text not null default 'not_started';
alter table vendors add column if not exists website_url text;
alter table vendors add column if not exists instagram_url text;

alter table budget_line_items add column if not exists due_date date;
alter table budget_line_items add column if not exists payment_sms_sent_at timestamptz;

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

-- ── Timeline phases ──────────────────────────────────────────────────────
--
-- Six (or however many) phases of the wedding day. The static mockup
-- has Getting ready / First look / Ceremony / Cocktail hour / Reception
-- / Send-off, with the ceremony and send-off styled differently —
-- `variant` carries that style hint (standard | ceremony | sendoff)
-- so the page can highlight them without inferring from the title.

create table if not exists timeline_phases (
  id            uuid primary key default gen_random_uuid(),
  couple_id     uuid not null references couples(id) on delete cascade,

  phase_number  integer not null,            -- 1..N; surfaces as "Phase 01"
  title         text not null,               -- "Getting ready"
  window_text   text,                         -- "8:00 AM – 1:00 PM"
  note_text     text,                         -- the longer paragraph
  variant       text not null default 'standard', -- standard | ceremony | sendoff

  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists timeline_phases_couple_id_idx on timeline_phases(couple_id);
create unique index if not exists timeline_phases_couple_number_uq on timeline_phases(couple_id, phase_number);

-- ── Timeline events ──────────────────────────────────────────────────────
--
-- One row per event under a phase. `time_text` is the display string
-- ("8:00", "12:30") and `meridiem` is the small caps suffix ("AM"/"PM");
-- separate columns so the public page can render the meridiem in its
-- own typographic treatment without parsing strings. The three optional
-- meta lines (where / lead / with) match the labels used on the mockup.

create table if not exists timeline_events (
  id            uuid primary key default gen_random_uuid(),
  phase_id      uuid not null references timeline_phases(id) on delete cascade,

  time_text     text not null,                 -- "8:00", "12:30", "4:25"
  meridiem      text,                           -- "AM" / "PM"
  title         text not null,                  -- "Hair and makeup begins"

  where_label   text,                           -- "Bridal suite, La Playa"
  lead_label    text,                           -- "Belle Âme Beauty · 5 stations"
  with_label    text,                           -- "Mom and maid of honor"
  note_text     text,                           -- italic note paragraph

  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists timeline_events_phase_id_idx on timeline_events(phase_id);

-- ── Floor-plan venue spaces ──────────────────────────────────────────────
--
-- One row per CSS-rendered top-down schematic on /floor-plan. The static
-- mockup has three: Ocean Lawn (ceremony), Upper Lawn & Loggia
-- (cocktails), Garden Ballroom (reception). `edge_top_label` is the
-- optional flavor caption pinned to the top edge of the schematic
-- ("Pacific Ocean", "Bougainvillea wall"). `location_label` is the
-- one-line meta string ("Outdoor", "Indoor", "Outdoor & covered").

create table if not exists floorplan_spaces (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references couples(id) on delete cascade,

  eyebrow         text,                  -- "Phase 03 · 4:00 PM"
  title           text not null,         -- "The Ocean Lawn"
  capacity        integer,               -- 60
  square_feet     integer,               -- 2400
  location_label  text,                   -- "Outdoor" / "Indoor" / "Outdoor & covered"
  edge_top_label  text,                   -- "Pacific Ocean", "Bougainvillea wall"
  layout_image_url text,                  -- optional uploaded venue layout image

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table floorplan_spaces add column if not exists layout_image_url text;

create index if not exists floorplan_spaces_couple_id_idx on floorplan_spaces(couple_id);

-- ── Floor-plan zones (the positioned shapes inside the schematic) ────────
--
-- Each zone has a `kind` that drives the colored treatment on the page
-- (arch, stage, chairs, aisle, service, bar, hightop, dance, table,
-- head-table, door). Position + size are stored as raw CSS strings
-- ("12%", "8%", null when not used); the public page renders them into
-- the inline `style` attribute exactly as written. `is_circle` adds
-- aspect-ratio: 1 for high-tops and round dinner tables. `edge_anchor`
-- is the optional dashed-edge variant for door markers
-- ("bottom-edge" today; could grow to "top-edge"/"left-edge" later).

create table if not exists floorplan_zones (
  id              uuid primary key default gen_random_uuid(),
  space_id        uuid not null references floorplan_spaces(id) on delete cascade,

  kind            text not null,           -- arch | stage | chairs | aisle | service |
                                            -- bar | hightop | dance | table | head-table | door
  label           text,                     -- "The arch", "01", "L · 24 chairs · 6 rows"

  position_top    text,                     -- "12%"
  position_left   text,                     -- "38%"
  position_right  text,                     -- "1%" (rare)
  position_bottom text,                     -- "1%" (for bottom-edge doors)
  size_width      text,                     -- "24%"
  size_height     text,                     -- "6%" (or null when is_circle)
  is_circle       boolean not null default false,
  edge_anchor     text,                     -- 'bottom-edge' | null

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists floorplan_zones_space_id_idx on floorplan_zones(space_id);

-- ── Floor-plan key items (the numbered legend below each schematic) ──────

create table if not exists floorplan_key_items (
  id              uuid primary key default gen_random_uuid(),
  space_id        uuid not null references floorplan_spaces(id) on delete cascade,

  name            text not null,           -- "The arch"
  detail          text,                     -- "Olive branches, ivory ribbon — built on site..."

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists floorplan_key_items_space_id_idx on floorplan_key_items(space_id);

-- ── Inspiration galleries ────────────────────────────────────────────────
--
-- Six (or however many) editorial chapters on /design. Each gallery has
-- a small-caps eyebrow ("Ceremony" / "Florals" / ...), an italic title,
-- and a description. The actual visual tiles live in
-- inspiration_tiles, with one tile flagged is_hero so it gets the
-- larger 2×2 layout in the grid.

create table if not exists inspiration_galleries (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references couples(id) on delete cascade,

  eyebrow         text,                    -- "Ceremony"
  title           text not null,           -- "An olive-branch arch over the aisle."
  description     text,                     -- the longer editorial paragraph

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists inspiration_galleries_couple_id_idx on inspiration_galleries(couple_id);

-- ── Inspiration tiles ────────────────────────────────────────────────────
--
-- One tile per visual reference under a gallery. `note` is the caption
-- that appears at the bottom of the tile (currently used for the file
-- path placeholder, e.g. "img → ceremony / hero", until real photos
-- ship). `is_hero` flips the tile to the 2×2 hero layout.

create table if not exists inspiration_tiles (
  id              uuid primary key default gen_random_uuid(),
  gallery_id      uuid not null references inspiration_galleries(id) on delete cascade,

  label           text not null,           -- "Hero" / "Aisle" / "Recessional"
  title           text not null,           -- "An olive-branch arch over the aisle."
  note            text,                     -- optional caption / file-path placeholder
  image_url       text,                     -- hosted photo URL (Cloudinary etc.)
  is_hero         boolean not null default false,

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table inspiration_tiles add column if not exists image_url text;
alter table inspiration_tiles add column if not exists bg_position_x integer default 50;
alter table inspiration_tiles add column if not exists bg_position_y integer default 50;

alter table design_materials add column if not exists image_url text;

create index if not exists inspiration_tiles_gallery_id_idx on inspiration_tiles(gallery_id);

-- ── Design materials ─────────────────────────────────────────────────────
--
-- The "Metals & Finishes" grid at the foot of /design — a small set of
-- 3-ish swatches (Polished silver, Matte white, Clear glass on the demo
-- couple). `swatch_kind` drives the visual treatment so Zoe doesn't
-- have to write CSS — picks a preset from a fixed list:
--   silver | gold | brass | white | ivory | clear | palette-1..4
-- The view maps each kind to a background gradient or a couple-palette
-- variable.

create table if not exists design_materials (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references couples(id) on delete cascade,

  name            text not null,           -- "Polished silver"
  detail          text,                     -- "Flatware · candle holders · table numbers"
  swatch_kind     text not null default 'silver',

  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists design_materials_couple_id_idx on design_materials(couple_id);

-- ── Team members ─────────────────────────────────────────────────────────
--
-- Global (not per-couple). Shown on every landing page in the "Meet your
-- team" section. Seeded with Zoe and Amanda on first run.

create table if not exists team_members (
  id          uuid primary key default gen_random_uuid(),
  sort_order  integer not null default 0,
  name        text not null,
  role        text,
  bio         text,
  photo_url   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Seed only when the table is empty (first deploy).
insert into team_members (sort_order, name, role, bio)
select v.sort_order, v.name, v.role, v.bio
from (values
  (0, 'Zoe McDaniel',
      'Founder & Creative Director · Zuzu Collective · San Diego, CA',
      'Story-driven design rooted in intention. I build bespoke weddings and events that escape the mundane — dark, moody, specific, and entirely yours. Nothing cookie-cutter, nothing ordinary.'),
  (1, 'Amanda',
      'Associate Coordinator · Zuzu Collective',
      'Amanda joins select Zuzu coordination clients to make sure every detail executes exactly as designed. She''s the reason the day flows.')
) as v(sort_order, name, role, bio)
where not exists (select 1 from team_members);

create index if not exists team_members_sort_idx on team_members(sort_order);
--
-- Append-only log of client page views. ip_hash is SHA-256(ip + salt)
-- truncated to 16 hex chars — enough for session-level deduplication,
-- not enough to recover the original IP. No PII stored.
-- `section` is the page slug: landing | design | vendors | checklist |
-- budget | timeline | floor-plan | guest-list.

create table if not exists portal_events (
  id          bigserial primary key,
  couple_id   uuid not null references couples(id) on delete cascade,
  section     text not null,
  ip_hash     text,
  created_at  timestamptz not null default now()
);

create index if not exists portal_events_couple_created_idx
  on portal_events(couple_id, created_at desc);
