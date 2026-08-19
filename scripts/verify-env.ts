// Checks that a missing environment variable produces the deliberate
// "not configured" error rather than a TypeError.
//
//   npx tsx scripts/verify-env.ts
//
// This script MUST run under plain Node (tsx), never through Vite. The bug it
// guards against is `process.env.X ?? import.meta.env.X` throwing
// `Cannot read properties of undefined` because `import.meta.env` does not
// exist outside Vite — run under Vite, the broken code passes every assertion
// here. `tsx` is the reproduction, not an implementation detail.
//
// It deliberately does not load `.env`: the variables under test have to be
// genuinely absent. They are deleted from `process.env` before each case in
// case the shell exports them.
//
// Exits non-zero on the first failed assertion.
import { readEnv } from '../src/lib/env';
import { getDb } from '../src/lib/db';
import { issueDraftToken } from '../src/lib/draft-token';

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

/** Run `fn` and describe what came out: a value, or the error it threw. */
async function attempt(fn: () => unknown): Promise<
  { threw: false; value: unknown } | { threw: true; error: unknown }
> {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, error };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The TypeError this whole ticket exists to remove. */
function isTheTrap(error: unknown): boolean {
  return error instanceof TypeError && /Cannot read propert/i.test(message(error));
}

const NAME = 'BK12_PROBE_VARIABLE';

// ---------------------------------------------------------------------------
console.log('readEnv on a missing variable');
// ---------------------------------------------------------------------------
{
  delete process.env[NAME];
  const r = await attempt(() => readEnv(NAME));
  check(!r.threw, `readEnv must not throw on a missing variable (threw ${r.threw ? message(r.error) : ''})`);
  check(!r.threw && r.value === undefined, 'a missing variable must read as undefined');
  console.log('  returns undefined, does not throw');
}

// ---------------------------------------------------------------------------
console.log('\nreadEnv value handling');
// ---------------------------------------------------------------------------
{
  process.env[NAME] = 'a-real-value';
  check(readEnv(NAME) === 'a-real-value', 'a set value must be returned unchanged');

  // The `vercel env pull` case: sensitive variables come back as "". Treating
  // that as a value is how a blank secret reads as "it's configured".
  process.env[NAME] = '';
  check(readEnv(NAME) === undefined, 'an empty string must read as not configured');

  delete process.env[NAME];
  console.log('  values pass through, empty string reads as unset');
}

// ---------------------------------------------------------------------------
console.log('\ngetDb without DATABASE_URL');
// ---------------------------------------------------------------------------
{
  delete process.env.DATABASE_URL;
  const r = await attempt(() => getDb());
  check(r.threw, 'getDb must throw when DATABASE_URL is unset');
  if (r.threw) {
    check(!isTheTrap(r.error), `getDb must not throw the TypeError trap (got "${message(r.error)}")`);
    check(
      message(r.error) === 'DATABASE_URL is not configured',
      `getDb must throw its own error (got "${message(r.error)}")`,
    );
  }
  console.log('  throws "DATABASE_URL is not configured"');
}

// ---------------------------------------------------------------------------
console.log('\nDraft tokens without BOOKING_DRAFT_SECRET');
// ---------------------------------------------------------------------------
{
  delete process.env.BOOKING_DRAFT_SECRET;
  const r = await attempt(() => issueDraftToken());
  check(r.threw, 'issueDraftToken must throw when BOOKING_DRAFT_SECRET is unset');
  if (r.threw) {
    check(
      !isTheTrap(r.error),
      `issueDraftToken must not throw the TypeError trap (got "${message(r.error)}")`,
    );
    check(
      message(r.error) === 'BOOKING_DRAFT_SECRET is not configured',
      `issueDraftToken must throw its own error (got "${message(r.error)}")`,
    );
  }
  console.log('  throws "BOOKING_DRAFT_SECRET is not configured"');
}

// ---------------------------------------------------------------------------
console.log('\nBooking notifications without RESEND_API_KEY');
// ---------------------------------------------------------------------------
{
  // The fourth readEnv site, and the one that must NOT throw: it runs after the
  // appointment row exists, where an exception becomes a 500 for a booking that
  // committed. It reports 'failed' instead — and it has to reach that answer
  // before `new Resend(key)`, which is the one SDK call that does throw on a
  // falsy key.
  const { sendBookingNotifications } = await import('../src/lib/booking-notify');
  const { planBookingNotifications } = await import('../src/lib/booking-email');

  delete process.env.RESEND_API_KEY;
  delete process.env.BOOKING_NOTIFY_DISABLED;

  const plan = planBookingNotifications({
    id: 1,
    messageType: 'confirmed',
    service: 'water',
    assessmentTier: 'standard',
    slotLabel: 'Tue, Aug 12 · 1:30 p.m.',
    slotStart: new Date('2026-08-12T19:30:00.000Z'),
    now: new Date('2026-08-12T17:00:00.000Z'),
    name: 'Probe',
    phone: '780-555-0100',
    email: 'probe@example.com',
    serviceLabel: 'Water Damage Restoration',
    description: null,
    address: '1 Test St',
    city: 'Edmonton',
    postalCode: null,
    paymentRoute: 'private',
    insurerName: null,
    policyNumber: null,
    claimNumber: null,
    smsConsent: false,
    filesAttached: 0,
  });

  const r = await attempt(() => sendBookingNotifications(plan, SEND_NOW));
  check(!r.threw, `sendBookingNotifications must not throw (threw "${r.threw ? message(r.error) : ''}")`);
  if (!r.threw) {
    const outcome = r.value as { customer: string; internal: string };
    check(
      outcome.customer === 'failed' && outcome.internal === 'failed',
      `an unset key must report failed, never sent (got ${JSON.stringify(outcome)})`,
    );
  }
  console.log('  reports failed without throwing');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All environment-read checks passed.');
