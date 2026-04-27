// Idempotent schema + seed runner. Called once at server startup so a
// fresh Render deploy comes up with a working database without manual
// psql work.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function initDb() {
  const schema = readFileSync(join(here, 'schema.sql'), 'utf-8');
  await pool.query(schema);

  const seed = readFileSync(join(here, 'seed.sql'), 'utf-8');
  await pool.query(seed);

  console.log('[db] schema applied and seed inserted (or skipped if present)');
}
