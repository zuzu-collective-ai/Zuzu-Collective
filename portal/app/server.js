// Zuzu Collective portal — Express entry point.
//
// Three concerns now:
//   1. Static assets — the existing CSS lives in ../mockup/styles. The
//      mockup is the design source of truth; the app just consumes it.
//      Admin-specific CSS lives in ./public/styles/admin.css.
//   2. Couple portal — GET /p/:slug/* (Phases 1-2).
//   3. Admin tool   — /admin/* with session auth (Phase 3a).

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db/pool.js';
import { initDb } from './db/init.js';
import portalRoutes from './routes/portal.js';
import adminRoutes from './routes/admin.js';

const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = join(here, '..', 'mockup');

const app = express();

app.set('trust proxy', 1); // Render terminates TLS in front of the app

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
        // 'https:' allows Cloudinary URLs and any other CDN for couple photos
        imgSrc: ["'self'", 'data:', 'https:'],
        // Inline scripts are limited to admin form helpers (add/remove
        // guest rows). Move to external files + nonces if the admin
        // ever needs anything more substantial.
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);

// Form-encoded body parser for admin POSTs.
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// Session — used only for admin auth right now. In-memory store is
// fine for a single-user admin; upgrade to a Redis or pg-backed store
// once we have multiple admins or need horizontal scale.
app.use(
  session({
    name: 'zuzu.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-do-not-use-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  }),
);

app.set('view engine', 'ejs');
app.set('views', join(here, 'views'));

// Serve the mockup's CSS folder directly so the app and the static
// mockup share one stylesheet source. /styles/landing.css → portal/mockup/styles/landing.css
app.use('/styles', express.static(join(mockupRoot, 'styles')));

// Anything we drop in portal/app/public is also served (admin.css lives here).
app.use(express.static(join(here, 'public')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/admin', adminRoutes);
app.use('/', portalRoutes);

// Root → couples list for admins, otherwise the demo couple.
app.get('/', (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin');
  res.redirect('/p/alicia-and-jack-2026');
});

app.use((_req, res) => {
  res.status(404).render('404');
});

const PORT = Number(process.env.PORT) || 3000;

(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[zuzu-portal] listening on :${PORT}`);
      if (!process.env.ADMIN_PASSWORD) {
        console.warn(
          '[zuzu-portal] WARNING: ADMIN_PASSWORD is not set. /admin/login will refuse to authenticate.',
        );
      }
      if (!process.env.SESSION_SECRET) {
        console.warn(
          '[zuzu-portal] WARNING: SESSION_SECRET is not set; using an insecure dev fallback.',
        );
      }
    });
  } catch (err) {
    console.error('[zuzu-portal] failed to start:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
