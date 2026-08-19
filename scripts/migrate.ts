// Versioned schema migrations.
//
//   npx tsx scripts/migrate.ts --target dev            apply pending migrations to DATABASE_URL_DEV
//   npx tsx scripts/migrate.ts --target prod           apply them to DATABASE_URL
//   npx tsx scripts/migrate.ts --target dev --status   list applied and pending
//
// **`--target` IS REQUIRED, AND THAT IS THE WHOLE POINT OF THIS BLOCK.**
//
// This script used to read `DATABASE_URL` with no argument at all, so a bare
// `npm run migrate` silently meant PRODUCTION. On 2026-08-18 that fired: a
// migration intended for dev was applied to production, which renamed 10 live
// rows and rebuilt the slot index under the deployed code's feet. The old
// code's `ON CONFLICT ... WHERE status <> 'cancelled'` could not resolve
// against the new predicate, so every booking — public and admin — raised
// 42P10 until the schema was restored by hand.
//
// The defence is not "be careful". Two things make it structural:
//
//   1. **No default target.** The dangerous option cannot be selected by
//      omission, which is how it was selected.
//   2. **The host is resolved and PRINTED before anything touches a database**,
//      and dev is proved to differ from production first — the same comparison
//      `verify-booking-smoke.ts` has always made before it writes a test row.
//      A guard that only exists on the paths someone was already being careful
//      about is not a guard.
//
// Requires DATABASE_URL (production) and DATABASE_URL_DEV in .env.local — run
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

const statusOnly = process.argv.includes('--status');

// ── Target selection ───────────────────────────────────────────────────────
const targetArg = process.argv.indexOf('--target');
const target = targetArg === -1 ? null : process.argv[targetArg + 1];

if (target !== 'dev' && target !== 'prod') {
  console.error('Refusing to run: --target dev|prod is required.');
  console.error('');
  console.error('  npx tsx scripts/migrate.ts --target dev     the Neon dev branch');
  console.error('  npx tsx scripts/migrate.ts --target prod    PRODUCTION');
  console.error('');
  console.error('There is deliberately no default. A bare invocation of this script used to');
  console.error('mean production, and on 2026-08-18 that took the booking funnel down.');
  process.exit(1);
}

const PROD_URL = process.env.DATABASE_URL;
const DEV_URL = process.env.DATABASE_URL_DEV;

// Production must be known even when the target is dev, because it is the thing
// dev is proved to differ FROM. Refusing when it is absent means the check
// cannot fail open exactly when it knows least — the guard order BK-02
// established and `verify-booking-smoke.ts` still uses.
if (!PROD_URL) {
  console.error('DATABASE_URL (production) is not set, so no target can be proved distinct from it.');
  console.error('Run: vercel env pull --environment=production .env.local');
  process.exit(1);
}
if (target === 'dev' && !DEV_URL) {
  console.error('DATABASE_URL_DEV is not set, so --target dev has nothing to point at.');
  process.exit(1);
}

const hostOf = (url: string) => url.replace(/.*@([^/]+)\/.*/, '$1');
const DATABASE_URL = target === 'prod' ? PROD_URL : (DEV_URL as string);

if (target === 'dev' && hostOf(DEV_URL as string) === hostOf(PROD_URL)) {
  console.error('REFUSING: DATABASE_URL_DEV and DATABASE_URL resolve to the same host,');
  console.error(`so "--target dev" would migrate PRODUCTION (${hostOf(PROD_URL)}).`);
  process.exit(1);
}

// Printed BEFORE the first statement, every run, including --status. The
// outage was survivable-in-hindsight for one reason only: the host was never
// shown, so nothing on screen distinguished the run that was safe from the run
// that was not.
console.log(
  `Target: ${target === 'prod' ? 'PRODUCTION' : 'dev branch'} — ${hostOf(DATABASE_URL)}`,
);
if (target === 'prod' && !statusOnly) {
  console.log('Applying migrations to PRODUCTION. Check the host above before this finishes.');
}
console.log('');

const sql = neon(DATABASE_URL);

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
