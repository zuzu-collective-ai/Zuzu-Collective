# Zuzu portal — dynamic app

Express + Postgres + EJS. The static mockup at `../mockup/` is the design
source of truth; this app reads couple data from Postgres and renders
the same pages with that data interpolated.

## What's in Phase 1

- `couples` table backing the landing page
- `GET /p/:slug` renders `landing.ejs` from a couple row
- Idempotent `schema.sql` + `seed.sql` run automatically at startup
- Render-ready (`/render.yaml` at the repo root provisions web + db on
  first deploy)
- Static stylesheets served from `../mockup/styles/` so design changes
  in the mockup land in the dynamic app for free

Phases 2–5 (couple pages, admin, AI allocator, floor plan editor)
build on this foundation.

## Deploy to Render

1. Sign in at <https://render.com> with GitHub.
2. **New + → Blueprint** → pick `zuzu-collective-ai/Zuzu-Collective`.
3. Render reads `/render.yaml` at the repo root, provisions the web
   service and the database, and links them. Click **Apply**.
4. First deploy takes ~3 minutes. When it's green, the app is live at
   `https://zuzu-portal.onrender.com/p/alicia-and-jack-2026`.

The seed inserts Alicia & Jack on first boot, so the URL works immediately.

## Run locally (optional)

```sh
# Install deps
cd portal/app
npm install

# Start a Postgres locally (or point DATABASE_URL at any Postgres you have)
# Easiest: docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=zuzu -e POSTGRES_DB=zuzu_portal postgres:16

# Configure env
cp .env.example .env
# edit .env so DATABASE_URL points at your Postgres

# Run the server
npm run dev
# → http://localhost:3000/p/alicia-and-jack-2026
```

Schema and seed are applied automatically on startup.

## File map

```
portal/app/
├── server.js              # Express entry — middleware, static, routes, startup
├── package.json           # Node 20+, ESM, four runtime deps
├── render.yaml            # Render blueprint — web + Postgres
├── .env.example           # Copy to .env for local dev
│
├── db/
│   ├── pool.js            # pg connection pool, SSL handling for Render
│   ├── schema.sql         # Idempotent DDL (couples table for now)
│   ├── seed.sql           # Alicia & Jack as the demo couple
│   └── init.js            # Runs schema + seed at startup
│
├── routes/
│   └── portal.js          # /p/:slug couple-facing routes
│
└── views/
    ├── landing.ejs        # Landing page template
    └── partials/
        ├── head.ejs       # <head> incl. fonts and per-couple palette inline
        ├── topbar.ejs     # Persistent nav highlighting `currentPage`
        └── footer.ejs     # Footer signature block
```

## Adding a new couple

Until the admin tool is built, drop a row into Postgres directly. From
the Render dashboard: `zuzu-portal-db` → **Connect → External Connection**
→ open psql, then:

```sql
insert into couples (slug, display_name, wedding_date, venue_name, venue_location, intro_text)
values (
  'taylor-and-sam-2026',
  'Taylor & Sam',
  '2026-09-12',
  'Casa de Luz',
  'Joshua Tree',
  'A two-day desert wedding in late September.'
);
```

Visit `/p/taylor-and-sam-2026` and the portal renders with the new
couple's data.

## Architecture notes

- **One database, every couple.** Every row keys back to `couples.id`.
- **Server-rendered, no client framework.** Each page is a real URL
  Zoe can share. No build step, no React.
- **Static mockup stays alive.** The mockup at `../mockup/` is editable
  and viewable on its own. The app reuses its CSS via the same file
  paths so a tweak there lands in both places.
- **Inline palette CSS variables** override `tokens.css`'s hardcoded
  Alicia & Jack scope, so a single stylesheet supports every couple.
