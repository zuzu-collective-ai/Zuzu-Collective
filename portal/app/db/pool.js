// Postgres connection pool — one per process, shared across requests.
//
// Reads DATABASE_URL from env. On Render this is injected automatically
// when the web service is linked to a database; locally it comes from
// .env (see .env.example).

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// Render's managed Postgres terminates SSL at the proxy and self-signs
// the cert chain — pg refuses to connect by default. Disable cert
// verification only when we're hitting a *.render.com host so local
// connections still get full validation.
const isRenderManagedDb = /\.render\.com/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRenderManagedDb ? { rejectUnauthorized: false } : false,
});
