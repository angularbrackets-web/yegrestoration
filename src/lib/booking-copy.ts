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
