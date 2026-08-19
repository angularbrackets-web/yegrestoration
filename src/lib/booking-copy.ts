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
import type { AssessmentTier } from './booking-pricing';

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

/**
 * A FIRST confirmation crossing the same boundary, which is not a restore.
 *
 * Before BK-23 the only inward crossing was `cancelled → booked`, so the
 * restore copy above was always true of it. P9 adds two more —
 * `pending_review → confirmed` and `approved_awaiting_payment → confirmed` —
 * and told this way round they are false in a way that matters: the customer
 * is informed their assessment "was cancelled and has now been reinstated" on
 * the first booking they ever paid for. Found in BK-23's implementation review.
 *
 * Deliberately says nothing about payment. This message is sent by the office
 * moving a row to `confirmed`, which under P9 is what a completed payment
 * means, but the transition itself is not proof one arrived — the status
 * dropdown can be driven by hand. Stating the fact (the appointment is
 * confirmed, here is the invite) is true on every path that reaches it;
 * "thank you for your payment" would not be.
 */
export const CONFIRMED_HEADING = 'Your assessment is confirmed';

export const CONFIRMED_LEAD =
  'Your assessment is confirmed and we have you booked in for the time below.';

export const CONFIRMED_CALENDAR_LINE =
  'A calendar invite is attached — open it to add the appointment to your calendar.';

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

// ---------------------------------------------------------------------------
// The tier picker (BK-31)
//
// `FEE_TERMS_ITEMS` above is the prose the terms box states, and it stays the
// client's own wording. These are the RADIO LABELS, which need to be short
// enough to scan and must NOT carry a figure: the price beside each radio is
// computed live from `booking-pricing.ts`, because it moves with the service
// (mould is cheaper) and the slot (weekends are 1.5x). A hard-coded "$399" on a
// radio would be wrong for a Saturday mould job and right nowhere the computed
// one is not.
//
// That is also the standing risk in this block, and it is BK-36's to close in
// copy: the terms box states the standard figures while the radios show the
// price that actually applies. A mould customer sees $399 in one place and
// $385 in the other with nothing to say which is real.
// ---------------------------------------------------------------------------

/** Short names, scannable in a radio list. Declaration order is render order. */
export const ASSESSMENT_TIER_NAMES: Record<AssessmentTier, string> = {
  standard: 'On-site assessment',
  report: 'Assessment + written report',
  sketch: 'Assessment + report + measured sketch',
};

/**
 * One line each, saying what the customer receives.
 *
 * The `sketch` line states the LAB TURNAROUND, and that is a client
 * requirement (2026-08-18), not drafting. Someone choosing the top tier is
 * usually choosing it because they need documentation for a claim, and
 * documentation they expected on the day is a complaint rather than a
 * deliverable. It is stated on the control they choose with, not in a footnote.
 */
export const ASSESSMENT_TIER_DESCRIPTIONS: Record<AssessmentTier, string> = {
  standard: 'A technician walks the affected areas and writes up the scope of the damage.',
  report:
    'Everything above, plus a written cause-of-loss report and a repair estimate — the documentation your adjuster works from if you are filing a claim.',
  sketch:
    'Everything above, plus a measured sketch and diagram of the affected areas. Where lab samples are taken, results take 3–5 business days.',
};

/** Sits above the radios, so the group has a name a screen reader can announce. */
export const ASSESSMENT_TIER_LEGEND = 'Choose your assessment';

/**
 * Why a weekend price is higher, said where the higher number appears.
 *
 * A surcharge a customer discovers only by comparing two figures is the kind of
 * thing that reads as a mistake or as sharp practice. Naming it costs one line.
 */
export const AFTER_HOURS_NOTE = 'Weekend rate — Saturday and Sunday appointments are 1.5× the weekday price.';

/** The heading over the computed total, so the figure is not a bare number. */
export const QUOTE_HEADING = 'Your assessment';

/** Says when the money moves. Under prepay BK-36 replaces this wholesale. */
export const QUOTE_TIMING_NOTE = 'Nothing is charged now.';

// ---------------------------------------------------------------------------
// The request-received surfaces (BK-23)
//
// EVERY LINE HERE IS WRITTEN AGAINST ONE CONSTRAINT: nothing may say, imply, or
// let a reader infer that the appointment is booked. Not "confirmed", not
// "scheduled", not "we'll see you then", and no calendar invite — a request has
// been received and a person will look at it.
//
// The time being HELD is true and is worth saying, because the customer's real
// question while they wait is whether somebody else can take their slot.
//
// The old page said "You're booked" and attached an invite. Under prepay that
// is false at submission, and it is false on the surface a customer is most
// likely to screenshot and hold us to.
// ---------------------------------------------------------------------------

export const RECEIVED_HEADING = 'Request received';

export const RECEIVED_LEAD =
  'Thanks — we have your request. It is not confirmed yet: someone from our office reviews every request before we take it.';

/** What happens next, in order, so the wait has a shape. */
export const RECEIVED_NEXT_STEPS: readonly string[] = [
  'We review your request and the photos you sent.',
  'If we can take it, we email you to approve it, with a secure payment link.',
  'Your appointment is confirmed once that payment goes through — and we send the calendar invite then.',
];

export const RECEIVED_HOLD_LINE = 'We are holding this time for you while we review it.';

/**
 * NO SERVICE-LEVEL PROMISE, and that is a decision rather than an omission.
 *
 * The client said "almost right away, max 1 hour" internally (2026-08-16) and
 * deliberately did not publish it: an operational intention becomes a
 * commitment the moment it is on a page somebody can screenshot. What this line
 * does instead is give the customer an action for the case the intention fails,
 * which is the only part of an SLA that helps them.
 *
 * `verify-booking-email.ts` asserts no review-time promise appears anywhere in
 * the request message, so a well-meaning copy edit cannot reintroduce one.
 */
export const RECEIVED_TIMING_LINE =
  'If you have not heard from us and the appointment is close, call or text us — do not wait.';

export const RECEIVED_EMAILED_LINE = "We've emailed you a copy of this request.";

// ---------------------------------------------------------------------------
// Approval and decline (BK-23)
//
// The approval message is the one that asks for money, so it carries three
// facts and cannot be allowed to lose any of them: WHAT the amount is, WHEN it
// is due, and WHAT HAPPENS if it is not paid. A payment request that omits the
// consequence is the one people leave in the inbox.
// ---------------------------------------------------------------------------

export const APPROVED_HEADING = 'Your assessment is approved';

export const APPROVED_LEAD =
  'Good news — we can take your assessment at the time you asked for. To confirm it, all that is left is the payment below.';

/**
 * What happens if nobody pays.
 *
 * Stated plainly and without threat. The slot is genuinely released — that is
 * the mechanism, not a collection tactic — and saying so is what makes the
 * deadline mean something to a customer who would otherwise read it as
 * administrative.
 */
export const APPROVED_DEADLINE_NOTE =
  'If it is not paid by then, we release the time for someone else and you are welcome to book again.';

/** The pay-now variant. Same fact, no clock, because there is no useful window. */
export const APPROVED_PAY_NOW_NOTE =
  'Your appointment is close, so please pay as soon as you can — we hold the time until you do, and we will call you if anything changes.';

export const APPROVED_INTERAC_LEAD = 'Prefer an Interac e-Transfer?';

export const DECLINED_HEADING = 'We cannot take this one';

/**
 * The decline, and it says ONE thing (client, 2026-08-16): we are at capacity.
 *
 * No reason menu and no free text. A reason chosen from a list is a reason
 * somebody has to defend on the phone, and the honest answer for almost every
 * decline is scheduling. The customer is given a route back in — a different
 * time, or a call — because a decline that ends the conversation ends it for
 * every future job too.
 */
export const DECLINED_LEAD =
  "We are sorry — we are at capacity at this time and cannot take your assessment. Nothing has been charged.";

/**
 * The stale-request expiry (BK-23 Task 4), and it is NOT the decline above.
 *
 * `DECLINED_LEAD` says "we are at capacity", which is a claim about our
 * schedule. This customer was not turned away — nobody looked at their request
 * in time, and their slot is now hours off. Sending them the at-capacity line
 * would be a tidy untruth, and P9 exists to remove those.
 *
 * So it says what happened, does not blame them, and **offers the phone**: the
 * damage that made them book has not gone away, and a form that has just
 * expired on them is the wrong thing to send them back to.
 *
 * No apology for "the delay" — the delay is the whole event, not a detail of
 * it.
 */
/**
 * `/book/confirmed/` — the post-payment landing (BK-32).
 *
 * ── A RECEIPT, NOT A STATE CLAIM, AND THE DISTINCTION IS THE WHOLE POINT ───
 *
 * This page is reached from Stripe's redirect and it **verifies nothing**: it
 * makes no network call, it writes nothing, and the session id in its URL is
 * shape-checked rather than confirmed against Stripe. Anyone can type the URL.
 * So it must not assert what only the webhook knows — "You're booked" is a
 * claim about state that this page is in no position to make, and P9 exists to
 * stop exactly that kind of claim being made on exactly this kind of surface.
 *
 * What it can honestly say is what the customer just did: they paid. The
 * booking details reach them in the confirmation email that `markPaid()` sends,
 * which is the artifact that actually knows.
 *
 * ── AND IT DOES NOT RENDER THE STORED REQUEST PAYLOAD ──────────────────────
 *
 * The `sessionStorage` payload on this origin was written by `/book/received/`
 * for a REQUEST and has no relationship to any payment. Someone who submits two
 * requests in one tab and then pays for the first would be shown the second
 * one's slot, address and reference number. That is a wrong booking under a
 * confident heading, which is worse than no detail at all.
 */
export const PAID_HEADING = 'Thanks — payment received';

export const PAID_LEAD =
  'Your confirmation email and calendar invite are on their way. They carry the time, the address and your booking reference.';

export const PAID_HELP_LINE = `If it has not arrived within a few minutes, check your junk folder or call or text us on ${SUPPORT_PHONE}.`;

/**
 * `/book/payment-cancelled/` — the `cancel_url`.
 *
 * The customer backed out of Stripe's page. **Nothing has gone wrong and
 * nothing is lost**, which is the only thing this page needs to establish: the
 * request still exists, the office has already approved it, and the link in
 * their email still works until the deadline. Sending them back to an empty
 * `/book/` form would be the one instruction that is actively wrong.
 */
export const PAYMENT_CANCELLED_HEADING = 'No payment was taken';

export const PAYMENT_CANCELLED_LEAD =
  'Your assessment request is still here and we are still holding your time. The payment link in your approval email works until the deadline it gives — open it again whenever you are ready.';

export const PAYMENT_CANCELLED_HELP_LINE = `If something went wrong with the payment, or you would rather pay another way, call or text us on ${SUPPORT_PHONE}.`;

export const EXPIRED_REQUEST_HEADING = 'We did not get to your request in time';

export const EXPIRED_REQUEST_LEAD =
  'We are sorry — we did not review your assessment request before the time you asked for, so we have released it. Nothing has been charged, and this is our fault rather than anything you did.';

export const EXPIRED_REQUEST_REBOOK_LINE = `Please call or text us on ${SUPPORT_PHONE} and we will sort out a time — if the damage is urgent, say so and we will treat it that way. You can also pick a new time on the website.`;

export const DECLINED_REBOOK_LINE =
  'You are welcome to pick another time, and if the damage is urgent please call or text us — we will do what we can.';

/**
 * The PAYMENT expiry (BK-32), and it is neither of the two above.
 *
 * Three expiries now exist and each is a different event, so each gets its own
 * words. The at-capacity decline is a claim about our schedule. The stale
 * request is our failure to look. This one is neither: the office approved,
 * quoted a price, gave a deadline, and the customer did not pay by it — so the
 * only honest framing is that the reservation lapsed, without implying they did
 * something wrong. People miss a payment window because they were at work, or
 * because the email went to spam, or because they decided against it, and the
 * copy has to be true for all three.
 *
 * **No "unfortunately", and no invoice language.** Nothing was owed and nothing
 * is outstanding — a message that reads like a missed bill would be false and
 * would frighten somebody who simply changed their mind.
 *
 * The phone is offered for the same reason it is offered on the stale-request
 * message: the damage that made them book has not gone away.
 */
/**
 * The line every payment-attention alert carries, whatever the alert is about.
 *
 * **IN THE BUILDER, NOT IN THE CALLER'S SENTENCE**, and the difference is the
 * whole reason it is a constant. Each caller describes a different problem — a
 * double payment, a payment after the slot went, an amount that did not match —
 * and if the instruction rode along in those sentences then the fourth caller
 * would be the one that forgot it. The office reads these with a customer
 * possibly on the phone, and "just refund it" is the obvious reflex; a refund
 * issued in a hurry against a payment that was never doubled is the mistake
 * this line exists to slow down.
 */
export const PAYMENT_ATTENTION_RULE =
  'Nothing has been refunded automatically. Check what actually happened before moving any money, then issue any refund by hand in the Stripe dashboard.';

export const PAYMENT_EXPIRED_HEADING = 'Your assessment time has been released';

export const PAYMENT_EXPIRED_LEAD =
  'The time we were holding for your assessment was not paid for by the deadline, so we have released it for someone else. Nothing has been charged, and there is nothing to settle.';

export const PAYMENT_EXPIRED_REBOOK_LINE = `If you still want the assessment, please call or text us on ${SUPPORT_PHONE} and we will find you another time — if the damage is urgent, say so and we will treat it that way. You can also pick a new time on the website.`;
