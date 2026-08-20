// Drives the admin write routes against a real database.
//
//   npm run verify:booking:admin:db
//
// BK-09 extended this with the read side: the admin file proxy's claimed-only
// lookup and its 404/502 arms. Same reason as everything below — the rule is
// `AND appointment_id IS NOT NULL` inside a SQL statement, and no amount of
// pure-function testing can execute it.
//
// scripts/verify-booking-admin-entry.ts covers the parsers, but it hands pure
// functions hand-built records — so it structurally cannot catch the three ways
// these routes can be wrong: the SQL itself (an untyped `CASE WHEN <boolean>`
// parameter, a `::date` that is silently a day out), the conflict behaviour of
// the partial unique index, and the un-cancel collision, which only exists
// because two rows can want one slot. All three need real rows.
//
// THE DEV BRANCH ONLY. This INSERTs, UPDATEs and DELETEs. It refuses to run
// without DATABASE_URL_DEV rather than falling back to production, and there is
// no --allow-production escape hatch: nothing in BK-08 has any business writing
// to the live database.
//
// The guard ORDER is load-bearing (BK-02 step zero, restated because this
// script imports routes): getDb() reads process.env.DATABASE_URL per call and
// nothing else, so refusing without DATABASE_URL_DEV protects nothing on its
// own. The variable has to be SWAPPED, and the route modules imported only
// afterwards — a static import would have bound its module graph first.
//
// Sends are muted throughout with BOOKING_NOTIFY_DISABLED=1, set in
// process.env before any import, which is where readEnv looks first. Send
// CONTENT is therefore verified lib-level, here and in
// verify-booking-admin-entry.ts: the mute silences injected seams too, so no
// message can be captured through a route.
//
// BK-14 adds the one thing a muted route CAN say. `sendCalendarInvite` logs the
// booking it is muting, so a captured `console.error` distinguishes "the route
// reached the send and the mute stopped it" from "the route was never wired to
// send at all" — which is what the boundary section below asserts, in both
// directions. It still says nothing about what the message contained.
import {
  APPOINTMENT_STATUSES,
  couldHoldCalendarInvite,
  DECISION_ENTRY_STATUSES,
  editorMaySetStatus,
  editorStatusTargets,
  INVITE_HOLDING_STATUSES,
  SLOT_HOLD_PREDICATE,
  type AppointmentStatus,
} from '../src/lib/booking-status';
import { neon } from '@neondatabase/serverless';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Type-only, so it is erased before the module graph exists and cannot bind a
// connection ahead of the DATABASE_URL swap below. Every VALUE import that
// reaches getDb() is dynamic and happens after it.
import type { Appointment } from '../src/lib/db';
import type { Message } from '../src/lib/booking-email';
import type { SendResult } from '../src/lib/booking-notify';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m;
    let val = rawValue.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

const hostOf = (url: string) => url.replace(/.*@([^/]+)\/.*/, '$1');

// 1. Refuse without the dev branch. No fallback, no flag.
const DEV_URL = process.env.DATABASE_URL_DEV;
if (!DEV_URL) {
  console.error('DATABASE_URL_DEV is not set. This script writes appointments and blackout dates,');
  console.error('and it will not fall back to production. See BK-02 step zero in the ROADMAP.');
  process.exit(1);
}

// 2. And refuse if that variable is pointed at the production host anyway.
if (process.env.DATABASE_URL && hostOf(DEV_URL) === hostOf(process.env.DATABASE_URL)) {
  console.error(`DATABASE_URL_DEV points at the production host (${hostOf(DEV_URL)}). Refusing.`);
  process.exit(1);
}

// 3. Swap BEFORE importing anything that reaches getDb().
process.env.DATABASE_URL = DEV_URL;

// 4. And mute mail before importing anything that reaches readEnv().
process.env.BOOKING_NOTIFY_DISABLED = '1';

const { POST: createRoute } = await import('../src/pages/api/admin/appointments/create');
const { POST: updateRoute } = await import('../src/pages/api/admin/appointments/update');
const { POST: resendRoute } = await import('../src/pages/api/admin/appointments/resend');
const { POST: reviewRoute } = await import('../src/pages/api/admin/appointments/review');
const { POST: blackoutAdd } = await import('../src/pages/api/admin/blackouts/add');
const { POST: blackoutDelete } = await import('../src/pages/api/admin/blackouts/delete');
const { GET: availability } = await import('../src/pages/api/booking/availability');
// The expiry cron authenticates on CRON_SECRET, so the value has to exist
// before the module is imported — same swap-then-import ordering as the DB URL.
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'verify-cron-secret';
const { GET: expiryCron } = await import('../src/pages/api/cron/expire-payments');
const { markPaid } = await import('../src/lib/booking-payment');
const { GET: fileRoute } = await import('../src/pages/api/admin/files/[id]');
const { claimedFilePathname } = await import('../src/lib/booking-files');
const { UNTICKED_NOTE } = await import('../src/lib/booking-admin-entry');
const { stampNotifications } = await import('../src/lib/booking-commit');
const {
  inviteEventFromAppointment,
  planCalendarInvite,
  planCancellationEmail,
  planForAppointment,
  planRestoreEmail,
  sendConfirmationAndStamp,
} = await import('../src/lib/booking-admin-notify');
const { localDateKey, zonedTimeToUtc } = await import('../src/lib/booking-time');
// BK-45's relationship pin needs the copy constants it asserts, the escaper the
// html arm is built with, and the two ics functions that rebuild what the
// payment path sent BEFORE the builder changed.
const { escapeHtml } = await import('../src/lib/booking-email');
const { SERVICE_LABELS } = await import('../src/lib/db');
const { buildBookingIcs, icsCustomer } = await import('../src/lib/booking-ics');
const { FEE_TERMS_HEADING, FEE_TERMS_INTRO, HAVE_READY_HEADING } = await import(
  '../src/lib/booking-copy'
);
const { GST_REGISTRATION_LINE } = await import('../src/lib/booking-config');
// BK-10's lead-reply path. Same split as the appointment resend above: the
// helper's send is injectable (lib-level), the route is driven under the mute
// (route-level).
const { sendReplyAndStamp } = await import('../src/lib/lead-reply');
const { POST: replyRoute } = await import('../src/pages/api/admin/reply');

const sql = neon(DEV_URL);
console.log(`Target: ${hostOf(DEV_URL)} (dev branch)\n`);

const MARKER = 'BK-08 verification — safe to delete';

/**
 * BK-14's injected send instants, and the insurance sentinels its PII check
 * needs. Sentinels rather than plausible values for the reason
 * `verify-booking-email.ts` gives: a policy number that is a substring of the
 * address makes "the ICS does not contain it" unfailable.
 */
const NOW = new Date('2026-08-20T15:00:00.000Z');
const LATER = new Date('2026-08-21T15:00:00.000Z');
const POLICY = 'POLICYSENTINEL-77Q';
const CLAIM = 'CLAIMSENTINEL-42Z';
/** Every appointment this run creates, so cleanup does not depend on the notes surviving. */
const createdIds: number[] = [];
/** Every blackout day this run touches. */
const touchedDays: string[] = [];

/**
 * BK-09's `appointment_files` fixtures, tracked separately because NOTHING ELSE
 * WILL REMOVE THEM. The FK cascade off `appointments` reaches only the claimed
 * row, the orphan cron runs against production and never the dev branch, and
 * `pathname` is UNIQUE — so a leaked unclaimed row makes the next run's insert
 * fail rather than merely leaving litter.
 */
const FILE_PREFIX = 'bk09-verify/';
const createdFileIds: number[] = [];

/** BK-10's `leads` fixtures. Nothing else removes them — `leads` has no FK here. */
const LEAD_MARKER = 'BK-10 reply verification';
const createdLeadIds: number[] = [];

/**
 * ONE FROZEN CLOCK FOR EVERY SEND IN THIS FILE (BK-32).
 *
 * The notification idempotency prefix now carries an attempt component, so
 * `new Date()` at each call site would make every prefix in this file unique
 * for a reason that has nothing to do with what is being asserted — and the
 * distinctness checks would then pass with the message TYPE dropped from the
 * key entirely. A fixed instant is what keeps those assertions able to fail.
 */
const SEND_NOW = new Date('2026-08-19T12:00:00.000Z');

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

function post(fields: Record<string, string>): Request {
  return new Request('https://verify.local/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

/** Every route here answers 302; the Location is the entire result. */
async function call(
  route: (ctx: never) => Promise<Response> | Response,
  fields: Record<string, string>,
): Promise<string> {
  const res = await route({ request: post(fields) } as never);
  check(res.status === 302, `expected a 302 redirect, got ${res.status}`);
  return res.headers.get('Location') ?? '';
}

/**
 * A slot instant no live row is holding (BK-32's arms).
 *
 * These arms insert directly rather than booking through the public route —
 * they need rows already sitting in `approved_awaiting_payment`, which no door
 * produces in one step. Direct inserts still meet the partial unique index, so
 * two probes sharing one `slot_start` is a 23505 rather than a test failure.
 *
 * Deliberately far past the 14-day public window: nothing here goes through
 * availability, and staying clear of it means these arms cannot consume the
 * bookable slots `verify:booking:commit` is already at the ceiling of (ROADMAP,
 * Known traps).
 */
let probeSlotCursor = 0;
async function freeProbeSlot(): Promise<Date> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    // 30 days out, then one hour per probe. On the grid's :30 to match the
    // duration CHECK's expectations even though nothing here reads the grid.
    const candidate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + probeSlotCursor * 60 * 60 * 1000);
    candidate.setUTCMinutes(30, 0, 0);
    probeSlotCursor++;
    // MIDWEEK ONLY. Saturday and Sunday carry the 1.5x after-hours multiplier
    // (BK-31), so a probe that drifted onto a weekend changed the price out
    // from under arms that assert a settled total — which is exactly what
    // happened once the cursor advanced far enough. Tuesday to Thursday is
    // clear of the weekend under either UTC or America/Edmonton reading, and
    // clear of the Friday closure.
    const weekday = candidate.getUTCDay();
    if (weekday < 2 || weekday > 4) continue;
    const held = (await sql`
      SELECT id FROM appointments
      WHERE slot_start = ${candidate.toISOString()} AND ${sql.unsafe(SLOT_HOLD_PREDICATE)}
    `) as { id: number }[];
    if (held.length === 0) return candidate;
  }
  throw new Error('freeProbeSlot: no free slot found in 400 attempts');
}

/** An `approved_awaiting_payment` row with an amount settled on it. */
/** The current status of one row. Used by every arm that drives a transition. */
async function statusOf(id: number): Promise<string | undefined> {
  return ((await sql`SELECT status FROM appointments WHERE id = ${id}`) as { status: string }[])[0]
    ?.status;
}

async function seedAwaitingPayment(
  totalCents: number,
  sessionId: string | null = null,
): Promise<number> {
  const slot = await freeProbeSlot();
  const inserted = (await sql`
    INSERT INTO appointments (name, phone, email, service, address, payment_route,
                              slot_start, status, assessment_tier, payment_status,
                              approved_at, assessment_amount_cents, travel_fee_cents,
                              gst_cents, total_amount_cents, payment_due_at,
                              stripe_session_id)
    VALUES ('MarkPaid Probe', '780-555-0142', 'markpaid@example.com', 'water', '9 Paid Ave',
            'private', ${slot.toISOString()}, 'approved_awaiting_payment', 'standard',
            'pending', ${new Date().toISOString()}, 39900, 0, 1995, ${totalCents},
            ${new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()}, ${sessionId})
    RETURNING id
  `) as { id: number }[];
  createdIds.push(inserted[0].id);
  return inserted[0].id;
}

function idFromLocation(location: string): number | null {
  const m = location.match(/^\/admin\/appointments\/(\d+)\//);
  return m ? Number(m[1]) : null;
}

type Row = {
  id: number;
  status: string;
  pipeline_stage: string;
  slot_start: Date;
  source: string;
  duration_minutes: number;
  sms_consent_at: Date | null;
  cancelled_at: Date | null;
  confirmation_sent_at: Date | null;
  internal_notified_at: Date | null;
  admin_notes: string | null;
  policy_number: string | null;
  payment_status: string;
  updated_at: Date;
};

async function read(id: number): Promise<Row | null> {
  const rows = (await sql`SELECT * FROM appointments WHERE id = ${id}`) as Row[];
  return rows[0] ?? null;
}

/**
 * Stamp a fixture as having been paid (BK-44).
 *
 * SEVERAL ARMS BELOW USED TO REACH `confirmed` BY POSTING IT TO THE STATUS
 * DROPDOWN, and one of them said so in a comment: *"it has to be moved to
 * `confirmed` first for there to be anything to cancel. That step is not
 * scaffolding; it is the new rule made visible."* It was not the rule. It was
 * the defect — `review.ts` was split out of `update.ts` precisely so the
 * dropdown could not produce that transition, and nothing enforced the split.
 * The suite had the hole baked into its own fixtures, which is part of why 23
 * green scripts could not see it.
 *
 * The arms themselves are testing the right things — the invite boundary, the
 * CANCEL on every outward crossing, the 23505 un-cancel collision — and none of
 * that has changed. So the FIXTURE is made honest rather than the assertion
 * loosened: a row permitted to sit at `confirmed` is a row that paid, which is
 * exactly what the guard now requires and what `markPaid` has always written.
 */
async function markFixturePaid(id: number): Promise<void> {
  // `paid_at` ONLY. The guard reads that column and no other, and stamping
  // `payment_status` / `payment_method` alongside it — which the first version
  // of this helper did — broke two unrelated arms that assert those columns are
  // untouched until approval. A fixture helper should move the minimum the
  // thing under test actually reads.
  await sql`
    UPDATE appointments
    SET paid_at = COALESCE(paid_at, ${new Date().toISOString()})
    WHERE id = ${id}
  `;
}

// ---------------------------------------------------------------------------
// Fixtures. The appointment slots sit years past the public horizon so this run
// cannot collide with anything a person or another script is doing in the
// window — which is exactly the bypass the admin path is for. The BLACKOUT day
// deliberately does not: the availability endpoint's blackout read is bounded
// by `blackoutQueryRange`, so an out-of-window day would make that assertion
// inert rather than failing.
// ---------------------------------------------------------------------------
const SLOT_DATE = '2029-05-15';
const SLOT_A = '11:30';
const SLOT_B = '12:30';
/**
 * A second day for BK-16's with-email boundary fixture.
 *
 * Its own date rather than a sixth slot on `SLOT_DATE`: the grid holds five,
 * all five are spoken for by the time the boundary section runs, and a fixture
 * that has to be cancelled out of somebody else's slot first is a fixture whose
 * setup can fail for reasons that have nothing to do with what it asserts.
 */
const SLOT_DATE_BK16 = '2029-05-22';

function entryFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    slot_date: SLOT_DATE,
    slot_time: SLOT_A,
    name: 'BK-08 test',
    phone: '7805550142',
    service: 'water',
    address: '1 Verification Way',
    city: 'Edmonton',
    payment_route: 'private',
    admin_notes: MARKER,
    ...over,
  };
}

/** Deletes by id AND by marker, retrying. Either alone would leak a row. */
async function cleanup(
  attempts = 3,
): Promise<{ appointments: number; blackouts: number; files: number; leads: number }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // Files first. The cascade off `appointments` would take the claimed rows
      // with it, but never the unclaimed one — and that is the row the
      // claimed-only query exists to hide, so leaking it is exactly the case
      // that would poison the next run.
      const f = (await sql`
        DELETE FROM appointment_files
        WHERE id = ANY(${createdFileIds}::int[]) OR pathname LIKE ${`${FILE_PREFIX}%`}
        RETURNING id
      `) as { id: number }[];
      const a = (await sql`
        DELETE FROM appointments
        WHERE id = ANY(${createdIds}::int[]) OR admin_notes LIKE ${`${MARKER}%`}
        RETURNING id
      `) as { id: number }[];
      const b = (await sql`
        DELETE FROM blackout_dates
        WHERE day = ANY(${touchedDays}::date[]) OR reason LIKE ${`${MARKER}%`}
        RETURNING day
      `) as { day: string }[];
      const l = (await sql`
        DELETE FROM leads
        WHERE id = ANY(${createdLeadIds}::int[]) OR name LIKE ${`${LEAD_MARKER}%`}
        RETURNING id
      `) as { id: number }[];
      return { appointments: a.length, blackouts: b.length, files: f.length, leads: l.length };
    } catch (err) {
      lastErr = err;
      console.error(`  cleanup attempt ${i + 1} failed, retrying:`, err);
    }
  }
  console.error('  ✗ CLEANUP FAILED. Remove the rows by hand:');
  console.error(`      DELETE FROM appointment_files WHERE pathname LIKE '${FILE_PREFIX}%';`);
  console.error(`      DELETE FROM appointments   WHERE admin_notes LIKE '${MARKER}%';`);
  console.error(`      DELETE FROM blackout_dates WHERE reason      LIKE '${MARKER}%';`);
  console.error(`      DELETE FROM leads          WHERE name        LIKE '${LEAD_MARKER}%';`);
  console.error(`      DELETE FROM appointments   WHERE id IN (${createdIds.join(', ') || 'none'});`);
  throw lastErr;
}

// A finally block does not run on SIGINT/SIGTERM, which would strand rows.
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

// Leftovers from an interrupted earlier run would make the first insert report
// a taken slot, which reads as a failure of this run rather than of that one.
await cleanup().catch(() => ({ appointments: 0, blackouts: 0, files: 0, leads: 0 }));
seeded = true;

try {
  // -------------------------------------------------------------------------
  console.log('Manual entry inserts an appointment (AC3)');
  // -------------------------------------------------------------------------
  const locationA = await call(createRoute, entryFields());
  const idA = idFromLocation(locationA);
  // This fixture is driven to `confirmed` below, so it must have paid its way in.
  if (idA !== null) await markFixturePaid(idA);
  check(idA !== null, `the redirect names the new appointment, got "${locationA}"`);
  if (idA === null) throw new Error('entry insert did not produce an id');
  createdIds.push(idA);

  check(locationA.endsWith('?email=off'), `no confirmation was requested, got "${locationA}"`);
  check(locationA.startsWith('/admin/appointments/'), 'and the Location is slashed and root-relative');

  const rowA = await read(idA);
  check(rowA !== null, 'the row exists');
  if (rowA) {
    check(rowA.source === 'admin', 'it is marked as office-entered');
    // BK-23: an office entry is a REQUEST like any other. It lands in
    // `pending_review` and the office approves it from the review panel, which
    // is where the amount is set. "Payment always precedes dispatch, no
    // exceptions" (client, 2026-08-16) applies to phone bookings too.
    check(rowA.status === 'pending_review', 'and it lands in pending_review, not confirmed');
    check(rowA.payment_status === 'not_required', 'with payment_status untouched until approval');
    check(rowA.pipeline_stage === 'assessment', 'at the default pipeline stage');
    check(rowA.duration_minutes === 30, 'with the locked 30-minute duration');
    // BK-35 pins BOTH halves here, and the equality is the point.
    //
    // `entryFields()` sends no `send_confirmation`, so the box is unticked and
    // BK-35 appends its audit line — which made the original
    // `admin_notes === MARKER` false the day BK-35 shipped, and left this
    // script red ever since. Relaxing it to `.includes(MARKER)` would have
    // fixed the colour and thrown away the assertion: it would then pass
    // whether or not the audit line was written, whether it was written twice,
    // and whether it overwrote the office's own words instead of appending to
    // them.
    //
    // AND IT IS SPELLED OUT RATHER THAN CALLING `appendUntickedNote(MARKER)`.
    // The first repair here did call it, and the red pass caught that
    // immediately: the route produces the stored value by calling that same
    // function, so breaking it moves BOTH sides of the comparison together and
    // the check stays green through any change to the thing it is checking.
    // `UNTICKED_NOTE` is data — the sentence itself — and the separator is
    // written out, so only the joining logic is under test. Sixth instance of
    // this family in the repo; see the ROADMAP.
    check(
      rowA.admin_notes === `${MARKER}\n\n${UNTICKED_NOTE}`,
      `the office note survived and the unticked audit line was appended, got ${JSON.stringify(rowA.admin_notes)}`,
    );
    check(
      rowA.slot_start.getTime() === zonedTimeToUtc(SLOT_DATE, SLOT_A).getTime(),
      `the slot instant is the Edmonton wall clock, got ${rowA.slot_start.toISOString()}`,
    );
    check(rowA.sms_consent_at === null, 'CASL: an unticked consent box records no consent');
    check(rowA.confirmation_sent_at === null, 'nothing was emailed');
    check(
      rowA.internal_notified_at === null,
      'and the office got no NOTIFICATION about its own keystrokes (the narrowed invariant)',
    );
  }

  // -------------------------------------------------------------------------
  console.log('CASL: the consent box is the consent (AC7)');
  // -------------------------------------------------------------------------
  const locationC = await call(
    createRoute,
    entryFields({ slot_time: SLOT_B, sms_consent: '1', name: 'BK-08 consent' }),
  );
  const idC = idFromLocation(locationC);
  check(idC !== null, `the consent entry saved, got "${locationC}"`);
  if (idC !== null) {
    createdIds.push(idC);
    const rowC = await read(idC);
    check(rowC?.sms_consent_at != null, 'a ticked consent box stamps sms_consent_at');
  }

  // -------------------------------------------------------------------------
  console.log('A taken slot is refused, and inserts nothing (AC3)');
  // -------------------------------------------------------------------------
  const before = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments
    WHERE slot_start = ${zonedTimeToUtc(SLOT_DATE, SLOT_A).toISOString()} AND ${sql.unsafe(SLOT_HOLD_PREDICATE)}
  `) as { n: number }[];
  const dupe = await call(createRoute, entryFields({ name: 'BK-08 duplicate' }));
  check(dupe.includes('taken=1'), `a duplicate slot reports taken, got "${dupe}"`);
  const after = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments
    WHERE slot_start = ${zonedTimeToUtc(SLOT_DATE, SLOT_A).toISOString()} AND ${sql.unsafe(SLOT_HOLD_PREDICATE)}
  `) as { n: number }[];
  check(
    before[0].n === 1 && after[0].n === 1,
    `exactly one non-cancelled appointment holds the slot (before ${before[0].n}, after ${after[0].n})`,
  );

  // -------------------------------------------------------------------------
  console.log('Cancelling frees the slot (AC4)');
  // -------------------------------------------------------------------------
  const cancelled = await call(updateRoute, { id: String(idA), status: 'cancelled' });
  check(cancelled.endsWith('?saved=1'), `the cancel saved, got "${cancelled}"`);
  const rowACancelled = await read(idA);
  check(rowACancelled?.status === 'cancelled', 'the row is cancelled');
  check(rowACancelled?.cancelled_at != null, 'and cancelled_at is stamped');
  const cancelledAt = rowACancelled?.cancelled_at?.getTime();

  // The slot is now free — `cancelled` is one of SLOT_RELEASING_STATUSES, so the
  // partial unique index no longer covers the row.
  const locationB = await call(createRoute, entryFields({ name: 'BK-08 rebook' }));
  const idB = idFromLocation(locationB);
  // This fixture is driven to `confirmed` below, so it must have paid its way in.
  if (idB !== null) await markFixturePaid(idB);
  check(idB !== null, `the freed slot accepts a new booking, got "${locationB}"`);
  if (idB === null) throw new Error('re-insert into the freed slot failed');
  createdIds.push(idB);

  // -------------------------------------------------------------------------
  console.log('Un-cancelling into a rebooked slot fails friendly (AC4)');
  // -------------------------------------------------------------------------
  // The stage is edited in the SAME submit. A 23505 rolls the whole statement
  // back, so it must be discarded too — the message says nothing was saved, and
  // this is what makes that true rather than merely claimed.
  const conflict = await call(updateRoute, {
    id: String(idA),
    status: 'confirmed',
    pipeline_stage: 'restoration',
    admin_notes: MARKER,
  });
  check(conflict.endsWith('?saved=conflict'), `the collision is reported, got "${conflict}"`);
  const rowAAfter = await read(idA);
  check(rowAAfter?.status === 'cancelled', 'the row stays cancelled — not a 500, and not a flip');
  check(
    rowAAfter?.cancelled_at?.getTime() === cancelledAt,
    'and keeps its original cancellation time',
  );
  check(
    rowAAfter?.pipeline_stage === 'assessment',
    `the same-submit stage edit was rolled back too, got ${rowAAfter?.pipeline_stage}`,
  );

  // -------------------------------------------------------------------------
  console.log('Un-cancelling into a free slot succeeds (AC4)');
  // -------------------------------------------------------------------------
  const freed = await call(updateRoute, { id: String(idB), status: 'cancelled' });
  check(freed.endsWith('?saved=1'), 'the rebooking is cancelled out of the way');
  const restored = await call(updateRoute, { id: String(idA), status: 'confirmed' });
  check(restored.endsWith('?saved=1'), `un-cancelling now succeeds, got "${restored}"`);
  const rowARestored = await read(idA);
  check(rowARestored?.status === 'confirmed', 'the row is confirmed again');
  check(rowARestored?.cancelled_at === null, 'and cancelled_at is cleared, not left stale');

  // -------------------------------------------------------------------------
  console.log('Stage and notes edits, and the whitelist (AC2)');
  // -------------------------------------------------------------------------
  const edited = await call(updateRoute, {
    id: String(idA),
    status: 'confirmed',
    pipeline_stage: 'mitigation',
    admin_notes: `${MARKER} edited`,
    // Everything below is outside the whitelist and must change nothing.
    slot_start: '2020-01-01T00:00:00.000Z',
    duration_minutes: '90',
    policy_number: 'POLICYSENTINEL-77Q',
    source: 'web',
    id_: 'nope',
  });
  check(edited.endsWith('?saved=1'), `the edit saved, got "${edited}"`);
  const rowEdited = await read(idA);
  check(rowEdited?.pipeline_stage === 'mitigation', 'the stage changed');
  check(rowEdited?.admin_notes === `${MARKER} edited`, 'the notes changed');
  check(
    rowEdited?.slot_start.getTime() === zonedTimeToUtc(SLOT_DATE, SLOT_A).getTime(),
    'slot_start is NOT updatable',
  );
  check(rowEdited?.duration_minutes === 30, 'duration_minutes is NOT updatable');
  check(rowEdited?.policy_number === null, 'policy_number is NOT updatable');
  check(rowEdited?.source === 'admin', 'source is NOT updatable');
  check(
    (rowEdited?.updated_at?.getTime() ?? 0) > (rowA?.updated_at.getTime() ?? 0),
    'and updated_at moved',
  );

  // A submitted-but-empty notes field is a deliberate clear; an absent one is
  // "leave alone". Both go through the same `CASE WHEN <boolean>` parameter,
  // which the Neon HTTP driver sends untyped.
  // ORDER MATTERS. The absent-field case is checked FIRST, while the notes
  // still hold a value: doing it after the clear compares NULL to NULL, which
  // is an assertion that cannot fail — the red pass caught exactly that.
  await call(updateRoute, { id: String(idA), status: 'confirmed' });
  check(
    (await read(idA))?.admin_notes === `${MARKER} edited`,
    'an absent notes field leaves the notes alone',
  );
  await call(updateRoute, { id: String(idA), admin_notes: '' });
  check((await read(idA))?.admin_notes === null, 'a submitted-but-empty one clears them');
  await call(updateRoute, { id: String(idA), admin_notes: MARKER });
  check((await read(idA))?.admin_notes === MARKER, 'and writing them back works');

  // A well-formed id that matches nothing.
  const missing = await call(updateRoute, { id: '2147483647', status: 'confirmed' });
  check(missing.includes('saved=missing'), `a vanished appointment is reported, got "${missing}"`);

  // -------------------------------------------------------------------------
  console.log('The resend gate (AC6)');
  // -------------------------------------------------------------------------
  // No email address on this row, so a resend must be refused whatever its
  // status.
  const noEmail = await call(resendRoute, { id: String(idA) });
  check(noEmail.endsWith('?email=refused'), `no email → refused, got "${noEmail}"`);

  // Give it one — and BK-23 narrowed the gate. The resend button re-sends the
  // confirmation WITH its calendar invite, so it is now `confirmed`-only. A fresh entry lands in `pending_review`, and offering to
  // re-send a confirmation for a booking nobody has paid for is the false claim
  // this whole flow removes.
  const withEmail = await call(
    createRoute,
    entryFields({
      slot_time: '13:30',
      name: 'BK-08 resend',
      email: 'bk08-verify@example.com',
    }),
  );
  const idD = idFromLocation(withEmail);
  // Driven to `confirmed` below to open the resend gate, so it must have paid.
  if (idD !== null) await markFixturePaid(idD);
  check(idD !== null, `the emailable entry saved, got "${withEmail}"`);
  if (idD !== null) {
    createdIds.push(idD);

    const pending = await call(resendRoute, { id: String(idD) });
    check(
      pending.endsWith('?email=refused'),
      `a pending_review row is refused even with an email, got "${pending}"`,
    );

    // Move it to confirmed and the gate opens. The send itself is muted here,
    // so this asserts the GATE, not that mail went out.
    //
    // THE UPDATE IS ASSERTED, not just performed. A refused update would leave
    // this row `pending_review`, and the resend route refuses that too — so
    // without the line below a tightened transition guard would make the arm
    // pass for the wrong reason instead of going red.
    const opened = await call(updateRoute, { id: String(idD), status: 'confirmed' });
    check(opened.endsWith('?saved=1'), `the fixture reached confirmed, got "${opened}"`);
    const accepted = await call(resendRoute, { id: String(idD) });
    check(
      !accepted.endsWith('?email=refused'),
      `a confirmed row with an email is accepted, got "${accepted}"`,
    );

    // Cancel it and the gate must close again: a cancelled appointment must not
    // be told again that its assessment is confirmed for a slot that may belong
    // to someone else now.
    await call(updateRoute, { id: String(idD), status: 'cancelled' });
    const refused = await call(resendRoute, { id: String(idD) });
    check(refused.endsWith('?email=refused'), `a cancelled row is refused, got "${refused}"`);
    for (const status of ['completed', 'no_show']) {
      await call(updateRoute, { id: String(idD), status });
      const r = await call(resendRoute, { id: String(idD) });
      check(r.endsWith('?email=refused'), `a ${status} row is refused, got "${r}"`);
    }
  }

  // -------------------------------------------------------------------------
  console.log('The stamp columns (AC5, the write half)');
  // -------------------------------------------------------------------------
  // Sends are muted here, so `stampNotifications` is unreachable through the
  // routes — but the statement itself is what this script exists to execute.
  // Its two `CASE WHEN <boolean>` parameters are sent untyped by the Neon HTTP
  // driver and inferred from context, which is exactly the kind of claim about
  // a third-party client this project refuses to make from memory.
  const stampAt = new Date('2026-08-10T18:30:00.000Z');
  await stampNotifications(sql, idA, { customer: true, internal: false }, stampAt);
  const stamped = await read(idA);
  check(
    stamped?.confirmation_sent_at?.getTime() === stampAt.getTime(),
    `the customer stamp is written, got ${String(stamped?.confirmation_sent_at)}`,
  );
  check(
    stamped?.internal_notified_at === null,
    'and the office column is left NULL — no admin action sends a notification email',
  );

  const later = new Date('2026-08-10T19:30:00.000Z');
  await stampNotifications(sql, idA, { customer: false, internal: false }, later);
  check(
    (await read(idA))?.confirmation_sent_at?.getTime() === stampAt.getTime(),
    'stamping nothing changes nothing',
  );

  // -------------------------------------------------------------------------
  console.log('Send-then-stamp: the column moves only when the send did (AC5, AC6)');
  // -------------------------------------------------------------------------
  // `sendConfirmationAndStamp` is the seam BETWEEN the two verified halves, and
  // it is the one place "stamp on 'sent' only" lives. The mute is lifted for
  // this scope alone — with an injected `deps.send` the real adapter is never
  // constructed, so no key is read and no mail can leave — and restored in the
  // finally, because everything after this calls routes again.
  //
  // Without this section the guard could be widened to `!== 'skipped'`, or the
  // stamp call deleted outright, and every gate would stay green.
  if (idD !== null) {
    delete process.env.BOOKING_NOTIFY_DISABLED;
    try {
      const full = (await sql`SELECT * FROM appointments WHERE id = ${idD}`) as Appointment[];
      const appointment = full[0];
      check(appointment != null, 'the send fixture row is readable');
      check(appointment?.email != null, 'and carries an email, so there is a customer message');
      if (!appointment) throw new Error('send fixture row vanished');

      const plan = planForAppointment(appointment, 'Water Damage Restoration', NOW, 0);
      check(plan.customer !== null, 'the plan has a customer message to deliver');
      check(plan.internal != null, 'and an internal one it must never deliver');
      // FLIPPED IN BK-16, NOT DELETED. It read "carries no calendar
      // attachment" — BK-14's deliberate absence, now the client-requested
      // feature. Inverted rather than dropped, and the ATTENDEE is the half
      // that matters: a plan built for a REAL ROW is where "the office's copy
      // got mailed to the customer" would actually happen, because this is the
      // only mapper that has both addresses in hand.
      check(
        (plan.customer?.attachments?.length ?? 0) === 1,
        `and the customer message carries their calendar invite, got ${plan.customer?.attachments?.length ?? 0}`,
      );
      const planIcs = (plan.customer?.attachments?.[0]?.content ?? '').replace(/\r\n /g, '');
      check(
        planIcs.includes(`RSVP=TRUE:mailto:${appointment.email}`),
        `naming the customer as the attendee, got ${planIcs.match(/ATTENDEE[^\r\n]*/)?.[0]}`,
      );
      check(
        !planIcs.includes('mailto:info@yegrestoration.ca'),
        'and not the office — the office has its own copy on the internal message',
      );

      const reset = async () => {
        await sql`
          UPDATE appointments
          SET confirmation_sent_at = NULL, internal_notified_at = NULL
          WHERE id = ${idD}
        `;
      };

      // 1. A successful send stamps the customer column and only that column.
      await reset();
      // The capture is the WHOLE message, not `{to}`. It recorded only the
      // address until BK-14, which would have made "the confirmation carries no
      // calendar attachment" unassertable at exactly the seam where a shared
      // builder makes attaching it to both a one-line edit.
      const delivered: Message[] = [];
      const sentOutcome = await sendConfirmationAndStamp(sql, plan, SEND_NOW, {
        send: async (m) => {
          delivered.push(m);
          return { ok: true };
        },
      });
      check(sentOutcome === 'sent', `a successful send reports sent, got ${sentOutcome}`);
      check(delivered.length === 1, `exactly one message left, got ${delivered.length}`);
      check(delivered[0]?.to === appointment.email, 'addressed to the customer');
      // FLIPPED IN BK-16, NOT DELETED — the same inversion as above, at the
      // seam the message actually leaves through rather than on the plan.
      check(
        (delivered[0]?.attachments?.length ?? 0) === 1,
        `and carrying their calendar invite, got ${delivered[0]?.attachments?.length ?? 0}`,
      );
      check(
        (delivered[0]?.attachments?.[0]?.contentType ?? '').includes('method=REQUEST'),
        'typed as a REQUEST invite',
      );
      const afterSent = await read(idD);
      check(afterSent?.confirmation_sent_at != null, 'confirmation_sent_at is written');
      check(
        afterSent?.internal_notified_at === null,
        'and internal_notified_at is NOT — the invite is not a notification and stamps nothing',
      );

      // 2. A resolved error stamps nothing. This is the mutation that would
      //    otherwise be invisible: a Resend outage during a manual entry would
      //    show a timestamp for mail that never left, and the office would
      //    never think to resend.
      await reset();
      const failedOutcome = await sendConfirmationAndStamp(sql, plan, SEND_NOW, {
        send: async () => ({ ok: false, error: 'validation_error: API key is invalid' }),
      });
      check(failedOutcome === 'failed', `a resolved error reports failed, got ${failedOutcome}`);
      const afterFailed = await read(idD);
      check(afterFailed?.confirmation_sent_at === null, 'a failed send stamps nothing');
      check(afterFailed?.internal_notified_at === null, 'and still nothing on the office column');

      // 3. A throwing sender is caught rather than escaping into the route —
      //    the appointment already exists by the time this runs.
      await reset();
      const threwOutcome = await sendConfirmationAndStamp(sql, plan, SEND_NOW, {
        send: async () => {
          throw new Error('socket hang up');
        },
      });
      check(threwOutcome === 'failed', `a throwing sender reports failed, got ${threwOutcome}`);
      check((await read(idD))?.confirmation_sent_at === null, 'and stamps nothing');

      // 4. The mute is a skip, not a send and not a failure — and it must not
      //    stamp either, or a muted test run would leave a false timestamp.
      process.env.BOOKING_NOTIFY_DISABLED = '1';
      await reset();
      const mutedOutcome = await sendConfirmationAndStamp(sql, plan, SEND_NOW, {
        send: async () => ({ ok: true }),
      });
      check(mutedOutcome === 'skipped', `the mute reports skipped, got ${mutedOutcome}`);
      check((await read(idD))?.confirmation_sent_at === null, 'and stamps nothing');
    } finally {
      // Restored before anything calls a route again.
      process.env.BOOKING_NOTIFY_DISABLED = '1';
    }
  } else {
    check(false, 'the send fixture row was never created — this section did not run');
  }

  // -------------------------------------------------------------------------
  console.log('Calendar invites, built from a real row (BK-14 AC1, AC3)');
  // -------------------------------------------------------------------------
  // LIB-LEVEL, against a row this run inserted — the fixture carries insurance
  // sentinels, so "no policy number in a calendar artifact" is checked against
  // a row that really has one rather than a hand-built record whose type
  // forbids it. `verify-booking-ics.ts` drives the builder; what this half adds
  // is the round trip through Postgres, where `slot_start` comes back as a
  // driver `Date` and the two identifiers come back as real columns.
  const insuredLocation = await call(
    createRoute,
    entryFields({
      slot_time: '14:30',
      name: 'BK-14 invite',
      payment_route: 'insurance',
      insurer_name: 'Prairie Mutual',
      policy_number: POLICY,
      claim_number: CLAIM,
    }),
  );
  const idE = idFromLocation(insuredLocation);
  // This fixture is driven to `confirmed` below, so it must have paid its way in.
  if (idE !== null) await markFixturePaid(idE);
  check(idE !== null, `the insured entry saved, got "${insuredLocation}"`);
  if (idE === null) throw new Error('calendar fixture insert failed');
  createdIds.push(idE);

  {
    const [row] = (await sql`SELECT * FROM appointments WHERE id = ${idE}`) as Appointment[];
    check(row != null, 'the calendar fixture row is readable');
    // The fixture really does carry the identifiers, or every absence check
    // below passes for free.
    check(row?.policy_number === POLICY, 'and really does carry a policy number');
    check(row?.claim_number === CLAIM, 'and a claim number');

    const event = inviteEventFromAppointment(row, 'Water Damage Restoration');
    const expectedStart = zonedTimeToUtc(SLOT_DATE, '14:30');

    const request = planCalendarInvite(event, 'request', NOW);
    const cancel = planCalendarInvite(event, 'cancel', LATER);

    for (const [label, message] of [
      ['request', request],
      ['cancel', cancel],
    ] as const) {
      check(message.to === 'info@yegrestoration.ca', `the ${label} invite goes to the office`);
      check(message.attachments?.length === 1, `and carries one attachment, got ${message.attachments?.length}`);
      // UNFOLDED. An ICS line folds at 75 octets with a CRLF and a leading
      // space, so a policy number past that boundary is invisible to
      // `includes` on the raw text. The red pass proved it: the break that put
      // the identifier in DESCRIPTION left this section GREEN against the raw
      // string, which is the "assertion that cannot fail" shape this project
      // keeps paying for. Both forms are checked below.
      const raw = message.attachments?.[0].content ?? '';
      const body = raw.replace(/\r\n /g, '');
      check(body.includes(`UID:booking-${idE}@`), `the ${label} names this booking`);
      // The instant survives the driver: a `Date` out of Postgres, formatted as
      // a UTC iCalendar stamp. Derived independently here from the wall clock
      // the entry was typed at.
      check(
        body.includes(`DTSTART:${expectedStart.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`),
        `the ${label} carries the slot instant, got ${body.match(/DTSTART:[^\r]*/)?.[0]}`,
      );
      // THE STRICTER RULE, against a real insured row.
      check(!body.includes(POLICY) && !raw.includes(POLICY), `the ${label} ICS carries no policy number`);
      check(!body.includes(CLAIM) && !raw.includes(CLAIM), `the ${label} ICS carries no claim number`);
      check(!body.includes('Prairie Mutual'), `nor the insurer`);
      const whole = [message.subject, message.html, message.text].join('\n');
      check(!whole.includes(POLICY) && !whole.includes(CLAIM), `nor does the ${label} email body`);
    }

    check(
      (request.attachments?.[0].content ?? '').includes('METHOD:REQUEST'),
      'the request is a REQUEST',
    );
    check(
      (cancel.attachments?.[0].content ?? '').includes('METHOD:CANCEL'),
      'and the cancellation a CANCEL',
    );
    const seqOf = (m: typeof request) =>
      Number(m.attachments?.[0].content.match(/SEQUENCE:(\d+)/)?.[1] ?? 0);
    check(seqOf(cancel) > seqOf(request), 'with a strictly greater SEQUENCE');

    // -----------------------------------------------------------------------
    // BK-16: the customer's two boundary emails, from the same real row.
    // -----------------------------------------------------------------------
    // Against a row that genuinely carries insurance identifiers, which is the
    // point of doing this here rather than only in `verify-booking-ics.ts`: a
    // hand-built record cannot express them, so the PII check there can only
    // fail if the BUILDER leaks. Here the mapper, the driver and the columns
    // are all real, and the two new messages are customer-facing.
    const customerAddress = 'bk16-customer@example.com';
    const cancellation = planCancellationEmail(event, customerAddress, LATER);
    const restore = planRestoreEmail(event, customerAddress, new Date(LATER.getTime() + 60_000));

    for (const [label, message, method] of [
      ['cancellation', cancellation, 'CANCEL'],
      ['restore', restore, 'REQUEST'],
    ] as const) {
      check(message.to === customerAddress, `the ${label} goes to the customer, got ${message.to}`);
      check(
        message.to !== 'info@yegrestoration.ca',
        `and the ${label} is not an office message`,
      );
      check(message.attachments?.length === 1, `carrying one attachment, got ${message.attachments?.length}`);

      const raw = message.attachments?.[0].content ?? '';
      const body = raw.replace(/\r\n /g, '');
      check(body.includes(`METHOD:${method}`), `the ${label} ICS is a ${method}`);
      check(body.includes(`UID:booking-${idE}@`), `for this booking`);
      check(
        body.includes(`DTSTART:${expectedStart.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`),
        `at the slot instant, got ${body.match(/DTSTART:[^\r]*/)?.[0]}`,
      );
      check(
        body.includes(`RSVP=TRUE:mailto:${customerAddress}`),
        `naming the customer as the attendee, got ${body.match(/ATTENDEE[^\r]*/)?.[0]}`,
      );
      check(
        !body.includes('mailto:info@yegrestoration.ca'),
        'and the office nowhere in it',
      );

      // THE STRICTER RULE, on a customer artifact built from an insured row.
      // Raw AND unfolded, for the reason the office loop above states.
      check(!body.includes(POLICY) && !raw.includes(POLICY), `the ${label} ICS carries no policy number`);
      check(!body.includes(CLAIM) && !raw.includes(CLAIM), `the ${label} ICS carries no claim number`);
      const whole = [message.subject, message.html, message.text].join('\n');
      check(!whole.includes(POLICY), `nor does the ${label} email body`);
      check(!whole.includes(CLAIM), `nor a claim number`);
      check(!whole.includes('Prairie Mutual'), `nor the insurer's name`);
      // The customer copy is bound by the CUSTOMER rule, not the office one:
      // the internal notification may print all three, this may not.
      check(!/https?:\/\//.test(whole), `and the ${label} carries no URL — cancellation is phone-in`);
    }

    check(
      Number((restore.attachments?.[0].content ?? '').match(/SEQUENCE:(\d+)/)?.[1] ?? 0) >
        Number((cancellation.attachments?.[0].content ?? '').match(/SEQUENCE:(\d+)/)?.[1] ?? 0),
      'the restore outranks the cancellation',
    );
    check(
      cancellation.attachments?.[0].content.match(/UID:[^\r\n]+/)?.[0] ===
        request.attachments?.[0].content.match(/UID:[^\r\n]+/)?.[0],
      'and both share the UID the office invite carries — one event, two calendars',
    );
  }

  // -------------------------------------------------------------------------
  console.log('The status-edit route sends on the boundary and nowhere else (BK-14 AC3)');
  // -------------------------------------------------------------------------
  // ROUTE-LEVEL, UNDER THE MUTE. The mute silences injected seams too, so no
  // message can be captured here — but `sendCalendarInvite` logs the booking it
  // is muting, and that line only exists if the route reached it. So this half
  // does distinguish "muted" from "never wired", which the plan expected only
  // the post-deploy check to do. What it still cannot see is the message
  // itself; that is the lib-level half above.
  {
    // THE MUTE LINE IS AUDIENCE-ATTRIBUTABLE SINCE BK-16, and these three
    // helpers are why. It used to read `no calendar invite for booking <id>`,
    // which counted the same for every send — so once a boundary crossing owed
    // TWO sends, "the route reached the invite send" could not tell "office and
    // customer both went" from "the office one went and the customer half was
    // never wired". Each arm below now names the audience it expects and
    // asserts the absence of the one it does not.
    const muteLine = (id: number, kind: 'request' | 'cancel', audience: 'office' | 'customer') =>
      new RegExp(`no calendar ${kind} \\(${audience}\\) for booking ${id}\\b`);
    /** Any send at all for one booking, whatever its kind or audience. */
    const anyMute = (id: number) =>
      new RegExp(`no calendar (?:request|cancel) \\((?:office|customer)\\) for booking ${id}\\b`);
    const ANY_INVITE = /no calendar (?:request|cancel) \((?:office|customer)\) for booking/;

    /** Runs any route with console.error captured. */
    async function capture(
      route: (ctx: never) => Promise<Response> | Response,
      fields: Record<string, string>,
    ): Promise<{ location: string; logs: string }> {
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
      };
      try {
        const res = await route({ request: post(fields) } as never);
        check(res.status === 302, `expected a 302 redirect, got ${res.status}`);
        return { location: res.headers.get('Location') ?? '', logs: lines.join('\n') };
      } finally {
        console.error = original;
      }
    }
    const callCapturingLogs = (fields: Record<string, string>) => capture(updateRoute, fields);

    // AC2, the half a lib-level test cannot reach: the invite is independent of
    // the customer-confirmation checkbox. That box is about the CUSTOMER, and
    // gating the office's own calendar on it is the obvious wrong wiring.
    for (const [label, extra] of [
      ['without the confirmation checkbox', {}],
      ['with the confirmation checkbox ticked', { send_confirmation: '1' }],
    ] as const) {
      const entered = await capture(
        createRoute,
        entryFields({ slot_time: '15:30', name: `BK-14 checkbox ${label}`, email: 'bk14@example.com', ...extra }),
      );
      const enteredId = idFromLocation(entered.location);
      check(enteredId !== null, `the entry ${label} saved, got "${entered.location}"`);
      if (enteredId !== null) {
        createdIds.push(enteredId);
        // BK-23 INVERTED THIS ONE. It used to assert that the office invite
        // fires regardless of the customer-confirmation checkbox. The office
        // invite is now GONE from the entry path entirely: an invite at entry
        // time is an invite for a slot nobody has paid for, and there is no
        // CANCEL to clear it when the request is declined or the payment lapses
        // — a row reaching `declined` from `pending_review` never had one.
        //
        // The assertion is kept rather than deleted, pointing the other way,
        // because "no invite at entry" is a property somebody will otherwise
        // restore by accident while fixing something else. This fixture HAS an
        // email address, so both halves are falsifiable rather than vacuous.
        check(
          !muteLine(enteredId, 'request', 'office').test(entered.logs),
          `an entry ${label} sends the office NO calendar invite`,
        );
        check(
          !muteLine(enteredId, 'request', 'customer').test(entered.logs),
          `and an entry ${label} sends the customer no invite either`,
        );
        // And it is cleaned up out of the slot so the next iteration can reuse it.
        await call(updateRoute, { id: String(enteredId), status: 'cancelled' });
      }
    }

    // The OTHER direction of the narrowed invariant, at route level: every
    // admin action that is not an entry or a boundary crossing still mails the
    // office nothing. Asserted on the two routes that do send something else
    // (the customer resend) and something at all (blackouts).
    const resendLogs = await capture(resendRoute, { id: String(idA) });
    check(!ANY_INVITE.test(resendLogs.logs), 'a customer resend sends the office no invite');
    const blackoutLogs = await capture(blackoutAdd, { day: '2029-05-16', reason: MARKER });
    touchedDays.push('2029-05-16');
    check(!ANY_INVITE.test(blackoutLogs.logs), 'and neither does a blackout edit');
    await call(blackoutDelete, { day: '2029-05-16' });

    // 1. Into cancelled, ON A ROW WITH NO EMAIL ADDRESS. The office invite goes;
    //    the customer half must not, because there is nobody to send it to.
    //    This is `idE`, whose fixture deliberately has no email — and it is the
    //    negative half of AC3 that a with-email row cannot express.
    check((await read(idE)) !== null, 'the no-email fixture is still here');
    const emailless = (await sql`SELECT email FROM appointments WHERE id = ${idE}`) as {
      email: string | null;
    }[];
    check(
      emailless[0]?.email == null,
      `and it really has no email, got ${JSON.stringify(emailless[0]?.email)} — otherwise the arm below is vacuous`,
    );
    // BK-23: THE BOUNDARY IS NOW "DID THIS STATUS HOLD AN INVITE", not "is it
    // the word cancelled". An office entry lands in `pending_review`, which
    // never had an invite issued — so it has to be moved to `confirmed` first
    // for there to be anything to cancel.
    //
    // THAT STEP USED TO BE DESCRIBED HERE AS "not scaffolding; the new rule
    // made visible". It was not the rule — it was BK-44's defect, and this arm
    // was leaning on it. The fixture is stamped `paid_at` at creation
    // (`markFixturePaid`) so the crossing below is one a paid booking has
    // earned, which is what the guard now requires and what `markPaid` has
    // always written. The arm itself is unchanged and still asserts the
    // boundary in both directions.
    const preInvite = await callCapturingLogs({ id: String(idE), status: 'pending_review' });
    check(!anyMute(idE).test(preInvite.logs), 'a pending_review row has no invite, so no mail crosses');
    const cancelPending = await callCapturingLogs({ id: String(idE), status: 'declined' });
    check(
      !anyMute(idE).test(cancelPending.logs),
      'and declining a never-confirmed request sends NO cancellation — there was never an invite',
    );
    await callCapturingLogs({ id: String(idE), status: 'pending_review' });

    const toConfirmed = await callCapturingLogs({ id: String(idE), status: 'confirmed' });
    check(
      muteLine(idE, 'request', 'office').test(toConfirmed.logs),
      'confirming a request issues the office invite',
    );

    // THE CASE P9 CREATED, and the reason the boundary had to stop being the
    // word "cancelled".
    //
    // A confirmed booking can now leave the calendar through `payment_expired`
    // and `declined` as well as `cancelled` — a refund, a reversal, an office
    // correction. Under the old rule NONE of those sent a CANCEL, because
    // neither the old status nor the new one was the literal `'cancelled'`, and
    // the invite would sit on two calendars forever with nothing to clear it.
    // Silent, and only visible to whoever turns up at the door.
    for (const exit of ['payment_expired', 'declined'] as const) {
      await callCapturingLogs({ id: String(idE), status: 'confirmed' });
      const left = await callCapturingLogs({ id: String(idE), status: exit });
      check(
        muteLine(idE, 'cancel', 'office').test(left.logs),
        `confirmed → ${exit} sends a CANCEL — the invite must not outlive the booking`,
      );
    }
    await callCapturingLogs({ id: String(idE), status: 'confirmed' });

    const toCancelled = await callCapturingLogs({ id: String(idE), status: 'cancelled' });
    check(toCancelled.location.endsWith('?saved=1'), `the cancel still saves, got "${toCancelled.location}"`);
    check((await read(idE))?.status === 'cancelled', 'and the row is cancelled');
    check(
      muteLine(idE, 'cancel', 'office').test(toCancelled.logs),
      'and the route reached the office invite send',
    );
    check(
      !muteLine(idE, 'cancel', 'customer').test(toCancelled.logs),
      'and sent the customer nothing — there is no address on the row',
    );
    check(
      !/calendar cancel \((?:office|customer)\) email failed/.test(toCancelled.logs),
      'without escaping the mute',
    );

    // 2. Re-submitting the SAME status is not a transition. This is the case
    //    `RETURNING id` could not see, and the reason the statement self-joins.
    const resubmit = await callCapturingLogs({
      id: String(idE),
      status: 'cancelled',
      admin_notes: MARKER,
    });
    check(resubmit.location.endsWith('?saved=1'), 'a re-submit still saves');
    check(!anyMute(idE).test(resubmit.logs), 'and sends nothing — it crossed no boundary');

    // 3. Out of cancelled: a fresh REQUEST, office only for this row.
    const restored = await callCapturingLogs({ id: String(idE), status: 'confirmed' });
    check(restored.location.endsWith('?saved=1'), `the un-cancel saves, got "${restored.location}"`);
    check((await read(idE))?.status === 'confirmed', 'and the row is confirmed again');
    check(
      muteLine(idE, 'request', 'office').test(restored.logs),
      'and the route reached the office invite send again',
    );
    check(
      !muteLine(idE, 'request', 'customer').test(restored.logs),
      'still with no customer send — the row still has no address',
    );

    // 4. Edits that do not touch the boundary send nothing.
    for (const status of ['completed', 'no_show', 'confirmed']) {
      const edit = await callCapturingLogs({ id: String(idE), status });
      check(edit.location.endsWith('?saved=1'), `a ${status} edit saves`);
      check(!anyMute(idE).test(edit.logs), `and a ${status} edit sends nothing`);
    }
    const notesOnly = await callCapturingLogs({ id: String(idE), admin_notes: `${MARKER} note` });
    check(notesOnly.location.endsWith('?saved=1'), 'a notes-only edit saves');
    check(!anyMute(idE).test(notesOnly.logs), 'and sends nothing');

    // 4b. THE SAME BOUNDARY ON A ROW THAT HAS AN EMAIL (BK-16 AC3). Two sends,
    //     and the assertion is that the two log lines are DISTINGUISHABLE
    //     rather than merely two — the whole reason the mute line gained the
    //     audience. A route that sent the office invite twice would produce two
    //     lines and satisfy any count.
    const withEmailEntry = await call(
      createRoute,
      entryFields({
        slot_date: SLOT_DATE_BK16,
        slot_time: '11:30',
        name: 'BK-16 boundary',
        email: 'bk16-boundary@example.com',
      }),
    );
    const idG = idFromLocation(withEmailEntry);
    // This fixture is driven to `confirmed` below, so it must have paid its way in.
    if (idG !== null) await markFixturePaid(idG);
    check(idG !== null, `the with-email fixture saved, got "${withEmailEntry}"`);
    if (idG !== null) {
      createdIds.push(idG);

      // Same as above: confirm it first, because that is when an invite exists
      // to be cancelled.
      await callCapturingLogs({ id: String(idG), status: 'confirmed' });
      const cancelG = await callCapturingLogs({ id: String(idG), status: 'cancelled' });
      check(cancelG.location.endsWith('?saved=1'), `the cancel saves, got "${cancelG.location}"`);
      check((await read(idG))?.status === 'cancelled', 'and the row is cancelled');
      check(
        muteLine(idG, 'cancel', 'office').test(cancelG.logs),
        'the office CANCEL was reached',
      );
      check(
        muteLine(idG, 'cancel', 'customer').test(cancelG.logs),
        'AND the customer cancellation was reached — the client-requested half',
      );
      const cancelLines = cancelG.logs.split('\n').filter((l) => anyMute(idG).test(l));
      check(cancelLines.length === 2, `exactly two sends, got ${cancelLines.length}`);
      check(
        new Set(cancelLines).size === 2,
        `and they are distinguishable rather than the same send twice:\n      ${cancelLines.join('\n      ')}`,
      );

      // Un-cancel: the restore direction, which exists because the resend
      // button's fixed idempotency key cannot carry it (the plan-review
      // blocker). Without this the customer's calendar shows "cancelled"
      // forever with no working recovery.
      const restoreG = await callCapturingLogs({ id: String(idG), status: 'confirmed' });
      check(restoreG.location.endsWith('?saved=1'), `the un-cancel saves, got "${restoreG.location}"`);
      check((await read(idG))?.status === 'confirmed', 'and the row is confirmed again');
      check(
        muteLine(idG, 'request', 'office').test(restoreG.logs),
        'the office REQUEST was reached',
      );
      check(
        muteLine(idG, 'request', 'customer').test(restoreG.logs),
        'AND the customer restore was reached',
      );
      check(
        !muteLine(idG, 'cancel', 'customer').test(restoreG.logs),
        'and the customer was not told it was cancelled again',
      );

      // The negative arms, on the row that CAN receive customer mail — which is
      // what makes them mean something. On `idE` they could not fail.
      const resubmitG = await callCapturingLogs({
        id: String(idG),
        status: 'confirmed',
        admin_notes: MARKER,
      });
      check(resubmitG.location.endsWith('?saved=1'), 'a re-submit on the with-email row saves');
      check(!anyMute(idG).test(resubmitG.logs), 'and mails nobody');
      // Order is load-bearing: the loop leaves the row `completed`, which is
      // what makes the next arm literally the completed → cancelled pair it
      // claims to pin (implementation review, should-fix 1 — it used to leave
      // the row at `no_show`).
      for (const status of ['no_show', 'completed']) {
        const edit = await callCapturingLogs({ id: String(idG), status });
        check(edit.location.endsWith('?saved=1'), `a ${status} edit saves`);
        check(
          !anyMute(idG).test(edit.logs),
          `and a ${status} edit mails the customer nothing — it crosses no boundary`,
        );
      }

      // `completed → cancelled` DOES cross it, and does mail them (the
      // direction-of-crossing rule inherited from BK-14, recorded as a decision
      // in BK-16's assumptions log rather than discovered here).
      const fromCompleted = await callCapturingLogs({ id: String(idG), status: 'cancelled' });
      check(fromCompleted.location.endsWith('?saved=1'), 'completed → cancelled saves');
      check(
        muteLine(idG, 'cancel', 'customer').test(fromCompleted.logs),
        'and mails the customer the cancellation — the rule is the boundary, not the status pair',
      );

      // A BLANK EMAIL IS NOT AN ADDRESS, and this is the half of the guard a
      // NULL column cannot exercise: `if (row.email)` alone is already false
      // for NULL, so the `.trim() !== ''` the resend route contributed
      // (plan-review N2) is only load-bearing for a present-but-blank value.
      // Written straight to the column, because `parseAdminEntry` normalizes a
      // blank to NULL and so cannot produce this row — which is exactly why a
      // row like it can exist from some other writer.
      await sql`UPDATE appointments SET email = '   ' WHERE id = ${idG}`;
      const blankEmail = await callCapturingLogs({ id: String(idG), status: 'confirmed' });
      check(blankEmail.location.endsWith('?saved=1'), 'a boundary crossing on a blank-email row saves');
      check(
        muteLine(idG, 'request', 'office').test(blankEmail.logs),
        'and the office still gets its invite',
      );
      check(
        !muteLine(idG, 'request', 'customer').test(blankEmail.logs),
        'but a whitespace-only email is not mailed — Resend would report that as a failed send',
      );
    }

    // 5. The 23505 arm. Cancel this row, take its slot, then try to un-cancel:
    //    the statement throws, the row is untouched, and nothing is sent —
    //    which matters because a CANCEL for a booking that is still live would
    //    clear an event the crew is expected at.
    await call(updateRoute, { id: String(idE), status: 'cancelled' });
    const stealer = await call(createRoute, entryFields({ slot_time: '14:30', name: 'BK-14 stealer' }));
    const idF = idFromLocation(stealer);
    check(idF !== null, `the freed slot was taken, got "${stealer}"`);
    if (idF !== null) createdIds.push(idF);

    const conflicted = await callCapturingLogs({ id: String(idE), status: 'confirmed' });
    check(
      conflicted.location.endsWith('?saved=conflict'),
      `the collision is still reported, got "${conflicted.location}"`,
    );
    check((await read(idE))?.status === 'cancelled', 'the row stays cancelled');
    check(
      !anyMute(idE).test(conflicted.logs),
      'and NOTHING was sent — the statement threw before any send',
    );

    // A well-formed id matching nothing sends nothing either.
    const vanished = await callCapturingLogs({ id: '2147483647', status: 'cancelled' });
    check(vanished.location.includes('saved=missing'), 'a vanished appointment is still reported');
    check(!ANY_INVITE.test(vanished.logs), 'and sends nothing');
  }

  // -------------------------------------------------------------------------
  console.log('Lead replies: send THEN stamp, never the other way (BK-10 AC2)');
  // -------------------------------------------------------------------------
  // The defect this closes shipped for months: `api/admin/reply.ts` awaited an
  // unchecked `resend.emails.send(...)` and stamped `status = 'replied'` on the
  // next line — and the SDK RESOLVES on failure rather than throwing. A bounced
  // key marked the lead answered and showed the office `?success=1`, while the
  // customer got nothing.
  //
  // LIB-LEVEL, through the extracted helper's injected send. The mute is lifted
  // for this scope alone — with an injected `deps.send` the real adapter is
  // never constructed, so no key is read and no mail can leave — and restored
  // in the finally, because the route calls below run under it.
  const [replyLead] = (await sql`
    INSERT INTO leads (name, phone, email, service, message)
    VALUES (${LEAD_MARKER}, '7805550142', 'bk10-verify@example.com', NULL, 'verification')
    RETURNING id
  `) as { id: number }[];
  createdLeadIds.push(replyLead.id);

  // The row is seeded with a NULL service on purpose: post-migration-004 that
  // is the ordinary case, and it is what the template guard exists for.
  const seededLead = (await sql`
    SELECT status, service FROM leads WHERE id = ${replyLead.id}
  `) as { status: string; service: string | null }[];
  check(seededLead[0]?.service === null, 'the fixture lead has a NULL service (migration 004)');
  check(seededLead[0]?.status === 'new', 'and starts unanswered');

  type LeadRow = { status: string; replied_at: Date | null };
  const readLead = async (id: number): Promise<LeadRow | null> => {
    const rows = (await sql`SELECT status, replied_at FROM leads WHERE id = ${id}`) as LeadRow[];
    return rows[0] ?? null;
  };
  const resetLead = async () => {
    await sql`UPDATE leads SET status = 'new', replied_at = NULL WHERE id = ${replyLead.id}`;
  };

  const replyInput = {
    leadId: replyLead.id,
    to: 'bk10-verify@example.com',
    subject: 'Re: your message',
    body: 'Hi Dana,\n\nThanks for getting in touch.',
  };

  {
    delete process.env.BOOKING_NOTIFY_DISABLED;
    try {
      // 1. A successful send stamps, once.
      await resetLead();
      const delivered: { to: string; subject: string }[] = [];
      const sent = await sendReplyAndStamp(sql, replyInput, {
        send: async (m) => {
          delivered.push({ to: m.to, subject: m.subject });
          return { ok: true };
        },
      });
      check(sent === 'sent', `a successful send reports sent, got ${sent}`);
      check(delivered.length === 1, `exactly one message left, got ${delivered.length}`);
      check(delivered[0]?.to === 'bk10-verify@example.com', 'addressed to the lead');
      const afterSent = await readLead(replyLead.id);
      check(afterSent?.status === 'replied', 'the lead is marked replied');
      check(afterSent?.replied_at != null, 'and replied_at is stamped');

      // 2. A RESOLVED error stamps NOTHING. This is the mutation the old route
      //    got wrong: remove the `if (outcome === 'failed') return` guard in
      //    `sendReplyAndStamp` and this goes red.
      await resetLead();
      const failed = await sendReplyAndStamp(sql, replyInput, {
        send: async () => ({ ok: false, error: 'validation_error: API key is invalid' }),
      });
      check(failed === 'failed', `a resolved error reports failed, got ${failed}`);
      const afterFailed = await readLead(replyLead.id);
      check(afterFailed?.status === 'new', 'the lead stays unanswered');
      check(afterFailed?.replied_at === null, 'and replied_at stays NULL');

      // 3. A throwing sender is caught rather than escaping into the route.
      await resetLead();
      const threw = await sendReplyAndStamp(sql, replyInput, {
        send: async () => {
          throw new Error('socket hang up');
        },
      });
      check(threw === 'failed', `a throwing sender reports failed, got ${threw}`);
      check((await readLead(replyLead.id))?.replied_at === null, 'and stamps nothing');

      // 4. No key is its own arm — a logged failure, not a throw. The route it
      //    replaced threw a bare Error here and 500'd a redirect-only page.
      await resetLead();
      const noKey = await sendReplyAndStamp(sql, replyInput, { send: null });
      check(noKey === 'failed', `a missing key reports failed, got ${noKey}`);
      check((await readLead(replyLead.id))?.status === 'new', 'and leaves the lead unanswered');

      // 5. The mute reports `skipped` and DOES stamp — the pinned test-only row
      //    that makes the route-level success path below reachable.
      process.env.BOOKING_NOTIFY_DISABLED = '1';
      await resetLead();
      const muted = await sendReplyAndStamp(sql, replyInput, {
        send: async () => ({ ok: true }),
      });
      check(muted === 'skipped', `the mute reports skipped, got ${muted}`);
      check(
        (await readLead(replyLead.id))?.status === 'replied',
        'and a skip still stamps — the pinned row',
      );
    } finally {
      // Restored before anything calls a route again.
      process.env.BOOKING_NOTIFY_DISABLED = '1';
    }
  }

  // -------------------------------------------------------------------------
  console.log('The reply route: slashed redirects and the right flash (BK-10 AC2, AC6)');
  // -------------------------------------------------------------------------
  // ROUTE-LEVEL, under the mute — so only the `skipped` arm is reachable, which
  // is exactly why the arms above live lib-level. What this half contributes is
  // the parse, the lookup, and every Location header.
  {
    await resetLead();
    const success = await call(replyRoute, {
      leadId: String(replyLead.id),
      subject: 'Re: your message',
      body: 'Hello.',
    });
    check(
      success === `/admin/leads/${replyLead.id}/?success=1`,
      `a muted send answers a SLASHED success redirect, got "${success}"`,
    );
    check((await readLead(replyLead.id))?.status === 'replied', 'and the lead is stamped');

    const validation = await call(replyRoute, { leadId: 'abc', subject: '', body: '' });
    check(
      validation === '/admin/?error=validation',
      `a malformed submit redirects to the SLASHED list, got "${validation}"`,
    );

    const missing = await call(replyRoute, {
      leadId: '2147483647',
      subject: 'Hi',
      body: 'There.',
    });
    check(
      missing === '/admin/',
      `a lead that does not exist redirects to the SLASHED list, got "${missing}"`,
    );

    const [noEmailLead] = (await sql`
      INSERT INTO leads (name, phone, email, service, message)
      VALUES (${`${LEAD_MARKER} no-email`}, '7805550143', NULL, NULL, 'verification')
      RETURNING id
    `) as { id: number }[];
    createdLeadIds.push(noEmailLead.id);
    const noEmail = await call(replyRoute, {
      leadId: String(noEmailLead.id),
      subject: 'Hi',
      body: 'There.',
    });
    check(
      noEmail === `/admin/leads/${noEmailLead.id}/?error=noemail`,
      `a lead with no email is refused, slashed, got "${noEmail}"`,
    );
    check(
      (await readLead(noEmailLead.id))?.status === 'new',
      'and is not stamped as replied',
    );

    // Every Location this route can produce is slashed. Four arms — the ROADMAP
    // said three, and the count was taken by eye.
    for (const [label, location] of [
      ['success', success],
      ['validation', validation],
      ['missing', missing],
      ['no email', noEmail],
    ] as const) {
      const path = location.split('?')[0];
      check(path.endsWith('/'), `the ${label} redirect path is slashed, got "${path}"`);
    }

    // The FAILED arm at ROUTE level (implementation-review should-fix): under
    // the mute this route reaches only `skipped`, so its mapping of `failed`
    // to ?error=sendfailed — and NOT stamping — was unobserved by any gate.
    // Mute off + no key in reach = `failed` with nothing sendable.
    await resetLead();
    delete process.env.BOOKING_NOTIFY_DISABLED;
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const failed = await call(replyRoute, {
        leadId: String(replyLead.id),
        subject: 'Re: your message',
        body: 'This cannot send — no key is reachable.',
      });
      check(
        failed === `/admin/leads/${replyLead.id}/?error=sendfailed`,
        `a failed send redirects to ?error=sendfailed, slashed, got "${failed}"`,
      );
      check(
        (await readLead(replyLead.id))?.status === 'new',
        'and the lead is NOT stamped replied — send-then-stamp holds at the route too',
      );
    } finally {
      process.env.BOOKING_NOTIFY_DISABLED = '1';
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    }
  }

  // -------------------------------------------------------------------------
  console.log('Blackout days round-trip through the public availability read (AC8)');
  // -------------------------------------------------------------------------
  const openDay = await findOpenDay();
  if (!openDay) {
    console.error('  ✗ no open day in the current 14-day window — cannot run the blackout check.');
    failures++;
  } else {
    touchedDays.push(openDay);
    const added = await call(blackoutAdd, { day: openDay, reason: MARKER });
    check(added.endsWith('?added=1'), `the day was closed, got "${added}"`);

    const rows = (await sql`
      SELECT day::text AS day, reason FROM blackout_dates WHERE day = ${openDay}::date
    `) as { day: string; reason: string | null }[];
    check(rows.length === 1, `one blackout row exists, got ${rows.length}`);
    check(
      rows[0]?.day === openDay,
      `and it is stored on the day that was typed — a ::date parsed as an instant lands a day early (got ${rows[0]?.day})`,
    );
    check(rows[0]?.reason === MARKER, 'with its reason');

    check(!(await dayIsOffered(openDay)), 'the public calendar no longer offers that day');

    // Idempotent: the office double-submitting a holiday updates the reason
    // rather than erroring.
    const again = await call(blackoutAdd, { day: openDay, reason: `${MARKER} again` });
    check(again.endsWith('?added=1'), 'adding the same day twice is not an error');
    const afterSecond = (await sql`
      SELECT reason FROM blackout_dates WHERE day = ${openDay}::date
    `) as { reason: string | null }[];
    check(afterSecond.length === 1, `still exactly one row, got ${afterSecond.length}`);
    check(afterSecond[0]?.reason === `${MARKER} again`, 'and the reason was updated');

    const removed = await call(blackoutDelete, { day: openDay });
    check(removed.endsWith('?removed=1'), `the day was reopened, got "${removed}"`);
    const gone = (await sql`
      SELECT day FROM blackout_dates WHERE day = ${openDay}::date
    `) as unknown[];
    check(gone.length === 0, 'the row is gone');
    check(await dayIsOffered(openDay), 'and the public calendar offers that day again');

    // Deleting again is a no-op, not an error — two clicks on one button.
    const twice = await call(blackoutDelete, { day: openDay });
    check(twice.endsWith('?removed=1'), 'deleting a day that is not blacked out is a no-op');

    // A malformed day never reaches the DELETE.
    const bad = await call(blackoutDelete, { day: '25-12-2026' });
    check(bad.includes('err='), `a malformed day is rejected, got "${bad}"`);
  }

  // -------------------------------------------------------------------------
  console.log('The file proxy serves claimed rows and nothing else (BK-09 AC2)');
  // -------------------------------------------------------------------------
  // Two fixtures that differ in ONE column. `appointment_id IS NOT NULL` is the
  // entire access rule for the admin file proxy, and it is checked here against
  // real rows because it lives in SQL — `scripts/verify-booking-files.ts` drives
  // the signing logic with fakes and never sees a database.
  //
  // Both the route and this script call the SAME `claimedFilePathname`. That is
  // the plan-review blocker: a script-side copy of the query would stay green
  // while the production statement lost its claimed-only clause, which is the
  // one regression this section exists to catch.
  const claimedPath = `${FILE_PREFIX}claimed.jpg`;
  const unclaimedPath = `${FILE_PREFIX}unclaimed.jpg`;
  const DRAFT_ID = '9f1c8a20-3c4e-4f1a-9c1e-2b7d5a6e4f30';

  const [claimedRow] = (await sql`
    INSERT INTO appointment_files
      (appointment_id, draft_id, pathname, content_type, size_bytes, original_name, upload_state)
    VALUES
      (${idA}, ${DRAFT_ID}::uuid, ${claimedPath}, 'image/jpeg', 2048, 'claimed.jpg', 'uploaded')
    RETURNING id
  `) as { id: number }[];
  createdFileIds.push(claimedRow.id);

  const [unclaimedRow] = (await sql`
    INSERT INTO appointment_files
      (appointment_id, draft_id, pathname, content_type, size_bytes, original_name, upload_state)
    VALUES
      (NULL, ${DRAFT_ID}::uuid, ${unclaimedPath}, 'image/jpeg', 4096, 'unclaimed.jpg', 'uploaded')
    RETURNING id
  `) as { id: number }[];
  createdFileIds.push(unclaimedRow.id);

  check(
    (await claimedFilePathname(sql, claimedRow.id)) === claimedPath,
    'a claimed file resolves to its pathname',
  );
  check(
    (await claimedFilePathname(sql, unclaimedRow.id)) === null,
    'an UNCLAIMED draft upload is invisible to the proxy — it belongs to no booking',
  );
  check(
    (await claimedFilePathname(sql, 2147483647)) === null,
    'and an id that matches nothing resolves to nothing',
  );

  // BK-40's soft delete, against a real row and through the SAME function the
  // route calls — for the reason above: a script-side copy of the query would
  // stay green while the production statement lost the clause.
  //
  // THIS IS THE ASSERTION THAT MAKES "DELETED" MEAN SOMETHING. Soft delete
  // leaves the bytes in the Blob store on purpose, so the row is the only thing
  // standing between a removed file and a signed URL for it. If this clause
  // were enforced only in the template, a link the office had already opened —
  // or one still in their history — would keep working after they removed the
  // file, which is not what the person pressing the button means by "remove".
  const deletedPath = `${FILE_PREFIX}deleted.jpg`;
  const [deletedRow] = (await sql`
    INSERT INTO appointment_files
      (appointment_id, draft_id, pathname, content_type, size_bytes, original_name,
       upload_state, source, deleted_at, deleted_note)
    VALUES
      (${idA}, ${DRAFT_ID}::uuid, ${deletedPath}, 'image/jpeg', 1024, 'deleted.jpg',
       'uploaded', 'link', now(), 'wrong appointment')
    RETURNING id
  `) as { id: number }[];
  createdFileIds.push(deletedRow.id);

  check(
    (await claimedFilePathname(sql, deletedRow.id)) === null,
    'a REMOVED file is invisible to the proxy, even though its bytes are still in the store',
  );

  check(
    (await getFile(String(deletedRow.id))).status === 404,
    'and the route 404s it rather than signing a URL',
  );

  // The CHECK constraint is the guard against a fourth spelling of provenance
  // arriving through some future code path and rendering as nothing at all.
  let constraintHeld = false;
  try {
    await sql`
      INSERT INTO appointment_files
        (appointment_id, draft_id, pathname, content_type, size_bytes, source)
      VALUES
        (${idA}, ${DRAFT_ID}::uuid, ${`${FILE_PREFIX}bogus.jpg`}, 'image/jpeg', 1, 'sms')
    `;
  } catch {
    constraintHeld = true;
  }
  check(constraintHeld, 'migration 006 refuses a source outside web/link/office');

  // NULL is what every row written before migration 006 holds, and the page
  // renders it as "source not recorded" rather than guessing one of the three.
  //
  // THE COLUMN IS OMITTED, NOT SET TO NULL, and that is the whole assertion.
  // The first version passed `source` explicitly as NULL — which beats any
  // column default, so migration 006 gaining `DEFAULT 'web'` (i.e. Assumption 1
  // being violated, and every pre-006 row silently acquiring a provenance
  // nobody recorded) would have left it green. Only `NOT NULL` could have
  // reddened it. Omitting the column is what actually tests the default.
  // Found in implementation review.
  const [nullSourceRow] = (await sql`
    INSERT INTO appointment_files
      (appointment_id, draft_id, pathname, content_type, size_bytes)
    VALUES
      (${idA}, ${DRAFT_ID}::uuid, ${`${FILE_PREFIX}nosource.jpg`}, 'image/jpeg', 1)
    RETURNING id, source
  `) as { id: number; source: string | null }[];
  createdFileIds.push(nullSourceRow.id);
  check(
    nullSourceRow.source === null,
    'a row that names no source defaults to NULL — migration 006 must not invent one',
  );

  // BIGINT arrives from the driver as a string however db.ts types it. Pinned
  // here against a real row, because this ticket owns that correction and the
  // pure scripts hand-build their fixtures.
  const [sizeRow] = (await sql`
    SELECT size_bytes FROM appointment_files WHERE id = ${claimedRow.id}
  `) as { size_bytes: unknown }[];
  check(
    typeof sizeRow.size_bytes === 'string',
    `size_bytes comes back as a string, got ${typeof sizeRow.size_bytes} — db.ts must not type it number`,
  );

  // Now the route itself, which contributes the id parse, the 404 mapping and
  // the wiring. The id is its ENTIRE input: there is no pathname to pass.
  async function getFile(id: string): Promise<Response> {
    return fileRoute({ params: { id } } as never);
  }

  for (const [label, badId] of [
    ['non-numeric', 'abc'],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-3'],
    ['past int4', '9999999999'],
  ] as const) {
    const res = await getFile(badId);
    check(res.status === 404, `a ${label} id 404s rather than reaching Postgres, got ${res.status}`);
  }

  // Leading zeros, checked against THIS RUN'S CLAIMED ROW rather than a made-up
  // number. `/api/admin/files/0000000012/` and `.../12/` would otherwise be two
  // URLs for one file, and a link a shared cache has already stored under one
  // spelling is a capability that outlives the other. Pinned to a row that
  // definitely exists because the red pass showed the made-up-id version passes
  // for the wrong reason — a loosened parser plus an id nothing matches also
  // 404s, so the assert was contingent on the dev branch's contents.
  const paddedRes = await getFile(`0${claimedRow.id}`);
  check(
    paddedRes.status === 404,
    `a zero-padded id for a REAL claimed row still 404s, got ${paddedRes.status}`,
  );

  check((await getFile('2147483647')).status === 404, 'an unknown id 404s');

  const unclaimedRes = await getFile(String(unclaimedRow.id));
  check(
    unclaimedRes.status === 404,
    `an unclaimed file 404s rather than being signed, got ${unclaimedRes.status}`,
  );
  check(
    !unclaimedRes.headers.get('Location'),
    'and answers no Location — a 404 that still redirected would be the whole bug',
  );

  // The unset-token 502, driven for a CLAIMED row so the 404 arms above cannot
  // be what produces it. Under tsx there is no import.meta.env, so removing the
  // process.env value is enough to make readEnv report it unset.
  const savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const res = await getFile(String(claimedRow.id));
    check(
      res.status === 502,
      `an unconfigured store token is a 502, not a 500 and not a 404, got ${res.status}`,
    );
    check(!res.headers.get('Location'), 'and nothing is redirected to');
  } finally {
    if (savedToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = savedToken;
  }
  check(
    process.env.BLOB_READ_WRITE_TOKEN === savedToken,
    'and the token is restored for anything that runs after this',
  );

  // The live 302 is deliberately NOT driven here: it would call the Blob
  // control API for real, and this script's contract is the dev database.
  // `verify:booking:files` covers the signing arguments; the post-deploy check
  // in the ticket covers the round trip.
  // ---------------------------------------------------------------------------
  console.log('\nBK-23 — approve and decline, against the real route');
  // ---------------------------------------------------------------------------
  //
  // THE GUARDED UPDATE IS WHAT THIS EXISTS FOR. Every transition is
  // `WHERE id = $1 AND status = 'pending_review'`, and zero rows returned means
  // the decision was not this caller's to make. A double-click, a second tab, and
  // a decline racing an approve all land there. Getting that wrong does not
  // corrupt a row — it sends the customer a second email, or an approval for a
  // booking somebody already declined.
  {
    const REVIEW_DATE = '2029-06-12';

    const makeRequest = async (time: string, over: Record<string, string> = {}) => {
      const location = await call(
        createRoute,
        entryFields({
          slot_date: REVIEW_DATE,
          slot_time: time,
          name: `BK-23 review ${time}`,
          email: 'bk23-verify@example.com',
          assessment_tier: 'standard',
          ...over,
        }),
      );
      const id = idFromLocation(location);
      if (id !== null) createdIds.push(id);
      return id;
    };

    // --- APPROVE REFUSES A SLOT THAT HAS ALREADY PASSED ----------------------
    //
    // Task 4's auto-decline at slot-4h is what would normally make this
    // unreachable, and it is not built. Without an equivalent on the built
    // path, a request nobody reviewed in time could still be approved days
    // later — emailing "please pay as soon as you can" for a visit that has
    // been and gone, and under BK-32 opening a live Checkout Session for it.
    //
    // Inserted directly rather than through the create route, because every
    // door refuses a past slot and the point is to reach the row a lapsed
    // request BECOMES by sitting there.
    {
      const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const inserted = (await sql`
        INSERT INTO appointments (name, phone, email, service, address, payment_route,
                                  slot_start, status, assessment_tier)
        VALUES ('Elapsed Probe', '780-555-0199', 'elapsed@example.com', 'water', '1 Past St',
                'private', ${past.toISOString()}, 'pending_review', 'standard')
        RETURNING id
      `) as { id: number }[];
      const elapsedId = inserted[0]?.id;
      check(elapsedId !== undefined, 'a lapsed request was constructed');
      if (elapsedId !== undefined) {
        createdIds.push(elapsedId);
        const location = await call(reviewRoute, { id: String(elapsedId), action: 'approve' });
        check(
          location.includes('review=elapsed'),
          `approving a slot in the past is refused, got "${location}"`,
        );

        const after = (await sql`
          SELECT status, approved_at, assessment_amount_cents, payment_status
          FROM appointments WHERE id = ${elapsedId}
        `) as Record<string, unknown>[];
        check(after[0]?.status === 'pending_review', 'and the row does not transition');
        check(after[0]?.approved_at === null, 'nothing is stamped');
        check(after[0]?.assessment_amount_cents === null, 'and no amount is written');
        check(
          after[0]?.payment_status === 'not_required',
          'and payment_status is untouched — a refusal must change nothing',
        );
      }
    }

    // --- APPROVE -------------------------------------------------------------
    const approveId = await makeRequest('11:30');
    check(approveId !== null, 'a request to approve was created');
    if (approveId !== null) {
      const before = await read(approveId);
      check(before?.status === 'pending_review', 'and it starts in pending_review');

      const location = await call(reviewRoute, { id: String(approveId), action: 'approve' });
      check(
        location.includes('review=approved'),
        `approving reports success, got "${location}"`,
      );

      const row = (await sql`
        SELECT status, payment_status, approved_at, assessment_amount_cents,
               travel_fee_cents, gst_cents, total_amount_cents, payment_due_at
        FROM appointments WHERE id = ${approveId}
      `) as Record<string, unknown>[];

      check(row[0]?.status === 'approved_awaiting_payment', 'the row moves to approved_awaiting_payment');
      check(row[0]?.payment_status === 'pending', 'and payment_status becomes pending');
      check(row[0]?.approved_at !== null, 'approved_at is stamped');

      // THE AMOUNTS ARE SNAPSHOTTED, not left to be recomputed later. A price
      // change under a live row must not move a quote the customer accepted.
      check(row[0]?.assessment_amount_cents === 39900, 'the base amount is snapshotted from the table');
      check(row[0]?.travel_fee_cents === 0, 'travel defaults to zero — never applied automatically');
      check(row[0]?.gst_cents === 1995, 'GST is computed, not typed');
      check(row[0]?.total_amount_cents === 41895, 'and the total is base + travel + GST');
      check(row[0]?.payment_due_at !== null, 'a distant slot carries a real deadline');

      // THE SLOT IS STILL HELD. `approved_awaiting_payment` is not in
      // SLOT_RELEASING_STATUSES — the whole point of a deadline is that the time
      // is reserved until it lapses.
      const held = await call(
        createRoute,
        entryFields({ slot_date: REVIEW_DATE, slot_time: '11:30', name: 'BK-23 collide' }),
      );
      check(held.includes('taken=1'), 'and the slot stays held against a second booking');

      // IDEMPOTENCE. A second approve is a no-op, not a second email.
      const again = await call(reviewRoute, { id: String(approveId), action: 'approve' });
      check(again.includes('review=stale'), `a second approve is a no-op, got "${again}"`);
      const after = (await sql`
        SELECT approved_at FROM appointments WHERE id = ${approveId}
      `) as { approved_at: Date }[];
      check(
        after[0].approved_at.getTime() === (row[0].approved_at as Date).getTime(),
        'and it does not restamp approved_at',
      );

      // A DECLINE CANNOT OVERTAKE AN APPROVAL. Same guard, other action.
      const raced = await call(reviewRoute, { id: String(approveId), action: 'decline' });
      check(raced.includes('review=stale'), 'declining an already-approved row is a no-op');
      const stillApproved = await read(approveId);
      check(
        stillApproved?.status === 'approved_awaiting_payment',
        'and the row is untouched by it',
      );
    }

    // --- APPROVE WITH AN OVERRIDE AND A TRAVEL FEE ---------------------------
    const overrideId = await makeRequest('12:30', { assessment_tier: 'report' });
    if (overrideId !== null) {
      await call(reviewRoute, {
        id: String(overrideId),
        action: 'approve',
        assessment_amount: '750.00',
        travel_fee: '46.50',
      });
      const row = (await sql`
        SELECT assessment_amount_cents, travel_fee_cents, gst_cents, total_amount_cents
        FROM appointments WHERE id = ${overrideId}
      `) as Record<string, number>[];
      check(row[0]?.assessment_amount_cents === 75000, 'an admin override replaces the suggested base');
      check(row[0]?.travel_fee_cents === 4650, 'and the typed travel fee is stored');
      // GST on base + travel, one rounding. 79650 * 5% = 3982.5 → 3983.
      check(row[0]?.gst_cents === 3983, 'GST is recomputed on the overridden subtotal');
      check(row[0]?.total_amount_cents === 83633, 'and the total adds up');
    }

    // --- A BAD AMOUNT CHANGES NOTHING ----------------------------------------
    const badId = await makeRequest('13:30');
    if (badId !== null) {
      const refused = await call(reviewRoute, {
        id: String(badId),
        action: 'approve',
        assessment_amount: '399abc',
      });
      check(refused.includes('review=amount'), `a malformed amount is refused, got "${refused}"`);
      const row = await read(badId);
      check(
        row?.status === 'pending_review',
        'and the row is left in pending_review — a refusal must not half-approve',
      );
    }

    // --- NO TIER, NO APPROVAL ------------------------------------------------
    const noTierId = await makeRequest('14:30', { assessment_tier: '' });
    if (noTierId !== null) {
      const refused = await call(reviewRoute, { id: String(noTierId), action: 'approve' });
      check(refused.includes('review=notier'), `no tier means no amount, so no approval, got "${refused}"`);
      check((await read(noTierId))?.status === 'pending_review', 'and nothing changed');

      // ...but it can still be declined. A request the office cannot price is
      // one they may well want to turn down.
      const declined = await call(reviewRoute, { id: String(noTierId), action: 'decline' });
      check(declined.includes('review=declined'), `an unpriced request can still be declined, got "${declined}"`);
      check((await read(noTierId))?.status === 'declined', 'and it lands in declined');
    }

    // --- DECLINE RELEASES THE SLOT -------------------------------------------
    const declineId = await makeRequest('15:30');
    if (declineId !== null) {
      await call(reviewRoute, { id: String(declineId), action: 'decline' });
      const row = (await sql`
        SELECT status, declined_at FROM appointments WHERE id = ${declineId}
      `) as { status: string; declined_at: Date | null }[];
      check(row[0]?.status === 'declined', 'declining moves the row to declined');
      check(row[0]?.declined_at !== null, 'and stamps declined_at');

      // THE SLOT IS BACK ON THE MARKET, through the real index rather than a
      // separate release step: `declined` is in SLOT_RELEASING_STATUSES, so the
      // row falls out of the partial unique index the moment it commits.
      const rebooked = await call(
        createRoute,
        entryFields({ slot_date: REVIEW_DATE, slot_time: '15:30', name: 'BK-23 rebook' }),
      );
      const rebookedId = idFromLocation(rebooked);
      check(rebookedId !== null, `the declined slot can be booked again, got "${rebooked}"`);
      if (rebookedId !== null) createdIds.push(rebookedId);
    }

    // --- A BAD ACTION IS NOT A DECISION --------------------------------------
    const bogus = await call(reviewRoute, { id: String(approveId ?? 1), action: 'confirm' });
    check(bogus.includes('review=invalid'), `an unrecognised action is refused, got "${bogus}"`);

    console.log('  approve, decline, override, refusals, and both idempotence guards');
  }

  // -------------------------------------------------------------------------
  console.log('\nThe expiry cron: two sweeps, one handler (BK-32 + BK-23 Task 4)');
  // -------------------------------------------------------------------------
  //
  // The verification BK-23 Task 4 named as mandatory, plus the payment sweep's
  // one rule that must never regress.
  {
    const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

    // A pending_review request is expired only once its slot is inside
    // slot - PAYMENT_DEADLINE_LEAD_HOURS. Both sides of that boundary, because
    // an off-by-one here either strands requests forever or kills live ones.
    const seed = async (
      status: string,
      slotAt: Date,
      extra: { paymentDueAt?: Date | null; notes?: string | null } = {},
    ): Promise<number> => {
      const rows = (await sql`
        INSERT INTO appointments (
          name, phone, email, service, address, payment_route,
          slot_start, status, assessment_tier, payment_due_at, admin_notes
        ) VALUES (
          ${`${MARKER} expiry`}, '780-555-0111', 'expiry@example.com', 'water', '1 Expiry St',
          'private', ${slotAt.toISOString()}, ${status}, 'standard',
          ${extra.paymentDueAt ? extra.paymentDueAt.toISOString() : null},
          ${extra.notes ?? null}
        )
        RETURNING id
      `) as { id: number }[];
      createdIds.push(rows[0].id);
      return rows[0].id;
    };

    // INSIDE the window — must expire.
    const staleId = await seed('pending_review', hours(1));
    // OUTSIDE it by an hour — must be left alone. This is the arm that would
    // catch a sweep that expired everything pending.
    const freshId = await seed('pending_review', hours(5));
    // The office's own note must survive the audit line being appended.
    const notedId = await seed('pending_review', hours(1), { notes: 'Office: customer called.' });

    // Not this sweep's business, in both directions.
    const awaitingOverdue = await seed('approved_awaiting_payment', hours(1), {
      paymentDueAt: hours(-1),
    });
    // THE PAY-NOW ROW. A NULL deadline must NEVER be treated as overdue: it is
    // the near-term branch, and expiring it would auto-cancel every emergency
    // and every next-day booking within 15 minutes of approval.
    const payNow = await seed('approved_awaiting_payment', hours(1), { paymentDueAt: null });
    const confirmedRow = await seed('confirmed', hours(1));

    // THE ROW WITH A LIVE CHECKOUT SESSION (BK-32).
    //
    // Expiring the row releases the slot, but the Stripe link stays payable
    // until its own `expires_at` — so a customer can pay for a time somebody
    // else may already have booked. This is the open dependency the ROADMAP
    // records against this ticket, and one call per expired row closes it.
    //
    // Observable WITHOUT a Stripe key, which is what makes it assertable here:
    // `expireCheckoutSession` returns false when nothing is configured, so the
    // handler counts it under `sessionsUncancelled`. A non-zero count proves the
    // sweep REACHED Stripe for that row; deleting the loop takes it to zero.
    await sql`
      UPDATE appointments SET stripe_session_id = ${'cs_test_cronprobe0001'}
      WHERE id = ${awaitingOverdue}
    `;
    // A SECOND overdue row with NO session — an approval that fell back to the
    // Interac route. Without it the sweep expires exactly one row and "call
    // Stripe for the row that has a session" is indistinguishable from "call
    // Stripe for every row"; a deliberate break to the latter stayed green on
    // one row, which is how this fixture earned its place.
    const overdueNoSession = await seed('approved_awaiting_payment', hours(2), {
      paymentDueAt: hours(-1),
    });

    const res = await expiryCron({
      request: new Request('https://example.com/api/cron/expire-payments/', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    } as never);
    check(res.status === 200, `the cron answers 200, got ${res.status}`);
    const counts = (await res.json()) as Record<string, number>;

    check(await statusOf(staleId) === 'declined', 'a stale request inside slot-4h is declined');
    check(
      await statusOf(freshId) === 'pending_review',
      'a request still outside slot-4h is left alone — the boundary is a window, not a sweep-everything',
    );
    check(
      await statusOf(awaitingOverdue) === 'payment_expired',
      'an overdue payment expires',
    );
    check(
      await statusOf(payNow) === 'approved_awaiting_payment',
      'a PAY-NOW row (NULL payment_due_at) is NEVER expired — it has no deadline to be past',
    );
    check(await statusOf(confirmedRow) === 'confirmed', 'a confirmed booking is untouched');
    // A FLOOR, not an equality. Earlier arms in this script leave their own
    // `pending_review` rows behind, and the sweep correctly takes any of them
    // that are inside the window — including the deliberately-elapsed row the
    // S3 arm seeds. Pinning an exact count here would fail whenever another arm
    // is added, which is a test that breaks for being right.
    check(
      counts.requestsExpired >= 2,
      `at least the two seeded stale requests expired, got ${counts.requestsExpired}`,
    );
    check(counts.paymentsExpired === 2, `both overdue payments expired, got ${counts.paymentsExpired}`);
    check(
      await statusOf(overdueNoSession) === 'payment_expired',
      'including the one that never had a card link',
    );

    // The sweep tried to kill the link. It cannot succeed without a Stripe key,
    // and that is exactly why the ATTEMPT is what gets asserted — the count is
    // zero if the loop is not there at all.
    check(
      (counts.sessionsCancelled ?? 0) + (counts.sessionsUncancelled ?? 0) === 1,
      `the sweep reached Stripe ONCE — for the row holding a session and not for the one without, got ${JSON.stringify({
        cancelled: counts.sessionsCancelled,
        uncancelled: counts.sessionsUncancelled,
      })}`,
    );
    // And it did NOT try for the rows with no session — a call per expired row
    // regardless would be a call per row for nothing, every fifteen minutes.
    check(
      (counts.sessionsCancelled ?? 0) === 0,
      'with nothing reported cancelled, since no key is configured in this harness',
    );

    // The system actor is RECORDED, not inferred, and does not eat the office's
    // note. BK-40's repair of this exact idiom is why both halves are asserted.
    const noted = (await sql`
      SELECT admin_notes, declined_at FROM appointments WHERE id = ${notedId}
    `) as { admin_notes: string | null; declined_at: Date | null }[];
    check(
      noted[0]?.admin_notes?.includes('Office: customer called.') === true,
      "the office's own note survives",
    );
    check(
      noted[0]?.admin_notes?.includes('Auto-declined by the expiry sweep') === true,
      'and the system actor is recorded beside it',
    );
    check(noted[0]?.declined_at !== null, 'declined_at is stamped');

    // THE SLOT IS GENUINELY BACK — asserted against SLOT_HOLD_PREDICATE, the
    // exact fragment the partial unique index and the availability query are
    // both built from, rather than against the status string.
    //
    // NOT against the public calendar, and the reason is worth stating: every
    // row this sweep touches is by definition within four hours of its slot,
    // and the next-day-earliest notice rule means such a slot is never offered
    // publicly whether it is held or free. An availability assertion here would
    // pass identically before and after the release — a check that cannot fail.
    // What "released" actually means is that the slot stops matching the hold
    // predicate, which is what frees it for the office to rebook by phone and
    // what stops it blocking the index.
    const staleRow = (await sql`
      SELECT slot_start FROM appointments WHERE id = ${staleId}
    `) as { slot_start: Date }[];
    const stillHeld = (await sql`
      SELECT id FROM appointments
      WHERE slot_start = ${staleRow[0].slot_start.toISOString()}
        AND ${sql.unsafe(SLOT_HOLD_PREDICATE)}
    `) as { id: number }[];
    check(
      stillHeld.length === 0,
      `the expired request no longer holds its slot (${stillHeld.length} row(s) still hold it)`,
    );

    // And the proof that the check above can fail: the row that was NOT expired
    // is still holding its own slot.
    const freshRow = (await sql`
      SELECT slot_start FROM appointments WHERE id = ${freshId}
    `) as { slot_start: Date }[];
    const freshHeld = (await sql`
      SELECT id FROM appointments
      WHERE slot_start = ${freshRow[0].slot_start.toISOString()}
        AND ${sql.unsafe(SLOT_HOLD_PREDICATE)}
    `) as { id: number }[];
    check(
      freshHeld.some((r) => r.id === freshId),
      'while the request that was left alone still holds its slot — so the check above is discriminating',
    );

    // A SECOND RUN IS A NO-OP. The guarded update is what makes the office
    // approving mid-sweep safe, and this is the observable half of it.
    const second = (await (
      await expiryCron({
        request: new Request('https://example.com/api/cron/expire-payments/', {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        }),
      } as never)
    ).json()) as Record<string, number>;
    check(
      second.requestsExpired === 0 && second.paymentsExpired === 0,
      `a second run expires nothing, got ${JSON.stringify(second)}`,
    );

    // And it will not run at all without the secret.
    const unauthorized = await expiryCron({
      request: new Request('https://example.com/api/cron/expire-payments/'),
    } as never);
    check(unauthorized.status === 401, `an unauthenticated call is refused, got ${unauthorized.status}`);

    console.log('  both sweeps, the pay-now exemption, the audit line, and the released slot');
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-32 — layer 1 CLAIMS an event, and this is executed, not read');
  // -------------------------------------------------------------------------
  //
  // THE IMPLEMENTATION REVIEW CAUGHT THIS AS THE NINTH CANNOT-FAIL ASSERTION.
  // Layer 1 was pinned only by two regexes over `webhook.ts` — nothing anywhere
  // created, inserted into or queried `stripe_events`, so the claim SQL had
  // never once been executed. Those pins pass unchanged if the statement is
  // syntactically broken, if `RETURNING` is dropped, or if the zero-row branch
  // is inverted. They pinned the SHAPE of the code they were asserting about,
  // which is the family this repo has now caught nine times.
  //
  // The property is the one plan-review blocker B1 existed to install, and it
  // is worth spelling out because "idempotent" is not it: **a claimed but
  // UNSTAMPED event must be claimable again**, or a handler that dies between
  // recording and confirming makes Stripe's retry a no-op — and the cron then
  // releases the slot of a booking that was paid for.
  //
  // The statement below is a byte-for-byte copy of the route's, which would
  // normally be the shared-helper smell. It is not: `webhook.ts` runs it inside
  // a signature-verified POST that cannot be reached from here, so the choice
  // is between executing the same SQL or executing none. A source pin that the
  // two agree is what keeps them honest, and it lives beside them below.
  {
    const eventId = `evt_probe_${Date.now()}`;
    const claim = async () =>
      (await sql`
        INSERT INTO stripe_events (event_id, type, received_at)
        VALUES (${eventId}, ${'checkout.session.completed'}, ${new Date().toISOString()})
        ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
          WHERE stripe_events.processed_at IS NULL
        RETURNING event_id
      `) as { event_id: string }[];

    try {
      const first = await claim();
      check(first.length === 1, 'a brand-new event is claimed');

      // THE CRASH WINDOW. The handler died here: the row exists, nothing is
      // stamped, and Stripe retries.
      const retry = await claim();
      check(
        retry.length === 1,
        'AN UNSTAMPED EVENT IS CLAIMED AGAIN — this is the payment that would otherwise be lost',
      );

      await sql`
        UPDATE stripe_events SET processed_at = ${new Date().toISOString()}
        WHERE event_id = ${eventId}
      `;

      const afterStamp = await claim();
      check(
        afterStamp.length === 0,
        'and once it is stamped, a redelivery claims nothing — the handler does no work twice',
      );

      const stored = (await sql`
        SELECT type, received_at, processed_at FROM stripe_events WHERE event_id = ${eventId}
      `) as Record<string, unknown>[];
      check(stored.length === 1, 'exactly one row exists for the event, however many deliveries');
      check(stored[0]?.type === 'checkout.session.completed', 'with the type recorded');
      check(stored[0]?.processed_at !== null, 'and processed_at stamped');
    } finally {
      await sql`DELETE FROM stripe_events WHERE event_id = ${eventId}`;
    }

    // The route must be running THIS statement. Without this the block above
    // proves Postgres works, not that the webhook uses it.
    const webhookSrc = readFileSync('src/pages/api/stripe/webhook.ts', 'utf8');
    check(
      webhookSrc.includes('ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id') &&
        webhookSrc.includes('WHERE stripe_events.processed_at IS NULL'),
      'and the webhook runs the same claim this arm just executed',
    );

    console.log('  claim, crash, re-claim, stamp, ignore — against the real database');
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-45 — the message a paying customer gets IS the one Resend sends');
  // -------------------------------------------------------------------------
  //
  // THE LOAD-BEARING PIN OF THIS TICKET, and it asserts a RELATIONSHIP rather
  // than two sets of contents. BK-44's lesson: an invariant over the whole
  // matrix caught a door no per-case assertion named. Here the door is "one of
  // the two paths gets repointed and the other does not" — which is precisely
  // the state BK-45 was filed for, and which every per-message assertion in this
  // repo was green through for a whole deploy.
  //
  // ── WHY THE MUTE COMES OFF FOR THIS ARM ───────────────────────────────────
  //
  // `BOOKING_NOTIFY_DISABLED` short-circuits `sendCalendarInvite` BEFORE it
  // consults `deps.send`, so under the mute the only observable is a log line
  // carrying no message content — which is exactly why this defect was
  // invisible. The flag comes off, a fake sender is injected, and nothing
  // reaches the network: `deps.send` is consulted before any API key is read.
  // Restored immediately after, in a `finally`, because every arm below this one
  // depends on it.
  //
  // ── WHAT THIS CANNOT CATCH, STATED ────────────────────────────────────────
  //
  // Both sides ultimately reach `planForAppointment`, so an edit to the BUILDER
  // moves both and stays green. That is the source pin's job
  // (`verify-booking-ics.ts`), and the two are complementary rather than
  // redundant: this one catches divergence, that one catches repointing.
  {
    const NOW = new Date();
    const id = await seedAwaitingPayment(65468);
    // The office edited the amount and added travel — the case where a
    // recomputed figure and the settled one disagree, which is what makes the
    // comparison below about the row rather than about the price table.
    await sql`
      UPDATE appointments
      SET assessment_amount_cents = 57750, travel_fee_cents = 4600, gst_cents = 3118,
          total_amount_cents = 65468
      WHERE id = ${id}
    `;

    const captured: Message[] = [];
    const capture = async (message: Message): Promise<SendResult> => {
      captured.push(message);
      return { ok: true };
    };

    const previousMute = process.env.BOOKING_NOTIFY_DISABLED;
    let outcome: string;
    try {
      delete process.env.BOOKING_NOTIFY_DISABLED;
      outcome = await markPaid(
        sql,
        id,
        { method: 'stripe', amountCents: 65468, reference: 'pi_rel', now: NOW },
        { send: capture },
      );
    } finally {
      if (previousMute === undefined) delete process.env.BOOKING_NOTIFY_DISABLED;
      else process.env.BOOKING_NOTIFY_DISABLED = previousMute;
    }
    check(outcome === 'confirmed', `the payment confirms, got "${outcome}"`);

    // Two sends: the office invite and the customer confirmation. The customer
    // one is identified by its recipient, never by its position — the two run
    // concurrently and the order they resolve in is not ours to depend on.
    const fromPayment = captured.find((m) => m.to === 'markpaid@example.com');
    check(
      captured.length === 2 && fromPayment !== undefined,
      `the payment path sent the office invite and a customer message, got ${captured.length}`,
    );

    // The other side: what the Resend button builds for the same row and the
    // same instant. Read back through `SELECT *` so it is the ROW that drives
    // it, exactly as `resend.ts` does.
    // THE FILE COUNT COMES FROM THE SAME SUBQUERY `resend.ts` USES, not from a
    // hardcoded 0. It reaches only `internalNotification` today, so the two are
    // identical either way — which is exactly why passing 0 would encode that
    // equivalence instead of testing it, and would leave this pin green on the
    // day anything file-related reaches the customer body. That day is the one
    // this pin exists for.
    const [row] = (await sql`
      SELECT a.*,
             (SELECT COUNT(*)::int FROM appointment_files f
               WHERE f.appointment_id = a.id AND f.deleted_at IS NULL) AS file_count
      FROM appointments a WHERE a.id = ${id}
    `) as (Appointment & { file_count: number })[];
    const fromResend = planForAppointment(
      row,
      SERVICE_LABELS[row.service] ?? row.service,
      NOW,
      row.file_count,
    ).customer;

    check(fromResend !== null, 'and the Resend button has a customer message to send for that row');

    if (fromPayment && fromResend) {
      for (const field of ['subject', 'html', 'text', 'to', 'from', 'replyTo'] as const) {
        check(
          fromPayment[field] === fromResend[field],
          `the paid message and the resent message have the same ${field}`,
        );
      }

      // THE ICS TOO, BY CONTENT AND NOT BY PRESENCE. "The calendar side works
      // today" was BK-45's stated constraint, and an attachment that is merely
      // PRESENT on both would satisfy a shape check while carrying a different
      // event.
      const a = fromPayment.attachments ?? [];
      const b = fromResend.attachments ?? [];
      check(a.length === 1 && b.length === 1, 'both carry exactly one attachment');
      check(a[0]?.filename === b[0]?.filename, 'the same attachment filename');
      check(a[0]?.contentType === b[0]?.contentType, 'the same content type, so the same METHOD');
      check(a[0]?.content === b[0]?.content, 'and a BYTE-IDENTICAL ics — same UID, same SEQUENCE');

      // AND THE ICS IS WHAT THE PAYMENT PATH SENT BEFORE THIS TICKET. The
      // builder changed; the calendar artifact must not have. Rebuilt here from
      // the pre-BK-45 expression rather than compared to itself.
      const before = buildBookingIcs(
        inviteEventFromAppointment(row, SERVICE_LABELS[row.service] ?? row.service),
        'request',
        NOW,
        icsCustomer(row.email!),
      );
      check(
        a[0]?.content === before,
        'and it is byte-identical to the ics the payment path sent before BK-45 changed the builder',
      );
    }

    // The content the ticket exists to deliver, asserted on the message that was
    // actually captured coming out of the payment route — not on a builder call.
    if (fromPayment) {
      check(
        fromPayment.html.includes(escapeHtml(HAVE_READY_HEADING)),
        'the message the payment path sent carries the have-ready list',
      );
      check(
        fromPayment.html.includes(escapeHtml(FEE_TERMS_HEADING)),
        'and the assessment terms',
      );
      check(
        fromPayment.html.includes('$654.68') && fromPayment.html.includes('$46.00'),
        'and what was actually charged, travel fee included',
      );
      check(
        !fromPayment.html.includes(escapeHtml(FEE_TERMS_INTRO)),
        'and NOT the sentence promising a payment link to a customer who has just paid',
      );
      // BK-48, asserted HERE and not only on a builder call: this is the
      // message the payment route actually handed its sender, and a receipt
      // that states a GST amount owes the number that makes it claimable.
      check(
        fromPayment.html.includes(escapeHtml(GST_REGISTRATION_LINE)),
        'and the GST registrant, on the message the payment route really sent',
      );
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-32 — markPaid, the one confirmation path, and its three no-ops');
  // -------------------------------------------------------------------------
  //
  // Every one of these goes through `markPaid` rather than through SQL, because
  // the property under test is that ONE function decides every payment outcome.
  // Mail is muted by BOOKING_NOTIFY_DISABLED, which is what the log lines the
  // route emits are read for elsewhere in this file.
  {
    const NOW = new Date();

    // ── The happy path ─────────────────────────────────────────────────────
    {
      const id = await seedAwaitingPayment(41895);
      const outcome = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_happy',
        paymentIntentId: 'pi_test_happy',
        sessionId: 'cs_test_happy0001',
        now: NOW,
      });
      check(outcome === 'confirmed', `a paid session confirms, got "${outcome}"`);

      const row = (await sql`
        SELECT status, payment_status, payment_method, paid_amount_cents, payment_reference,
               stripe_payment_intent_id, total_amount_cents, paid_at
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      check(row[0]?.status === 'confirmed', 'the status becomes confirmed');
      check(row[0]?.payment_status === 'paid', 'payment_status becomes paid');
      check(row[0]?.payment_method === 'stripe', 'the method is recorded');
      check(row[0]?.paid_at !== null, 'paid_at is stamped');
      // THE SNAPSHOT SURVIVES THE PAYMENT. What arrived goes in its own column;
      // `total_amount_cents` is what the approval settled and the email quoted,
      // and overwriting it would leave nothing to compare a receipt against.
      check(row[0]?.paid_amount_cents === 41895, 'what arrived is recorded in paid_amount_cents');
      check(
        row[0]?.total_amount_cents === 41895,
        'and total_amount_cents is UNTOUCHED — it is the approval snapshot, not the receipt',
      );
      check(
        row[0]?.stripe_payment_intent_id === 'pi_test_happy',
        'the payment intent lands in the column BK-33 refunds from',
      );
    }

    // ── THE APPROVAL SNAPSHOT SURVIVES A PAYMENT THAT DISAGREES WITH IT ────
    //
    // A SEPARATE ARM WITH A DIFFERENT AMOUNT, because the happy path above
    // cannot test this: there the arriving amount equals the settled total, so
    // writing one over the other is invisible and the check stayed green
    // through a deliberate break. The amounts have to differ for the property
    // to be observable at all.
    //
    // They differ here by construction rather than by accident — `markPaid`
    // takes what arrived as a parameter, and a partial payment, a Terminal
    // handler, or an office member marking an e-Transfer that came up short all
    // supply something other than the quote. `total_amount_cents` is what the
    // approval email told the customer, so it has to survive any of them or
    // there is nothing left to compare a receipt against.
    {
      const id = await seedAwaitingPayment(41895);
      const outcome = await markPaid(sql, id, {
        method: 'interac',
        amountCents: 40000,
        reference: 'ETR-SHORT',
        actor: 'Dana',
        now: NOW,
      });
      check(outcome === 'confirmed', `a short payment still confirms, got "${outcome}"`);
      const row = (await sql`
        SELECT paid_amount_cents, total_amount_cents FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      check(row[0]?.paid_amount_cents === 40000, 'what actually arrived is recorded');
      check(
        row[0]?.total_amount_cents === 41895,
        'and the approval snapshot is UNCHANGED — the two are different columns for this reason',
      );
    }

    // ── ONE PAYMENT DELIVERED TWICE IS NOT A DOUBLE PAYMENT ────────────────
    //
    // Stripe redelivers by design, and `checkout.session.completed` plus
    // `async_payment_succeeded` can both reach here for one session. Reporting
    // those as a double payment would tell the office to refund a single charge
    // — and the ticket's rule is that a human acts on that alert.
    {
      const id = await seedAwaitingPayment(41895);
      await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_twice',
        paymentIntentId: 'pi_test_twice',
        sessionId: 'cs_test_twice0001',
        now: NOW,
      });
      const again = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_twice',
        paymentIntentId: 'pi_test_twice',
        sessionId: 'cs_test_twice0001',
        now: NOW,
      });
      check(again === 'already-recorded', `a redelivery is silent, got "${again}"`);
      const row = (await sql`
        SELECT needs_attention FROM appointments WHERE id = ${id}
      `) as { needs_attention: string | null }[];
      check(
        row[0]?.needs_attention === null,
        'and it flags NOTHING — the office is not told to refund a single charge',
      );
    }

    // ── TWO PAYMENTS IS A DOUBLE PAYMENT, AND IT NEVER REFUNDS ─────────────
    //
    // The real race: the office marks an e-Transfer, then the customer pays the
    // Stripe link too. The second arrival must no-op and flag.
    {
      const id = await seedAwaitingPayment(41895);
      await markPaid(sql, id, {
        method: 'interac',
        amountCents: 41895,
        reference: 'ETR-8891',
        actor: 'Dana',
        now: NOW,
      });
      const clash = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_clash',
        paymentIntentId: 'pi_test_clash',
        sessionId: 'cs_test_clash0001',
        now: NOW,
      });
      check(clash === 'double-pay', `a DIFFERENT payment on a confirmed row is a double pay, got "${clash}"`);

      const row = (await sql`
        SELECT payment_method, payment_reference, interac_marked_by, needs_attention, status
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      check(row[0]?.status === 'confirmed', 'the row stays confirmed');
      check(
        row[0]?.payment_method === 'interac' && row[0]?.payment_reference === 'ETR-8891',
        'the FIRST payment keeps the columns — the loser overwrites nothing',
      );
      check(row[0]?.interac_marked_by === 'Dana', 'including who asserted it');
      check(
        typeof row[0]?.needs_attention === 'string' &&
          (row[0].needs_attention as string).includes('DOUBLE PAYMENT'),
        'and the row is flagged for a human',
      );
      check(
        (row[0].needs_attention as string).includes('NOT refunded automatically'),
        'with the instruction that nothing was refunded — never move money without a person',
      );
    }

    // ── PAID AFTER THE SLOT WAS RELEASED ───────────────────────────────────
    //
    // The cron/webhook race the ticket calls out. The money is real: record it,
    // flag it, and DO NOT put the status back — the slot may already be rebooked.
    {
      const id = await seedAwaitingPayment(41895);
      await sql`UPDATE appointments SET status = 'payment_expired' WHERE id = ${id}`;
      const late = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_late',
        paymentIntentId: 'pi_test_late',
        sessionId: 'cs_test_late00001',
        now: NOW,
      });
      check(late === 'paid-after-release', `a payment on a released row records, got "${late}"`);

      const row = (await sql`
        SELECT status, payment_status, paid_amount_cents, needs_attention
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      check(
        row[0]?.status === 'payment_expired',
        'the STATUS IS NOT PUT BACK — the slot may already belong to somebody else',
      );
      check(row[0]?.payment_status === 'paid', 'but the money is recorded');
      check(row[0]?.paid_amount_cents === 41895, 'with the amount that arrived');
      check(
        typeof row[0]?.needs_attention === 'string' &&
          (row[0].needs_attention as string).includes('PAID AFTER THE SLOT WAS RELEASED'),
        'and flagged for a human',
      );
    }

    // ── AN INTERAC REFERENCE NEVER LANDS IN THE STRIPE COLUMN ──────────────
    {
      const id = await seedAwaitingPayment(41895);
      await markPaid(sql, id, {
        method: 'interac',
        amountCents: 41895,
        reference: 'ETR-4410',
        actor: 'Sam',
        now: NOW,
      });
      const row = (await sql`
        SELECT payment_reference, stripe_payment_intent_id, interac_marked_at
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      check(row[0]?.payment_reference === 'ETR-4410', 'the e-Transfer reference is recorded');
      check(
        row[0]?.stripe_payment_intent_id === null,
        'and NOT in stripe_payment_intent_id, which BK-33 would aim a refund at',
      );
      check(row[0]?.interac_marked_at !== null, 'interac_marked_at is stamped');
    }

    // ── THE LATE-PAYMENT UPDATE RESTATES ITS OWN EXPECTATIONS ──────────────
    //
    // `review.ts:46` forbids SELECT-then-act categorically. The narrow UPDATE
    // on the released-row branch reads the row first to decide WHICH branch it
    // is, so it has to re-state `status IN (...) AND payment_status <> 'paid'`
    // in its own WHERE — or a payment that lands between the read and the write
    // overwrites the method, stamp and reference of one that got there first.
    {
      const id = await seedAwaitingPayment(41895);
      await sql`UPDATE appointments SET status = 'payment_expired' WHERE id = ${id}`;
      await markPaid(sql, id, {
        method: 'interac',
        amountCents: 41895,
        reference: 'ETR-FIRST',
        actor: 'Dana',
        now: NOW,
      });
      // A second, different payment onto the same released row. The first one
      // is already recorded, so this must not overwrite it.
      const second = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_second',
        paymentIntentId: 'pi_test_second',
        now: NOW,
      });
      check(
        second === 'not-applicable',
        `a second payment onto an already-recorded released row no-ops, got "${second}"`,
      );
      const row = (await sql`
        SELECT payment_method, payment_reference, interac_marked_by
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      check(
        row[0]?.payment_method === 'interac' && row[0]?.payment_reference === 'ETR-FIRST',
        'and the FIRST payment keeps the columns — the loser overwrites nothing',
      );
      check(row[0]?.interac_marked_by === 'Dana', 'including who asserted it');
    }

    // ── TWO REFERENCE-LESS MARKS ON ONE METHOD ARE ONE ASSERTION ───────────
    //
    // Deliberate, and the trade is stated rather than left to be discovered: an
    // office member clicking "Mark as paid" twice with nothing typed is ONE
    // claim made twice, so it must not read as a refundable double payment. The
    // cost is that a genuinely second e-Transfer with no reference either is
    // silently unflagged — which is why the form asks for a reference and says
    // what it is for.
    {
      const id = await seedAwaitingPayment(41895);
      await markPaid(sql, id, { method: 'interac', amountCents: 41895, reference: null, now: NOW });
      const again = await markPaid(sql, id, {
        method: 'interac',
        amountCents: 41895,
        reference: null,
        now: NOW,
      });
      check(again === 'already-recorded', `a second reference-less mark is silent, got "${again}"`);
      const row = (await sql`
        SELECT needs_attention FROM appointments WHERE id = ${id}
      `) as { needs_attention: string | null }[];
      check(row[0]?.needs_attention === null, 'and flags nothing');

      // But a DIFFERENT METHOD is always a different payment, reference or not.
      // This is the real double-pay race: Interac marked, then the card link paid.
      const clash = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_after_interac',
        paymentIntentId: 'pi_test_after_interac',
        now: NOW,
      });
      check(clash === 'double-pay', `a different METHOD is always a double pay, got "${clash}"`);
    }

    // ── A ROW IN NO PAYABLE STATE ──────────────────────────────────────────
    {
      const id = await seedAwaitingPayment(41895);
      await sql`UPDATE appointments SET status = 'pending_review' WHERE id = ${id}`;
      const nope = await markPaid(sql, id, {
        method: 'stripe',
        amountCents: 41895,
        reference: 'pi_test_nope',
        now: NOW,
      });
      check(nope === 'not-applicable', `an unapproved row is not payable, got "${nope}"`);
    }

    console.log('  one path, four outcomes, and nothing is ever refunded automatically');
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-32 — the approve route transitions BEFORE it talks to Stripe');
  // -------------------------------------------------------------------------
  //
  // With no STRIPE_SECRET_KEY set — which is the state of this environment —
  // `createCheckoutSession` returns null and the approval degrades to the
  // Interac route. That is the supported state, and it is enough to observe the
  // ORDER: the columns are stamped and the flash says the card link was not
  // created, rather than the whole approval being refused.
  {
    {
      const slot = await freeProbeSlot();
      const inserted = (await sql`
        INSERT INTO appointments (name, phone, email, service, address, payment_route,
                                  slot_start, status, assessment_tier)
        VALUES ('Order Probe', '780-555-0177', 'order@example.com', 'water', '2 Order Rd',
                'private', ${slot.toISOString()}, 'pending_review', 'standard')
        RETURNING id
      `) as { id: number }[];
      const orderId = inserted[0].id;
      createdIds.push(orderId);

      const location = await call(reviewRoute, { id: String(orderId), action: 'approve' });
      // `review=approved` covers all three success variants — `approved`,
      // `approved-interac` and `approved-nomail`. Which one comes back depends
      // on whether mail went, and mail cannot go in this harness (no valid
      // Resend key), so pinning the exact string would be pinning the
      // environment. What the arm is actually about is below: the row
      // transitioned, `approved_at` is stamped, and no session was minted.
      check(
        location.includes('review=approved'),
        `the approval COMPLETES rather than being refused, got "${location}"`,
      );

      const row = (await sql`
        SELECT status, approved_at, total_amount_cents, stripe_session_id
        FROM appointments WHERE id = ${orderId}
      `) as Record<string, unknown>[];
      // THE TRANSITION RAN. Under the old order the Checkout Session was created
      // first and `approved_at` did not exist when its idempotency key needed it.
      check(row[0]?.status === 'approved_awaiting_payment', 'the row transitioned');
      check(row[0]?.approved_at !== null, 'and approved_at IS STAMPED — the key names it');
      check(row[0]?.total_amount_cents === 41895, 'with the settled total');
      check(
        row[0]?.stripe_session_id === null,
        'and no session id, because no session was created — not a half-written one',
      );

      // A SECOND CLICK REACHES NOTHING. This is what the inversion buys: the
      // guarded UPDATE returns zero rows, so Stripe is never called a second
      // time and there is no orphan session to clean up.
      const twice = await call(reviewRoute, { id: String(orderId), action: 'approve' });
      check(twice.includes('review=stale'), `a second approve is a no-op, got "${twice}"`);
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-32 — the webhook, driven end to end over a real signature');
  // -------------------------------------------------------------------------
  //
  // `stripe.webhooks.generateTestHeaderString` signs a body with any secret, so
  // the route can be driven for real — signature verification, the claim, the
  // amount check and the confirm transition — with no Stripe account, no
  // network and no live key. Everything before this was pinned at the source
  // level, which is what let the implementation review find that layer 1 had
  // never once been executed.
  {
    const secret = 'whsec_verify_only_not_a_real_secret';
    const priorSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const priorKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    // The route constructs a client from this to VERIFY. Verification is local
    // (HMAC over the body), so a syntactically valid key that is not a real one
    // is enough and nothing here ever reaches Stripe.
    process.env.STRIPE_SECRET_KEY = 'sk_test_verify_only_not_a_real_key';

    const { default: StripeSdk } = await import('stripe');
    const signer = new StripeSdk('sk_test_verify_only_not_a_real_key');
    const { POST: webhookRoute } = await import('../src/pages/api/stripe/webhook');

    const sessionEvent = (id: number, opts: { amount: number; eventId: string; sessionId: string }) =>
      JSON.stringify({
        id: opts.eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: opts.sessionId,
            object: 'checkout.session',
            payment_status: 'paid',
            amount_total: opts.amount,
            client_reference_id: String(id),
            metadata: { appointment_id: String(id), tier: 'standard' },
            payment_intent: `pi_${opts.sessionId}`,
          },
        },
      });

    const post = async (body: string) => {
      const header = signer.webhooks.generateTestHeaderString({ payload: body, secret });
      return webhookRoute({
        request: new Request('https://example.com/api/stripe/webhook/', {
          method: 'POST',
          headers: { 'stripe-signature': header },
          body,
        }),
      } as never);
    };

    const eventIds: string[] = [];
    try {
      // ── A FORGED BODY IS 400, NOT 200 ────────────────────────────────────
      const forged = await webhookRoute({
        request: new Request('https://example.com/api/stripe/webhook/', {
          method: 'POST',
          headers: { 'stripe-signature': 't=1,v1=deadbeef' },
          body: '{"id":"evt_forged","type":"checkout.session.completed"}',
        }),
      } as never);
      check(forged.status === 400, `a bad signature is refused with 400, got ${forged.status}`);

      // ── AN UNKNOWN EVENT TYPE IS 200 ─────────────────────────────────────
      const unknownId = `evt_unknown_${Date.now()}`;
      eventIds.push(unknownId);
      const unknown = await post(
        JSON.stringify({ id: unknownId, type: 'customer.created', data: { object: {} } }),
      );
      check(unknown.status === 200, `an unhandled event type answers 200, got ${unknown.status}`);

      // ── A REAL PAYMENT CONFIRMS ──────────────────────────────────────────
      const payId = await seedAwaitingPayment(41895, 'cs_test_webhook00001');
      const payEvent = `evt_pay_${Date.now()}`;
      eventIds.push(payEvent);
      const paid = await post(
        sessionEvent(payId, {
          amount: 41895,
          eventId: payEvent,
          sessionId: 'cs_test_webhook00001',
        }),
      );
      check(paid.status === 200, `a paid session answers 200, got ${paid.status}`);
      check(await statusOf(payId) === 'confirmed', 'and the booking is confirmed');

      // ── A REDELIVERY DOES NOTHING ────────────────────────────────────────
      const replay = await post(
        sessionEvent(payId, {
          amount: 41895,
          eventId: payEvent,
          sessionId: 'cs_test_webhook00001',
        }),
      );
      check(replay.status === 200, 'a redelivery answers 200');
      const replayBody = (await replay.json()) as { duplicate?: boolean };
      check(
        replayBody.duplicate === true,
        'and is recognised as already processed rather than run again',
      );

      // ── AN AMOUNT STRIPE DISAGREES WITH CONFIRMS NOTHING ─────────────────
      //
      // The stale-link case: a session minted by an earlier approval at a
      // different price. This is the only place it becomes visible.
      const wrongId = await seedAwaitingPayment(41895, 'cs_test_webhook00002');
      const wrongEvent = `evt_wrong_${Date.now()}`;
      eventIds.push(wrongEvent);
      const wrong = await post(
        sessionEvent(wrongId, {
          amount: 39900,
          eventId: wrongEvent,
          sessionId: 'cs_test_webhook00002',
        }),
      );
      check(wrong.status === 200, 'a mismatched amount still answers 200 — nothing to retry');
      check(
        await statusOf(wrongId) === 'approved_awaiting_payment',
        'but the booking is NOT confirmed at a price it was never quoted',
      );
      const wrongRow = (await sql`
        SELECT needs_attention FROM appointments WHERE id = ${wrongId}
      `) as { needs_attention: string | null }[];
      check(
        wrongRow[0]?.needs_attention?.includes('AMOUNT MISMATCH') === true,
        'and it is flagged for a human',
      );

      // ── A TRANSITION THAT FAILS LEAVES THE EVENT UNSTAMPED ───────────────
      //
      // THE SECOND IMPLEMENTATION-REVIEW BLOCKER. `markPaid` never throws — a
      // failed UPDATE comes back as the VALUE 'error' — so discarding that
      // return meant a transient database blip produced: event claimed, nothing
      // written, event stamped, Stripe told 200 and never retrying. The row
      // then expired on the cron and the customer was emailed an apology for a
      // booking they had paid for. Exactly what `processed_at` exists to
      // prevent, reopened one layer up.
      //
      // Driven by pointing the event at a row that exists and is payable, then
      // making the confirm UPDATE fail — the amount column is dropped from
      // under it for the length of this arm.
      const failId = await seedAwaitingPayment(41895, 'cs_test_webhook00003');
      const failEvent = `evt_fail_${Date.now()}`;
      eventIds.push(failEvent);
      await sql`ALTER TABLE appointments RENAME COLUMN paid_amount_cents TO paid_amount_cents_tmp`;
      let failStatus = 0;
      try {
        const failed = await post(
          sessionEvent(failId, {
            amount: 41895,
            eventId: failEvent,
            sessionId: 'cs_test_webhook00003',
          }),
        );
        failStatus = failed.status;
      } finally {
        await sql`ALTER TABLE appointments RENAME COLUMN paid_amount_cents_tmp TO paid_amount_cents`;
      }
      check(failStatus === 500, `a failed transition answers 500 so Stripe retries, got ${failStatus}`);
      const stamp = (await sql`
        SELECT processed_at FROM stripe_events WHERE event_id = ${failEvent}
      `) as { processed_at: Date | null }[];
      check(
        stamp[0]?.processed_at === null,
        'and the event is left UNSTAMPED — the retry is what recovers the payment',
      );
      check(
        await statusOf(failId) === 'approved_awaiting_payment',
        'with the booking still awaiting payment rather than silently lost',
      );

      // The retry now succeeds, which is the whole point of leaving it unstamped.
      const recovered = await post(
        sessionEvent(failId, {
          amount: 41895,
          eventId: failEvent,
          sessionId: 'cs_test_webhook00003',
        }),
      );
      check(recovered.status === 200, "Stripe's retry answers 200");
      check(await statusOf(failId) === 'confirmed', 'AND THE PAYMENT LANDS — the booking confirms');
    } finally {
      for (const id of eventIds) {
        await sql`DELETE FROM stripe_events WHERE event_id = ${id}`.catch(() => {});
      }
      if (priorSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = priorSecret;
      if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = priorKey;
    }

    console.log('  signature, claim, confirm, replay, mismatch, and a failure that retries');
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-32 — re-approving a booking that already holds a Checkout Session');
  // -------------------------------------------------------------------------
  //
  // THE PATH THE IMPLEMENTATION REVIEW FOUND B1 ON, and the ticket had claimed
  // an arm for it that did not exist.
  //
  // The flow is real and documented on BK-23's approval screen: "once a
  // Checkout Session exists the amount is frozen; changing it means cancelling
  // and re-approving." The office puts an expired or mistaken booking back to
  // `pending_review` and approves it again — and that row still names the
  // session minted the first time.
  //
  // With no STRIPE_SECRET_KEY in this harness `expireCheckoutSession` returns
  // `'failed'` without a network call, which is exactly the branch that
  // mattered: the first version ABORTED here and rolled back, except the
  // rollback was guarded `AND stripe_session_id IS NULL` and so could never
  // run — leaving the row approved, a deadline ticking, NO email sent, and the
  // office told the approval was refused.
  {
    const slot = await freeProbeSlot();
    const inserted = (await sql`
      INSERT INTO appointments (name, phone, email, service, address, payment_route,
                                slot_start, status, assessment_tier, stripe_session_id)
      VALUES ('Reapprove Probe', '780-555-0166', 'reapprove@example.com', 'water', '4 Again St',
              'private', ${slot.toISOString()}, 'pending_review', 'standard',
              ${'cs_test_stale000000001'})
      RETURNING id
    `) as { id: number }[];
    const againId = inserted[0].id;
    createdIds.push(againId);

    const location = await call(reviewRoute, { id: String(againId), action: 'approve' });

    // THE APPROVAL STANDS. Aborting would be worse in every direction: the
    // transition has already committed, and a rollback would leave a
    // possibly-live link pointing at a `pending_review` row — where `markPaid`
    // refuses, so a payment on it is money recorded nowhere.
    check(
      location.includes('review=approved'),
      `the approval COMPLETES rather than reporting a refusal, got "${location}"`,
    );

    const row = (await sql`
      SELECT status, approved_at, payment_status, needs_attention
      FROM appointments WHERE id = ${againId}
    `) as Record<string, unknown>[];
    check(row[0]?.status === 'approved_awaiting_payment', 'the row is approved');
    check(row[0]?.approved_at !== null, 'and stamped — not left half-transitioned');
    check(row[0]?.payment_status === 'pending', 'with payment_status moved on');
    // The old link may still be live at the OLD price. A human has to close it,
    // and the webhook's amount check is what stops it confirming at a stale
    // price in the meantime.
    check(
      typeof row[0]?.needs_attention === 'string' &&
        (row[0].needs_attention as string).includes('STALE CHECKOUT SESSION'),
      'and the un-expirable session is FLAGGED rather than silently left behind',
    );
    check(
      (row[0].needs_attention as string).includes('cs_test_stale000000001'),
      'naming the session id, so the office can actually go and close it',
    );
  }

  // -------------------------------------------------------------------------
  console.log('\nBK-32 — a $0.00 approval confirms without a payment step');
  // -------------------------------------------------------------------------
  {
    const slot = await freeProbeSlot();
    const inserted = (await sql`
      INSERT INTO appointments (name, phone, email, service, address, payment_route,
                                slot_start, status, assessment_tier)
      VALUES ('Goodwill Probe', '780-555-0188', 'goodwill@example.com', 'water', '3 Free Ln',
              'private', ${slot.toISOString()}, 'pending_review', 'standard')
      RETURNING id
    `) as { id: number }[];
    const freeId = inserted[0].id;
    createdIds.push(freeId);

    const location = await call(reviewRoute, {
      id: String(freeId),
      action: 'approve',
      assessment_amount: '0.00',
      travel_fee: '0.00',
    });
    check(
      location.includes('review=approved-free'),
      `a $0 approval confirms in one step, got "${location}"`,
    );

    const row = (await sql`
      SELECT status, payment_status, payment_method, total_amount_cents, payment_due_at,
             stripe_session_id
      FROM appointments WHERE id = ${freeId}
    `) as Record<string, unknown>[];
    check(row[0]?.status === 'confirmed', 'it reaches confirmed');
    check(row[0]?.payment_status === 'paid', 'payment_status is paid');
    // NOT 'not_required'. Migration 008 reserves that value for rows predating
    // prepay, and reusing it would mix a live booking into the historical ones.
    check(
      row[0]?.payment_method === 'none',
      "the method is 'none' — not payment_status 'not_required', which means something older",
    );
    check(row[0]?.total_amount_cents === 0, 'the total is zero');
    check(
      row[0]?.stripe_session_id === null,
      'AND NO CHECKOUT SESSION WAS OPENED — a $0 session is a booking with a broken step, not one without a step',
    );

    console.log('  approved and confirmed through the same markPaid, with no link and no charge');
  }


  // -------------------------------------------------------------------------
  // BK-44 — the status dropdown may not perform a review decision.
  //
  // WHY THESE PINS LOOK DIFFERENT FROM EVERY OTHER ARM IN THIS FILE. The defect
  // they cover was not found by any of the 23 verify scripts, and the reason is
  // structural rather than a coverage gap: every script drives ONE route and
  // asserts what that route does. `verify-booking-review.ts` proves `review.ts`
  // guards its transitions. The arms above prove `update.ts` writes what it is
  // told. Both passed while the two routes overlapped, and the overlap was the
  // bug. A sixth per-route script would not have found it either.
  //
  // So the load-bearing assertion here is the INVARIANT one at the end of the
  // matrix — a property of the whole state space rather than of any single
  // transition — and it is what goes red if somebody opens a door nobody
  // thought of, the way `completed` and `no_show` turned out to be doors into
  // the invite-holding set that guarding `confirmed` alone would have missed.
  {
    console.log('\nBK-44 — the editor cannot perform a review decision');

    /** Seed one row at an arbitrary lifecycle state. */
    async function seedAt(
      status: AppointmentStatus,
      opts: { paid?: boolean; session?: string | null } = {},
    ): Promise<number> {
      const slot = await freeProbeSlot();
      const paidAt = opts.paid ? new Date().toISOString() : null;
      const inserted = (await sql`
        INSERT INTO appointments (name, phone, email, service, address, payment_route,
                                  slot_start, status, pipeline_stage, admin_notes,
                                  payment_status, paid_at, payment_method, stripe_session_id)
        VALUES ('BK44 Probe', '780-555-0199', 'bk44@example.com', 'water', '44 Guard Rd',
                'private', ${slot.toISOString()}, ${status}, 'assessment', ${MARKER},
                ${opts.paid ? 'paid' : 'pending'}, ${paidAt},
                ${opts.paid ? 'stripe' : null}, ${opts.session ?? null})
        RETURNING id
      `) as { id: number }[];
      createdIds.push(inserted[0].id);
      return inserted[0].id;
    }

    async function stateOf(id: number): Promise<{ status: AppointmentStatus; paid_at: Date | null }> {
      const r = (await sql`
        SELECT status, paid_at FROM appointments WHERE id = ${id}
      `) as { status: AppointmentStatus; paid_at: Date | null }[];
      return r[0];
    }

    // ── The matrix, driven through the ROUTE ───────────────────────────────
    //
    // Not through the template and not through `editorMaySetStatus` alone. The
    // ticket is explicit: a template-only fix is a client-side check on a write
    // path, so the proof has to be a forbidden transition POSTed to `update.ts`
    // and refused by it. Every arm below is a real form submission.
    //
    // The row is reset between targets rather than reseeded, so one insert
    // covers eight transitions and the run stays inside a sane number of round
    // trips.
    let matrixChecked = 0;
    let invariantViolations = 0;

    for (const paid of [false, true]) {
      for (const from of APPOINTMENT_STATUSES) {
        const id = await seedAt(from, { paid });
        const paidAtSeed = (await stateOf(id)).paid_at;

        for (const to of APPOINTMENT_STATUSES) {
          // Reset. `cancelled_at` goes with it: entering and leaving
          // `cancelled` stamps and clears it, and a stale stamp would make the
          // next target's arm assert against a row it did not seed.
          await sql`
            UPDATE appointments
            SET status = ${from}, paid_at = ${paidAtSeed?.toISOString() ?? null},
                cancelled_at = NULL
            WHERE id = ${id}
          `;

          const expected = editorMaySetStatus(
            { status: from, paid_at: paidAtSeed, stripe_session_id: null },
            to,
          );

          const location = await call(updateRoute, {
            id: String(id),
            status: to,
            pipeline_stage: 'assessment',
          });
          const after = await stateOf(id);
          matrixChecked++;

          if (expected) {
            check(
              location.includes('saved=1'),
              `${from} -> ${to} (paid=${paid}) should be allowed, got "${location}"`,
            );
            check(
              after.status === to,
              `${from} -> ${to} (paid=${paid}) should have landed, row is ${after.status}`,
            );
          } else {
            check(
              location.includes('saved=blocked'),
              `${from} -> ${to} (paid=${paid}) should be REFUSED at the route, got "${location}"`,
            );
            check(
              after.status === from,
              `${from} -> ${to} (paid=${paid}) was refused but the row moved to ${after.status}`,
            );
          }

          // ── THE RELATIONSHIP ASSERTION ───────────────────────────────────
          //
          // Not about this transition — about the whole matrix. No POST to the
          // editor may leave a row inside the invite-holding set with no
          // payment behind it, unless it was already inside before the POST.
          //
          // This is what a per-route test cannot express. It does not name
          // `confirmed`, or `completed`, or `no_show`; it names the boundary,
          // so a fourth status added to `couldHoldCalendarInvite` later is
          // covered on the day it is added rather than the day somebody
          // remembers to widen a list.
          //
          // WHAT IT CANNOT CATCH, stated so nobody over-trusts it: the guard
          // derives from `couldHoldCalendarInvite` and so does this assertion,
          // so a WRONG `couldHoldCalendarInvite` moves both together and stays
          // green. It catches SQL-versus-TypeScript drift and list-versus-
          // predicate drift, which is what red rows 4 and 5 demonstrate — not a
          // mis-defined boundary.
          if (
            couldHoldCalendarInvite(after.status) &&
            after.paid_at === null &&
            !couldHoldCalendarInvite(from)
          ) {
            invariantViolations++;
            check(
              false,
              `INVARIANT: ${from} -> ${to} left an unpaid row at ${after.status}, inside the invite-holding set`,
            );
          }
        }
      }
    }
    check(matrixChecked === 128, `the matrix drove 128 transitions, drove ${matrixChecked}`);
    check(invariantViolations === 0, 'no editor POST put an unpaid row inside the invite-holding set');
    console.log(`  ${matrixChecked} transitions driven through update.ts; the invite boundary held`);

    // ── The three consequences the ticket names, asserted by name ──────────
    //
    // All three are inside the matrix already. They are restated here because a
    // matrix failure reports a coordinate, and these three deserve to fail with
    // their own sentence — they are the reason the ticket exists.
    {
      const id = await seedAt('pending_review');
      let location = await call(updateRoute, { id: String(id), status: 'approved_awaiting_payment' });
      check(
        location.includes('saved=blocked') && (await stateOf(id)).status === 'pending_review',
        'CONSEQUENCE 1: approving by dropdown is refused — no amount, no deadline, no email',
      );

      location = await call(updateRoute, { id: String(id), status: 'confirmed' });
      check(
        location.includes('saved=blocked') && (await stateOf(id)).status === 'pending_review',
        'CONSEQUENCE 2: confirming an unpaid request by dropdown is refused',
      );

      // The door guarding `confirmed` alone would have left open. `completed`
      // crosses the same boundary and mails the same first-confirmation email.
      location = await call(updateRoute, { id: String(id), status: 'completed' });
      check(
        location.includes('saved=blocked') && (await stateOf(id)).status === 'pending_review',
        'CONSEQUENCE 2, THROUGH THE OTHER DOOR: pending_review -> completed is refused too',
      );
      console.log('  the two consequences, and the third door into the same room');
    }

    // ── What must NOT get harder ───────────────────────────────────────────
    {
      for (const from of APPOINTMENT_STATUSES) {
        if (from === 'cancelled') continue;
        const id = await seedAt(from);
        const location = await call(updateRoute, { id: String(id), status: 'cancelled' });
        check(
          location.includes('saved=1') && (await stateOf(id)).status === 'cancelled',
          `cancelling must stay reachable from ${from}, got "${location}"`,
        );
      }
      console.log('  cancel is still reachable from every status');
    }

    {
      // The correction `update.ts`'s docstring names, on a row with NO paid_at
      // — which is every pre-P9 row, because 008 renamed them to `confirmed`
      // and 010 never backfilled the column. An over-tight rule keyed on
      // `confirmed` would refuse this and the office would have no route back.
      const legacy = await seedAt('confirmed');
      let location = await call(updateRoute, { id: String(legacy), status: 'no_show' });
      check(
        location.includes('saved=1') && (await stateOf(legacy)).status === 'no_show',
        'a legacy confirmed row can still be marked no-show',
      );
      location = await call(updateRoute, { id: String(legacy), status: 'confirmed' });
      check(
        location.includes('saved=1') && (await stateOf(legacy)).status === 'confirmed',
        'AND BACK — movement inside the invite set never asks for a payment, so pre-prepay rows stay correctable',
      );

      // Un-cancelling, both directions of the carve-out.
      const paidCancel = await seedAt('cancelled', { paid: true });
      location = await call(updateRoute, { id: String(paidCancel), status: 'confirmed' });
      check(
        location.includes('saved=1') && (await stateOf(paidCancel)).status === 'confirmed',
        'a PAID cancelled booking still un-cancels — the interesting case update.ts is built around',
      );

      const unpaidCancel = await seedAt('cancelled');
      location = await call(updateRoute, { id: String(unpaidCancel), status: 'confirmed' });
      check(
        location.includes('saved=blocked') && (await stateOf(unpaidCancel)).status === 'cancelled',
        'a NEVER-PAID cancelled booking does not — that is the hole wearing a different hat',
      );
      console.log('  corrections kept, and the carve-out cuts where it should');
    }

    // ── An approved row is markPaid's to confirm ───────────────────────────
    //
    // Found at implementation review, and it is the case a `paid_at`-only rule
    // could not see: nothing ever CLEARS that column, so a row that has been
    // paid once, walked back to `pending_review` and re-approved carries the
    // old stamp while a fresh, unpaid Checkout Session is live. The invite
    // crossing would have been waved through on the strength of last cycle's
    // money, skipping the amount columns, the session expiry and the
    // double-payment detection — and mailing a confirmation for it.
    {
      const stale = await seedAt('approved_awaiting_payment', {
        paid: true,
        session: 'cs_test_bk44_stale',
      });
      for (const target of INVITE_HOLDING_STATUSES) {
        const location = await call(updateRoute, { id: String(stale), status: target });
        check(
          location.includes('saved=blocked'),
          `an approved row with a stale paid_at cannot be moved to ${target} by hand, got "${location}"`,
        );
        check(
          (await stateOf(stale)).status === 'approved_awaiting_payment',
          `and it did not move to ${target}`,
        );
      }
      console.log('  a stale paid_at cannot confirm an approval — markPaid owns that crossing');
    }

    // ── `rollBack`'s rule, applied to the editor ───────────────────────────
    {
      const live = await seedAt('approved_awaiting_payment', { session: 'cs_test_bk44_live' });
      let location = await call(updateRoute, { id: String(live), status: 'pending_review' });
      check(
        location.includes('saved=blocked') && (await stateOf(live)).status === 'approved_awaiting_payment',
        'an approval with a LIVE payment link cannot be walked back — the customer could still pay it',
      );

      const dead = await seedAt('approved_awaiting_payment', { session: null });
      location = await call(updateRoute, { id: String(dead), status: 'pending_review' });
      check(
        location.includes('saved=1') && (await stateOf(dead)).status === 'pending_review',
        'with no live session it walks back fine — approveFree already relies on that path',
      );
      console.log('  the live-session walk-back is closed, the ordinary one is not');
    }

    // ── A refused edit changes NOTHING, and mails nothing ──────────────────
    {
      const id = await seedAt('pending_review');
      await sql`
        UPDATE appointments SET admin_notes = ${`${MARKER} original`}, pipeline_stage = 'assessment'
        WHERE id = ${id}
      `;
      const before = (await sql`
        SELECT status, pipeline_stage, admin_notes, assessment_tier, cancelled_at, updated_at
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];

      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
      };
      let location: string;
      try {
        const res = await updateRoute({
          request: post({
            id: String(id),
            status: 'confirmed',
            pipeline_stage: 'restoration',
            admin_notes: `${MARKER} this note rode along with a forbidden status`,
            assessment_tier: 'standard',
          }),
        } as never);
        location = res.headers.get('Location') ?? '';
      } finally {
        console.error = original;
      }

      check(location.includes('saved=blocked'), 'the refused edit reports blocked');

      const after = (await sql`
        SELECT status, pipeline_stage, admin_notes, assessment_tier, cancelled_at, updated_at
        FROM appointments WHERE id = ${id}
      `) as Record<string, unknown>[];
      // THE WHOLE STATEMENT IS REFUSED, which is why the flash says nothing at
      // all was saved. A note that survived a refused status would make that
      // message a lie, and the office would stop believing the next one.
      for (const col of ['status', 'pipeline_stage', 'admin_notes', 'assessment_tier', 'cancelled_at']) {
        check(
          String(after[0][col]) === String(before[0][col]),
          `a refused edit left ${col} alone (was ${String(before[0][col])}, now ${String(after[0][col])})`,
        );
      }
      check(
        String(after[0].updated_at) === String(before[0].updated_at),
        'a refused edit does not even bump updated_at — nothing was written',
      );

      // `sendCalendarInvite` logs the booking it is muting, so a silent capture
      // distinguishes "reached the send and the mute stopped it" from "never
      // wired to send at all". Nothing may reach it across a refusal.
      check(
        !lines.some((l) => l.includes(String(id))),
        'and NO mail was attempted across the refusal — the send was never reached',
      );
      console.log('  a refused edit writes nothing and mails nothing');
    }

    // ── The dropdown and the guard read one source ─────────────────────────
    {
      // Contract, not incident: a <select> that omits its own current value
      // submits the FIRST option instead, so a notes-only save on an approved
      // booking would silently un-approve it.
      for (const status of APPOINTMENT_STATUSES) {
        for (const paid_at of [null, new Date()]) {
          for (const stripe_session_id of [null, 'cs_test_x']) {
            check(
              editorStatusTargets({ status, paid_at, stripe_session_id }).includes(status),
              `editorStatusTargets always offers the row's own status (${status}, paid=${!!paid_at}, session=${!!stripe_session_id})`,
            );
          }
        }
      }

      // ── EVERY WITHHELD STATUS HAS A SENTENCE EXPLAINING IT ───────────────
      //
      // The Update panel explains an absent option in three groups: decision-
      // owned ("comes from approving"), invite-holding ("not listed until this
      // booking is paid"), and reopening ("cannot be reopened while its payment
      // link is live"). The list is derived per row; so is the reason.
      //
      // THIS TIES THE COPY TO THE RULE. A future conjunct that withholds a
      // status for a fourth reason would render it in a list the page cannot
      // explain — an option silently missing, which reads as broken rather than
      // as routed elsewhere, and is the half of BK-44 that was never about the
      // write path. The partition is asserted, not the wording.
      for (const status of APPOINTMENT_STATUSES) {
        for (const paid_at of [null, new Date()]) {
          for (const stripe_session_id of [null, 'cs_test_x']) {
            const row = { status, paid_at, stripe_session_id };
            const targets = editorStatusTargets(row);
            const withheld = APPOINTMENT_STATUSES.filter(x => !targets.includes(x));
            const unexplained = withheld.filter(
              x =>
                !DECISION_ENTRY_STATUSES.includes(x) &&
                !INVITE_HOLDING_STATUSES.includes(x) &&
                x !== 'pending_review',
            );
            check(
              unexplained.length === 0,
              `every withheld status has a sentence (${status}, paid=${!!paid_at}, session=${!!stripe_session_id}): ${unexplained.join(', ')} has none`,
            );
          }
        }
      }

      const page = readFileSync(resolve(root, 'src/pages/admin/appointments/[id].astro'), 'utf8');
      check(
        page.includes('{statusTargets.map('),
        'the status dropdown renders editorStatusTargets, not a second list',
      );
      check(
        !page.includes('{APPOINTMENT_STATUSES.map('),
        'and no longer maps all eight statuses into a <select>',
      );
      console.log('  the dropdown offers exactly what the route accepts');
    }

    // ── The narrowed source scan (the second, weaker overlap pin) ──────────
    //
    // Scoped to the ENTRY functions rather than to whole files, deliberately.
    // A file-wide sweep for `SET status =` goes red against correct code:
    // `review.ts` also writes `declined` and, in `rollBack`, `pending_review`,
    // and both of those are legitimately the editor's too. Declining by hand
    // skips no obligation. Disjointness was the wrong relationship; what
    // matters is that no status a DECISION creates is one the editor can
    // conjure from outside the invite boundary.
    {
      const reviewSrc = readFileSync(
        resolve(root, 'src/pages/api/admin/appointments/review.ts'),
        'utf8',
      );
      const paymentSrc = readFileSync(resolve(root, 'src/lib/booking-payment.ts'), 'utf8');

      // Ends at the next TOP-LEVEL declaration, matched at column zero, so a
      // nested helper stays inside the body and the slice cannot run to the end
      // of the file. It did, at first: `markPaid` is `export async function`, a
      // shape a search for `\nasync function ` never matches, so the pin
      // swallowed every function after it and reported statuses those functions
      // write. A pin that over-collects fails against correct code, which is
      // the fastest way to get a pin deleted.
      function bodyOf(src: string, name: string): string {
        const at = src.search(new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\(`));
        if (at < 0) throw new Error(`entry function ${name} not found — this pin has gone stale`);
        const rest = /\n(?:export )?(?:async )?function /g;
        rest.lastIndex = at + 1;
        const next = rest.exec(src);
        return src.slice(at, next ? next.index : src.length);
      }

      const entries = [
        bodyOf(reviewSrc, 'approve'),
        bodyOf(reviewSrc, 'approveFree'),
        bodyOf(paymentSrc, 'markPaid'),
      ].join('\n');

      // ASSIGNMENTS ONLY, and this took two goes to get right. A bare search
      // for `status = '<lit>'` also matches every GUARD — `WHERE id = $1 AND
      // status = 'pending_review'` — and every comment quoting one, so the pin
      // reported `pending_review` as something a decision route creates and
      // failed against correct code. Only the SET clause assigns.
      const written = new Set<string>();
      for (const stmt of entries.matchAll(/UPDATE\s+appointments\b([\s\S]*?)\bWHERE\b/g)) {
        const setClause = stmt[1].replace(/--[^\n]*/g, '');
        // The leading class is what keeps `payment_status` out of the results.
        for (const m of setClause.matchAll(/(?:^|[\s,(])status\s*=\s*'([a-z_]+)'/g)) {
          if ((APPOINTMENT_STATUSES as readonly string[]).includes(m[1])) written.add(m[1]);
        }
      }
      // THE EXACT SET, not `size > 0`. If `bodyOf` ever stops reaching
      // `markPaid`'s SET clause — the mirror image of the over-collection this
      // pin already had once — then `written` quietly loses `confirmed`, every
      // remaining member still passes the check below, and half the
      // relationship pin evaporates with no red. A pin that can go vacuous is
      // worse than no pin, because the green is read as coverage.
      const expected = ['approved_awaiting_payment', 'confirmed'];
      check(
        [...written].sort().join(',') === expected.sort().join(','),
        `the entry functions assign exactly ${expected.join(', ')} — found ${[...written].sort().join(', ') || '(none)'}`,
      );
      for (const status of written) {
        const s = status as AppointmentStatus;
        check(
          DECISION_ENTRY_STATUSES.includes(s) || INVITE_HOLDING_STATUSES.includes(s),
          `${status} is created by a decision route, so the editor must not be able to conjure it`,
        );
      }
      console.log(`  every status the entry functions create (${[...written].join(', ')}) is out of the editor's reach`);
    }
  }

} finally {
  const removed = await cleanup().catch(() => ({ appointments: -1, blackouts: -1, files: -1, leads: -1 }));
  seeded = false;
  console.log(
    `\n  cleaned up ${removed.appointments} appointment row(s), ${removed.blackouts} blackout row(s), ${removed.files} file row(s), ${removed.leads} lead row(s)`,
  );
  const left = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM appointments
        WHERE id = ANY(${createdIds}::int[]) OR admin_notes LIKE ${`${MARKER}%`}) AS appointments,
      (SELECT COUNT(*)::int FROM blackout_dates
        WHERE day = ANY(${touchedDays}::date[]) OR reason LIKE ${`${MARKER}%`}) AS blackouts,
      (SELECT COUNT(*)::int FROM appointment_files
        WHERE id = ANY(${createdFileIds}::int[]) OR pathname LIKE ${`${FILE_PREFIX}%`}) AS files,
      (SELECT COUNT(*)::int FROM leads
        WHERE id = ANY(${createdLeadIds}::int[]) OR name LIKE ${`${LEAD_MARKER}%`}) AS leads
  `) as { appointments: number; blackouts: number; files: number; leads: number }[];
  const stillThere = left[0].appointments + left[0].blackouts + left[0].files + left[0].leads;
  if (stillThere > 0) {
    console.error(`  ✗ ${stillThere} seeded row(s) survived cleanup — remove them manually.`);
    failures++;
  }
}

/**
 * A day inside the public window that currently offers at least one slot, and
 * is not today.
 *
 * Today is excluded on purpose: its remaining slots are the ones that can cross
 * the 4-hour notice cutoff mid-run, and then the closing "the day is offered
 * again" assertion fails for a reason that has nothing to do with blackouts.
 */
async function findOpenDay(): Promise<string | null> {
  const today = localDateKey(new Date());
  const body = (await (await availability({} as never)).json()) as {
    dates: { date: string; slots: unknown[] }[];
  };
  return body.dates.find((d) => d.date > today && d.slots.length > 0)?.date ?? null;
}

/** Does the public calendar still offer anything on that day? */
async function dayIsOffered(day: string): Promise<boolean> {
  const body = (await (await availability({} as never)).json()) as {
    dates: { date: string; slots: unknown[] }[];
  };
  return (body.dates.find((d) => d.date === day)?.slots.length ?? 0) > 0;
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ admin write-path checks passed\n');
