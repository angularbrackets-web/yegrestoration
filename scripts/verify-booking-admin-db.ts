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
import { neon } from '@neondatabase/serverless';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Type-only, so it is erased before the module graph exists and cannot bind a
// connection ahead of the DATABASE_URL swap below. Every VALUE import that
// reaches getDb() is dynamic and happens after it.
import type { Appointment } from '../src/lib/db';
import type { Message } from '../src/lib/booking-email';

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
const { POST: blackoutAdd } = await import('../src/pages/api/admin/blackouts/add');
const { POST: blackoutDelete } = await import('../src/pages/api/admin/blackouts/delete');
const { GET: availability } = await import('../src/pages/api/booking/availability');
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
  updated_at: Date;
};

async function read(id: number): Promise<Row | null> {
  const rows = (await sql`SELECT * FROM appointments WHERE id = ${id}`) as Row[];
  return rows[0] ?? null;
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
  check(idA !== null, `the redirect names the new appointment, got "${locationA}"`);
  if (idA === null) throw new Error('entry insert did not produce an id');
  createdIds.push(idA);

  check(locationA.endsWith('?email=off'), `no confirmation was requested, got "${locationA}"`);
  check(locationA.startsWith('/admin/appointments/'), 'and the Location is slashed and root-relative');

  const rowA = await read(idA);
  check(rowA !== null, 'the row exists');
  if (rowA) {
    check(rowA.source === 'admin', 'it is marked as office-entered');
    check(rowA.status === 'booked', 'and booked');
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
    WHERE slot_start = ${zonedTimeToUtc(SLOT_DATE, SLOT_A).toISOString()} AND status <> 'cancelled'
  `) as { n: number }[];
  const dupe = await call(createRoute, entryFields({ name: 'BK-08 duplicate' }));
  check(dupe.includes('taken=1'), `a duplicate slot reports taken, got "${dupe}"`);
  const after = (await sql`
    SELECT COUNT(*)::int AS n FROM appointments
    WHERE slot_start = ${zonedTimeToUtc(SLOT_DATE, SLOT_A).toISOString()} AND status <> 'cancelled'
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

  // The slot is now free — the partial index only covers status <> 'cancelled'.
  const locationB = await call(createRoute, entryFields({ name: 'BK-08 rebook' }));
  const idB = idFromLocation(locationB);
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
    status: 'booked',
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
  const restored = await call(updateRoute, { id: String(idA), status: 'booked' });
  check(restored.endsWith('?saved=1'), `un-cancelling now succeeds, got "${restored}"`);
  const rowARestored = await read(idA);
  check(rowARestored?.status === 'booked', 'the row is booked again');
  check(rowARestored?.cancelled_at === null, 'and cancelled_at is cleared, not left stale');

  // -------------------------------------------------------------------------
  console.log('Stage and notes edits, and the whitelist (AC2)');
  // -------------------------------------------------------------------------
  const edited = await call(updateRoute, {
    id: String(idA),
    status: 'booked',
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
  await call(updateRoute, { id: String(idA), status: 'booked' });
  check(
    (await read(idA))?.admin_notes === `${MARKER} edited`,
    'an absent notes field leaves the notes alone',
  );
  await call(updateRoute, { id: String(idA), admin_notes: '' });
  check((await read(idA))?.admin_notes === null, 'a submitted-but-empty one clears them');
  await call(updateRoute, { id: String(idA), admin_notes: MARKER });
  check((await read(idA))?.admin_notes === MARKER, 'and writing them back works');

  // A well-formed id that matches nothing.
  const missing = await call(updateRoute, { id: '2147483647', status: 'booked' });
  check(missing.includes('saved=missing'), `a vanished appointment is reported, got "${missing}"`);

  // -------------------------------------------------------------------------
  console.log('The resend gate (AC6)');
  // -------------------------------------------------------------------------
  // No email address on this row, so a resend must be refused whatever its
  // status.
  const noEmail = await call(resendRoute, { id: String(idA) });
  check(noEmail.endsWith('?email=refused'), `no email → refused, got "${noEmail}"`);

  // Give it one, and a booked row is accepted — the send itself is muted here,
  // so this asserts the GATE opened, not that mail went out.
  const withEmail = await call(
    createRoute,
    entryFields({
      slot_time: '13:30',
      name: 'BK-08 resend',
      email: 'bk08-verify@example.com',
    }),
  );
  const idD = idFromLocation(withEmail);
  check(idD !== null, `the emailable entry saved, got "${withEmail}"`);
  if (idD !== null) {
    createdIds.push(idD);
    const accepted = await call(resendRoute, { id: String(idD) });
    check(
      !accepted.endsWith('?email=refused'),
      `a booked row with an email is accepted, got "${accepted}"`,
    );

    // Cancel it and the gate must close again: a cancelled appointment must not
    // receive a fresh "You're booked" for a slot that may belong to someone
    // else now.
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
      const sentOutcome = await sendConfirmationAndStamp(sql, plan, {
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
      const failedOutcome = await sendConfirmationAndStamp(sql, plan, {
        send: async () => ({ ok: false, error: 'validation_error: API key is invalid' }),
      });
      check(failedOutcome === 'failed', `a resolved error reports failed, got ${failedOutcome}`);
      const afterFailed = await read(idD);
      check(afterFailed?.confirmation_sent_at === null, 'a failed send stamps nothing');
      check(afterFailed?.internal_notified_at === null, 'and still nothing on the office column');

      // 3. A throwing sender is caught rather than escaping into the route —
      //    the appointment already exists by the time this runs.
      await reset();
      const threwOutcome = await sendConfirmationAndStamp(sql, plan, {
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
      const mutedOutcome = await sendConfirmationAndStamp(sql, plan, {
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
        check(
          muteLine(enteredId, 'request', 'office').test(entered.logs),
          `an entry ${label} still reaches the office invite send`,
        );
        // AND THE ENTRY MAILS THE CUSTOMER NOTHING FROM THE INVITE PATH. The
        // entry's customer mail is the confirmation, gated on the checkbox and
        // sent through `sendConfirmationAndStamp`; BK-16 must not have grown a
        // second customer send here. This fixture HAS an email address, so the
        // assertion is falsifiable rather than vacuous.
        check(
          !muteLine(enteredId, 'request', 'customer').test(entered.logs),
          `and an entry ${label} sends the customer no separate invite`,
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
    const restored = await callCapturingLogs({ id: String(idE), status: 'booked' });
    check(restored.location.endsWith('?saved=1'), `the un-cancel saves, got "${restored.location}"`);
    check((await read(idE))?.status === 'booked', 'and the row is booked again');
    check(
      muteLine(idE, 'request', 'office').test(restored.logs),
      'and the route reached the office invite send again',
    );
    check(
      !muteLine(idE, 'request', 'customer').test(restored.logs),
      'still with no customer send — the row still has no address',
    );

    // 4. Edits that do not touch the boundary send nothing.
    for (const status of ['completed', 'no_show', 'booked']) {
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
    check(idG !== null, `the with-email fixture saved, got "${withEmailEntry}"`);
    if (idG !== null) {
      createdIds.push(idG);

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
      const restoreG = await callCapturingLogs({ id: String(idG), status: 'booked' });
      check(restoreG.location.endsWith('?saved=1'), `the un-cancel saves, got "${restoreG.location}"`);
      check((await read(idG))?.status === 'booked', 'and the row is booked again');
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
        status: 'booked',
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
      const blankEmail = await callCapturingLogs({ id: String(idG), status: 'booked' });
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

    const conflicted = await callCapturingLogs({ id: String(idE), status: 'booked' });
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
