-- Seed data for Phase 1+ — Alicia & Jack as the proof-of-concept couple.
--
-- Top-level INSERT is idempotent (on conflict do nothing). Per-section
-- seed blocks below are wrapped in DO $$ ... $$ that no-ops if data for
-- this couple already exists, so re-running the seed never duplicates.

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

-- ── Vendors — 17-row Alicia & Jack roster ──────────────────────────────
do $$
declare
  aj_id uuid;
  has_vendors boolean;
begin
  select id into aj_id from couples where slug = 'alicia-and-jack-2026';
  if aj_id is null then return; end if;

  select exists(select 1 from vendors where couple_id = aj_id) into has_vendors;
  if has_vendors then return; end if;

  insert into vendors (couple_id, vendor_type, display_name, contact_name, phone, email, address, status, note, position) values
    (aj_id, 'Venue',                  'La Playa Hotel',         'Michael Hernandez',     '(831) 624-6476',         'events@laplayahotel.com',     'Camino Real at 8th Ave, Carmel-by-the-Sea, CA', 'booked',     null,                                                                                                            1),
    (aj_id, 'Caterer',                'La Playa Catering',      'Sandra Chen',           '(831) 624-6476 ext. 2',  'catering@laplayahotel.com',   null,                                            'booked',     'in-house',                                                                                                       2),
    (aj_id, 'Photographer',           'Iris & Light Studio',    'Iris Tanaka',           '(415) 555-0234',         'iris@irisandlight.com',       null,                                            'booked',     null,                                                                                                            3),
    (aj_id, 'Videographer',           'Carmel Coast Films',     'Marcus Wells',          '(831) 555-0788',         'hello@carmelcoast.com',       null,                                            'booked',     null,                                                                                                            4),
    (aj_id, 'Florist',                null,                     null,                    null,                     null,                          null,                                            'shortlist',  'Three studios shortlisted. Looking for ivory-forward florals with baby''s breath, calla lilies, and roses. Decision by end of month.', 5),
    (aj_id, 'DJ',                     'West Coast Sound',       'Daniel Marquez',        '(415) 555-9923',         'daniel@westcoastsound.com',   null,                                            'booked',     null,                                                                                                            6),
    (aj_id, 'Band',                   null,                     null,                    null,                     null,                          null,                                            'na',         'Couple opted for DJ over band for the reception. Ceremony quartet covers live music for the processional.',     7),
    (aj_id, 'Wedding Planner',        'Zuzu Collective',        'Zoe McDaniel & Amanda', '(347) 860-5573',         'info@zuzucollective.com',     null,                                            'booked',     null,                                                                                                            8),
    (aj_id, 'Officiant',              'Reverend Diane Marquez', null,                    '(831) 555-2244',         'diane@coastalceremonies.com', null,                                            'booked',     null,                                                                                                            9),
    (aj_id, 'Hair Stylist',           null,                     null,                    null,                     null,                          null,                                            'shortlist',  'Trial scheduled with two finalists in October. Looking for soft, undone updo with movement.',                  10),
    (aj_id, 'Makeup Artist',          null,                     null,                    null,                     null,                          null,                                            'shortlist',  'Bundling with hair stylist trial. Bridal party of four also requesting service day-of.',                       11),
    (aj_id, 'Transportation',         null,                     null,                    null,                     null,                          null,                                            'pending',    '14-passenger sprinter for the bridal party (hotel → venue) and a vintage getaway sedan for the couple''s exit.', 12),
    (aj_id, 'Baker / Cake',           'Pacific Pastries',       'Lila Romero',           '(831) 555-1100',         'orders@pacificpastries.com',  null,                                            'booked',     null,                                                                                                            13),
    (aj_id, 'Hotel (Room Block)',     'La Playa Hotel',         null,                    null,                     null,                          null,                                            'booked',     'venue room block — 40 rooms held · Oct 9–11 · code ALICIAJACK2026 · cutoff September 10, 2026',                14),
    (aj_id, 'Rehearsal Dinner Venue', null,                     null,                    null,                     null,                          null,                                            'shortlist',  '25 guests · coastal restaurant within 10 minutes of the venue. Looking at three candidates.',                  15),
    (aj_id, 'Honeymoon Hotel',        null,                     null,                    null,                     null,                          null,                                            'pending',    'Couple''s choice — Amalfi Coast, two-week stay. Booking direct through their travel agent.',                    16),
    (aj_id, 'Honeymoon Airline',      null,                     null,                    null,                     null,                          null,                                            'pending',    'Travel agent handling — SFO → Naples direct. Targeting business class on the outbound.',                       17);
end $$;
