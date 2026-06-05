// Run once after pulling env vars: npx tsx scripts/migrate.ts
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';

function loadEnv(path: string) {
  try {
    readFileSync(path, 'utf-8')
      .split('\n')
      .forEach(line => {
        const eq = line.indexOf('=');
        if (eq < 1 || line.trimStart().startsWith('#')) return;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
      });
  } catch {}
}

loadEnv('.env.local');
loadEnv('.env');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Run: vercel env pull .env.local');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS leads (
    id         SERIAL       PRIMARY KEY,
    name       TEXT         NOT NULL,
    phone      TEXT         NOT NULL,
    email      TEXT,
    service    TEXT         NOT NULL,
    message    TEXT,
    status     TEXT         NOT NULL DEFAULT 'new',
    replied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`;

console.log('✓ leads table ready');
