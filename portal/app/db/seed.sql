-- Seed data for Phase 1 — Alicia & Jack as the proof-of-concept couple.
--
-- This INSERT is idempotent (on conflict do nothing) so re-running the
-- seed against an existing database doesn't error or duplicate.

insert into couples (
  slug,
  display_name,
  wedding_date,
  venue_name,
  venue_location,
  intro_text
) values (
  'alicia-and-jack-2026',
  'Alicia & Jack',
  '2026-10-10',
  'La Playa',
  'Carmel-by-the-Sea',
  'Every vendor, every detail, every intentional choice adding up to October tenth — gathered here as we build it together.'
)
on conflict (slug) do nothing;
