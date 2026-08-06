// Versioned schema migrations.
//
//   npx tsx scripts/migrate.ts          apply pending migrations
//   npx tsx scripts/migrate.ts --status list what is applied and what is pending
//
// Requires DATABASE_URL in .env.local — run
// `vercel env pull --environment=production .env.local` first.
//
// Each migration runs as a sequence of separate statements (Neon's HTTP driver
// has no cross-call transaction), so a migration is NOT atomic. It is only
// recorded in `schema_migrations` after every statement succeeds, and every
// statement is IF NOT EXISTS, so a partial failure is safe to re-run.
import { neon } from '@neondatabase/serverless';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { migrations } from './migrations/index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set (or present but empty).');
  console.error('Run: vercel env pull --environment=production .env.local');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const statusOnly = process.argv.includes('--status');

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const rows = (await sql`SELECT name FROM schema_migrations`) as { name: string }[];
const applied = new Set(rows.map((r) => r.name));

if (statusOnly) {
  for (const m of migrations) {
    console.log(`${applied.has(m.name) ? '✓' : '·'} ${m.name}${applied.has(m.name) ? '' : '  (pending)'}`);
  }
  process.exit(0);
}

let ran = 0;
for (const m of migrations) {
  if (applied.has(m.name)) {
    console.log(`· ${m.name} (already applied)`);
    continue;
  }
  try {
    await m.up(sql);
  } catch (err) {
    console.error(`\n✗ ${m.name} failed — nothing was recorded, safe to re-run.`);
    console.error(err);
    process.exit(1);
  }
  await sql`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
  console.log(`✓ ${m.name}`);
  ran++;
}

console.log(ran === 0 ? '\nSchema up to date.' : `\nApplied ${ran} migration${ran === 1 ? '' : 's'}.`);
