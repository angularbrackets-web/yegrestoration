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

// 2. Assert it is not production. Refusing when DATABASE_URL is ABSENT is the
//    point: on a fresh clone, in CI, or with a `vercel env pull` that blanked
//    the value, a silent skip would leave a copy-pasted production string in
//    DATABASE_URL_DEV unchallenged, and the hammer would run 12 parallel real
//    bookings against the live table. A safety check must not fail open exactly
//    when it has least information.
const PROD_URL = process.env.DATABASE_URL ?? '';
if (!PROD_URL) {
  console.error('DATABASE_URL is not set, so DATABASE_URL_DEV cannot be proven different from');
  console.error('production. Refusing to run. Pull the production env first.');
  process.exit(1);
}
if (hostOf(PROD_URL) === hostOf(DEV_URL)) {
  console.error(`DATABASE_URL_DEV points at the production host (${hostOf(DEV_URL)}). Refusing.`);
  process.exit(1);
}

// 3. Swap, so the route's getDb() resolves to the branch.
process.env.DATABASE_URL = DEV_URL;

// 4. Only now import the route and anything that reaches the database.
const { POST } = await import('../src/pages/api/booking/create');
const { insertBooking } = await import('../src/lib/booking-commit');
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
      // Match on pathname as well as this run's draft ids: a crashed run's
      // files are unreachable by id, and an unclaimed pile would otherwise
      // accumulate on the branch forever.
      const f = (await sql`
        DELETE FROM appointment_files
        WHERE draft_id = ANY(${draftIds}::uuid[]) OR pathname LIKE 'bk02/%'
        RETURNING id
      `) as { id: number }[];
      const a = (await sql`
        DELETE FROM appointments WHERE name LIKE ${NAME + '%'} RETURNING id
      `) as { id: number }[];
      const r = (await sql`
        DELETE FROM rate_limits WHERE bucket LIKE 'booking-create:bk02-%' RETURNING bucket
      `) as { bucket: string }[];
      // Blackout rows too: one surviving here suppresses a whole day of slots
      // for every later run, quietly.
      const b = (await sql`
        DELETE FROM blackout_dates WHERE reason = ${NAME} RETURNING day
      `) as { day: string }[];
      return a.length + f.length + r.length + b.length;
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

/**
 * A pool of draft tokens, each already holding one unclaimed
 * `appointment_files` row on the dev branch.
 *
 * BK-22 turned "has at least one file" into a precondition of booking at all,
 * so the default payload has to carry one — otherwise 13 of the 16 `post(...)`
 * sites below flip to a 422 on `files` and quietly stop testing the thing they
 * are named after. The most expensive of those is the endpoint hammer: twelve
 * racers that all 422 would fail `conflicted.length === HAMMER_N - 1` outright,
 * and **the only endpoint-level test of the double-booking guard** would be the
 * thing that got "fixed".
 *
 * Pre-seeded rather than minted per call so `payload()` can stay synchronous:
 * it is called inside `Array.from(...)` and inside loops, and making it async
 * would rewrite every call site to buy nothing. Sized well ahead of real
 * consumption; `nextDraft` throws a legible error rather than handing back
 * `undefined` if that estimate is ever wrong.
 */
const DRAFT_POOL_SIZE = 96;
const draftPool: { token: string; draftId: string }[] = [];
let draftCursor = 0;

function nextDraft(): { token: string; draftId: string } {
  const draft = draftPool[draftCursor++];
  if (!draft) {
    throw new Error(`Ran out of seeded drafts after ${draftCursor - 1}; raise DRAFT_POOL_SIZE.`);
  }
  return draft;
}

async function seedDraftPool() {
  const ids: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < DRAFT_POOL_SIZE; i++) {
    const d = await issueDraftToken();
    draftPool.push(d);
    draftIds.push(d.draftId);
    ids.push(d.draftId);
    paths.push(`bk02/pool/${d.draftId}.jpg`);
  }
  // One statement, not 96 round trips. The `bk02/` pathname prefix means
  // cleanup reaches these even if the run dies before `draftIds` is read.
  await sql`
    INSERT INTO appointment_files (draft_id, pathname, content_type, upload_state)
    SELECT t.id::uuid, t.path, 'image/jpeg', 'pending'
    FROM unnest(${ids}::text[], ${paths}::text[]) AS t(id, path)
  `;
}

/** Everything except the draft token, so the two payload builders cannot drift. */
function baseFields(slot: Date, overrides: Record<string, unknown> = {}) {
  return {
    name: `${NAME} ${ipCounter}`,
    phone: '7805550134',
    email: 'verify@example.com',
    service: 'water',
    address: '1 Test Way',
    city: 'Edmonton',
    payment_route: 'private',
    slot_start: slot.toISOString(),
    // BK-27: the public door refuses a booking without this, so it belongs in
    // the SHARED builder rather than in the arms that happen to think about it.
    // Putting it in `payload()` alone would 422 every `payloadWithoutFiles`
    // call for the wrong reason — the file arms would still be red, still
    // "pass", and would have stopped testing files at all. Same shape of trap
    // as BK-22's draft-token blocker, one layer down.
    terms_ack: true,
    // BK-31, in the SHARED builder for exactly the reason above: the public
    // door refuses a booking without a tier, so leaving it to individual arms
    // would 422 the file and concurrency arms for a reason those arms are not
    // about — and they would keep "passing" while testing nothing.
    assessment_tier: 'standard',
    ...overrides,
  };
}

/**
 * The default: a payload that can actually be booked, which since BK-22 means
 * one carrying a draft token whose draft holds a file. `email` has always been
 * here, so the email half of BK-22 breaks nothing in this script; the file half
 * is what every call site below depends on.
 */
function payload(slot: Date, overrides: Record<string, unknown> = {}) {
  return { ...baseFields(slot), draft_token: nextDraft().token, ...overrides };
}

/**
 * Deliberately tokenless — BK-22's AC2. Kept as a named builder rather than
 * `payload(slot, { draft_token: undefined })` because that spelling depends on
 * `JSON.stringify` dropping undefined keys, which is a fact about the
 * serializer rather than a statement of intent.
 */
function payloadWithoutFiles(slot: Date, overrides: Record<string, unknown> = {}) {
  return baseFields(slot, overrides);
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

/**
 * Every `nextSlot()` call below consumes one. Keep this ahead of the real
 * count — it is a precondition check, so being short here aborts with a clear
 * message instead of throwing out of `nextSlot()` halfway through a run.
 * Raised from 24 by BK-22, which added eight file-requirement cases.
 */
const SLOTS_NEEDED = 40;

const slots = freeSlots();
if (slots.length < SLOTS_NEEDED) {
  console.error(`Need ${SLOTS_NEEDED} free slots to run these checks, found ${slots.length}.`);
  process.exit(1);
}
let slotCursor = 0;
function nextSlot(): Date {
  const slot = slots[slotCursor++];
  // An undefined here would surface as an opaque TypeError inside payload().
  if (!slot) {
    throw new Error(
      `Ran out of free slots after ${slotCursor - 1} of ${slots.length}. ` +
        'Raising SLOTS_NEEDED will NOT help — that is a precondition check, not the ' +
        'supply. The supply is the 14-day booking window minus Fridays, which is ~60 ' +
        'slots, and this script now consumes nearly all of them. A new arm that needs ' +
        'a bookable slot has to use `recycleSlot()` below, or free one.',
    );
  }
  return slot;
}

/**
 * A slot that is genuinely free RIGHT NOW, asked of the database rather than of
 * the cursor.
 *
 * `nextSlot()` hands out one slot per CALL, but most calls belong to arms that
 * deliberately fail — a 422 or a 409 books nothing and leaves its slot free
 * forever. By the end of a run the cursor has walked off the end of a pool that
 * is still largely unbooked, and the script aborts with slots to spare. This
 * closes that gap for arms added after the cursor is exhausted.
 *
 * Deliberately NOT a replacement for `nextSlot()`: the concurrency hammer needs
 * a slot nothing else will touch, and re-querying mid-run would hand it one
 * another arm is about to take. This is for the sequential arms at the end.
 */
async function recycleSlot(): Promise<Date> {
  const taken = (await sql`
    SELECT slot_start FROM appointments WHERE status <> 'cancelled'
  `) as { slot_start: Date }[];
  const busy = new Set(taken.map((r) => new Date(r.slot_start).getTime()));
  const free = freeSlots().find((s) => !busy.has(s.getTime()));
  if (!free) throw new Error('No free slot remains in the booking window at all.');
  return free;
}

// ---------------------------------------------------------------------------
try {
  // A leftover row from a crashed run occupies a slot and makes every racer
  // lose, which cascades into a page of unrelated failures. Sweep first, and
  // abort rather than continue if the sweep does not clear it — downstream
  // results would be noise. (Cleanup does not run on SIGPIPE, e.g. when the
  // output is piped through `head`, so leftovers are a real occurrence.)
  const stale = await cleanup().catch(() => -1);
  if (stale > 0) console.log(`  swept ${stale} leftover row(s) from an earlier run\n`);
  const existing = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments WHERE name LIKE ${NAME + '%'}
  `) as { n: number }[];
  if (existing[0].n !== 0) {
    console.error(`Dev branch still holds ${existing[0].n} verify row(s) after sweeping. Aborting.`);
    process.exit(1);
  }
  seeded = true;

  // Before anything posts: since BK-22 a payload without a file cannot book, so
  // the pool has to exist before the first `payload()` call rather than being
  // filled lazily.
  await seedDraftPool();
  console.log(`  seeded ${DRAFT_POOL_SIZE} drafts, one file each\n`);

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

    // Each racer gets its own draft with one file, so the losers' claim arm is
    // exercised too: a loser must leave its own file unclaimed rather than
    // writing over the winner's. Without this the EXISTS guard in the CTE has
    // no test that would go red if it were removed.
    const racerDrafts: string[] = [];
    for (let i = 0; i < HAMMER_N; i++) {
      const d = await issueDraftToken();
      racerDrafts.push(d.draftId);
      draftIds.push(d.draftId);
      await sql`
        INSERT INTO appointment_files (draft_id, pathname, content_type, upload_state)
        VALUES (${d.draftId}::uuid, ${`bk02/cte/${d.draftId}.jpg`}, 'image/jpeg', 'pending')
      `;
    }

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
            // These racers go through `insertBooking` directly, below the
            // parser, so the value here is the office door's: an admin entry
            // acknowledges nothing (BK-27). The stamp assertions live in the
            // endpoint arms, which is where the public requirement is enforced.
            termsAcked: false,
            assessmentTier: null,
            draftToken: null,
          },
          racerDrafts[i],
          now,
        ).then(
          (r) => ({ ok: true as const, r, i }),
          (e) => ({ ok: false as const, e, i }),
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

    // The winner claims its own file; every loser leaves its file alone.
    const winner = won[0] as { ok: true; r: { id: number; files: number }; i: number } | undefined;
    check(winner?.r.files === 1, `the winner must claim its one file (got ${winner?.r.files})`);
    const claimedRows = (await sql`
      SELECT draft_id::text AS draft_id, appointment_id
      FROM appointment_files WHERE draft_id = ANY(${racerDrafts}::uuid[])
    `) as { draft_id: string; appointment_id: number | null }[];
    const attached = claimedRows.filter((r) => r.appointment_id !== null);
    check(attached.length === 1, `exactly one racer's file may be claimed (got ${attached.length})`);
    check(
      winner !== undefined && attached[0]?.draft_id === racerDrafts[winner.i],
      "the claimed file must belong to the winner's own draft",
    );
    console.log(
      `  ${HAMMER_N} parallel executions → 1 insert, ${lost.length} clean conflicts, only the winner's file claimed`,
    );
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
    // Losers may fail either at the precheck (slot_unavailable) or at the index
    // (slot_taken) depending on interleaving — both are 409, both must be
    // machine-readable so BK-03 never has to parse prose.
    check(
      conflicted.every((r) => ['slot_taken', 'slot_unavailable'].includes(r.body?.code)),
      'every 409 must carry a known code',
    );
    check(
      conflicted.some((r) => r.body?.code === 'slot_taken'),
      'at least one loser must reach the index rather than the precheck',
    );
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
    // Build this from the raw grid, NOT from `slots`. `freeSlots()` keeps only
    // slots satisfying isWithinBookingWindow (s >= now + 4h), so searching it
    // for s < now + 4h is the negation of the filter that built it — it could
    // only ever hit on the sub-second drift between the two `new Date()` calls.
    // Measured across 2304 clock positions, it hit 35 times, all inside a
    // ~2-second window. That is not a time-of-day limitation; it is a check
    // that never runs.
    const tooSoon = slotStartsForDate(bookableDateRange(now)[0]).find(
      (s) => s.getTime() > now.getTime() && s.getTime() < now.getTime() + 4 * 60 * 60 * 1000,
    );
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
        // Loud, not silent. "Inside the notice window" needs a grid slot that
        // is both future and less than 4h away, which genuinely does not exist
        // outside roughly 07:30–15:30 local. The boundary itself is asserted
        // exactly, on both sides, by verify:availability through the same
        // isSlotBookable predicate this endpoint calls — but a quiet skip would
        // read as coverage, which is how a check rots into decoration.
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
    const retaken = await post(payload(taken));
    check(retaken.status === 409, 'an already-booked slot must 409');
    // Uncontended, so this must be the precheck's code, not the index's — the
    // two are different situations and BK-03 acts on them differently.
    check(
      retaken.body?.code === 'slot_unavailable',
      `an uncontended repeat must read slot_unavailable (got ${retaken.body?.code})`,
    );

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
  console.log('\nBK-22 — a public booking must carry a file (AC2, AC3)');
  // -------------------------------------------------------------------------
  {
    // A row to claim against, so "already claimed" below is genuinely claimed
    // by a real appointment rather than by a made-up id.
    const donor = await post(payload(nextSlot()));
    check(donor.status === 201, `donor booking must succeed (got ${donor.status})`);
    const donorId = donor.body.id as number;

    const seedFiles = async (
      draftId: string,
      rows: { state: 'pending' | 'uploaded'; claimedBy: number | null }[],
    ) => {
      for (const [i, row] of rows.entries()) {
        await sql`
          INSERT INTO appointment_files (draft_id, pathname, content_type, upload_state, appointment_id)
          VALUES (
            ${draftId}::uuid, ${`bk02/bk22/${draftId}-${i}.jpg`}, 'image/jpeg',
            ${row.state}, ${row.claimedBy}
          )
        `;
      }
    };

    // AC2 — no token at all. The common case: the island only sends a token
    // once it has an attachment, so "booked without photos" arrives as this.
    const noToken = await post(payloadWithoutFiles(nextSlot()));
    check(noToken.status === 422, `no draft token must 422 (got ${noToken.status})`);
    check(
      noToken.body?.fields?.[0]?.field === 'files',
      'the rejection must name `files`, or the island cannot route it to step 3',
    );

    // AC1, at the endpoint rather than at the parser.
    //
    // `verify:booking:payload` proves the *rule* — `entry: 'public'` rejects an
    // absent email. Only this proves the ROUTE asks for that rule: change one
    // word at `create.ts`'s `parseBookingPayload` call and the parser stays
    // perfect, every payload assertion stays green, and the public form quietly
    // stops requiring an email. There is no other script that reads that line.
    const withoutEmail = payload(nextSlot()) as Record<string, unknown>;
    delete withoutEmail.email;
    const noEmail = await post(withoutEmail);
    check(noEmail.status === 422, `a public POST with no email must 422 (got ${noEmail.status})`);
    check(
      Array.isArray(noEmail.body?.fields) &&
        noEmail.body.fields.some((f: { field: string }) => f.field === 'email'),
      'and it must name the `email` field',
    );

    // AC3 — a *valid* token whose draft holds nothing. The token proves a
    // session was opened, never that a photo exists, and these are exactly the
    // visitors who opened the picker and changed their mind.
    const emptyDraft = await issueDraftToken();
    draftIds.push(emptyDraft.draftId);
    const empty = await post(
      payloadWithoutFiles(nextSlot(), { draft_token: emptyDraft.token }),
    );
    check(empty.status === 422, `a token with no files must 422 (got ${empty.status})`);

    // AC3 — `upload_state` must NOT be part of the rule. The row is written at
    // token-mint time, before the bytes; `onUploadCompleted` never fires on
    // localhost and lags in production. Gating on 'uploaded' would make every
    // dev booking impossible and would reject real customers on webhook lag.
    for (const state of ['pending', 'uploaded'] as const) {
      const d = await issueDraftToken();
      draftIds.push(d.draftId);
      await seedFiles(d.draftId, [{ state, claimedBy: null }]);
      const r = await post(payloadWithoutFiles(nextSlot(), { draft_token: d.token }));
      check(r.status === 201, `one '${state}' file must be enough to book (got ${r.status})`);
      check(r.body?.filesAttached === 1, `and it must be claimed (got ${r.body?.filesAttached})`);
    }

    // ---- The fixture that manages the two-copies risk (Q1 / plan review S2).
    //
    // `countUnclaimedFiles` and `insertBooking`'s `claimed` CTE hold SEPARATE
    // hand-written copies of the same predicate, evaluated at different
    // instants against a table the cleanup cron also writes. Nothing makes them
    // agree — so these two arms are the tripwire, and they are a pair because
    // one alone cannot catch both copies:
    //
    //   * mixed draft (1 claimed + 1 unclaimed) → 201 claiming exactly 1.
    //     Drop `appointment_id IS NULL` from the CTE and it claims 2 → red.
    //     The COUNT's copy is invisible here: 1 and 2 both clear a >0 gate.
    //   * spent draft (1 claimed, 0 unclaimed) → 422.
    //     Drop `appointment_id IS NULL` from the COUNT and it sees 1, the gate
    //     opens, and a booking with no photo of its own commits → red.
    const mixed = await issueDraftToken();
    draftIds.push(mixed.draftId);
    await seedFiles(mixed.draftId, [
      { state: 'uploaded', claimedBy: donorId },
      { state: 'pending', claimedBy: null },
    ]);
    const mixedRes = await post(payloadWithoutFiles(nextSlot(), { draft_token: mixed.token }));
    check(mixedRes.status === 201, `a draft with one free file must book (got ${mixedRes.status})`);
    check(
      mixedRes.body?.filesAttached === 1,
      `only the unclaimed row may be claimed (got ${mixedRes.body?.filesAttached})`,
    );
    const donorStillOwns = (await sql`
      SELECT appointment_id FROM appointment_files
      WHERE draft_id = ${mixed.draftId}::uuid AND appointment_id = ${donorId}
    `) as { appointment_id: number }[];
    check(donorStillOwns.length === 1, "the donor's file must not be stolen by the new booking");

    const spent = await issueDraftToken();
    draftIds.push(spent.draftId);
    await seedFiles(spent.draftId, [{ state: 'uploaded', claimedBy: donorId }]);
    const spentRes = await post(payloadWithoutFiles(nextSlot(), { draft_token: spent.token }));
    check(
      spentRes.status === 422,
      `a draft whose only file is already claimed must 422 (got ${spentRes.status})`,
    );

    console.log('  no token / empty draft / spent draft refused; pending and uploaded both suffice');
  }

  // -------------------------------------------------------------------------
  console.log('\nAssessment fee terms (BK-27)');
  // -------------------------------------------------------------------------
  {
    // At the endpoint, not the parser, for the reason the email arm above
    // exists: `verify:booking:payload` proves the RULE, and only this proves
    // the route asks for it. Change `entry: 'public'` at `create.ts`'s
    // `parseBookingPayload` call and every parser assertion stays green while
    // the public form quietly stops requiring the acknowledgment.
    const withoutAck = payload(nextSlot()) as Record<string, unknown>;
    delete withoutAck.terms_ack;
    const noAck = await post(withoutAck);
    check(noAck.status === 422, `a public POST with no acknowledgment must 422 (got ${noAck.status})`);
    check(
      Array.isArray(noAck.body?.fields) &&
        noAck.body.fields.some((f: { field: string }) => f.field === 'terms_ack'),
      'and it must name the `terms_ack` field, or the island cannot route it to step 3',
    );

    const refused = await post(payload(nextSlot(), { terms_ack: false }));
    check(refused.status === 422, `an explicit refusal must 422 (got ${refused.status})`);

    // The happy path, and the stamp. `terms_acked_at` is the whole record of
    // the acknowledgment — a 201 that writes NULL is a booking nobody can prove
    // agreed to anything.
    const ackedSlot = nextSlot();
    const before = Date.now();
    const acked = await post(payload(ackedSlot, { name: `${NAME} terms` }));
    check(acked.status === 201, `an acknowledged booking must commit (got ${acked.status})`);
    const ackRow = (await sql`
      SELECT terms_acked_at, source FROM appointments WHERE id = ${acked.body?.id}
    `) as { terms_acked_at: Date | null; source: string }[];
    check(ackRow[0]?.terms_acked_at != null, 'and it must stamp terms_acked_at');
    if (ackRow[0]?.terms_acked_at) {
      // Bounded on both sides. `!= null` alone passes for a column defaulting
      // to some fixed instant, or to the epoch.
      const stamped = new Date(ackRow[0].terms_acked_at).getTime();
      check(
        stamped >= before - 60_000 && stamped <= Date.now() + 60_000,
        'with the instant of the booking, not a default',
      );
    }

    // The office door, through the same statement the admin route runs. The
    // exemption is not "admin sends true anyway" — it is that nothing is
    // acknowledged and nothing is stamped, with no second statement to do it.
    const adminSlot = nextSlot();
    const adminCreated = await insertBooking(
      sql,
      {
        name: `${NAME} terms admin`,
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
        slotStart: adminSlot,
        smsConsent: false,
        termsAcked: false,
        assessmentTier: null,
        draftToken: null,
      },
      null,
      new Date(),
      'admin',
    );
    check(adminCreated !== null, 'an admin entry must commit');
    const adminRow = (await sql`
      SELECT terms_acked_at FROM appointments WHERE id = ${adminCreated?.id ?? -1}
    `) as { terms_acked_at: Date | null }[];
    check(adminRow[0]?.terms_acked_at === null, 'and must leave terms_acked_at NULL — exempt');

    console.log('  required and stamped on the public door, NULL and exempt on the office door');
  }

  // -------------------------------------------------------------------------
  console.log('\nAssessment tier (BK-31)');
  // -------------------------------------------------------------------------
  {
    // At the ENDPOINT, for the reason the acknowledgment arm above gives:
    // `verify:booking:payload` proves the rule, and only this proves the route
    // asks for it and the column takes it.
    // ONE slot serves both rejection arms, deliberately: neither request
    // commits, so the slot is still free for the second. If either ever DID
    // commit, the other would come back 409 instead of 422 and this arm goes
    // red — which is the outcome we want from that mistake anyway. The slot
    // pool is bounded by the 14-day booking window and this script is close to
    // exhausting it, so a slot spent on a request that cannot book is a slot
    // the concurrency hammer above does not get.
    const rejectSlot = await recycleSlot();

    const withoutTier = payload(rejectSlot) as Record<string, unknown>;
    delete withoutTier.assessment_tier;
    const noTier = await post(withoutTier);
    check(noTier.status === 422, `a public POST with no tier must 422 (got ${noTier.status})`);
    check(
      Array.isArray(noTier.body?.fields) &&
        noTier.body.fields.some((f: { field: string }) => f.field === 'assessment_tier'),
      'and it must name `assessment_tier`, or the island cannot route it to step 3',
    );

    const bogus = await post(payload(rejectSlot, { assessment_tier: 'premium' }));
    check(bogus.status === 422, `an invented tier must 422 (got ${bogus.status})`);

    // The happy path through to the column, AND the price-integrity case, in
    // one booking — the slot pool cannot afford two. The request names the
    // dearest tier and also carries amount fields naming a dollar: the tier
    // must be stored and the amounts must vanish. There is no amount column for
    // one to land in, and that is the property being asserted — nobody added a
    // path to one.
    //
    // A 201 that stored NULL here would be a booking with no amount to charge,
    // which under P9 is a booking that can never be confirmed.
    const tierBooking = await post(
      payload(await recycleSlot(), {
        name: `${NAME} tier`,
        assessment_tier: 'sketch',
        amount_cents: 100,
        assessment_amount_cents: 100,
        price: 1,
      }),
    );
    check(
      tierBooking.status === 201,
      `a booking with a tier (and stray amounts) must commit (got ${tierBooking.status})`,
    );
    const tierRow = (await sql`
      SELECT * FROM appointments WHERE id = ${tierBooking.body?.id}
    `) as Record<string, unknown>[];
    check(tierRow[0]?.assessment_tier === 'sketch', 'and the chosen tier must reach the column');
    check(
      tierRow[0] !== undefined &&
        !Object.keys(tierRow[0]).some((k) => /amount|price|cents|total/i.test(k)),
      'and the row carries no amount-shaped column at all for a request to have written',
    );

    // The DB CHECK is the backstop under the parser. Asserted directly, because
    // the parser is the only thing standing between a hand-built request and
    // this column, and a CHECK nobody ever exercised is a CHECK that might not
    // be there.
    //
    // THE ERROR CODE IS ASSERTED, NOT JUST THE FAILURE, and that is not
    // pedantry — it caught a real hole during the red pass. The first version
    // only checked that the INSERT threw, and it stayed green with the CHECK
    // constraint dropped: a probe row left behind by the previous run made the
    // second INSERT fail on the slot_start unique index instead. A test that
    // passes for the wrong reason on the exact defect it exists to catch is
    // worse than no test. 23514 is `check_violation`.
    //
    // A far-future instant rather than a slot from the pool: this INSERT
    // bypasses the route entirely, so it needs no bookable time, and the pool
    // is the scarce resource here. It is deleted first so a crashed earlier run
    // cannot make the unique index answer for the CHECK again.
    await sql`DELETE FROM appointments WHERE name = 'BK-31 check probe'`;
    let checkViolation = false;
    try {
      await sql`
        INSERT INTO appointments (name, phone, service, address, city, payment_route, slot_start, assessment_tier)
        VALUES ('BK-31 check probe', '7805550134', 'water', '1 Test Way', 'Edmonton', 'private', '2099-01-01T18:30:00Z', 'premium')
      `;
    } catch (err) {
      checkViolation = (err as { code?: string }).code === '23514';
    }
    check(checkViolation, 'the database CHECK refuses a tier outside the closed set (23514)');
    const probeRows = (await sql`
      SELECT COUNT(*)::int AS n FROM appointments WHERE name = 'BK-31 check probe'
    `) as { n: number }[];
    check(probeRows[0].n === 0, 'and nothing landed');

    console.log('  required, stored, and no amount ever reaches a column');
  }

  // -------------------------------------------------------------------------
  console.log('\nDraft token integrity');
  // -------------------------------------------------------------------------
  {
    const rowsBefore = (await sql`SELECT COUNT(*)::int AS n FROM appointments`) as { n: number }[];
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

    // **INVERTED BY BK-22.** This line read `check(none.status === 201, 'a
    // booking with no token must still succeed')` — a live, green assertion of
    // the exact opposite of that ticket's AC2. It is inverted rather than
    // deleted so the reversal is visible in the diff instead of looking like a
    // check that was quietly dropped when it became inconvenient.
    const none = await post(payloadWithoutFiles(nextSlot()));
    check(none.status === 422, `a booking with no token must now be refused (got ${none.status})`);
    check(
      Array.isArray(none.body?.fields) &&
        none.body.fields.some((f: { field: string }) => f.field === 'files'),
      'and it must name the `files` field, or the island cannot route it to step 3',
    );

    // AC5 is "…and creates nothing": a 400 returned *after* an insert would
    // otherwise pass. Nothing in this block may now create a row at all — the
    // tokenless booking that used to be the one permitted exception is a
    // rejection since BK-22.
    const rowsAfter = (await sql`SELECT COUNT(*)::int AS n FROM appointments`) as { n: number }[];
    check(
      rowsAfter[0].n === rowsBefore[0].n,
      `nothing in this block may create a row (${rowsBefore[0].n} → ${rowsAfter[0].n})`,
    );
    console.log('  forged and expired rejected, bare draft_id refused, tokenless booking refused');
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

    // The above dies at the availability precheck, never reaching the insert —
    // so on its own it would stay green even if insertBooking were wrapped in a
    // catch that returned 201, which is the exact failure AC10 names. Fail the
    // insert directly to cover that half.
    const deadSql = neon('postgresql://u:p@ep-does-not-exist-00000000.us-east-2.aws.neon.tech/nope');
    let insertThrew = false;
    try {
      await insertBooking(
        deadSql,
        {
          name: `${NAME} dead`,
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
          slotStart: nextSlot(),
          smsConsent: false,
          termsAcked: false,
          assessmentTier: null,
          draftToken: null,
        },
        null,
        new Date(),
      );
    } catch {
      insertThrew = true;
    }
    check(insertThrew, 'insertBooking must reject rather than resolve when the DB is unreachable');
    console.log('  precheck failure → 500 with nothing created; insert failure rejects');
  }

  // -------------------------------------------------------------------------
  console.log('\nNo insurance identifier leaks (AC11)');
  // -------------------------------------------------------------------------
  {
    // Scanning bodies that were never given a secret proves nothing — the
    // realistic leak is an error path echoing the payload it rejected. So drive
    // an insurance-bearing payload down every status a caller can reach.
    const insured = (over: Record<string, unknown> = {}) => ({
      payment_route: 'insurance',
      insurer_name: 'Acme Mutual',
      policy_number: 'POL-SECRET-3',
      claim_number: 'CLM-SECRET-3',
      ...over,
    });

    const takenSlot = nextSlot();
    check((await post(payload(takenSlot, insured()))).status === 201, 'setup booking must succeed');
    const conflict = await post(payload(takenSlot, insured()));
    check(conflict.status === 409, `409 path must be reached (got ${conflict.status})`);

    const invalid = await post(payload(nextSlot(), insured({ phone: 'nope' })));
    check(invalid.status === 422, `422 path must be reached (got ${invalid.status})`);

    const realUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      'postgresql://u:p@ep-does-not-exist-00000000.us-east-2.aws.neon.tech/nope';
    let broken;
    try {
      broken = await post(payload(nextSlot(), insured()));
    } finally {
      process.env.DATABASE_URL = realUrl;
    }
    check(broken.status === 500, `500 path must be reached (got ${broken.status})`);

    const limitIp = freshIp();
    let rateLimited = null;
    for (let i = 0; i <= BOOKING_RATE_LIMIT_PER_HOUR + 1; i++) {
      const r = await post(payload(nextSlot(), insured({ phone: 'nope' })), limitIp);
      if (r.status === 429) {
        rateLimited = r;
        break;
      }
    }
    check(rateLimited !== null, '429 path must be reached with insurance fields present');

    const all = bodies.join('\n');
    for (const secret of [
      'POL-SECRET-1',
      'CLM-SECRET-1',
      'POL-SECRET-2',
      'CLM-SECRET-2',
      'POL-SECRET-3',
      'CLM-SECRET-3',
    ]) {
      check(!all.includes(secret), `${secret} must never appear in a response body`);
    }
    console.log(
      `  identifiers sent down 201/409/422/500/429; scanned ${bodies.length} bodies, none echoed`,
    );
  }

  // -------------------------------------------------------------------------
  console.log('\nRate limiting (AC9) — last, on a throwaway IP');
  // -------------------------------------------------------------------------
  {
    const ip = freshIp();
    let limited = null;
    let sent = 0;
    for (let i = 0; i <= BOOKING_RATE_LIMIT_PER_HOUR + 1; i++) {
      // Deliberately invalid, so the limiter is reached without booking anything.
      sent++;
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
    // Report the measured count, not the expected one: a leftover bucket from a
    // crashed run would 429 on request 1 while a hard-coded line still claimed 30.
    check(
      sent === BOOKING_RATE_LIMIT_PER_HOUR + 1,
      `the 429 must arrive on request ${BOOKING_RATE_LIMIT_PER_HOUR + 1} (arrived on ${sent} — leftover bucket?)`,
    );
    console.log(`  429 on request ${sent}, Retry-After present`);
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
