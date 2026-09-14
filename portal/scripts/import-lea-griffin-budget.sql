-- Lea & Griffin budget import
-- Run in any Postgres client connected to your Render database.
-- Safe to re-run: clears their existing data first.

BEGIN;

-- Find couple id
DO $$
DECLARE
  v_couple_id INT;
  v_cat_id INT;
BEGIN

  SELECT id INTO v_couple_id FROM couples
  WHERE lower(display_name) LIKE '%lea%' AND lower(display_name) LIKE '%griffin%'
  ORDER BY id LIMIT 1;

  IF v_couple_id IS NULL THEN
    RAISE EXCEPTION 'Could not find couple matching Lea + Griffin';
  END IF;

  RAISE NOTICE 'Found couple id: %', v_couple_id;

  -- Clear existing data
  DELETE FROM budget_line_items WHERE category_id IN (
    SELECT id FROM budget_categories WHERE couple_id = v_couple_id
  );
  DELETE FROM budget_categories WHERE couple_id = v_couple_id;

  -- 1. Planning (Zuzu Collective) — contracted $5,500
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 1, 'Planning', null, 550000, 0, 1, now(), now())
  RETURNING id INTO v_cat_id;
  INSERT INTO budget_line_items (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at) VALUES
    (v_cat_id, v_couple_id, 'Deposit',       275000, 275000, 'paid',     null,         1, now(), now()),
    (v_cat_id, v_couple_id, 'Installment 2', 137500, 137500, 'paid',     null,         2, now(), now()),
    (v_cat_id, v_couple_id, 'Final payment', 137500, 0,      'upcoming', '2027-08-28', 3, now(), now());

  -- 2. Catering (Classic Culinaire) — contracted $22,383
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 2, 'Catering', '(Classic Culinaire)', 2238300, 0, 2, now(), now())
  RETURNING id INTO v_cat_id;
  INSERT INTO budget_line_items (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at) VALUES
    (v_cat_id, v_couple_id, 'Deposit',       150000,  150000,  'paid',     null,         1, now(), now()),
    (v_cat_id, v_couple_id, 'Final payment', 2088300, 0,       'upcoming', '2027-09-03', 2, now(), now());

  -- 3. Bar & Alcohol — estimated $3,600
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 3, 'Bar & Alcohol', null, 0, 360000, 3, now(), now());

  -- 4. Photography & Video (Dennis Roy Coronel) — contracted $10,500
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 4, 'Photography & Video', '(Dennis Roy Coronel)', 1050000, 0, 4, now(), now())
  RETURNING id INTO v_cat_id;
  INSERT INTO budget_line_items (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at) VALUES
    (v_cat_id, v_couple_id, 'Deposit',       525000, 525000, 'paid',     null,         1, now(), now()),
    (v_cat_id, v_couple_id, 'Final payment', 525000, 0,      'upcoming', '2027-08-10', 2, now(), now());

  -- 5. Music (Hip Service) — contracted $14,750
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 5, 'Music', '(Hip Service)', 1475000, 0, 5, now(), now())
  RETURNING id INTO v_cat_id;
  INSERT INTO budget_line_items (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at) VALUES
    (v_cat_id, v_couple_id, 'Deposit',       737500, 737500, 'paid',     '2026-07-16', 1, now(), now()),
    (v_cat_id, v_couple_id, 'Final payment', 737500, 0,      'upcoming', '2027-09-04', 2, now(), now());

  -- 6. Florals & Decor (Blonde Bouquet) — contracted $9,520
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 6, 'Florals & Decor', '(Blonde Bouquet)', 952000, 0, 6, now(), now())
  RETURNING id INTO v_cat_id;
  INSERT INTO budget_line_items (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at) VALUES
    (v_cat_id, v_couple_id, 'Deposit',       50000,  50000,  'paid',     null,         1, now(), now()),
    (v_cat_id, v_couple_id, 'Final payment', 902000, 0,      'upcoming', '2027-08-28', 2, now(), now());

  -- 7. Rentals — estimated $27,410
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 7, 'Rentals', null, 0, 2741000, 7, now(), now());

  -- 8. Hair & Makeup (Beauty on Set) — contracted $4,290
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 8, 'Hair & Makeup', '(Beauty on Set)', 429000, 0, 8, now(), now())
  RETURNING id INTO v_cat_id;
  INSERT INTO budget_line_items (category_id, couple_id, name, amount_cents, paid_cents, status_kind, due_date, position, created_at, updated_at) VALUES
    (v_cat_id, v_couple_id, 'Retainer',      214500, 214500, 'paid',     '2026-02-12', 1, now(), now()),
    (v_cat_id, v_couple_id, 'Final payment', 214500, 0,      'upcoming', '2027-08-12', 2, now(), now());

  -- 9. Cake & Desserts — estimated $1,000
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 9, 'Cake & Desserts', null, 0, 100000, 9, now(), now());

  -- 10. Ceremony
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 10, 'Ceremony', null, 0, 0, 10, now(), now());

  -- 11. Stationery & Favors — estimated $2,000
  INSERT INTO budget_categories (couple_id, category_number, title, title_emphasis, contracted_cents, estimated_cents, position, created_at, updated_at)
  VALUES (v_couple_id, 11, 'Stationery & Favors', null, 0, 200000, 11, now(), now());

  -- Set spreadsheet URL
  UPDATE couples
  SET budget_spreadsheet_url = 'https://docs.google.com/spreadsheets/d/1pi6hYLYShvZVyjJvUX4X7TuI-ATil_03RcinkHdWAgY/edit',
      budget_last_imported_at = now()
  WHERE id = v_couple_id;

  RAISE NOTICE 'Done — Lea & Griffin budget imported successfully.';

END $$;

COMMIT;
