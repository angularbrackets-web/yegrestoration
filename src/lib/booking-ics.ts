/**
 * The iCalendar artifact a booking produces, as a value.
 *
 * Pure: a plain record in, an RFC 5545 string out. No Resend, no `readEnv`, no
 * clock of its own, no database — the same split as `booking-email.ts`, and for
 * the same reason: `scripts/verify-booking-ics.ts` drives every rule here under
 * plain `tsx`.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE, AND IT IS STRICTER THAN THE EMAIL'S.
 * `policy_number` and `claim_number` never appear in an ICS, for ANY audience —
 * not even the office, which receives them in the body of the very email this
 * attachment rides on. An email lands in one inbox; a calendar event syncs to
 * phones, to shared calendars, and into third-party apps that were never part
 * of the decision to store an insurance identifier. `IcsEvent` therefore does
 * not have the two fields at all, which is a stronger guarantee than
 * remembering not to interpolate them — the same shape as
 * `customerConfirmation` not reading them in `booking-email.ts`.
 *
 * WHAT IS PINNED AGAINST RFC 5545 RATHER THAN RECALL (the verify script asserts
 * each of these):
 *
 *   - CRLF line endings (§3.1), lines folded at 75 octets with a leading space
 *     on continuations. Octets, not characters — folding a multi-byte character
 *     in half produces an unparseable file.
 *   - TEXT values escape `\`, `;`, `,` and newlines (§3.3.11).
 *   - `METHOD:REQUEST` for a create or a restore, `METHOD:CANCEL` with
 *     `STATUS:CANCELLED` for a cancellation (§3.7.2), same `UID` throughout.
 *   - `SEQUENCE` must increase per revision (§3.8.7.4). See `icsSequence`.
 *   - `DTSTAMP` and `VERSION:2.0` are required (§3.6.1, §3.7.4).
 */

import {
  BOOKING_INTERNAL_TO,
  ICS_ORGANIZER,
  ICS_PRODID,
  ICS_UID_DOMAIN,
  SLOT_MINUTES,
} from './booking-config';
import { CANCEL_LINE, VISIT_LENGTH_LINE } from './booking-copy';
import type { EmailAttachment } from './booking-email';

/** A create/restore invite, or the cancellation of one. */
export type IcsKind = 'request' | 'cancel';

/** Which calendar this copy of the event is going onto. */
export type IcsAudienceName = 'office' | 'customer';

/**
 * WHO THE INVITE IS FOR, AND IT IS A REQUIRED ARGUMENT OF THE BUILDER.
 *
 * BK-14 built one artifact for one audience and hard-coded both audience-shaped
 * facts: `ATTENDEE` was `BOOKING_INTERNAL_TO`, and DESCRIPTION's first line was
 * the customer's phone number — "who do I call to reach them", which is a
 * sentence only the office has any use for. BK-16 adds a second audience, so
 * both become parameters.
 *
 * **Never defaulted, and that is the plan-review finding rather than a style
 * choice.** A default of `office` would let a customer-path caller that simply
 * forgets the argument mail a customer an ICS naming the office as the
 * attendee, with their own phone number as the description, and `npm run
 * typecheck` green. Required means the compiler asks the question at every
 * call site — which is also why this is a discriminated union rather than a
 * pair of loose strings: there is no way to spell "the office address with the
 * customer's contact line", and the customer case cannot be constructed
 * without the address the ATTENDEE needs.
 */
export type IcsAudience =
  | { audience: 'office' }
  | { audience: 'customer'; email: string };

/** The office's own calendar. Byte-identical to everything BK-14 shipped. */
export const ICS_OFFICE: IcsAudience = { audience: 'office' };

/** The customer's calendar. The address is the ATTENDEE, so it is not optional. */
export function icsCustomer(email: string): IcsAudience {
  return { audience: 'customer', email };
}

/**
 * Everything an invite needs, already resolved.
 *
 * Deliberately not the `appointments` row and not `BookingPayload`: the admin
 * create path holds only a payload plus the returned id, the update path holds
 * a self-join snapshot, and the public path holds the notification input. A
 * plain record is the one shape all three can produce and a verify script can
 * build by hand.
 *
 * Note what is absent: `policyNumber`, `claimNumber`, `insurerName`, `email`,
 * `description`. The first three are the locked rule above. `description` is
 * simply not a calendar's business — the email carries it. `email` is absent
 * for a different reason since BK-16: the customer's address is not a property
 * of the event, it is a property of WHO THIS COPY IS FOR, and it arrives on the
 * `IcsAudience` argument instead. Keeping it off the event is what stops the
 * office copy from ever being built with a customer attendee by accident.
 */
export type IcsEvent = {
  id: number;
  name: string;
  /** Display label, not the key — `SERVICE_LABELS[service]`. */
  serviceLabel: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string | null;
  /** The UTC instant. Never a formatted label — an ICS carries instants. */
  slotStart: Date;
};

/**
 * The revision counter, derived from the send instant rather than stored.
 *
 * RFC 5545 §3.8.7.4 asks only that it increase for each revision of an event.
 * Seconds-since-epoch does that for free: a cancel sent after a create is
 * strictly greater, and a restore after the cancel greater still, with no
 * column, no migration, and no read-modify-write race between two admin tabs.
 *
 * TWO BOUNDS, DOCUMENTED RATHER THAN DEFENDED:
 *
 *   1. One-second granularity. A cancel and an un-cancel inside the SAME second
 *      produce an equal SEQUENCE, and Google reads the restoring REQUEST as
 *      stale. That is two form submits and two redirects apart; accepted.
 *   2. iCalendar INTEGER is int32 (§3.3.8), which seconds-since-epoch crosses on
 *      2038-01-19. A dated horizon, not a defect this ticket pays to avoid.
 */
export function icsSequence(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

/** `booking-<id>@yegrestoration.ca` — stable across the whole lifecycle. */
export function icsUid(id: number): string {
  return `booking-${id}@${ICS_UID_DOMAIN}`;
}

/**
 * The idempotency-key prefix for one invite send, and the reason it is a
 * function rather than a template literal at the call site.
 *
 * `createResendSender` appends `:<to>` and hands the result to Resend as an
 * `Idempotency-Key`. Every OFFICE invite in a booking's lifecycle goes to the
 * same address, so a FIXED per-booking prefix — the obvious thing to write, and
 * what the notification path correctly uses — would make the create, the cancel
 * and the restore byte-identical keys. Resend would then collapse the CANCEL
 * into a duplicate of the REQUEST and the calendar event would never clear,
 * with nothing in any log to say so.
 *
 * Embedding the kind and the SEQUENCE keeps retry dedupe *within* one
 * transition, which is what the key is for, and makes it impossible *across*
 * transitions.
 *
 * The audience is deliberately NOT in the prefix (BK-16). The office copy and
 * the customer copy of one transition are sent concurrently, and the `:<to>`
 * the sender appends already differs between them — adding the audience here
 * would be a second reason for something that is already impossible, and would
 * suggest the `to` suffix could not be relied on.
 */
export function inviteIdempotencyPrefix(id: number, kind: IcsKind, now: Date): string {
  return `booking-${id}-${kind}-${icsSequence(now)}`;
}

/** `assessment-<id>.ics`. Same name for every kind — it is the same event. */
export function icsFilename(id: number): string {
  return `assessment-${id}.ics`;
}

/**
 * The `Content-Type` a calendar attachment carries.
 *
 * The `method=` parameter is the conventional signal that this is an invite
 * rather than a file to download. Gmail's actual rendering is heuristic and
 * undocumented, which is why the ticket's post-deploy render check is the
 * honest pin for AC5 and this comment is not.
 */
export function icsContentType(kind: IcsKind): string {
  return `text/calendar; charset=utf-8; method=${kind === 'cancel' ? 'CANCEL' : 'REQUEST'}`;
}

/** The Resend attachment object for an already-built ICS body. */
export function icsAttachment(ics: string, kind: IcsKind, id: number): EmailAttachment {
  return {
    filename: icsFilename(id),
    content: ics,
    contentType: icsContentType(kind),
  };
}

// ---------------------------------------------------------------------------
// RFC 5545 primitives
// ---------------------------------------------------------------------------

/**
 * Escapes a TEXT value (§3.3.11). The backslash goes first, or every escape
 * this function then adds would be escaped again by the pass that follows.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/[\r\n]/g, '\\n');
}

const MAX_OCTETS = 75;

/**
 * Folds one content line to 75 octets, continuations prefixed with a space.
 *
 * OCTETS, NOT CHARACTERS, and the split points are chosen between code points:
 * a name or an address can carry an accented character or an em dash, and
 * cutting one of those in half yields a file no parser will read. The leading
 * space on a continuation counts toward that line's 75 — which is why a
 * continuation's octet count starts at 1 rather than 0 below.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let budget = MAX_OCTETS;

  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > budget) {
      out.push(current);
      current = '';
      bytes = 1; // the leading space the join below adds
      budget = MAX_OCTETS;
    }
    current += char;
    bytes += size;
  }
  out.push(current);

  return out.join('\r\n ');
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** `YYYYMMDDTHHMMSSZ` — a UTC instant, which needs no VTIMEZONE block. */
function icsInstant(instant: Date): string {
  return `${instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

/** `address, city, postal` — blanks dropped, then escaped as one TEXT value. */
function icsLocation(event: IcsEvent): string {
  return [event.address, event.city, event.postalCode].filter(Boolean).join(', ');
}

/**
 * The two audience-shaped facts, resolved. Everything else about the event is
 * shared — UID, ORGANIZER, SEQUENCE, DTSTART/DTEND, SUMMARY, LOCATION — because
 * the office copy and the customer copy ARE ONE EVENT, and a CANCEL only clears
 * an event a client already holds under the same UID.
 *
 * The office's contact line is the customer's phone: the office reads its
 * calendar asking "who do I call". The customer's is the reschedule line, for
 * the same reason inverted — their own number in their own calendar entry helps
 * nobody, and it is the one thing they might need from the event at 8am.
 */
function audienceOf(event: IcsEvent, audience: IcsAudience): {
  attendee: string;
  contactLine: string;
} {
  return audience.audience === 'customer'
    ? { attendee: audience.email, contactLine: CANCEL_LINE }
    : { attendee: BOOKING_INTERNAL_TO, contactLine: `Phone: ${event.phone}` };
}

/**
 * The whole invite, as an RFC 5545 string.
 *
 * `now` is injected rather than read from the clock so DTSTAMP and SEQUENCE come
 * from ONE instant per send, and so both are assertable.
 *
 * `audience` is required — see `IcsAudience`. The office form is asserted
 * byte-for-byte against the text BK-14 shipped (the golden pin in
 * `verify-booking-ics.ts`), because that is the output a real Gmail render was
 * checked against and it must not drift as a side effect of gaining a second
 * audience.
 */
export function buildBookingIcs(
  event: IcsEvent,
  kind: IcsKind,
  now: Date,
  audience: IcsAudience,
): string {
  const cancel = kind === 'cancel';
  const start = event.slotStart;
  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
  const { attendee, contactLine } = audienceOf(event, audience);

  const summary = `Assessment — ${event.name} (${event.serviceLabel})`;
  const description = [
    contactLine,
    `Service: ${event.serviceLabel}`,
    VISIT_LENGTH_LINE,
  ].join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeIcsText(ICS_PRODID)}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${cancel ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${icsUid(event.id)}`,
    `DTSTAMP:${icsInstant(now)}`,
    `DTSTART:${icsInstant(start)}`,
    `DTEND:${icsInstant(end)}`,
    `SEQUENCE:${icsSequence(now)}`,
    // CONFIRMED is the ordinary state; CANCELLED is what actually clears the
    // event in a client that already holds it. METHOD alone does not.
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `LOCATION:${escapeIcsText(icsLocation(event))}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `ORGANIZER:mailto:${ICS_ORGANIZER}`,
    // The RSVP parameters are what make Gmail offer the yes/no/maybe buttons
    // rather than rendering a file to download. The address is the payload, and
    // it is the one thing the audience decides.
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  // Trailing CRLF: §3.1 makes the line break part of the line, and some
  // parsers drop a final line that has none.
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}
