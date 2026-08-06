// Round-trips the availability endpoint against the real database.
//
//   npx tsx scripts/verify-availability-db.ts
//
// scripts/verify-availability.ts covers the *rules*, but it feeds the pure
// function hand-built primitives, so it structurally cannot catch the two ways
// this endpoint can be wrong: driver deserialization (the Neon driver returns
// `Date` where db.ts says `string`, so a mismatched comparison silently never
// fires) and query bounds (a naive `now + 14 × 24h` bound misses a booking on
// the last offered afternoon). Both only show up against real rows.
//
// This INSERTS AND DELETES rows. Every row it writes carries MARKER in a text
// column, cleanup retries and also runs from SIGINT/SIGTERM, and the script
// re-checks that nothing survived before exiting.
//
// POLICY (set in BK-02): writing verification scripts run against the Neon dev
// branch named by DATABASE_URL_DEV, never production, and refuse to run when it
// is unset rather than falling back. `--allow-production` is reserved for
// deliberate smoke tests against the live database.
//
// This script still runs against DATABASE_URL because it predates the dev
// branch; BK-02 step zero creates the branch and retrofits this script to the
// rule above. Until then `--allow-production` is required on every run.
import { neon } from '@neondatabase/serverless';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, raw] = m;
    let val = raw.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Run: vercel env pull --environment=production .env.local');
  process.exit(1);
}

// Seeding writes to whatever DATABASE_URL names, and there is no separate dev
// branch — so it must be asked for, never run by reflex. For the second or two
// the rows exist, a visitor loading the picker would see those slots and that
// day as unavailable.
if (!process.argv.includes('--allow-production')) {
  console.error('This script INSERTS INTO and DELETES FROM the live database.');
  console.error('Re-run with --allow-production if that is what you want:');
  console.error('  npm run verify:availability:db -- --allow-production');
  process.exit(1);
}

const { GET } = await import('../src/pages/api/booking/availability');
const { MAX_ADVANCE_DAYS } = await import('../src/lib/booking-config');

const sql = neon(process.env.DATABASE_URL);
const MARKER = 'BK-01 verification — safe to delete';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

async function fetchAvailability() {
  const res = await GET({} as never);
  return { res, body: (await res.clone().json()) as any };
}

/** Deletes by marker, retrying — a Neon HTTP blip here would strand rows in production. */
async function cleanup(attempts = 3): Promise<{ appointments: number; blackouts: number }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const a = (await sql`
        DELETE FROM appointments WHERE admin_notes = ${MARKER} RETURNING id
      `) as { id: number }[];
      const b = (await sql`
        DELETE FROM blackout_dates WHERE reason = ${MARKER} RETURNING day
      `) as { day: string }[];
      return { appointments: a.length, blackouts: b.length };
    } catch (err) {
      lastErr = err;
      console.error(`  cleanup attempt ${i + 1} failed, retrying:`, err);
    }
  }
  console.error('  ✗ CLEANUP FAILED. Remove the rows by hand:');
  console.error(`      DELETE FROM appointments   WHERE admin_notes = '${MARKER}';`);
  console.error(`      DELETE FROM blackout_dates WHERE reason      = '${MARKER}';`);
  throw lastErr;
}

// A finally block does not run on SIGINT/SIGTERM, which would strand seeded
// rows in the live database until someone noticed.
let seeded = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (seeded) {
      console.error(`\n${signal} received — cleaning up seeded rows first.`);
      await cleanup().catch(() => {});
    }
    process.exit(130);
  });
}

console.log('Round-tripping /api/booking/availability/ against the real database\n');

const existing = (await sql`
  SELECT (SELECT COUNT(*) FROM appointments) AS appointments,
         (SELECT COUNT(*) FROM blackout_dates) AS blackouts
`) as { appointments: string; blackouts: string }[];
console.log(
  `  existing rows before seeding — appointments: ${existing[0].appointments}, blackout_dates: ${existing[0].blackouts}\n`,
);

try {
  const before = await fetchAvailability();
  check(before.res.status === 200, `expected 200 before seeding, got ${before.res.status}`);

  const openDates = before.body.dates.filter((d: any) => d.slots.length > 0);
  if (openDates.length < 2) {
    console.error('Not enough open days in the current window to run this check.');
    process.exit(1);
  }

  // Needs two free slots on one day: one to book, one to cancel and prove it
  // comes back. Picking a day with only one left and falling back to a
  // computed slot would seed a slot the notice cutoff already excludes, and
  // the gate would go red for a reason unrelated to the endpoint.
  const nearDay = openDates.find((d: any) => d.slots.length >= 2);
  if (!nearDay) {
    console.error('No day in the current window has two free slots — cannot run this check.');
    process.exit(1);
  }

  const horizonDay = openDates[openDates.length - 1];
  const blackoutDay = openDates.find((d: any) => d.date !== nearDay.date && d.date !== horizonDay.date);
  if (!blackoutDay) {
    console.error('Not enough distinct open days in the window — cannot run this check.');
    process.exit(1);
  }

  // The last slot of the furthest offered day — the row a naive
  // `now + 14 × 24h` query bound would fail to see. That only holds if the
  // furthest OPEN day really is the last day of the window; when day 14 is a
  // Friday or blacked out it is not, and this check would quietly degrade into
  // testing a slot the naive bound would have caught anyway. Assert both facts
  // rather than passing on the weaker case.
  const lastDate = before.body.dates[before.body.dates.length - 1].date;
  const horizonSlot = horizonDay.slots[horizonDay.slots.length - 1].start;
  const naiveBound = Date.now() + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000;
  check(
    horizonDay.date === lastDate,
    `query-bounds coverage lost: last open day is ${horizonDay.date}, window ends ${lastDate}`,
  );
  check(
    Date.parse(horizonSlot) > naiveBound,
    `query-bounds coverage lost: ${horizonSlot} is inside a naive ${MAX_ADVANCE_DAYS}×24h bound`,
  );

  const bookedSlot = nearDay.slots[0].start;
  const cancelledSlot = nearDay.slots[1].start;

  console.log(`  booking      ${bookedSlot}  (${nearDay.date})`);
  console.log(`  cancelling   ${cancelledSlot}  (should stay available)`);
  console.log(`  horizon      ${horizonSlot}  (${horizonDay.date})`);
  console.log(`  blacking out ${blackoutDay.date}\n`);

  seeded = true;
  for (const [slot, status] of [
    [bookedSlot, 'booked'],
    [horizonSlot, 'booked'],
    [cancelledSlot, 'cancelled'],
  ] as const) {
    await sql`
      INSERT INTO appointments (name, phone, service, address, payment_route, slot_start, status, source, admin_notes)
      VALUES ('BK-01 test', '0000000000', 'verification', 'n/a', 'private', ${slot}, ${status}, 'admin', ${MARKER})
    `;
  }
  await sql`
    INSERT INTO blackout_dates (day, reason) VALUES (${blackoutDay.date}, ${MARKER})
  `;

  const after = await fetchAvailability();
  check(after.res.status === 200, `expected 200 after seeding, got ${after.res.status}`);
  check(
    after.res.headers.get('Cache-Control') === 'no-store',
    `Cache-Control must be no-store, got ${after.res.headers.get('Cache-Control')}`,
  );

  const slotsOn = (date: string) =>
    (after.body.dates.find((d: any) => d.date === date)?.slots ?? []).map((s: any) => s.start);

  check(!slotsOn(nearDay.date).includes(bookedSlot), 'a booked slot must disappear');
  check(
    slotsOn(nearDay.date).includes(cancelledSlot),
    'a cancelled booking must leave its slot available',
  );
  check(
    !slotsOn(horizonDay.date).includes(horizonSlot),
    'a booking on the last offered afternoon must disappear (query bounds)',
  );
  check(slotsOn(blackoutDay.date).length === 0, 'a blacked-out day must offer nothing');
  check(
    after.body.dates.some((d: any) => d.date === blackoutDay.date),
    'a blacked-out day must still appear in the window',
  );
  check(
    !JSON.stringify(after.body).includes(MARKER),
    'no seeded text may leak into the public response',
  );
  console.log('  checks run against seeded rows');
} finally {
  // Swallow a cleanup failure here so the survival re-check below still runs
  // and reports — cleanup() has already printed the manual DELETEs.
  const removed = await cleanup().catch(() => ({ appointments: -1, blackouts: -1 }));
  seeded = false;
  console.log(
    `\n  cleaned up ${removed.appointments} appointment row(s), ${removed.blackouts} blackout row(s)`,
  );
  const left = (await sql`
    SELECT
      (SELECT COUNT(*) FROM appointments   WHERE admin_notes = ${MARKER}) AS appointments,
      (SELECT COUNT(*) FROM blackout_dates WHERE reason      = ${MARKER}) AS blackouts
  `) as { appointments: string; blackouts: string }[];
  const stillThere = Number(left[0].appointments) + Number(left[0].blackouts);
  if (stillThere > 0) {
    console.error(`  ✗ ${stillThere} seeded row(s) survived cleanup — remove them manually.`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Failure path. Runs after cleanup so the deletes above used the real database.
// A caught-and-swallowed error returning an empty calendar would look identical
// to "fully booked" and quietly turn away every visitor, so this must be a 500.
// ---------------------------------------------------------------------------
{
  const real = process.env.DATABASE_URL;
  // A Neon-shaped host that does not resolve, so this is a genuine fetch
  // rejection. A bare 127.0.0.1 URL would fail earlier, inside the driver's
  // own URL construction, and never exercise the network path at all.
  process.env.DATABASE_URL =
    'postgresql://u:p@ep-does-not-exist-00000000.us-east-2.aws.neon.tech/nope';
  try {
    const res = await GET({} as never);
    const body = (await res.json()) as any;
    check(res.status === 500, `an unreachable database must answer 500, got ${res.status}`);
    check(typeof body.error === 'string', 'the 500 must carry an error message');
    check(!('dates' in body), 'the 500 must not carry a calendar');
    console.log(`\n  unreachable database → ${res.status} ${JSON.stringify(body)}`);
  } finally {
    process.env.DATABASE_URL = real;
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ Endpoint round-trip passed.');
