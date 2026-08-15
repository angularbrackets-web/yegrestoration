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

// ---------------------------------------------------------------------------
// The assessment fee terms (BK-27)
//
// THE PRICING MODEL CHANGED ON 2026-08-14, AFTER THIS BLOCK WAS FIRST WRITTEN.
// The earlier version said the assessment "costs you nothing if you go ahead"
// and priced only the walk-away. That was a *waiver* model and it is gone.
// Under the settled model EVERY customer pays at the end of the visit, and the
// amount is CREDITED IN FULL against the final invoice if they go ahead — so it
// costs nothing in the end, but it is never free at the point of sale. The
// difference is not a nuance: it is the difference between "free assessment"
// being conditionally true and being false, which is why BK-29 (the site-wide
// "free assessment" sweep) is a hard blocker on deploying this.
//
// THE FIGURES, THE THREE TIERS AND THE CREDIT ARE THE CLIENT'S OWN, relayed
// 2026-08-14 — $399 / $699 / $1,199, all + GST, all credited in full on
// proceeding, all non-refundable otherwise, paid on site, nothing charged at
// booking. They are not implementer drafting and must not be edited on
// anybody's judgment. The SENTENCES around them are ours and may be tightened.
//
// This is customer-visible *pricing*: a wrong number here is a dispute at the
// kitchen table, not a typo.
//
// The dollar figures live in ONE place — here. The verify script asserts these
// constants against the email and the two surfaces rather than against retyped
// literals, so a client edit does not fail the gate, but it separately asserts
// that these strings still contain the numbers, so an edit cannot silently
// delete the price either.
// ---------------------------------------------------------------------------

export const FEE_TERMS_HEADING = 'Assessment terms';

/**
 * The baseline and the credit, before the tiers rather than after them. A
 * visitor who reads only this line has read the two facts that decide whether
 * they book: there is a fee, and it comes back off the invoice.
 *
 * "Paid at the end of the visit" is load-bearing. The implementation review's
 * open question Q8 was that a customer ticks a box agreeing to a charge with no
 * surface saying WHEN it lands; the client settled it (on site, at the end of
 * the visit), so the answer is stated here rather than left to be inferred.
 */
export const FEE_TERMS_INTRO =
  'The assessment is paid at the end of the visit, starting at $399 + GST. If you go ahead with the restoration work, we credit the full amount against your final invoice.';

/**
 * The three tiers, in the client's own figures (relayed 2026-08-14).
 *
 * Three things here are the client's statement rather than drafting, and none
 * of them may be "tidied":
 *
 *   - **`+ GST`.** The figures are before tax. Dropping it would understate a
 *     real price by 5%, which is the direction that ends in an argument at the
 *     kitchen table. Asserted separately in `verify-booking-email.ts`.
 *   - **`$1,199`, not "up to $1,200".** An early relay said "up to $1,200"; the
 *     client's own wording is a fixed $1,199. An "up to" on a fixed price
 *     invites the customer to expect less than they will be billed.
 *   - **"includes the report and estimate".** The tiers are alternatives, not
 *     line items. The clause exists so that $399 + $699 + $1,199 is not a
 *     reading anybody can arrive at honestly (BK-27 Q4, confirmed).
 */
export const FEE_TERMS_ITEMS: readonly string[] = [
  '$399 + GST — the on-site assessment',
  '$699 + GST — the assessment plus a written cause-of-loss report and a repair estimate',
  '$1,199 + GST — adds a sketch or diagram you can use for an insurance claim, and includes the report and estimate',
];

/**
 * What the list cannot say, and what the customer is actually agreeing to.
 *
 * Two sentences, two jobs, and neither is decoration:
 *
 *   - **Nothing is charged at booking.** The site never takes money (client,
 *     locked). Without this line a visitor ticking a box beside "$1,199" has
 *     every reason to think the next button charges them.
 *   - **The tier is settled on the day.** There is no tier picker on the form
 *     yet — that is BK-31 — so the drafted "whichever you choose" would have
 *     been a claim about a control that does not exist. It said "you can move up
 *     to a higher one then" for a while, which a review pointed out presumes a
 *     baseline the form never collects: you cannot upgrade from a choice you
 *     were never asked to make. Dropped. Choosing on the day is non-binding by
 *     construction, so the client's "not binding" point needs no sentence until
 *     BK-31 gives the customer something to be bound to — and that sentence is
 *     BK-31's to write.
 *   - **Non-refundable, stated at the point of acknowledgment.** The client was
 *     explicit that the fee is not refundable if the customer does not proceed,
 *     and an undisclosed non-refundable term is the one most likely to be
 *     disputed. It renders inside the same box as the checkbox on every surface,
 *     which is what makes the acknowledgment mean anything.
 */
export const FEE_TERMS_OUTRO: readonly string[] = [
  'Nothing is charged when you book. Tell the tech on the day which of these you want.',
  'Whichever you choose, the full amount comes off your invoice if you hire us. It is not refundable if you decide not to go ahead.',
];

/**
 * The checkbox label.
 *
 * It references the box rather than restating the figures, so the numbers exist
 * once. The rendered terms box must therefore sit immediately above the
 * checkbox on every surface that shows one — "above" is a claim this label
 * makes about the page.
 */
export const FEE_TERMS_ACK_LABEL = 'I understand the assessment terms above.';
