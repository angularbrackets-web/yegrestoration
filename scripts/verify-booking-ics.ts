// Checks the calendar invite: what the ICS says, what it must never say, how a
// transition is keyed, and that the SDK boundary actually forwards it.
//
//   npm run verify:booking:ics
//
// Pure: no network, no database, no live API key. `booking-ics.ts` is a string
// builder and `sendCalendarInvite` takes an injected sender, so the mute, the
// missing-key arm and the idempotency prefix are all reachable here without
// mailing anybody.
//
// TWO OF THESE ASSERTIONS ARE SOURCE PINS AND ARE HONESTLY WEAK. The mapping
// from `Message` to the Resend SDK is an object literal behind a boundary this
// script cannot drive without a live key, and the two route call sites are
// wiring a route-level run under the mute cannot distinguish from "never
// wired". They are read off the file rather than executed, they are labelled as
// such below, and the ticket's post-deploy check is the real pin.
//
// Exits non-zero if any assertion fails.
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { parseAdminEntry } from '../src/lib/booking-admin-entry';
import {
  inviteEventFromAppointment,
  inviteEventFromPayload,
  planCalendarInvite,
} from '../src/lib/booking-admin-notify';
import {
  BOOKING_EMAIL_FROM,
  BOOKING_INTERNAL_TO,
  ICS_ORGANIZER,
  SLOT_MINUTES,
} from '../src/lib/booking-config';
import type { Message } from '../src/lib/booking-email';
import {
  buildBookingIcs,
  escapeIcsText,
  foldIcsLine,
  icsAttachment,
  icsSequence,
  icsUid,
  inviteIdempotencyPrefix,
  type IcsEvent,
} from '../src/lib/booking-ics';
import { sendCalendarInvite, type SendResult } from '../src/lib/booking-notify';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sentinels again, and for the reason `verify-booking-email.ts` states: a
 * policy number that is a substring of the address makes "the ICS does not
 * contain the policy number" an assertion that cannot fail.
 */
const POLICY = 'POLICYSENTINEL-77Q';
const CLAIM = 'CLAIMSENTINEL-42Z';

const SLOT = new Date('2026-08-24T19:30:00.000Z'); // 13:30 Edmonton, MDT
const NOW = new Date('2026-08-20T15:00:00.000Z');
const LATER = new Date('2026-08-21T15:00:00.000Z');

const EVENT: IcsEvent = {
  id: 481,
  name: 'Dana Whitecloud',
  serviceLabel: 'Water Damage Restoration',
  phone: '780-555-0142',
  address: '123 Maple St',
  city: 'Edmonton',
  postalCode: 'T5J 2R7',
  slotStart: SLOT,
};

/** Folded content lines rejoined. Every content assertion reads this. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '');
}

/** One property's value, unfolded. `null` when the property is absent. */
function prop(ics: string, name: string): string | null {
  const line = unfold(ics)
    .split('\r\n')
    .find((l) => l === name || l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  if (line === undefined) return null;
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1);
}

// ---------------------------------------------------------------------------
console.log('\nRFC 5545 shape: CRLF, required properties, METHOD/STATUS pairing');
// ---------------------------------------------------------------------------
{
  const request = buildBookingIcs(EVENT, 'request', NOW);
  const cancel = buildBookingIcs(EVENT, 'cancel', NOW);

  for (const [kind, ics] of [
    ['request', request],
    ['cancel', cancel],
  ] as const) {
    // A bare LF anywhere is the whole file malformed. Checked by counting
    // rather than by a regex on the joined string, so a single stray one in the
    // middle of a description cannot hide.
    const bareLf = ics.split('\n').length - 1 - (ics.split('\r\n').length - 1);
    check(bareLf === 0, `the ${kind} ICS has no bare LF, got ${bareLf}`);
    check(ics.endsWith('\r\n'), `the ${kind} ICS ends with a CRLF`);
    check(ics.startsWith('BEGIN:VCALENDAR\r\n'), `the ${kind} ICS opens the calendar`);
    check(ics.trimEnd().endsWith('END:VCALENDAR'), `and closes it`);
    check(unfold(ics).includes('BEGIN:VEVENT\r\n'), `the ${kind} ICS has a VEVENT`);
    check(prop(ics, 'VERSION') === '2.0', `the ${kind} ICS declares VERSION:2.0`);
    check((prop(ics, 'PRODID') ?? '').length > 0, `the ${kind} ICS declares a PRODID`);
  }

  check(prop(request, 'METHOD') === 'REQUEST', 'a create is METHOD:REQUEST');
  check(prop(request, 'STATUS') === 'CONFIRMED', 'and STATUS:CONFIRMED');
  check(prop(cancel, 'METHOD') === 'CANCEL', 'a cancellation is METHOD:CANCEL');
  check(
    prop(cancel, 'STATUS') === 'CANCELLED',
    'and STATUS:CANCELLED — METHOD alone does not clear an event a client already holds',
  );

  // DTSTAMP is required, and it comes from the INJECTED instant rather than
  // from the wall clock — otherwise this script could not assert it at all.
  check(prop(request, 'DTSTAMP') === '20260820T150000Z', `DTSTAMP is the injected now, got ${prop(request, 'DTSTAMP')}`);
  check(
    prop(buildBookingIcs(EVENT, 'request', LATER), 'DTSTAMP') === '20260821T150000Z',
    'and it moves with it',
  );
}

// ---------------------------------------------------------------------------
console.log('\nUID and ORGANIZER are identical across the lifecycle');
// ---------------------------------------------------------------------------
{
  // Both halves of what Gmail matches a CANCEL against. A cancel carrying a
  // fresh UID, or an organizer spelled the friendly-name way the FROM header
  // uses, is a cancel Google quietly ignores — the event stays on the calendar
  // and nothing anywhere reports a failure.
  const request = buildBookingIcs(EVENT, 'request', NOW);
  const cancel = buildBookingIcs(EVENT, 'cancel', LATER);

  check(prop(request, 'UID') === icsUid(481), `the UID is booking-<id>@domain, got ${prop(request, 'UID')}`);
  check(prop(cancel, 'UID') === prop(request, 'UID'), 'and the cancel carries the same UID');
  check(
    prop(request, 'ORGANIZER') === `mailto:${ICS_ORGANIZER}`,
    `the organizer is the bare sending address, got ${prop(request, 'ORGANIZER')}`,
  );
  check(
    prop(cancel, 'ORGANIZER') === prop(request, 'ORGANIZER'),
    'and the cancel carries the same organizer',
  );
  // The bare-address rule, stated as its own assertion: `BOOKING_EMAIL_FROM` is
  // `Name <addr>`, and interpolating that into ORGANIZER is the obvious edit.
  check(
    !(prop(request, 'ORGANIZER') ?? '').includes('<'),
    'the organizer is not the friendly-name form',
  );
  check(BOOKING_EMAIL_FROM.includes(ICS_ORGANIZER), 'and it is the same identity the mail is sent from');
  check(
    (prop(request, 'ATTENDEE') ?? '').endsWith(`mailto:${BOOKING_INTERNAL_TO}`),
    `the office is the attendee, got ${prop(request, 'ATTENDEE')}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nSEQUENCE increases per transition');
// ---------------------------------------------------------------------------
{
  const created = Number(prop(buildBookingIcs(EVENT, 'request', NOW), 'SEQUENCE'));
  const cancelled = Number(prop(buildBookingIcs(EVENT, 'cancel', LATER), 'SEQUENCE'));
  const restored = Number(
    prop(buildBookingIcs(EVENT, 'request', new Date(LATER.getTime() + 60_000)), 'SEQUENCE'),
  );

  check(Number.isInteger(created), `SEQUENCE is an integer, got ${prop(buildBookingIcs(EVENT, 'request', NOW), 'SEQUENCE')}`);
  check(cancelled > created, `a later cancel outranks the create (${created} → ${cancelled})`);
  check(restored > cancelled, `and a restore outranks the cancel (${cancelled} → ${restored})`);
  check(created === icsSequence(NOW), 'the value is the exported derivation, not a second copy of it');

  // The documented int32 horizon. Asserted rather than commented so the day it
  // stops being true is a red gate rather than a calendar that silently stops
  // accepting revisions.
  check(icsSequence(NOW) < 2_147_483_647, 'and it still fits an iCalendar INTEGER (int32, to 2038-01-19)');

  // One second apart is one step, which is the documented granularity bound.
  check(
    icsSequence(new Date(NOW.getTime() + 999)) === icsSequence(NOW),
    'sub-second transitions share a SEQUENCE — the accepted bound, stated as a fact',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe instants: UTC Z form, and the slot is 30 minutes long');
// ---------------------------------------------------------------------------
{
  const ics = buildBookingIcs(EVENT, 'request', NOW);
  const start = prop(ics, 'DTSTART') ?? '';
  const end = prop(ics, 'DTEND') ?? '';

  check(/^\d{8}T\d{6}Z$/.test(start), `DTSTART is a UTC instant, got ${start}`);
  check(/^\d{8}T\d{6}Z$/.test(end), `DTEND is a UTC instant, got ${end}`);
  check(start === '20260824T193000Z', `DTSTART is the slot instant, got ${start}`);
  check(end === '20260824T200000Z', `DTEND is DTSTART + ${SLOT_MINUTES} minutes, got ${end}`);
  check(SLOT_MINUTES === 30, 'and the locked appointment length is still 30 minutes');

  // No VTIMEZONE block, which is the point of the Z form: Google renders in the
  // viewer's zone and there is no zone table to get wrong.
  check(!ics.includes('BEGIN:VTIMEZONE'), 'no VTIMEZONE block is needed or emitted');

  // A winter slot, because a frozen offset gets exactly one of the two right —
  // the same trap `verify-slots.ts` exists for. The builder does no zone maths
  // at all, and this is what makes that claim falsifiable.
  const winter = buildBookingIcs(
    { ...EVENT, slotStart: new Date('2026-01-15T20:30:00.000Z') },
    'request',
    NOW,
  );
  check(prop(winter, 'DTSTART') === '20260115T203000Z', 'a winter slot is carried as its own instant');
  check(prop(winter, 'DTEND') === '20260115T210000Z', 'and its end is half an hour later');
}

// ---------------------------------------------------------------------------
console.log('\nContent: summary, location, description');
// ---------------------------------------------------------------------------
{
  // PER PROPERTY, not against the whole file. The red pass caught the
  // whole-file version being unfailable: dropping the service label from
  // SUMMARY left `body.includes('Water Damage Restoration')` green, because
  // DESCRIPTION carries a `Service:` line of its own. A content assertion has
  // to name the property it is about.
  const ics = buildBookingIcs(EVENT, 'request', NOW);
  const summary = prop(ics, 'SUMMARY') ?? '';
  const location = prop(ics, 'LOCATION') ?? '';
  const description = prop(ics, 'DESCRIPTION') ?? '';

  check(summary.startsWith('Assessment'), `the summary says what the appointment is, got ${summary}`);
  check(summary.includes('Dana Whitecloud'), 'and who it is for');
  check(summary.includes('Water Damage Restoration'), 'and which service');
  check(location.includes('123 Maple St'), 'the location carries the address');
  check(location.includes('Edmonton'), 'the city');
  check(location.includes('T5J 2R7'), 'and the postal code');
  check(description.includes('780-555-0142'), 'the description carries the phone number');
  check(description.includes('Water Damage Restoration'), 'the service');
  check(description.includes('about 30 minutes'), 'and the visit-length line');

  // A missing postal code must not leave a dangling separator.
  const noPostal = prop(buildBookingIcs({ ...EVENT, postalCode: null }, 'request', NOW), 'LOCATION') ?? '';
  check(!noPostal.endsWith(', '), `a blank postal code is dropped, got ${JSON.stringify(noPostal)}`);
  check(noPostal.includes('Edmonton'), 'and the rest of the address survives');
}

// ---------------------------------------------------------------------------
console.log('\nThe stricter-than-email rule: no insurance identifier in a calendar artifact');
// ---------------------------------------------------------------------------
{
  // Built through the REAL mapper from a fully-insured booking, so the policy
  // and claim numbers are genuinely in the input. A hand-built `IcsEvent` could
  // not carry them — the type has no such fields — which would make this an
  // assertion that cannot fail.
  const parsed = parseAdminEntry(
    {
      slot_date: '2026-08-24',
      slot_time: '13:30',
      name: 'Dana Whitecloud',
      phone: '780-555-0142',
      email: 'dana@example.com',
      service: 'water',
      description: 'Basement flooded overnight.',
      address: '123 Maple St',
      city: 'Edmonton',
      postal_code: 'T5J 2R7',
      payment_route: 'insurance',
      insurer_name: 'Prairie Mutual',
      policy_number: POLICY,
      claim_number: CLAIM,
    },
    { allowedServices: new Set(['water', 'fire', 'mold', 'other']) },
  );
  check(parsed.ok, 'the insured fixture parses');
  if (!parsed.ok) throw new Error('insured fixture did not parse');

  // The fixture really does carry them, or everything below passes for free.
  check(parsed.payload.policy_number === POLICY, 'and really does carry a policy number');
  check(parsed.payload.claim_number === CLAIM, 'and a claim number');

  const event = inviteEventFromPayload(4812, parsed.payload, 'Water Damage Restoration');
  for (const kind of ['request', 'cancel'] as const) {
    // UNFOLDED, and this is not a detail. A DESCRIPTION long enough to fold —
    // which is every one of them — can split an identifier across a CRLF and a
    // leading space, and `raw.includes(POLICY)` is then false for an ICS that
    // plainly carries it. The red pass caught exactly that: the break went
    // green against the raw string. Both are checked, because the raw form
    // catches an identifier somewhere folding does not reach.
    const ics = unfold(buildBookingIcs(event, kind, NOW));
    const raw = buildBookingIcs(event, kind, NOW);
    check(!ics.includes(POLICY) && !raw.includes(POLICY), `the ${kind} ICS carries no policy number`);
    check(!ics.includes(CLAIM) && !raw.includes(CLAIM), `the ${kind} ICS carries no claim number`);
    check(!ics.includes('Prairie Mutual'), `nor the insurer's name`);
    // Whole-message, not just the ICS: the invite email itself is a calendar
    // artifact too, and it is one `row('Policy #', …)` away from carrying them.
    const message = planCalendarInvite(event, kind, NOW);
    // Attachment CONTENT rather than a JSON dump of it: `JSON.stringify`
    // escapes the CRLFs, so unfolding could not reach inside a dumped string
    // and the whole-message check would inherit the folding blindness above.
    const all = [
      message.subject,
      message.html,
      message.text,
      ...(message.attachments ?? []).map((a) => `${a.filename}\n${a.contentType}\n${unfold(a.content)}`),
    ].join('\n');
    check(!all.includes(POLICY), `the ${kind} invite email carries no policy number`);
    check(!all.includes(CLAIM), `the ${kind} invite email carries no claim number`);
  }

  // The mapper is the guarantee, so assert its output shape rather than only
  // the absence: a spread of the payload would carry the two fields into a type
  // that does not declare them, and `JSON.stringify` would then find them.
  check(
    !JSON.stringify(event).includes('SENTINEL'),
    'no insurance identifier survives the mapper at all',
  );
  check(event.slotStart.getTime() === parsed.payload.slotStart.getTime(), 'and the slot instant is carried through');
}

// ---------------------------------------------------------------------------
console.log('\nEscaping and folding');
// ---------------------------------------------------------------------------
{
  check(escapeIcsText('a\\b') === 'a\\\\b', 'a backslash is doubled');
  check(escapeIcsText('a;b') === 'a\\;b', 'a semicolon is escaped');
  check(escapeIcsText('a,b') === 'a\\,b', 'a comma is escaped');
  check(escapeIcsText('a\nb') === 'a\\nb', 'a newline becomes \\n');
  check(escapeIcsText('a\r\nb') === 'a\\nb', 'and a CRLF becomes ONE \\n, not two');
  // Order: the backslash pass must run first, or every escape it adds is
  // escaped again by the passes after it.
  check(escapeIcsText('a\\;b') === 'a\\\\\\;b', 'a literal backslash before a semicolon survives both passes');

  // A comma in an address is the ordinary case, not the exotic one.
  const comma = unfold(
    buildBookingIcs({ ...EVENT, address: 'Suite 5, 123 Maple St' }, 'request', NOW),
  );
  check(comma.includes('Suite 5\\, 123 Maple St'), 'a comma in the address is escaped in LOCATION');
  const semi = unfold(buildBookingIcs({ ...EVENT, name: 'Dana; Whitecloud' }, 'request', NOW));
  check(semi.includes('Dana\\; Whitecloud'), 'a semicolon in the name is escaped in SUMMARY');

  // Folding, at the octet boundary rather than the character one.
  check(foldIcsLine('x'.repeat(75)) === 'x'.repeat(75), 'a 75-octet line is not folded');
  const folded = foldIcsLine('x'.repeat(200));
  for (const line of folded.split('\r\n')) {
    check(Buffer.byteLength(line, 'utf8') <= 75, `every folded line is ≤75 octets, got ${Buffer.byteLength(line, 'utf8')}`);
  }
  check(
    folded.split('\r\n').slice(1).every((l) => l.startsWith(' ')),
    'and every continuation begins with a space',
  );
  check(folded.replace(/\r\n /g, '') === 'x'.repeat(200), 'unfolding restores the original exactly');

  // Multi-byte: an em dash is three octets, and splitting one in half yields a
  // file no parser will read. 30 of them is 90 octets, so a fold MUST happen
  // inside the run.
  const dashes = foldIcsLine('—'.repeat(30));
  check(dashes.includes('\r\n '), 'a multi-byte line long enough to fold does fold');
  for (const line of dashes.split('\r\n')) {
    check(Buffer.byteLength(line, 'utf8') <= 75, 'and each octet-counted line stays within 75');
  }
  check(dashes.replace(/\r\n /g, '') === '—'.repeat(30), 'and no character is split across the fold');

  // End to end, through the builder, on the field most likely to be long.
  const longAddress = '1234 Extremely Long Street Name Northwest, Second Floor, Rear Entrance By The Alley';
  const ics = buildBookingIcs({ ...EVENT, address: longAddress }, 'request', NOW);
  for (const line of ics.split('\r\n')) {
    check(Buffer.byteLength(line, 'utf8') <= 75, `every builder line is ≤75 octets, got ${Buffer.byteLength(line, 'utf8')}`);
  }
  check(
    unfold(ics).includes(escapeIcsText(longAddress)),
    'and the long address survives unfolding intact',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe attachment, and the message that carries it');
// ---------------------------------------------------------------------------
{
  const ics = buildBookingIcs(EVENT, 'request', NOW);
  const attachment = icsAttachment(ics, 'request', EVENT.id);
  check(attachment.filename === 'assessment-481.ics', `the filename names the booking, got ${attachment.filename}`);
  check(attachment.content === ics, 'the content is the ICS itself');
  check(
    attachment.contentType === 'text/calendar; charset=utf-8; method=REQUEST',
    `the content type carries method=REQUEST, got ${attachment.contentType}`,
  );
  check(
    icsAttachment(ics, 'cancel', EVENT.id).contentType.endsWith('method=CANCEL'),
    'and a cancellation carries method=CANCEL',
  );

  for (const kind of ['request', 'cancel'] as const) {
    const message = planCalendarInvite(EVENT, kind, NOW);
    check(message.to === BOOKING_INTERNAL_TO, `the ${kind} invite is addressed to the office`);
    check(message.from === BOOKING_EMAIL_FROM, 'from the shared sender identity');
    check(message.replyTo === undefined, 'with no reply-to — it is the office writing to itself');
    check(message.attachments?.length === 1, `exactly one attachment, got ${message.attachments?.length}`);
    check(
      message.attachments?.[0].contentType.includes(kind === 'cancel' ? 'CANCEL' : 'REQUEST') ?? false,
      `and it is the ${kind} ICS`,
    );
    check(message.subject.includes('#481'), 'the subject names the booking');
    check(message.subject.includes('Dana Whitecloud'), 'and the customer');
    check(!message.subject.includes('\n'), 'and carries no newline');
    // The narrowed invariant at its source: this is a CALENDAR artifact, not
    // the lead notification the invariant still forbids.
    check(!message.subject.includes('New booking'), 'it is not the internal notification');
    check(message.text.length < 400, 'the body is deliberately tiny');
  }
  check(
    planCalendarInvite(EVENT, 'cancel', NOW).subject !== planCalendarInvite(EVENT, 'request', NOW).subject,
    'a cancellation does not arrive under the same subject as the booking',
  );

  // A hostile name reaches the subject and the html body of the invite.
  const hostile = planCalendarInvite({ ...EVENT, name: `<img src=x onerror="alert(1)">` }, 'request', NOW);
  check(!hostile.html.includes('<img src=x'), 'the invite html has no injected tag');
  check(hostile.html.includes('&lt;img src=x'), 'it survives as escaped text');
  const newline = planCalendarInvite({ ...EVENT, name: 'Dana\nWhitecloud' }, 'request', NOW);
  check(!newline.subject.includes('\n'), 'a name with a newline is collapsed in the subject');

  // The other mapper, driven from a row-shaped record.
  const fromRow = inviteEventFromAppointment(
    {
      id: 99,
      name: 'Sam Rivers',
      phone: '780-555-0143',
      address: '9 Spruce Ave',
      city: 'Edmonton',
      postal_code: null,
      slot_start: SLOT,
    },
    'Mold Removal',
  );
  check(fromRow.id === 99 && fromRow.name === 'Sam Rivers', 'the row mapper carries the identity');
  check(fromRow.postalCode === null, 'and a null postal code stays null');
  check(fromRow.slotStart.getTime() === SLOT.getTime(), 'and the slot instant');
  check(
    unfold(buildBookingIcs(fromRow, 'cancel', NOW)).includes('UID:booking-99@'),
    'and it builds a cancellation for the right booking',
  );
}

// ---------------------------------------------------------------------------
console.log('\nsendCalendarInvite — the mute, the missing key, the per-transition key');
// ---------------------------------------------------------------------------
{
  delete process.env.BOOKING_NOTIFY_DISABLED;

  const message = planCalendarInvite(EVENT, 'request', NOW);
  const keyParts = { id: EVENT.id, kind: 'request' as const, now: NOW };

  const seen: Message[] = [];
  const record = async (m: Message): Promise<SendResult> => {
    seen.push(m);
    return { ok: true };
  };

  check(await sendCalendarInvite(message, keyParts, { send: record }) === 'sent', 'a successful send reports sent');
  check(seen.length === 1, `exactly one message is delivered, got ${seen.length}`);
  check(seen[0]?.to === BOOKING_INTERNAL_TO, 'addressed to the office');
  check(seen[0]?.attachments?.length === 1, 'and the attachment reaches the sender');

  check(
    (await sendCalendarInvite(message, keyParts, {
      send: async () => ({ ok: false, error: 'validation_error: API key is invalid' }),
    })) === 'failed',
    'a resolved error response is failed, never sent',
  );
  check(
    (await sendCalendarInvite(message, keyParts, {
      send: async () => {
        throw new Error('socket hang up');
      },
    })) === 'failed',
    'a throwing sender is caught rather than escaping into the route',
  );

  // The mute is checked BEFORE the seam, so it silences an injected fake too —
  // which is why every route-level script asserts nothing about sends.
  for (const [value, muted] of [
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
    ['', false],
  ] as const) {
    process.env.BOOKING_NOTIFY_DISABLED = value;
    const calls: Message[] = [];
    const outcome = await sendCalendarInvite(message, keyParts, {
      send: async (m) => {
        calls.push(m);
        return { ok: true };
      },
    });
    check(
      (outcome === 'skipped' && calls.length === 0) === muted,
      `BOOKING_NOTIFY_DISABLED=${JSON.stringify(value)} must ${muted ? 'mute' : 'not mute'} the invite`,
    );
  }
  delete process.env.BOOKING_NOTIFY_DISABLED;

  // An unset key is reported, not thrown on: `new Resend(falsy)` DOES throw.
  const realKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    check(
      (await sendCalendarInvite(message, keyParts)) === 'failed',
      'an unset RESEND_API_KEY reports failed rather than throwing',
    );
  } finally {
    if (realKey !== undefined) process.env.RESEND_API_KEY = realKey;
  }

  // THE PLAN-REVIEW BLOCKER, as a regression test. The key is driven through
  // the exported symbol the sender actually uses — a second copy of the format
  // string here would keep passing while production collapsed to a fixed key.
  const create = inviteIdempotencyPrefix(481, 'request', NOW);
  const cancel = inviteIdempotencyPrefix(481, 'cancel', LATER);
  const restore = inviteIdempotencyPrefix(481, 'request', new Date(LATER.getTime() + 60_000));
  check(create !== cancel, `the cancel does not share the create's key (${create} vs ${cancel})`);
  check(cancel !== restore, `nor the restore the cancel's (${cancel} vs ${restore})`);
  check(create !== restore, 'and the restore is not the create again');
  check(new Set([create, cancel, restore]).size === 3, 'all three transitions key differently');
  check(create.includes('481'), 'the key still names the booking, so a retry within a transition collapses');
  check(
    inviteIdempotencyPrefix(481, 'request', NOW) === create,
    'and the same transition at the same instant keys identically — that is the retry case',
  );
  check(
    inviteIdempotencyPrefix(482, 'request', NOW) !== create,
    'two bookings never share a key',
  );
}

// ---------------------------------------------------------------------------
console.log('\nSource pins (weak by construction — see the header)');
// ---------------------------------------------------------------------------
{
  // 1. THE WHITELIST. `createResendSender` maps `Message` to the SDK through an
  //    explicit object literal, and the real call is behind a boundary this
  //    script cannot drive without a live key and a network. Removing the
  //    `attachments` line ships an attachment-less invite with every gate
  //    green, because the injected fakes above receive the whole `Message` and
  //    never that literal. Read off the file, and labelled as read.
  const notify = readFileSync(resolve(root, 'src/lib/booking-notify.ts'), 'utf8');
  const sender = notify.slice(notify.indexOf('export function createResendSender'));
  const literal = sender.slice(0, sender.indexOf('if (error)'));
  check(
    /attachments:\s*message\.attachments/.test(literal),
    'createResendSender forwards message.attachments to the SDK',
  );
  // The type alone is not enough, and this states why in an assertion: a field
  // on `Message` that the literal does not name is dropped silently.
  check(
    /text:\s*message\.text/.test(literal),
    'and the literal really is the whole mapping — the other fields are here too',
  );

  // 2. THE ROUTE CALL SITES. A route-level run under the mute cannot tell
  //    "muted" from "never wired", so the wiring is pinned here and rendered
  //    for real only by the ticket's post-deploy check.
  //
  //    THE FIRST VERSION OF THIS PIN WAS A CHECK THAT COULD NOT FAIL, and the
  //    red pass is what showed it: `source.includes('sendCalendarInvite')` is
  //    satisfied by the IMPORT LINE, so deleting the call out of the route left
  //    it green. Imports and comments are stripped first, and the helper each
  //    route wraps its send in must appear at least TWICE — once defined, once
  //    called — because a helper nobody calls is exactly what the break left
  //    behind.
  const strip = (file: string): string =>
    readFileSync(resolve(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/^import[\s\S]*?from '[^']*';$/gm, '');
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  for (const [label, file, helper, needles] of [
    [
      'the admin entry route',
      'src/pages/api/admin/appointments/create.ts',
      'sendOfficeInvite(',
      ['planCalendarInvite(', 'sendCalendarInvite(', 'inviteEventFromPayload('],
    ],
    [
      'the status-edit route',
      'src/pages/api/admin/appointments/update.ts',
      'sendBoundaryInvite(',
      ['planCalendarInvite(', 'sendCalendarInvite(', 'inviteEventFromAppointment(', 'prev_status'],
    ],
  ] as const) {
    const source = strip(file);
    for (const needle of needles) {
      check(source.includes(needle), `${label} calls ${needle}`);
    }
    check(
      count(source, helper) >= 2,
      `${label}'s ${helper.slice(0, -1)} is both defined and called, got ${count(source, helper)}`,
    );
  }

  // The public path's invite rides the internal notification rather than a
  // second email — so `booking-email.ts` is where it must be attached, and
  // `create.ts` must feed THE PLAN the two new fields. Pinned on the plan's
  // argument block rather than on the whole file, because
  // `slotStart: payload.slotStart` is also a substring of
  // `slotStart: payload.slotStart.toISOString()` in the JSON response twenty
  // lines earlier — which is how the first version of this pin survived a break
  // that took it out of the plan.
  const email = readFileSync(resolve(root, 'src/lib/booking-email.ts'), 'utf8');
  check(email.includes('icsAttachment('), 'the internal notification attaches an ICS');

  const publicRoute = strip('src/pages/api/booking/create.ts');
  const planArgs = publicRoute.slice(
    publicRoute.indexOf('planBookingNotifications({'),
    publicRoute.indexOf('filesAttached,'),
  );
  check(planArgs.length > 0, 'the public route builds the notification plan');
  check(
    /slotStart: payload\.slotStart,/.test(planArgs),
    'and passes the slot instant into it, not just the label',
  );
  check(/^ *now,$/m.test(planArgs), 'and the send instant');
  check(
    !publicRoute.includes('sendCalendarInvite'),
    'and it sends no second email — the public path has exactly one office message',
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ calendar invite checks passed\n');
