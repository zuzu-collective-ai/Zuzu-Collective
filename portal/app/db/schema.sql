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
