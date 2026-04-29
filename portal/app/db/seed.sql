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

-- ── Reception tables, households, guests ───────────────────────────────
do $$
declare
  aj_id uuid;
  has_seating boolean;

  t01 uuid; t02 uuid; t03 uuid; t04 uuid; t05 uuid;
  t06 uuid; t07 uuid; t08 uuid; t09 uuid; t10 uuid;

  h_bennetts uuid; h_cohens uuid; h_eleanor uuid; h_marcheses uuid;
  h_maya uuid; h_nina uuid; h_theo_anna uuid; h_daniel_vega uuid;
  h_pattersons uuid; h_lees uuid; h_priya uuid; h_aisha uuid;
  h_cabreras uuid; h_crawfords uuid; h_ortegas uuid;
  h_whitfields uuid; h_ruth uuid; h_norths uuid; h_ahmeds uuid; h_will uuid;
  h_hartwells uuid; h_suzukis uuid; h_margaret uuid; h_rios uuid; h_friedmans uuid;
begin
  select id into aj_id from couples where slug = 'alicia-and-jack-2026';
  if aj_id is null then return; end if;

  select exists(select 1 from tables where couple_id = aj_id) into has_seating;
  if has_seating then return; end if;

  -- Tables
  insert into tables (couple_id, table_number, table_name, capacity, role, note, position) values
    (aj_id, 1, 'Cypress',       8,  'head',     'Parents and the couple. Closest to the dance floor.',                          1),
    (aj_id, 2, 'Bay',           8,  'standard', 'Grandparents and elders — aisle seat reserved for Eleanor.',                   2),
    (aj_id, 3, 'Olive',         8,  'standard', 'Wedding party and partners.',                                                  3),
    (aj_id, 4, 'Beach',         10, 'standard', 'Family friends with kids — seated near the courtyard exit.',                   4),
    (aj_id, 5, 'Bougainvillea', 10, 'standard', 'Bride''s college circle.',                                                     5),
    (aj_id, 6, 'Sage',          10, 'standard', 'Bride''s extended family.',                                                    6),
    (aj_id, 7, 'Heather',       10, 'standard', 'Groom''s extended family.',                                                    7),
    (aj_id, 8, 'Coral',         10, 'standard', 'Groom''s college circle.',                                                     8),
    (aj_id, 9, 'Manzanita',     10, 'standard', 'Bride''s work circle.',                                                        9),
    (aj_id, 10,'Driftwood',     8,  'kids',     'Children''s table — supervised by Patterson and Lee parents nearby. Crayons, paper menus, fries on standby.', 10);

  -- Pull the IDs we just inserted by table_number. (Multi-row INSERT
  -- with `RETURNING id INTO single_var` raises P0003 in PL/pgSQL.)
  select id into t01 from tables where couple_id = aj_id and table_number = 1;
  select id into t02 from tables where couple_id = aj_id and table_number = 2;
  select id into t03 from tables where couple_id = aj_id and table_number = 3;
  select id into t04 from tables where couple_id = aj_id and table_number = 4;
  select id into t05 from tables where couple_id = aj_id and table_number = 5;
  select id into t06 from tables where couple_id = aj_id and table_number = 6;
  select id into t07 from tables where couple_id = aj_id and table_number = 7;
  select id into t08 from tables where couple_id = aj_id and table_number = 8;
  select id into t09 from tables where couple_id = aj_id and table_number = 9;
  select id into t10 from tables where couple_id = aj_id and table_number = 10;

  -- ── Accepted households ──────────────────────────────────────────────
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Bennetts', 'Bride''s parents', 'accepted', 'Father of the bride — welcome toast at 5:45.', 1)
       returning id into h_bennetts;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Cohens', 'Groom''s parents', 'accepted', 'Mother-son dance immediately after the first dance.', 2)
       returning id into h_cohens;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Eleanor Bennett', 'Bride''s grandmother', 'accepted', 'Mobility — needs aisle seat; car service to and from the hotel.', 3)
       returning id into h_eleanor;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Marcheses', 'Groom''s grandparents', 'accepted', null, 4)
       returning id into h_marcheses;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Maya Bennett & Carlos Vargas', 'Bride''s side · sister', 'accepted', 'Maya — sister of the bride, reading at the four-minute mark.', 5)
       returning id into h_maya;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Nina Reyes', 'Bridal party · maid of honor', 'accepted', 'Maid-of-honor toast at 7:15.', 6)
       returning id into h_nina;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Theo Cohen & Anna Park', 'Groom''s side · brother', 'accepted', null, 7)
       returning id into h_theo_anna;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Daniel Vega', 'Bridal party · best man', 'accepted', 'Best-man toast at 7:18.', 8)
       returning id into h_daniel_vega;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Pattersons', 'Both sides · family friends', 'accepted', 'Two children''s meals; high chair not required.', 9)
       returning id into h_pattersons;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Lees', 'Groom''s side · college', 'accepted', 'Hannah — gluten-free meal preference noted with caterer.', 10)
       returning id into h_lees;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Priya Mehta', 'Bride''s side · college', 'accepted', null, 11)
       returning id into h_priya;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Aisha Cole & Marcus Webb', 'Bride''s side · college', 'accepted', null, 12)
       returning id into h_aisha;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Cabreras', 'Bride''s aunt & uncle', 'accepted', null, 13)
       returning id into h_cabreras;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Crawfords', 'Bride''s side · work', 'accepted', 'Recently engaged — may have a conflict with the rehearsal dinner.', 14)
       returning id into h_crawfords;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Ortegas', 'Groom''s aunt & uncle', 'accepted', 'Awaiting table assignment — Zoe to confirm Table 07 or 09.', 15)
       returning id into h_ortegas;

  -- ── Awaiting households ──────────────────────────────────────────────
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Whitfields', 'Bride''s side · cousin', 'awaiting', 'Save-the-date confirmed received; invitation mailed April 6.', 16)
       returning id into h_whitfields;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Ruth Bennett', 'Bride''s side · aunt', 'awaiting', 'Aunt Ruth left a voicemail — call her back this week.', 17)
       returning id into h_ruth;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Norths', 'Bride''s side · second cousin', 'awaiting', null, 18)
       returning id into h_norths;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Ahmeds', 'Groom''s side · family friend', 'awaiting', null, 19)
       returning id into h_ahmeds;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Will Sutton', 'Groom''s side · college', 'awaiting', 'Travelling abroad through April; reply expected first week of May.', 20)
       returning id into h_will;

  -- ── Declined households ──────────────────────────────────────────────
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Hartwells', 'Bride''s side · cousin', 'declined', 'Out of the country in October — a thank-you note went out.', 21)
       returning id into h_hartwells;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Suzukis', 'Groom''s side · college', 'declined', 'Conflicting wedding the same weekend.', 22)
       returning id into h_suzukis;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'Margaret Hill', 'Bride''s side · family friend', 'declined', 'Health — sending a gift in lieu.', 23)
       returning id into h_margaret;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Rios', 'Groom''s side · cousin', 'declined', null, 24)
       returning id into h_rios;
  insert into households (couple_id, display_name, side, status, note, position)
       values (aj_id, 'The Friedmans', 'Both sides · family friend', 'declined', null, 25)
       returning id into h_friedmans;

  -- ── Guests with table assignments ────────────────────────────────────
  -- Table 01 Cypress (head) — couple, parents, sister, brother
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_bennetts, t01, 'Alicia Bennett', 'adult', 1),
    (h_cohens,   t01, 'Jack Cohen',     'adult', 2),
    (h_bennetts, t01, 'David Bennett',  'adult', 3),
    (h_bennetts, t01, 'Helen Bennett',  'adult', 4),
    (h_cohens,   t01, 'Robert Cohen',   'adult', 5),
    (h_cohens,   t01, 'Susan Cohen',    'adult', 6),
    (h_maya,     t01, 'Maya Bennett',   'adult', 7),
    (h_theo_anna,t01, 'Theo Cohen',     'adult', 8);

  -- Table 02 Bay
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_eleanor,   t02, 'Eleanor Bennett',  'adult', 1),
    (h_marcheses, t02, 'Antonio Marchese', 'adult', 2),
    (h_marcheses, t02, 'Rosa Marchese',    'adult', 3);

  -- Table 03 Olive — wedding party
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_nina,        t03, 'Nina Reyes',    'adult',     1),
    (h_nina,        t03, 'Daniel Park',   'plus_one',  2),
    (h_daniel_vega, t03, 'Daniel Vega',   'adult',     3),
    (h_daniel_vega, t03, 'Lily Foster',   'plus_one',  4),
    (h_maya,        t03, 'Carlos Vargas', 'adult',     5),
    (h_theo_anna,   t03, 'Anna Park',     'adult',     6);

  -- Table 04 Beach
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_pattersons, t04, 'Mark Patterson',   'adult', 1),
    (h_pattersons, t04, 'Janine Patterson', 'adult', 2),
    (h_pattersons, t04, 'Ada Patterson',    'child', 3),
    (h_pattersons, t04, 'Owen Patterson',   'child', 4),
    (h_lees,       t04, 'Hannah Lee',       'adult', 5),
    (h_lees,       t04, 'Sam Lee',          'adult', 6);

  -- Table 05 Bougainvillea — bride's college
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_priya, t05, 'Priya Mehta', 'adult', 1),
    (h_aisha, t05, 'Aisha Cole',  'adult', 2),
    (h_aisha, t05, 'Marcus Webb', 'adult', 3);

  -- Table 06 Sage — bride's extended family
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_cabreras, t06, 'Jorge Cabrera',   'adult', 1),
    (h_cabreras, t06, 'Marisol Cabrera', 'adult', 2),
    (h_cabreras, t06, 'Elena Cabrera',   'adult', 3);

  -- Table 09 Manzanita — bride's work
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_crawfords, t09, 'Beth Crawford', 'adult', 1),
    (h_crawfords, t09, 'Tom Crawford',  'adult', 2);

  -- Unseated (status='accepted' but table_id is null)
  insert into guests (household_id, table_id, display_name, guest_type, position) values
    (h_ortegas, null, 'Pablo Ortega',  'adult', 1),
    (h_ortegas, null, 'Lucia Ortega',  'adult', 2),
    (h_ortegas, null, 'Mateo Ortega',  'adult', 3);

  -- Awaiting (no table assignment yet — they haven't said yes)
  insert into guests (household_id, display_name, guest_type, position) values
    (h_whitfields, 'Catherine Whitfield', 'adult', 1),
    (h_whitfields, 'James Whitfield',     'adult', 2),
    (h_whitfields, 'Hazel Whitfield',     'child', 3),
    (h_whitfields, 'Theo Whitfield',      'child', 4),
    (h_ruth,       'Ruth Bennett',        'adult', 1),
    (h_ruth,       'Plus one — name TBC', 'plus_one', 2),
    (h_norths,     'Eli North',           'adult', 1),
    (h_norths,     'Sara North',          'adult', 2),
    (h_ahmeds,     'Imran Ahmed',         'adult', 1),
    (h_ahmeds,     'Yasmin Ahmed',        'adult', 2),
    (h_ahmeds,     'Layla Ahmed',         'adult', 3),
    (h_will,       'Will Sutton',         'adult', 1),
    (h_will,       'Plus one — name TBC', 'plus_one', 2);

  -- Declined
  insert into guests (household_id, display_name, guest_type, position) values
    (h_hartwells, 'Greg Hartwell',       'adult', 1),
    (h_hartwells, 'Maria Hartwell',      'adult', 2),
    (h_hartwells, 'Sophie Hartwell',     'child', 3),
    (h_suzukis,   'Kenji Suzuki',        'adult', 1),
    (h_suzukis,   'Mei Suzuki',          'adult', 2),
    (h_margaret,  'Margaret Hill',       'adult', 1),
    (h_rios,      'Tomas Rios',          'adult', 1),
    (h_rios,      'Daniela Rios',        'adult', 2),
    (h_rios,      'Felix Rios',          'child', 3),
    (h_rios,      'Ines Rios',           'child', 4),
    (h_friedmans, 'Aaron Friedman',      'adult', 1),
    (h_friedmans, 'Rebecca Friedman',    'adult', 2),
    (h_friedmans, 'Noa Friedman',        'child', 3);
end $$;
