// DB-backed checks for the booking commit endpoint.
//
//   npm run verify:booking:commit
//
// Runs against the Neon DEV BRANCH only (DATABASE_URL_DEV). It creates real
// appointments in parallel, which is why it must never see production.
//
// The guard order below is load-bearing: getDb() reads process.env.DATABASE_URL
// and nothing else, so refusing to run without DATABASE_URL_DEV protects
// nothing on its own — the variable has to be SWAPPED, and the route module
// imported only afterwards, or a static import binds the production connection
// before the swap happens.
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

const hostOf = (url: string) => url.replace(/.*@([^/]+)\/.*/, '$1');

// 1. Refuse without the dev branch.
const DEV_URL = process.env.DATABASE_URL_DEV;
if (!DEV_URL) {
  console.error('DATABASE_URL_DEV is not set. This script creates real bookings and must');
  console.error('never run against production. See docs/booking/tickets/BK-02.md step zero.');
  process.exit(1);
}

// 2. Assert it is not production.
const PROD_URL = process.env.DATABASE_URL ?? '';
if (PROD_URL && hostOf(PROD_URL) === hostOf(DEV_URL)) {
  console.error(`DATABASE_URL_DEV points at the production host (${hostOf(DEV_URL)}). Refusing.`);
  process.exit(1);
}

// 3. Swap, so the route's getDb() resolves to the branch.
process.env.DATABASE_URL = DEV_URL;

// 4. Only now import the route and anything that reaches the database.
const { POST, insertBooking } = await import('../src/pages/api/booking/create');
const { issueDraftToken } = await import('../src/lib/draft-token');
const { BOOKING_RATE_LIMIT_PER_HOUR, DRAFT_TOKEN_TTL_HOURS } = await import(
  '../src/lib/booking-config'
);
const { bookableDateRange, slotStartsForDate, isClosedWeekday, isWithinBookingWindow, addDays } =
  await import('../src/lib/booking-time');

const sql = neon(DEV_URL);
const NAME = 'BK-02 verify';
const HAMMER_N = 12;

console.log(`Booking commit checks against ${hostOf(DEV_URL)} (dev branch)\n`);

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

let seeded = false;
const draftIds: string[] = [];
/** Cases that could not be constructed on this run. Reported at the end, never swallowed. */
const skipped: string[] = [];

async function cleanup(attempts = 3): Promise<number> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // appointment_files first would orphan nothing (ON DELETE CASCADE covers
      // claimed rows), but unclaimed rows have no appointment to cascade from.
      const f = (await sql`
        DELETE FROM appointment_files WHERE draft_id = ANY(${draftIds}::uuid[]) RETURNING id
      `) as { id: number }[];
      const a = (await sql`
        DELETE FROM appointments WHERE name LIKE ${NAME + '%'} RETURNING id
      `) as { id: number }[];
      const r = (await sql`
        DELETE FROM rate_limits WHERE bucket LIKE 'booking-create:bk02-%' RETURNING bucket
      `) as { bucket: string }[];
      return a.length + f.length + r.length;
    } catch (err) {
      lastErr = err;
      console.error(`  cleanup attempt ${i + 1} failed, retrying:`, err);
    }
  }
  console.error('  ✗ CLEANUP FAILED on the dev branch. Remove by hand:');
  console.error(`      DELETE FROM appointments WHERE name LIKE '${NAME}%';`);
  throw lastErr;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (seeded) {
      console.error(`\n${signal} received — cleaning up first.`);
      await cleanup().catch(() => {});
    }
    process.exit(130);
  });
}

// --- helpers ---------------------------------------------------------------

let ipCounter = 0;
/** A distinct IP per logical test: one shared bucket would turn expected 409s into 429s. */
function freshIp() {
  return `bk02-${++ipCounter}`;
}

function payload(slot: Date, overrides: Record<string, unknown> = {}) {
  return {
    name: `${NAME} ${ipCounter}`,
    phone: '7805550134',
    email: 'verify@example.com',
    service: 'water',
    address: '1 Test Way',
    city: 'Edmonton',
    payment_route: 'private',
    slot_start: slot.toISOString(),
    ...overrides,
  };
}

async function post(body: unknown, ip = freshIp()) {
  const request = new Request('http://localhost/api/booking/create/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await POST({ request, clientAddress: ip } as never);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null; the raw text is still scanned for leaks */
  }
  bodies.push(text);
  return { status: res.status, body: json, text, headers: res.headers };
}

/** Every response body seen, scanned at the end for leaked insurance identifiers. */
const bodies: string[] = [];

async function countBookings(slot: Date) {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments
    WHERE slot_start = ${slot.toISOString()} AND status <> 'cancelled'
  `) as { n: number }[];
  return rows[0].n;
}

/** Free grid slots inside the window, far enough out to dodge the notice cutoff. */
function freeSlots(now = new Date()): Date[] {
  const out: Date[] = [];
  for (const date of bookableDateRange(now)) {
    if (isClosedWeekday(date)) continue;
    for (const s of slotStartsForDate(date)) {
      if (isWithinBookingWindow(s, now)) out.push(s);
    }
  }
  return out;
}

const slots = freeSlots();
if (slots.length < 10) {
  console.error('Not enough free slots in the window to run these checks.');
  process.exit(1);
}
let slotCursor = 0;
const nextSlot = () => slots[slotCursor++];

// ---------------------------------------------------------------------------
try {
  const existing = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments WHERE name LIKE ${NAME + '%'}
  `) as { n: number }[];
  check(existing[0].n === 0, `dev branch already holds ${existing[0].n} leftover verify rows`);
  seeded = true;

  // -------------------------------------------------------------------------
  console.log('Raw CTE under real contention');
  // -------------------------------------------------------------------------
  // The primary conflict assertion. The endpoint-level hammer below can pass
  // without ever reaching ON CONFLICT — if the requests happen to serialize,
  // the availability precheck produces every rejection and the conflict path
  // runs zero times. Racing the statement itself cannot be dodged that way.
  {
    const slot = nextSlot();
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: HAMMER_N }, (_, i) =>
        insertBooking(
          sql,
          {
            name: `${NAME} cte ${i}`,
            phone: '7805550134',
            email: null,
            service: 'water',
            description: null,
            address: '1 Test Way',
            city: 'Edmonton',
            postal_code: null,
            payment_route: 'private',
            insurer_name: null,
            policy_number: null,
            claim_number: null,
            slotStart: slot,
            smsConsent: false,
            draftToken: null,
          },
          null,
          now,
        ).then(
          (r) => ({ ok: true as const, r }),
          (e) => ({ ok: false as const, e }),
        ),
      ),
    );

    const threw = results.filter((r) => !r.ok);
    const won = results.filter((r) => r.ok && r.r !== null);
    const lost = results.filter((r) => r.ok && r.r === null);

    check(threw.length === 0, `no execution may throw (${threw.length} did)`);
    check(won.length === 1, `exactly one execution must insert (got ${won.length})`);
    check(lost.length === HAMMER_N - 1, `the rest must return null (got ${lost.length})`);
    check((await countBookings(slot)) === 1, 'exactly one row must exist for the slot');
    console.log(`  ${HAMMER_N} parallel executions → 1 insert, ${lost.length} clean conflicts`);
  }

  // -------------------------------------------------------------------------
  console.log('\nEndpoint hammer (status mapping)');
  // -------------------------------------------------------------------------
  {
    const slot = nextSlot();
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: HAMMER_N }, () => post(payload(slot), ip)),
    );
    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);

    check(created.length === 1, `exactly one 201 (got ${created.length})`);
    check(
      conflicted.length === HAMMER_N - 1,
      `the rest must be 409 (got ${conflicted.length}; statuses ${results.map((r) => r.status).join(',')})`,
    );
    check((await countBookings(slot)) === 1, 'exactly one row must exist for the slot');
    check(typeof created[0]?.body?.id === 'number', 'the 201 must carry a numeric id');
    check(typeof created[0]?.body?.slotLabel === 'string', 'the 201 must carry a slot label');
    check(conflicted[0]?.body?.code === 'slot_taken', 'a 409 must be machine-readable');
    console.log(`  ${HAMMER_N} parallel requests → 1×201, ${conflicted.length}×409, 1 row`);
  }

  // -------------------------------------------------------------------------
  console.log('\nRejections (AC3)');
  // -------------------------------------------------------------------------
  {
    const before = (await sql`SELECT COUNT(*)::int AS n FROM appointments`) as { n: number }[];
    const now = new Date();

    const offGrid = new Date(nextSlot().getTime() + 7 * 60 * 1000);
    const past = slotStartsForDate(addDays(bookableDateRange(now)[0], -3))[0];
    const tooSoon = slots.find((s) => s.getTime() < now.getTime() + 4 * 60 * 60 * 1000);
    const beyondHorizon = slotStartsForDate(addDays(bookableDateRange(now).at(-1)!, 2))[0];
    const friday = (() => {
      for (const d of bookableDateRange(now)) if (isClosedWeekday(d)) return slotStartsForDate(d)[0];
      return null;
    })();

    const cases: [string, Date | null | undefined][] = [
      ['off-grid', offGrid],
      ['in the past', past],
      ['inside the notice window', tooSoon],
      ['past the horizon', beyondHorizon],
      ['on a Friday', friday],
    ];

    for (const [label, slot] of cases) {
      if (!slot) {
        // Loud, not silent. "Inside the notice window" only exists between
        // roughly 07:30 and 15:30 local, so this case is unconstructible at
        // other times of day. The boundary itself is asserted exactly, on both
        // sides, by verify:availability through the same isSlotBookable
        // predicate this endpoint calls — but a quiet skip would read as
        // coverage, which is how a check rots into decoration.
        console.log(`  ⚠ COVERAGE GAP: "${label}" not constructible right now — skipped.`);
        skipped.push(label);
        continue;
      }
      const r = await post(payload(slot));
      check(r.status === 422 || r.status === 409, `${label} must be rejected (got ${r.status})`);
    }

    // A blackout day, seeded and removed here.
    const blackoutSlot = nextSlot();
    const blackoutDay = blackoutSlot.toISOString().slice(0, 10);
    await sql`INSERT INTO blackout_dates (day, reason) VALUES (${blackoutDay}, ${NAME})
              ON CONFLICT (day) DO NOTHING`;
    const bo = await post(payload(blackoutSlot));
    await sql`DELETE FROM blackout_dates WHERE reason = ${NAME}`;
    check(bo.status === 409, `a blackout day must be rejected (got ${bo.status})`);

    // An already-booked slot, via a fresh booking.
    const taken = nextSlot();
    check((await post(payload(taken))).status === 201, 'setup booking must succeed');
    check((await post(payload(taken))).status === 409, 'an already-booked slot must 409');

    const after = (await sql`SELECT COUNT(*)::int AS n FROM appointments`) as { n: number }[];
    check(
      after[0].n === before[0].n + 1,
      `only the setup booking may have been created (${before[0].n} → ${after[0].n})`,
    );
    console.log('  every rejection case created nothing');
  }

  // -------------------------------------------------------------------------
  console.log('\nFile claim');
  // -------------------------------------------------------------------------
  {
    const mine = await issueDraftToken();
    const foreign = await issueDraftToken();
    draftIds.push(mine.draftId, foreign.draftId);

    for (const [draftId, n] of [
      [mine.draftId, 2],
      [foreign.draftId, 1],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await sql`
          INSERT INTO appointment_files (draft_id, pathname, content_type, upload_state)
          VALUES (${draftId}::uuid, ${`bk02/${draftId}/${i}.jpg`}, 'image/jpeg', 'pending')
        `;
      }
    }

    const slot = nextSlot();
    const r = await post(payload(slot, { draft_token: mine.token }));
    check(r.status === 201, `booking with uploads must succeed (got ${r.status})`);
    check(r.body?.filesAttached === 2, `both pending files must be claimed (got ${r.body?.filesAttached})`);
    check(typeof r.body?.filesAttached === 'number', 'the claimed count must be a number, not a string');

    const claimed = (await sql`
      SELECT appointment_id, upload_state FROM appointment_files WHERE draft_id = ${mine.draftId}::uuid
    `) as { appointment_id: number | null; upload_state: string }[];
    check(claimed.every((f) => f.appointment_id === r.body.id), 'claimed files must point at the booking');
    check(claimed.every((f) => f.upload_state === 'pending'), 'upload_state must be left alone');

    const untouched = (await sql`
      SELECT appointment_id FROM appointment_files WHERE draft_id = ${foreign.draftId}::uuid
    `) as { appointment_id: number | null }[];
    check(
      untouched.every((f) => f.appointment_id === null),
      "another draft's files must not be claimed",
    );
    console.log('  2 pending files claimed, foreign draft untouched');
  }

  // -------------------------------------------------------------------------
  console.log('\nDraft token integrity');
  // -------------------------------------------------------------------------
  {
    const good = await issueDraftToken();
    const forged = good.token.slice(0, -1) + (good.token.endsWith('a') ? 'b' : 'a');
    const expired = await issueDraftToken(
      new Date(Date.now() - (DRAFT_TOKEN_TTL_HOURS + 1) * 60 * 60 * 1000),
    );

    const f = await post(payload(nextSlot(), { draft_token: forged }));
    check(f.status === 400, `a forged token must 400 (got ${f.status})`);
    const e = await post(payload(nextSlot(), { draft_token: expired.token }));
    check(e.status === 400, `an expired token must 400 (got ${e.status})`);

    // A caller must not be able to name a draft id directly.
    const bare = await post(payload(nextSlot(), { draft_id: good.draftId }));
    check(bare.status === 422, `a bare draft_id must be refused (got ${bare.status})`);

    const none = await post(payload(nextSlot()));
    check(none.status === 201, 'a booking with no token must still succeed');
    check(none.body?.filesAttached === 0, 'a booking with no token must claim no files');
    console.log('  forged and expired rejected, bare draft_id refused, tokenless booking allowed');
  }

  // -------------------------------------------------------------------------
  console.log('\nInsurance fields and consent, read back from the row');
  // -------------------------------------------------------------------------
  {
    const insuredSlot = nextSlot();
    const ins = await post(
      payload(insuredSlot, {
        payment_route: 'insurance',
        insurer_name: 'Acme Mutual',
        policy_number: 'POL-SECRET-1',
        claim_number: 'CLM-SECRET-1',
        sms_consent: true,
      }),
    );
    check(ins.status === 201, `insurance booking must succeed (got ${ins.status})`);

    const insRow = (await sql`
      SELECT policy_number, claim_number, insurer_name, sms_consent_at, source, pipeline_stage, status
      FROM appointments WHERE id = ${ins.body.id}
    `) as any[];
    check(insRow[0].policy_number === 'POL-SECRET-1', 'policy number must persist');
    check(insRow[0].claim_number === 'CLM-SECRET-1', 'claim number must persist');
    check(insRow[0].sms_consent_at !== null, 'consent must be stamped when given');
    check(insRow[0].source === 'web', "source must be 'web'");
    check(insRow[0].pipeline_stage === 'assessment', 'pipeline stage must default to assessment');
    check(insRow[0].status === 'booked', 'status must default to booked');

    const privSlot = nextSlot();
    const priv = await post(
      payload(privSlot, {
        payment_route: 'private',
        insurer_name: 'Acme',
        policy_number: 'POL-SECRET-2',
        claim_number: 'CLM-SECRET-2',
      }),
    );
    check(priv.status === 201, 'private booking must succeed');
    const privRow = (await sql`
      SELECT policy_number, claim_number, insurer_name, sms_consent_at
      FROM appointments WHERE id = ${priv.body.id}
    `) as any[];
    check(privRow[0].policy_number === null, 'policy number must not reach a private row');
    check(privRow[0].claim_number === null, 'claim number must not reach a private row');
    check(privRow[0].insurer_name === null, 'insurer must not reach a private row');
    check(privRow[0].sms_consent_at === null, 'consent must be null when not given');
    console.log('  stored on insurance, absent on private, consent stamped only when given');
  }

  // -------------------------------------------------------------------------
  console.log('\nMalformed input');
  // -------------------------------------------------------------------------
  {
    const bad = await post('{not json');
    check(bad.status === 422, `malformed JSON must 422, not 500 (got ${bad.status})`);
    const wrong = await post({ name: 'only a name' });
    check(wrong.status === 422, `an incomplete payload must 422 (got ${wrong.status})`);
    check(Array.isArray(wrong.body?.fields), 'a 422 must list the offending fields');
    console.log('  malformed and incomplete bodies rejected without a 500');
  }

  // -------------------------------------------------------------------------
  console.log('\nDatabase failure (AC10)');
  // -------------------------------------------------------------------------
  {
    const before = (await sql`SELECT COUNT(*)::int AS n FROM appointments`) as { n: number }[];
    const real = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      'postgresql://u:p@ep-does-not-exist-00000000.us-east-2.aws.neon.tech/nope';
    let r;
    try {
      r = await post(payload(nextSlot()));
    } finally {
      process.env.DATABASE_URL = real;
    }
    check(r.status === 500, `an unreachable database must 500 (got ${r.status})`);
    check(!('id' in (r.body ?? {})), 'a 500 must not look like a created booking');
    const after = (await sql`SELECT COUNT(*)::int AS n FROM appointments`) as { n: number }[];
    check(after[0].n === before[0].n, 'a failed commit must create nothing');
    console.log('  unreachable database → 500, nothing created');
  }

  // -------------------------------------------------------------------------
  console.log('\nNo insurance identifier leaks (AC11)');
  // -------------------------------------------------------------------------
  {
    const all = bodies.join('\n');
    for (const secret of ['POL-SECRET-1', 'CLM-SECRET-1', 'POL-SECRET-2', 'CLM-SECRET-2']) {
      check(!all.includes(secret), `${secret} must never appear in a response body`);
    }
    console.log(`  scanned ${bodies.length} response bodies, no identifiers echoed`);
  }

  // -------------------------------------------------------------------------
  console.log('\nRate limiting (AC9) — last, on a throwaway IP');
  // -------------------------------------------------------------------------
  {
    const ip = freshIp();
    let limited = null;
    for (let i = 0; i <= BOOKING_RATE_LIMIT_PER_HOUR + 1; i++) {
      // Deliberately invalid, so the limiter is reached without booking anything.
      const r = await post({ nope: true }, ip);
      if (r.status === 429) {
        limited = r;
        break;
      }
    }
    check(limited !== null, `expected a 429 within ${BOOKING_RATE_LIMIT_PER_HOUR + 2} requests`);
    check(
      limited !== null && Number(limited.headers.get('Retry-After')) > 0,
      'a 429 must carry a positive Retry-After',
    );
    console.log(`  429 after ${BOOKING_RATE_LIMIT_PER_HOUR} requests, Retry-After present`);
  }
} finally {
  const removed = await cleanup().catch(() => -1);
  seeded = false;
  console.log(`\n  cleaned up ${removed} row(s)`);
  const left = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments WHERE name LIKE ${NAME + '%'}
  `) as { n: number }[];
  if (left[0].n > 0) {
    console.error(`  ✗ ${left[0].n} verify row(s) survived cleanup.`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
if (skipped.length > 0) {
  console.log(`\n⚠ Passed, but ${skipped.length} case(s) were not constructible: ${skipped.join(', ')}.`);
}
console.log('\n✓ All booking commit checks passed.');
