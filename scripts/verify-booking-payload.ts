// Property-checks the booking payload validator. Pure — no database, no network.
//
//   npx tsx scripts/verify-booking-payload.ts
//
// Exits non-zero on the first failed assertion.
import { parseBookingPayload, MAX_FIELD_LENGTHS, type ParseOptions } from '../src/lib/booking-payload';
import { slotStartsForDate, localDateKey, addDays } from '../src/lib/booking-time';

const SERVICES = new Set(['water', 'fire', 'mold', 'other']);

/**
 * The public door. Every pre-existing case in this file runs through it, which
 * is the right default: it is the stricter of the two, so a case that passes
 * here passes everywhere.
 */
const opts: ParseOptions = { allowedServices: SERVICES, entry: 'public' };

/** The office door — BK-22's exemption. Used only by the arms that test it. */
const adminOpts: ParseOptions = { allowedServices: SERVICES, entry: 'admin' };

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/** A real grid instant, so slot validation is never the reason a case fails. */
const SLOT = slotStartsForDate(addDays(localDateKey(new Date('2026-08-05T15:00:00Z')), 3))[0];

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Sam Rivers',
    phone: '780-555-0134',
    email: 'sam@example.com',
    service: 'water',
    address: '123 Maple St',
    city: 'Edmonton',
    payment_route: 'private',
    slot_start: SLOT.toISOString(),
    ...overrides,
  };
}

function errorsFor(input: unknown): string[] {
  const r = parseBookingPayload(input, opts);
  return r.ok ? [] : r.errors.map((e) => e.field);
}

/** The same, through the office door. Only BK-22's exemption arms use it. */
function adminErrorsFor(input: unknown): string[] {
  const r = parseBookingPayload(input, adminOpts);
  return r.ok ? [] : r.errors.map((e) => e.field);
}

// ---------------------------------------------------------------------------
console.log('Happy path');
// ---------------------------------------------------------------------------
{
  const r = parseBookingPayload(base(), opts);
  check(r.ok, `a complete valid payload must parse (got ${JSON.stringify(errorsFor(base()))})`);
  if (r.ok) {
    check(r.payload.slotStart.getTime() === SLOT.getTime(), 'slot instant must round-trip');
    check(r.payload.city === 'Edmonton', 'city must be kept');
    check(r.payload.smsConsent === false, 'consent must default to false');
    check(r.payload.draftToken === null, 'a missing draft token must be null, not undefined');
    check(r.payload.email === 'sam@example.com', 'email must be kept');
  }
  const noCity = parseBookingPayload(base({ city: undefined }), opts);
  check(noCity.ok && noCity.payload.city === 'Edmonton', 'city must default to Edmonton');
  console.log('  parses, defaults applied');
}

// ---------------------------------------------------------------------------
console.log('\nRequired fields and shapes');
// ---------------------------------------------------------------------------
{
  for (const field of ['name', 'phone', 'service', 'address']) {
    check(errorsFor(base({ [field]: undefined })).includes(field), `${field} must be required`);
    check(errorsFor(base({ [field]: '   ' })).includes(field), `${field} must reject whitespace`);
  }
  check(errorsFor(base({ phone: '123' })).includes('phone'), 'a short phone must be rejected');
  check(errorsFor(base({ phone: '1-780-555-0134' })).length === 0, '11-digit phone must pass');
  check(errorsFor(base({ email: 'not-an-email' })).includes('email'), 'bad email must be rejected');
  // BK-22 inverted this: it used to read "email must be optional". Public
  // bookings now require one; the admin exemption is asserted in its own block
  // below, and the two arms together are what pin the discriminator's polarity.
  check(errorsFor(base({ email: undefined })).includes('email'), 'email must be required');
  check(errorsFor(base({ email: '   ' })).includes('email'), 'email must reject whitespace');
  // An over-long address reports "too long" and must NOT also report
  // "required" — the parsed value is null in both cases, which is exactly the
  // trap the presence test avoids by re-reading the raw field.
  check(
    errorsFor(base({ email: `${'x'.repeat(MAX_FIELD_LENGTHS.email)}@example.com` })).filter(
      (f) => f === 'email',
    ).length === 1,
    'an over-long email must report exactly one error, not two',
  );
  check(errorsFor(base({ service: 'nope' })).includes('service'), 'unknown service must be rejected');
  check(
    errorsFor(base({ payment_route: 'cash' })).includes('payment_route'),
    'unknown payment route must be rejected',
  );
  check(errorsFor(base({ name: 'x'.repeat(MAX_FIELD_LENGTHS.name + 1) })).includes('name'), 'over-long name must be rejected');
  check(
    errorsFor(base({ description: 'x'.repeat(MAX_FIELD_LENGTHS.description + 1) })).includes('description'),
    'over-long description must be rejected',
  );
  console.log('  required, length, and format rules hold');
}

// ---------------------------------------------------------------------------
console.log("\nBK-22 — the admin exemption and its polarity");
// ---------------------------------------------------------------------------
{
  // These two are a PAIR, and the pairing is the point. Breaking the email
  // requirement itself turns both of them red at once and proves nothing about
  // which way `entry` points; only a discriminator wired the right way round
  // satisfies both, because they demand opposite outcomes from one input.
  check(
    errorsFor(base({ email: undefined })).includes('email'),
    'public: an absent email must be rejected',
  );
  check(
    adminErrorsFor(base({ email: undefined })).length === 0,
    'admin: an absent email must be accepted (the client exemption)',
  );

  // The exemption is about PRESENCE only. A malformed address is still
  // malformed however it was typed, and the office typos as readily as anyone.
  check(
    adminErrorsFor(base({ email: 'not-an-email' })).includes('email'),
    'admin: a malformed email must still be rejected',
  );

  // Nothing else moves with the door. If it did, the discriminator would be
  // doing more than it says.
  check(adminErrorsFor(base()).length === 0, 'admin: a complete entry parses');
  check(adminErrorsFor(base({ name: undefined })).includes('name'), 'admin: name is still required');
  check(
    adminErrorsFor(base({ phone: '123' })).includes('phone'),
    'admin: the phone rule is unchanged',
  );

  // `null`, never `''`. `BookingPayload.email` is `string | null`, and reusing
  // the `required()` helper for this field would have written an empty string
  // into a type that does not admit one.
  const exempt = parseBookingPayload(base({ email: undefined }), adminOpts);
  check(
    exempt.ok && exempt.payload.email === null,
    'admin: an absent email parses to null, never an empty string',
  );
  console.log('  public requires an email, admin does not, and nothing else moves');
}

// ---------------------------------------------------------------------------
console.log('\nNon-object and hostile input');
// ---------------------------------------------------------------------------
{
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    const r = parseBookingPayload(bad, opts);
    check(!r.ok, `${JSON.stringify(bad) ?? 'undefined'} must not parse`);
  }
  // Fields the server owns must never be accepted from a caller.
  for (const key of ['draft_id', 'draftId', 'id', 'status', 'pipeline_stage', 'source']) {
    check(errorsFor(base({ [key]: 'x' })).includes(key), `${key} must be rejected outright`);
  }
  console.log('  non-objects rejected; server-owned fields refused');
}

// ---------------------------------------------------------------------------
console.log('\nSlot validation');
// ---------------------------------------------------------------------------
{
  check(errorsFor(base({ slot_start: undefined })).includes('slot_start'), 'slot is required');
  check(errorsFor(base({ slot_start: 'tomorrow' })).includes('slot_start'), 'unparseable slot rejected');
  const offGrid = new Date(SLOT.getTime() + 5 * 60 * 1000);
  check(errorsFor(base({ slot_start: offGrid.toISOString() })).includes('slot_start'), 'off-grid slot rejected');
  const offByOneMs = new Date(SLOT.getTime() + 1);
  check(errorsFor(base({ slot_start: offByOneMs.toISOString() })).includes('slot_start'), 'slot off by 1 ms rejected');
  console.log('  grid membership enforced to the millisecond');
}

// ---------------------------------------------------------------------------
console.log('\nInsurance route');
// ---------------------------------------------------------------------------
{
  const insured = parseBookingPayload(
    base({
      payment_route: 'insurance',
      insurer_name: 'Acme Mutual',
      policy_number: 'POL-1',
      claim_number: 'CLM-1',
    }),
    opts,
  );
  check(insured.ok, 'a complete insurance payload must parse');
  if (insured.ok) {
    check(insured.payload.policy_number === 'POL-1', 'policy number must persist on the insurance route');
    check(insured.payload.claim_number === 'CLM-1', 'claim number must persist on the insurance route');
  }

  check(
    errorsFor(base({ payment_route: 'insurance' })).includes('insurer_name'),
    'insurance route must require an insurer',
  );

  // The point of the rule: stale insurance fields must be DROPPED on a private
  // booking, not merely unused, so they cannot reach the row.
  const priv = parseBookingPayload(
    base({ payment_route: 'private', insurer_name: 'Acme', policy_number: 'POL-9', claim_number: 'CLM-9' }),
    opts,
  );
  check(priv.ok, 'a private payload carrying stale insurance fields must still parse');
  if (priv.ok) {
    check(priv.payload.policy_number === null, 'policy number must be dropped on the private route');
    check(priv.payload.claim_number === null, 'claim number must be dropped on the private route');
    check(priv.payload.insurer_name === null, 'insurer must be dropped on the private route');
    check(
      !JSON.stringify(priv.payload).includes('POL-9') && !JSON.stringify(priv.payload).includes('CLM-9'),
      'no insurance identifier may survive anywhere in a private payload',
    );
  }
  console.log('  identifiers kept on insurance, dropped on private');
}

// ---------------------------------------------------------------------------
console.log('\nConsent and draft token');
// ---------------------------------------------------------------------------
{
  const yes = parseBookingPayload(base({ sms_consent: true }), opts);
  check(yes.ok && yes.payload.smsConsent === true, 'consent true must be carried');
  const no = parseBookingPayload(base({ sms_consent: false }), opts);
  check(no.ok && no.payload.smsConsent === false, 'consent false must be carried');
  check(errorsFor(base({ sms_consent: 'yes' })).includes('sms_consent'), 'non-boolean consent rejected');

  const tok = parseBookingPayload(base({ draft_token: 'v1.abc.123.def' }), opts);
  check(tok.ok && tok.payload.draftToken === 'v1.abc.123.def', 'draft token must pass through unverified');
  check(errorsFor(base({ draft_token: 42 })).includes('draft_token'), 'non-string draft token rejected');
  console.log('  consent tri-state and token passthrough hold');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All booking payload checks passed.');
