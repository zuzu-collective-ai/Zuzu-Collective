// Zuzu Collective portal — Express entry point.
//
// One server, three concerns for now:
//   1. Static assets — the existing CSS lives in ../mockup/styles. The
//      mockup is the design source of truth; the app just consumes it.
//   2. Couple portal — GET /p/:slug renders the landing page from DB.
//   3. Health check — GET /healthz for Render's uptime probe.
//
// Phases 2-5 will add more routes (design, vendors, …, admin, AI).

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db/pool.js';
import { initDb } from './db/init.js';
import portalRoutes from './routes/portal.js';

const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = join(here, '..', 'mockup');

const app = express();

// Helmet's CSP defaults block Google Fonts and inline <style>. Loosen
// just enough for the brand fonts and the per-couple palette overrides
// we inject inline in the layout. Tighten further once we self-host
// the licensed fonts.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
      },
    },
  }),
);

app.set('view engine', 'ejs');
app.set('views', join(here, 'views'));

// Serve the mockup's CSS folder directly so the app and the static
// mockup share one stylesheet source. /styles/landing.css → portal/mockup/styles/landing.css
app.use('/styles', express.static(join(mockupRoot, 'styles')));

// Future-proof: anything we drop in portal/app/public is also served.
app.use(express.static(join(here, 'public')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/', portalRoutes);

// Root → redirect to Alicia & Jack for the demo. Once admin lands and
// there's more than one couple, this becomes a "no portal here" page.
app.get('/', (_req, res) => res.redirect('/p/alicia-and-jack-2026'));

// Anything we don't recognize gets a small 404. Real product would have
// a styled page; for now the editorial 404 can wait.
app.use((_req, res) => {
  res.status(404).send('Not found.');
});

const PORT = Number(process.env.PORT) || 3000;

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[zuzu-portal] listening on :${PORT}`);
    });
  } catch (err) {
    console.error('[zuzu-portal] failed to start:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
