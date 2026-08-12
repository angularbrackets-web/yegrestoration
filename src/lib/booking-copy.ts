/**
 * The settled client copy for a booking, in one place.
 *
 * Agreed with the client on 2026-08-08 (ROADMAP, open question 2): the
 * implementer drafts, the client edits later. This module is where they edit —
 * both the confirmation email and `/book/confirmed/` read from here, so a
 * change lands in both or in neither. Before BK-05 the have-ready list existed
 * twice, once in `BookingConfirmation.svelte` with a comment noting it was
 * restating the email's.
 *
 * Pure and env-free, so a `tsx` verify script can import it.
 *
 * ONE RULE IS NOT A COPY PREFERENCE. `policy_number` and `claim_number` may
 * never be printed in a customer-facing message — the confirmation may only ask
 * the customer to *have them ready*, which is what the list below does. That is
 * the locked data-model rule restated at the copy level, so a copy edit cannot
 * quietly break it.
 */

import { SUPPORT_PHONE } from './booking-config';

/**
 * What to have ready for the visit.
 *
 * The insurance line asks for the numbers. It does not print them, and no
 * variant of this list ever may.
 */
export const HAVE_READY_ITEMS: readonly string[] = [
  'Access to the affected areas',
  'Photos, or a list of what was damaged',
  "Your insurance policy and claim numbers, if you're filing",
  'Someone 18 or older on site',
  'Pets secured',
];

export const HAVE_READY_HEADING = 'Have this ready for us';

export const VISIT_LENGTH_LINE = 'The visit takes about 30 minutes.';

/**
 * The zone qualifier.
 *
 * `formatSlot` produces `Mon, Aug 11 · 1:30 p.m.` — no zone, no year. On the
 * confirmation page that is fine, because the visitor is looking at a calendar
 * they just used. In an email read three days later on a phone that may be in
 * another province it is not, so the qualifier is copy rather than something
 * the formatter is asked to grow.
 */
export const TIMEZONE_NOTE = 'Edmonton time';

/**
 * Cancellation is phone-in at launch (settled 2026-08-08). There is no
 * self-service cancel link, no cancel token, and therefore no URL for this
 * sentence to carry — see BK-04 and BK-05.
 */
export const CANCEL_LINE = `To cancel or reschedule, call or text ${SUPPORT_PHONE}.`;

/** Shown only when the confirmation email actually went out. */
export const EMAILED_LINE = "We've emailed you a copy of this confirmation.";

// ---------------------------------------------------------------------------
// The customer's calendar (BK-16)
//
// Client-decided 2026-08-12: the customer gets the invite with the
// confirmation, and a written cancellation when the office cancels the row.
// Same standing rule as everything above — the implementer drafts, the client
// edits here, and both the email and the ICS read from these constants.
//
// NEITHER BOUNDARY MESSAGE MAY CARRY A URL, on the same terms as the
// confirmation: there is no self-service cancel or rebook path to link to
// (locked, phone-in), so a URL could only be decoration or a lie.
// ---------------------------------------------------------------------------

/** The confirmation's nod to its own attachment. */
export const CALENDAR_ATTACHED_LINE =
  'A calendar invite is attached — open it to add the appointment to your calendar.';

export const CANCELLED_HEADING = 'Your assessment is cancelled';

/**
 * The cancellation's opening line.
 *
 * "As requested" is deliberate and it is a claim about the world: cancellation
 * is phone-in (locked), so by the time this sends, a person almost always
 * asked. The office cancelling a row for its own reasons is the exception, and
 * the sentence is still true enough not to confuse anybody who did not ask —
 * they are told to call, which is what they would do either way.
 */
export const CANCELLED_LEAD =
  "We've cancelled the assessment below, as requested. Nothing further is needed from you.";

/** What to do about it. Phone, never a link. */
export const CANCELLED_REBOOK_LINE = `To book a new time, or if this cancellation is a surprise, call or text ${SUPPORT_PHONE}.`;

/** The attached CANCEL does the work; this says so, because a bare .ics is opaque. */
export const CANCELLED_CALENDAR_LINE =
  'The attached update removes the appointment from your calendar.';

export const RESTORED_HEADING = 'Your assessment is back on';

export const RESTORED_LEAD =
  'The assessment below was cancelled and has now been reinstated. The original time is unchanged.';

export const RESTORED_CALENDAR_LINE =
  'A calendar invite is attached — open it to put the appointment back on your calendar.';
