// Checks the admin write forms' parsers and the admin-only send path.
//
//   npm run verify:booking:admin:entry
//
// Pure: no database, no network, no live API key. `booking-admin-entry.ts` is
// env-free by construction, and `sendCustomerConfirmation` takes an injected
// sender, so its audience, its count, and its failure mappings are all
// reachable here without mailing anybody.
//
// Exits non-zero if any assertion fails.

// The server this code runs on is UTC (Vercel). Pin the process before anything
// builds a formatter or an instant, so "the entry lands at the right Edmonton
// wall clock" is a claim that can actually fail here rather than passing by
// accident on a laptop already set to Edmonton.
process.env.TZ = 'UTC';

import {
  ADMIN_ENTRY_FIELD_LABELS,
  APPOINTMENT_STATUSES,
  MAX_ADMIN_NOTES,
  PIPELINE_STAGES,
  parseAdminEntry,
  parseAppointmentId,
  parseAppointmentUpdate,
  parseBlackoutDay,
  parseBlackoutInput,
} from '../src/lib/booking-admin-entry';
import {
  inviteEventFromPayload,
  planCalendarInvite,
  planForPayload,
} from '../src/lib/booking-admin-notify';
import {
  BOOKING_INTERNAL_TO,
  SLOT_START_TIMES,
  TIMEZONE,
} from '../src/lib/booking-config';
import { planBookingNotifications, type Message } from '../src/lib/booking-email';
import {
  sendBookingNotifications,
  sendCalendarInvite,
  sendCustomerConfirmation,
  type SendResult,
} from '../src/lib/booking-notify';
import { isClosedWeekday, localDateKey, weekdayOfDateKey } from '../src/lib/booking-time';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/** The send instant every plan below is built at. Injected, never a live clock. */
const NOW = new Date('2026-08-20T15:00:00.000Z');

/** The services the routes pass. Named here so an unknown key is really unknown. */
const SERVICES = new Set(['water', 'fire', 'mold', 'other']);
const OPTS = { allowedServices: SERVICES };

/** A complete, valid entry record. Every case below is this minus or plus one thing. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot_date: '2026-08-24', // a Monday
    slot_time: '13:30',
    name: 'Dana Whitecloud',
    phone: '780-555-0142',
    email: 'dana@example.com',
    service: 'water',
    description: 'Basement flooded overnight.',
    address: '123 Maple St',
    city: 'Edmonton',
    postal_code: 'T5J 2R7',
    payment_route: 'private',
    ...over,
  };
}

function fieldsOf(result: ReturnType<typeof parseAdminEntry>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.field);
}

// ---------------------------------------------------------------------------
console.log('\nparseAdminEntry — a valid entry, and the instant it produces (AC1)');
// ---------------------------------------------------------------------------
{
  const result = parseAdminEntry(entry(), OPTS);
  check(result.ok, `a complete entry parses; got ${JSON.stringify(fieldsOf(result))}`);

  if (result.ok) {
    const p = result.payload;
    check(p.name === 'Dana Whitecloud', 'the name survives');
    check(p.phone === '780-555-0142', 'the phone survives');
    check(p.email === 'dana@example.com', 'the email survives');
    check(p.service === 'water', 'the service key survives');
    check(p.address === '123 Maple St', 'the address survives');
    check(p.city === 'Edmonton', 'the city survives');
    check(p.postal_code === 'T5J 2R7', 'the postal code survives');
    check(p.payment_route === 'private', 'the payment route survives');
    check(p.draftToken === null, 'no draft token is ever accepted from an admin form');
  }

  // The wrong-day bug this parser exists to avoid. 13:30 Edmonton is 19:30 UTC
  // in summer (MDT, -6) and 20:30 UTC in winter (MST, -7). A hand-built instant
  // — or a frozen offset — gets exactly one of these right.
  const summer = parseAdminEntry(entry({ slot_date: '2026-07-15' }), OPTS);
  const winter = parseAdminEntry(entry({ slot_date: '2026-01-15' }), OPTS);
  check(
    summer.ok && summer.payload.slotStart.toISOString() === '2026-07-15T19:30:00.000Z',
    `MDT: 13:30 local is 19:30 UTC, got ${summer.ok ? summer.payload.slotStart.toISOString() : 'a parse error'}`,
  );
  check(
    winter.ok && winter.payload.slotStart.toISOString() === '2026-01-15T20:30:00.000Z',
    `MST: 13:30 local is 20:30 UTC, got ${winter.ok ? winter.payload.slotStart.toISOString() : 'a parse error'}`,
  );

  // And the instant reads back as the local date it was typed as — the check
  // that fails when a conversion lands on the far side of midnight.
  check(
    summer.ok && localDateKey(summer.payload.slotStart) === '2026-07-15',
    'the instant belongs to the calendar date the office typed',
  );
}

// ---------------------------------------------------------------------------
console.log('\nAdmin bypasses every public window (AC1, decision 2)');
// ---------------------------------------------------------------------------
{
  // Each of these is a date the PUBLIC calendar refuses. The admin parser has no
  // window checks at all, so each must parse. The fixture facts are asserted
  // first: "a Friday is accepted" is not an assertion if the date is a Tuesday.
  const FRIDAY = '2026-08-28';
  check(weekdayOfDateKey(FRIDAY) === 5, `${FRIDAY} really is a Friday`);
  check(isClosedWeekday(FRIDAY), 'and Friday really is the closed weekday');

  const cases: [string, string][] = [
    ['a closed Friday', FRIDAY],
    ['a date in the past', '2020-03-01'],
    ['a date past the 14-day horizon', '2027-12-25'],
    ['today, inside the 4-hour notice', localDateKey(new Date())],
  ];
  for (const [label, slot_date] of cases) {
    const result = parseAdminEntry(entry({ slot_date }), OPTS);
    check(result.ok, `${label} (${slot_date}) is accepted; got ${JSON.stringify(fieldsOf(result))}`);
  }

  // Blackout days are not a parser input at all — there is no DB here. Stated
  // so the absence is deliberate rather than an oversight: the admin path never
  // reads `blackout_dates`, which is what makes "admin ignores blackouts" true.
  const source = parseAdminEntry.toString();
  check(!source.includes('blackout'), 'the entry parser does not consult blackouts');

  // Every one of the five grid times is offerable.
  for (const slot_time of SLOT_START_TIMES) {
    check(parseAdminEntry(entry({ slot_time }), OPTS).ok, `${slot_time} is a valid start time`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nparseAdminEntry — what it rejects (AC1)');
// ---------------------------------------------------------------------------
{
  const cases: [string, Record<string, unknown>, string][] = [
    ['an off-grid time', { slot_time: '12:00' }, 'slot_time'],
    ['a time between grid slots', { slot_time: '13:00' }, 'slot_time'],
    ['a missing time', { slot_time: '' }, 'slot_time'],
    ['a malformed date', { slot_date: '24-08-2026' }, 'slot_date'],
    ['a date that does not exist', { slot_date: '2026-02-31' }, 'slot_date'],
    ['an ISO instant in the date field', { slot_date: '2026-08-24T13:30:00Z' }, 'slot_date'],
    ['a missing date', { slot_date: '' }, 'slot_date'],
    ['a missing name', { name: '  ' }, 'name'],
    ['a missing phone', { phone: '' }, 'phone'],
    ['a phone that is not a number', { phone: 'call the office' }, 'phone'],
    ['a seven-digit phone', { phone: '555-0142' }, 'phone'],
    ['an email with no domain', { email: 'dana@' }, 'email'],
    ['an email with no @', { email: 'dana.example.com' }, 'email'],
    ['an unknown service key', { service: 'timetravel' }, 'service'],
    ['a missing service', { service: '' }, 'service'],
    ['a missing address', { address: '' }, 'address'],
    ['a missing payment route', { payment_route: '' }, 'payment_route'],
    ['an unknown payment route', { payment_route: 'barter' }, 'payment_route'],
    [
      'an insurance entry with no insurer',
      { payment_route: 'insurance', policy_number: 'P-1', claim_number: 'C-1' },
      'insurer_name',
    ],
    ['notes past the cap', { admin_notes: 'x'.repeat(MAX_ADMIN_NOTES + 1) }, 'admin_notes'],
  ];

  for (const [label, over, field] of cases) {
    const result = parseAdminEntry(entry(over), OPTS);
    check(!result.ok, `${label} is rejected`);
    check(fieldsOf(result).includes(field), `${label} names ${field}`);
  }

  // A failed slot must produce ONE slot error, not two differently-worded ones
  // from the two parsers stacked here.
  const badSlot = parseAdminEntry(entry({ slot_time: '12:00' }), OPTS);
  check(
    fieldsOf(badSlot).filter((f) => f.startsWith('slot')).length === 1,
    `a bad time reports one slot error, got ${JSON.stringify(fieldsOf(badSlot))}`,
  );

  check(!parseAdminEntry(null, OPTS).ok, 'a non-record input is rejected rather than thrown on');
  check(!parseAdminEntry([], OPTS).ok, 'an array is rejected too');

  // Every field name the parser can report has a label on the form page, or the
  // error silently renders as nothing.
  const everyField = new Set<string>();
  for (const [, over] of cases.map(([l, o]) => [l, o] as const)) {
    for (const f of fieldsOf(parseAdminEntry(entry(over), OPTS))) everyField.add(f);
  }
  for (const field of everyField) {
    check(field in ADMIN_ENTRY_FIELD_LABELS, `${field} has a label the form can render`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe private route drops insurance identifiers (AC1)');
// ---------------------------------------------------------------------------
{
  // Both insurance fields are always rendered on the form and there is no JS to
  // clear them, so "typed insurance details, then switched to private" is the
  // LIKELY path, not an edge case. The values must be dropped, not merely
  // unused: a claim number stored against a private-pay job is a data-retention
  // problem, not a display one.
  const result = parseAdminEntry(
    entry({
      payment_route: 'private',
      insurer_name: 'Prairie Mutual',
      policy_number: 'POLICYSENTINEL-77Q',
      claim_number: 'CLAIMSENTINEL-42Z',
    }),
    OPTS,
  );
  check(result.ok, 'a private-route entry carrying stale insurance values still parses');
  if (result.ok) {
    check(result.payload.insurer_name === null, 'the insurer is dropped');
    check(result.payload.policy_number === null, 'the policy number is dropped');
    check(result.payload.claim_number === null, 'the claim number is dropped');
    check(
      !JSON.stringify(result.payload).includes('SENTINEL'),
      'no insurance identifier survives anywhere in the payload',
    );
  }

  // The insurance route keeps them, or the check above would pass for a parser
  // that simply never reads the fields.
  const insured = parseAdminEntry(
    entry({
      payment_route: 'insurance',
      insurer_name: 'Prairie Mutual',
      policy_number: 'POLICYSENTINEL-77Q',
      claim_number: 'CLAIMSENTINEL-42Z',
    }),
    OPTS,
  );
  check(insured.ok, 'a complete insurance entry parses');
  if (insured.ok) {
    check(insured.payload.insurer_name === 'Prairie Mutual', 'the insurer is kept on the insurance route');
    check(insured.payload.policy_number === 'POLICYSENTINEL-77Q', 'the policy number is kept');
    check(insured.payload.claim_number === 'CLAIMSENTINEL-42Z', 'the claim number is kept');
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe two checkboxes (AC1, AC7)');
// ---------------------------------------------------------------------------
{
  // An unchecked box submits NOTHING — absence is the whole signal, and the
  // value attribute is the template's to choose, so presence is what is read.
  for (const [label, value, expected] of [
    ['absent', undefined, false],
    ['"1"', '1', true],
    ['"on"', 'on', true],
    ['"yes"', 'yes', true],
    ['empty', '', false],
    ['whitespace', '   ', false],
  ] as const) {
    const consent = parseAdminEntry(entry({ sms_consent: value }), OPTS);
    check(
      consent.ok && consent.payload.smsConsent === expected,
      `sms_consent ${label} → ${expected}`,
    );
    const send = parseAdminEntry(entry({ send_confirmation: value }), OPTS);
    check(
      send.ok && send.sendConfirmation === expected,
      `send_confirmation ${label} → ${expected}`,
    );
  }

  // CASL, restated as its own assertion because the default is the rule: the
  // presence of `sms_consent_at` IS the consent, so a form that forgets the box
  // must record no consent, never a default yes.
  const noBox = parseAdminEntry(entry(), OPTS);
  check(noBox.ok && noBox.payload.smsConsent === false, 'consent is never defaulted on');

  // And the two boxes are independent — a shared read would make one imply the
  // other, which would be a silent CASL violation every time the office sent a
  // confirmation.
  const onlySend = parseAdminEntry(entry({ send_confirmation: '1' }), OPTS);
  check(
    onlySend.ok && onlySend.sendConfirmation && !onlySend.payload.smsConsent,
    'ticking "send confirmation" does not record SMS consent',
  );
  const onlyConsent = parseAdminEntry(entry({ sms_consent: '1' }), OPTS);
  check(
    onlyConsent.ok && onlyConsent.payload.smsConsent && !onlyConsent.sendConfirmation,
    'ticking consent does not turn the confirmation email on',
  );
}

// ---------------------------------------------------------------------------
console.log('\nparseAppointmentUpdate — the whitelist (AC2)');
// ---------------------------------------------------------------------------
{
  const ok = parseAppointmentUpdate({
    id: '12',
    status: 'completed',
    pipeline_stage: 'mitigation',
    admin_notes: 'Crew ran late.',
  });
  check(ok.ok, 'a valid update parses');
  if (ok.ok) {
    check(ok.update.id === 12, 'the id is an integer, not a string');
    check(ok.update.status === 'completed', 'the status survives');
    check(ok.update.pipeline_stage === 'mitigation', 'the stage survives');
    check(ok.update.admin_notes === 'Crew ran late.', 'the notes survive');
  }

  // THE WHITELIST. Anything outside the four keys must not appear on the
  // returned object at all — the route's SQL names columns literally, so a key
  // that is not here cannot reach an UPDATE.
  const hostile = parseAppointmentUpdate({
    id: '12',
    status: 'booked',
    slot_start: '2026-01-01T00:00:00Z',
    duration_minutes: '90',
    policy_number: 'POLICYSENTINEL-77Q',
    claim_number: 'CLAIMSENTINEL-42Z',
    source: 'web',
    email: 'attacker@example.com',
    confirmation_sent_at: '2026-01-01T00:00:00Z',
    sms_consent_at: '2026-01-01T00:00:00Z',
    cancelled_at: null,
    name: 'Someone Else',
  });
  check(hostile.ok, 'unknown keys do not fail the parse — they are simply not read');
  if (hostile.ok) {
    const keys = Object.keys(hostile.update).sort();
    check(
      keys.join(',') === 'id,status',
      `only whitelisted keys survive, got ${JSON.stringify(keys)}`,
    );
    check(
      !JSON.stringify(hostile.update).includes('SENTINEL'),
      'no insurance identifier reaches the update',
    );
    for (const forbidden of [
      'slot_start',
      'duration_minutes',
      'source',
      'email',
      'name',
      'cancelled_at',
      'sms_consent_at',
      'confirmation_sent_at',
    ]) {
      check(!(forbidden in hostile.update), `${forbidden} is not updatable`);
    }
  }

  // Closed sets.
  for (const status of APPOINTMENT_STATUSES) {
    const r = parseAppointmentUpdate({ id: '1', status });
    check(r.ok && r.update.status === status, `${status} is a valid status`);
  }
  for (const stage of PIPELINE_STAGES) {
    const r = parseAppointmentUpdate({ id: '1', pipeline_stage: stage });
    check(r.ok && r.update.pipeline_stage === stage, `${stage} is a valid stage`);
  }
  for (const bad of ['deleted', 'BOOKED', 'booked; DROP TABLE appointments', 'no-show', '']) {
    const r = parseAppointmentUpdate({ id: '1', status: bad });
    check(
      bad === '' ? r.ok && r.update.status === undefined : !r.ok,
      `status ${JSON.stringify(bad)} is ${bad === '' ? 'treated as absent' : 'rejected'}`,
    );
  }
  for (const bad of ['done', 'Assessment', 'demolition']) {
    check(!parseAppointmentUpdate({ id: '1', pipeline_stage: bad }).ok, `stage ${bad} is rejected`);
  }

  // Notes: submitted-but-empty is a deliberate clear, absent is "leave alone".
  const cleared = parseAppointmentUpdate({ id: '1', admin_notes: '   ' });
  check(cleared.ok && 'admin_notes' in cleared.update, 'an empty textarea is a submitted field');
  check(cleared.ok && cleared.update.admin_notes === null, 'and it clears the notes');
  const absent = parseAppointmentUpdate({ id: '1' });
  check(absent.ok && !('admin_notes' in absent.update), 'an absent notes field leaves them alone');
  check(
    !parseAppointmentUpdate({ id: '1', admin_notes: 'x'.repeat(MAX_ADMIN_NOTES + 1) }).ok,
    'notes past the cap are rejected',
  );

  // Ids.
  for (const bad of ['0', '-1', 'abc', '', '0012', '2147483648', '  ', '1.5', '1e3']) {
    check(!parseAppointmentUpdate({ id: bad }).ok, `id ${JSON.stringify(bad)} is rejected`);
  }
  check(parseAppointmentId('2147483647') === 2147483647, 'the largest int4 id is accepted');
  check(parseAppointmentId('0012') === null, 'a leading zero is a second URL for one row');
  check(parseAppointmentId(12) === 12, 'a numeric id is accepted');
  check(parseAppointmentId(12.5) === null, 'a fractional id is not');
  check(!parseAppointmentUpdate(null).ok, 'a non-record update is rejected rather than thrown on');
}

// ---------------------------------------------------------------------------
console.log('\nBlackout parsing (AC8, parser half)');
// ---------------------------------------------------------------------------
{
  const ok = parseBlackoutInput({ day: '2026-12-25', reason: 'Christmas Day' });
  check(ok.ok && ok.input.day === '2026-12-25', 'a valid day parses');
  check(ok.ok && ok.input.reason === 'Christmas Day', 'the reason survives');

  const noReason = parseBlackoutInput({ day: '2026-12-25', reason: '  ' });
  check(noReason.ok && noReason.input.reason === null, 'a blank reason is null, not an empty string');

  for (const bad of ['', '25-12-2026', '2026-13-01', '2026-02-30', '2026-12-25T00:00:00Z', 'today']) {
    check(!parseBlackoutInput({ day: bad }).ok, `day ${JSON.stringify(bad)} is rejected`);
    check(parseBlackoutDay(bad) === null, `and the delete form rejects it identically`);
  }
  check(parseBlackoutDay('2026-12-25') === '2026-12-25', 'the delete form accepts a valid day');
  check(parseBlackoutDay(undefined) === null, 'a missing day is not a day');
  check(
    !parseBlackoutInput({ day: '2026-12-25', reason: 'x'.repeat(500) }).ok,
    'an over-long reason is rejected',
  );
}

// ---------------------------------------------------------------------------
console.log('\nsendCustomerConfirmation — count and audience (AC5)');
// ---------------------------------------------------------------------------
{
  // The flag is checked before `deps.send` is consulted, so it would mute every
  // assertion below. Explicitly unset in this scope — the DB script sets it, and
  // an inherited value here would turn this whole section green for free.
  delete process.env.BOOKING_NOTIFY_DISABLED;

  const parsed = parseAdminEntry(
    entry({
      payment_route: 'insurance',
      insurer_name: 'Prairie Mutual',
      policy_number: 'POLICYSENTINEL-77Q',
      claim_number: 'CLAIMSENTINEL-42Z',
    }),
    OPTS,
  );
  if (!parsed.ok) {
    check(false, 'the send fixture must parse');
    throw new Error('fixture did not parse');
  }
  const plan = planForPayload(4812, parsed.payload, 'Water Damage Restoration', NOW);

  // The plan carries BOTH messages — it is the same BK-05 builder the public
  // path uses. Asserting that first is what makes "only one was delivered" mean
  // something: against a plan with no internal message it could not fail.
  check(plan.internal.to === BOOKING_INTERNAL_TO, 'the plan does contain an internal message');
  check(plan.customer !== null, 'and a customer message');
  check(plan.bookingId === 4812, 'and the booking id, for the idempotency key');

  const seen: Message[] = [];
  const record = async (message: Message): Promise<SendResult> => {
    seen.push(message);
    return { ok: true };
  };

  const outcome = await sendCustomerConfirmation(plan, { send: record });
  check(outcome === 'sent', 'a successful send reports sent');
  check(seen.length === 1, `exactly one message is delivered, got ${seen.length}`);
  check(seen[0]?.to === 'dana@example.com', 'and it is addressed to the customer');
  check(
    !seen.some((m) => m.to === BOOKING_INTERNAL_TO),
    'the confirmation path still never reaches the office inbox',
  );
  check(
    !seen.some((m) => m.subject.includes('New booking')),
    'and the internal message is not delivered under another address either',
  );

  // The locked PII rule, checked on the message this path actually delivers —
  // not on the plan. The builder is shared, so this cannot regress on its own;
  // it is here because the admin path is a second caller and the rule is the
  // kind that gets broken by a "just add the policy number for the office" edit.
  const delivered = [seen[0]?.subject, seen[0]?.html, seen[0]?.text, seen[0]?.to].join('\n');
  check(!delivered.includes('POLICYSENTINEL-77Q'), 'the delivered message carries no policy number');
  check(!delivered.includes('CLAIMSENTINEL-42Z'), 'nor a claim number');

  // Contrast: the untouched public path still delivers both. Without this the
  // "exactly one" assertion above would also pass for a module that had stopped
  // sending anything at all.
  const both: Message[] = [];
  await sendBookingNotifications(plan, {
    send: async (m) => {
      both.push(m);
      return { ok: true };
    },
  });
  check(both.length === 2, `the public path still delivers two messages, got ${both.length}`);
  check(both.some((m) => m.to === BOOKING_INTERNAL_TO), 'including the office one');
}

// ---------------------------------------------------------------------------
console.log('\nThe narrowed invariant: the office gets a calendar artifact, never a notification (BK-14)');
// ---------------------------------------------------------------------------
{
  // WHAT THIS SECTION REPLACES, AND WHY IT IS NOT THE OLD ASSERTION WITH AN
  // EXCEPTION BOLTED ON. The rule used to be "no admin action ever mails the
  // office", asserted as `!seen.some(m => m.to === office)` — a check that
  // stays green when a path stops sending ANYTHING. BK-14 makes exactly one
  // admin action mail the office on purpose, so the assertion has to be
  // two-sided: exactly one message, addressed to the office, and it is the
  // invite rather than the lead notification.
  //
  // LIB-LEVEL, through the injected seam, and deliberately so: a route-level
  // run happens under the mute, which silences injected fakes too, so it could
  // not tell "muted" from "never wired". The route wiring is pinned at the
  // source in verify:booking:ics and rendered for real by the post-deploy check.
  delete process.env.BOOKING_NOTIFY_DISABLED;

  const parsed = parseAdminEntry(entry({ name: 'Dana Whitecloud' }), OPTS);
  if (!parsed.ok) {
    check(false, 'the invite fixture must parse');
    throw new Error('fixture did not parse');
  }

  const event = inviteEventFromPayload(4815, parsed.payload, 'Water Damage Restoration');

  for (const kind of ['request', 'cancel'] as const) {
    const seen: Message[] = [];
    const outcome = await sendCalendarInvite(
      planCalendarInvite(event, kind, NOW),
      { id: 4815, kind, now: NOW },
      {
        send: async (m) => {
          seen.push(m);
          return { ok: true };
        },
      },
    );

    check(outcome === 'sent', `the ${kind} invite reports sent`);
    // Both halves. "Exactly one" fails if the path goes silent; "to the office"
    // fails if it goes to the customer instead.
    check(seen.length === 1, `exactly one message is delivered for a ${kind}, got ${seen.length}`);
    check(seen[0]?.to === BOOKING_INTERNAL_TO, `and it is addressed to the office`);
    check(
      (seen[0]?.attachments?.length ?? 0) === 1,
      `and it carries the ICS — an invite with no attachment is a pointless email`,
    );
    check(
      seen[0]?.attachments?.[0].contentType.includes('text/calendar') ?? false,
      'which really is a calendar artifact',
    );
    check(
      !(seen[0]?.subject.includes('New booking') ?? true),
      'it is NOT the lead notification the invariant still forbids',
    );
    // The lead notification's tell is its content, not just its subject: it
    // lists the phone, the description, the file count and the SMS consent.
    check(
      !(seen[0]?.text.includes('SMS consent') ?? true),
      'and carries none of the notification body',
    );
  }

  // The other direction of the narrowing, restated where someone editing this
  // file will see it: everything else the admin surface does still mails the
  // office nothing. `sendCustomerConfirmation` reads `plan.customer` and no
  // other field, which is asserted above and is a property of the code.
  const plan = planForPayload(4816, parsed.payload, 'Water Damage Restoration', NOW);
  const resent: Message[] = [];
  await sendCustomerConfirmation(plan, {
    send: async (m) => {
      resent.push(m);
      return { ok: true };
    },
  });
  check(
    resent.every((m) => m.to !== BOOKING_INTERNAL_TO),
    'a resend still mails the office nothing, invite or otherwise',
  );
  check(
    resent.every((m) => (m.attachments?.length ?? 0) === 0),
    'and the customer copy carries no calendar attachment',
  );
}

// ---------------------------------------------------------------------------
console.log('\nsendCustomerConfirmation — outcomes (AC5)');
// ---------------------------------------------------------------------------
{
  delete process.env.BOOKING_NOTIFY_DISABLED;

  const withEmail = planBookingNotifications({
    id: 4813,
    slotLabel: 'Mon, Aug 24 · 1:30 p.m.',
    slotStart: new Date('2026-08-24T19:30:00.000Z'),
    now: NOW,
    name: 'Dana Whitecloud',
    phone: '780-555-0142',
    email: 'dana@example.com',
    serviceLabel: 'Water Damage Restoration',
    description: null,
    address: '123 Maple St',
    city: 'Edmonton',
    postalCode: null,
    paymentRoute: 'private',
    insurerName: null,
    policyNumber: null,
    claimNumber: null,
    smsConsent: false,
    filesAttached: 0,
  });
  const noEmail = planBookingNotifications({
    id: 4814,
    slotLabel: 'Mon, Aug 24 · 2:30 p.m.',
    slotStart: new Date('2026-08-24T20:30:00.000Z'),
    now: NOW,
    name: 'Sam Rivers',
    phone: '780-555-0143',
    email: null,
    serviceLabel: 'Mold Removal',
    description: null,
    address: '9 Spruce Ave',
    city: 'Edmonton',
    postalCode: null,
    paymentRoute: 'private',
    insurerName: null,
    policyNumber: null,
    claimNumber: null,
    smsConsent: false,
    filesAttached: 0,
  });

  const sent = async (): Promise<SendResult> => ({ ok: true });
  // What resend@6.17.1 actually does on a bad key: it RESOLVES with an error
  // rather than throwing, which is why try/catch around it catches nothing.
  const failed = async (): Promise<SendResult> => ({
    ok: false,
    error: 'validation_error: API key is invalid',
  });
  const threw = async (): Promise<SendResult> => {
    throw new Error('socket hang up');
  };

  check(await sendCustomerConfirmation(withEmail, { send: sent }) === 'sent', 'success → sent');
  check(
    (await sendCustomerConfirmation(withEmail, { send: failed })) === 'failed',
    'a resolved error response is failed, never sent',
  );
  check(
    (await sendCustomerConfirmation(withEmail, { send: threw })) === 'failed',
    'a throwing sender is caught rather than escaping into the route',
  );
  check(
    (await sendCustomerConfirmation(noEmail, { send: sent })) === 'skipped',
    'no email address → skipped, and nothing is delivered',
  );

  // No customer message means no send at all — not an unaddressed one.
  const attempts: Message[] = [];
  await sendCustomerConfirmation(noEmail, {
    send: async (m) => {
      attempts.push(m);
      return { ok: true };
    },
  });
  check(attempts.length === 0, `a no-email plan delivers nothing, got ${attempts.length}`);

  // The disable flag is fail-open and only a deliberate value trips it: `0` and
  // `false` are what someone writes meaning "present but off", and treating
  // those as "disable" would silently stop every confirmation in production.
  for (const [value, muted] of [
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['', false],
  ] as const) {
    process.env.BOOKING_NOTIFY_DISABLED = value;
    const calls: Message[] = [];
    const outcome = await sendCustomerConfirmation(withEmail, {
      send: async (m) => {
        calls.push(m);
        return { ok: true };
      },
    });
    check(
      (outcome === 'skipped' && calls.length === 0) === muted,
      `BOOKING_NOTIFY_DISABLED=${JSON.stringify(value)} must ${muted ? 'mute' : 'not mute'}`,
    );
  }
  delete process.env.BOOKING_NOTIFY_DISABLED;

  // An unset key is reported, not thrown on: `new Resend(falsy)` DOES throw, so
  // the key has to be checked before the client is constructed.
  const realKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    check(
      (await sendCustomerConfirmation(withEmail)) === 'failed',
      'an unset RESEND_API_KEY reports failed rather than throwing',
    );
  } finally {
    if (realKey !== undefined) process.env.RESEND_API_KEY = realKey;
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe parsers read no environment and no database');
// ---------------------------------------------------------------------------
{
  const { readFileSync } = await import('fs');
  const { resolve, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Comments stripped first. This module's header *names* the functions it must
  // not call, in prose, to explain why — scanning the raw text would make the
  // ban unsatisfiable by any file that documents itself.
  const source = readFileSync(resolve(root, 'src/lib/booking-admin-entry.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  check(!source.includes('import.meta.env'), 'booking-admin-entry.ts reads no import.meta.env');
  check(!source.includes('process.env'), 'booking-admin-entry.ts reads no process.env');
  check(!source.includes('getDb'), 'and never reaches the database client');
  check(!source.includes('new Date()'), 'and has no clock of its own — a parser is not a scheduler');

  // The bypass is expressed by NOT CALLING the window checks. A shared predicate
  // growing an `isAdmin` parameter is how the public path inherits the bypass,
  // so the admin parser must not touch them at all.
  for (const banned of ['isSlotBookable', 'isWithinBookingWindow', 'earliestBookableInstant']) {
    check(!source.includes(banned), `and does not call ${banned} — admin bypasses the windows`);
  }
  // But it does call the one check that is NOT optional.
  check(source.includes('isSlotOnGrid'), 'while still gating on isSlotOnGrid');
  check(source.includes('zonedTimeToUtc'), 'and building the instant with the zone-aware helper');
  check(TIMEZONE === 'America/Edmonton', 'the zone those helpers default to is Edmonton');
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ admin entry checks passed\n');
