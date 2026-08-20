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
 * Deliberately says nothing about payment, and the REASON changed under BK-44
 * even though the conclusion did not. It used to be that "the status dropdown
 * can be driven by hand", so the transition was no proof a payment arrived.
 * The dropdown can no longer create `confirmed` for a row that has never been
 * paid — note the qualifier, because the absolute is false: a PAID row restored
 * from `cancelled`, or from `declined` / `payment_expired` after a late
 * payment, still reaches `confirmed` through the dropdown. What reaches this
 * message with no payment behind it at all is `approveFree`, which confirms a
 * genuinely free assessment through `markPaid` with `payment_method = 'none'`.
 * Stating the fact (the appointment is confirmed, here is the invite) is true
 * on every path that reaches it; "thank you for your payment" would not be.
 */
export const CONFIRMED_HEADING = 'Your assessment is confirmed';

export const CONFIRMED_LEAD =
  'Your assessment is confirmed and we have you booked in for the time below.';

export const CONFIRMED_CALENDAR_LINE =
  'A calendar invite is attached — open it to add the appointment to your calendar.';

/**
 * The two lines BK-45 needed so that a PAID message can carry the assessment
 * terms without carrying the instructions for paying (client, 2026-08-20).
 *
 * ── WHY A NEW LINE RATHER THAN A REWORDED TERM ────────────────────────────
 *
 * `FEE_TERMS_INTRO` and `FEE_TERMS_PAYMENT[2]`/`[3]` describe payment as a
 * thing still ahead of the reader — *"we email you a secure payment link"*,
 * *"nothing is charged when you send your request"*, *"if we do not have the
 * payment in time, we may release the time"*. Every one of them is TRUE on the
 * request message and on the three rendered surfaces, and every one is FALSE in
 * an email sent seconds after the money arrived. They are not reworded and they
 * are not forked per-arm: the confirmed message simply does not render them, and
 * these two lines say the past-tense thing instead.
 *
 * The split is finer than "terms versus instructions" by one line, and the extra
 * line is deliberate. `FEE_TERMS_PAYMENT[0]` and `[1]` say what the RATES are —
 * they stay, because `FEE_TERMS_ITEMS` prints the standard $399/$699/$1,199 and
 * a weekend or mould customer's own total does not match any of them. Dropping
 * the reconciliation would leave two figures on one page with nothing joining
 * them, which that constant's own header calls the single most likely way this
 * copy ships subtly wrong.
 */
export const PAID_IN_FULL_LINE =
  'Paid in full — nothing further is due before the visit.';

/**
 * The $0 approval (`approveFree` → `markPaid({ method: 'none' })`).
 *
 * A goodwill booking never receives an approval email — `review.ts` returns
 * before that send, because there is nothing to pay and no link to send — so
 * this confirmation is the ONLY message that ever tells that customer what the
 * visit costs. Silence would invite the phone call, and an itemised block of
 * `$0.00` rows would read as a pricing error; `approvalMessage`'s own rule for a
 * zero travel fee is the precedent — a line item for nothing invites the
 * question of what it might have been.
 */
export const NO_CHARGE_LINE = 'There is no charge for this visit.';

// ---------------------------------------------------------------------------
// The assessment fee terms (BK-27, rewritten for prepay by BK-36)
//
// THE PAYMENT MODEL CHANGED TWICE. Read both, because the second change is
// invisible if you only know the first.
//
//   1. 2026-08-14 — the WAIVER model died. The block used to say the
//      assessment "costs you nothing if you go ahead" and priced only the
//      walk-away. Under what replaced it every customer pays and the amount is
//      CREDITED IN FULL against the final invoice, so it costs nothing in the
//      end but is never free at the point of sale. That is what made BK-29's
//      site-wide "free assessment" sweep a hard blocker.
//   2. 2026-08-16/18 — PREPAY (P9). SUPERSEDED FROM THAT DATE: "paid at the
//      end of the visit", "nothing is charged at booking", "tell the tech on
//      the day", and "non-refundable" as a blanket term. A web booking is now a
//      REQUEST. The office reviews it, approves it, and emails a payment link;
//      the appointment is confirmed when that payment lands. The client's
//      refund answer (2026-08-18) is a real policy with a 24-hour window, not
//      a blanket clause.
//
// THE FIGURES, THE THREE TIERS AND THE CREDIT ARE STILL THE CLIENT'S OWN,
// relayed 2026-08-14 — $399 / $699 / $1,199, all + GST, all credited in full on
// proceeding. They are not implementer drafting and must not be edited on
// anybody's judgment. The SENTENCES around them are ours and may be tightened.
// So are the 2026-08-18 answers folded in below: the 24-hour refund rule, the
// weekend surcharge, and tier 3's lab turnaround.
//
// This is customer-visible *pricing*: a wrong number here is a dispute at the
// kitchen table, not a typo.
//
// The dollar figures live in ONE place — FEE_TERMS_ITEMS. The verify scripts
// assert these constants against the email and the three surfaces rather than
// against retyped literals, so a client edit does not fail the gate, but they
// separately assert that these strings still contain the numbers, so an edit
// cannot silently delete the price either.
//
// ── THE BLOCK IS FOUR CONSTANTS AND THEIR ORDER IS A CONSTRAINT ────────────
//
//   HEADING -> INTRO -> ITEMS -> PAYMENT -> REFUND -> CREDIT
//   -> [tier radios] -> [ack checkbox]
//
// on every surface, without exception. Two reasons, both load-bearing:
//
//   - **It ends on the credit.** Refund and forfeiture language sits in the
//     MIDDLE; the last thing read is the good news. This is why the old
//     FEE_TERMS_OUTRO was SPLIT rather than edited — its second line ended the
//     block on non-refundability.
//   - **"the terms above"** is a claim FEE_TERMS_ACK_LABEL makes about the
//     page, so everything being acknowledged, the tier choice included, has to
//     render above the checkbox.
//
// `verify-cutover.ts` pins the order on all three rendered surfaces and
// `verify-booking-email.ts` pins it in both arms of both customer messages.
//
// ── TWO WORDS THAT MAY NEVER APPEAR, AND THEY ARE NOT STYLE ────────────────
//
//   - **"deductible".** Deductible rebating by contractors is explicitly
//     illegal in several US jurisdictions and reads as claims-fraud territory
//     to Canadian insurers. The credit is against OUR invoice; this copy never
//     names what the customer's share is called. (The word is used elsewhere on
//     the site, on /insurance-claims/ and /about/, where it explains coverage
//     rather than pricing an assessment. That is a different claim on a
//     different page and is not this block's to make.)
//   - **anything saying the assessment is billed to an insurer.** The
//     $699/$1,199 language describes documentation the CUSTOMER receives and
//     can hand to their adjuster. It never says who pays.
//
// Both are pinned at the constants and again in `dist/` after the build, which
// is BK-29's lesson: a source-level grep passed green while <Navbar /> put the
// banned phrase into 16 built files including 404.html.
// ---------------------------------------------------------------------------

export const FEE_TERMS_HEADING = 'Assessment terms';

/**
 * What the customer is actually agreeing to, in the order it happens.
 *
 * THREE THINGS ARE DELIBERATELY ABSENT and each was a decision:
 *
 *   - **No review SLA.** The client said "almost right away, max 1 hour"
 *     internally (2026-08-16) and deliberately did not publish it: an
 *     operational intention becomes a commitment the moment it is on a page
 *     somebody can screenshot. This sentence stops at "before confirming it".
 *   - **No price literal.** It used to open "The assessment is paid at the end
 *     of the visit, starting at $399 + GST" — a fourth place a figure lived,
 *     covered by no pin, and false for mould and for every weekend slot
 *     (BK-31's nit, folded into BK-36). The figures live in FEE_TERMS_ITEMS and
 *     in TIER_DEFAULT_CENTS, and nowhere else.
 *   - **No "choose your assessment below".** The drafted copy opened that way.
 *     It is true on exactly one of the four surfaces this renders on — the
 *     island's step 3. The homepage card has no picker, `/book/`'s
 *     informational block sits below the island, and neither email has
 *     controls. A sentence true on one surface of four is the defect class this
 *     block exists to remove.
 */
export const FEE_TERMS_INTRO =
  'We review every request before confirming it. Once we approve yours, we email you a secure payment link — and your appointment is confirmed as soon as the payment goes through.';

/**
 * The three tiers, in the client's own figures (relayed 2026-08-14).
 *
 * Four things here are the client's statement rather than drafting, and none of
 * them may be "tidied":
 *
 *   - **`+ GST`.** The figures are before tax. Dropping it would understate a
 *     real price by 5%, which is the direction that ends in an argument at the
 *     kitchen table. Asserted separately in `verify-booking-email.ts`.
 *   - **`$1,199`, not "up to $1,200".** An early relay said "up to $1,200"; the
 *     client's own wording is a fixed $1,199. An "up to" on a fixed price
 *     invites the customer to expect less than they will be billed.
 *   - **Each tier states that it INCLUDES the ones below it** — "the assessment
 *     plus…", "alongside the report and estimate". The tiers are alternatives,
 *     not line items. Those clauses exist so that $399 + $699 + $1,199 is not a
 *     reading anybody can arrive at honestly (BK-27 Q4, confirmed). BK-36's
 *     first draft dropped the clause from the middle tier and the plan review
 *     put it back.
 *   - **The lab turnaround on tier 3** (client, 2026-08-18). Someone choosing
 *     the top tier is usually choosing it because they need documentation for a
 *     claim, and documentation they expected on the day is a complaint rather
 *     than a deliverable. Stated in the bullet, not in a footnote, and in the
 *     same words `ASSESSMENT_TIER_DESCRIPTIONS.sketch` uses on the radio — one
 *     fact, two places it must appear, and they may not drift into two
 *     different promises.
 *
 * ZIPPED TO THE PRICE TABLE BY POSITION. `verify-booking-pricing.ts` pairs
 * these bullets with `ASSESSMENT_TIERS` in order and asserts each one contains
 * its tier's exact figure. Reordering them, or adding a fourth, breaks a charge
 * against a price — not a sentence.
 */
export const FEE_TERMS_ITEMS: readonly string[] = [
  '$399 + GST — the on-site assessment and a written scope of the damage',
  '$699 + GST — the assessment plus a written cause-of-loss report and a repair estimate: the documentation your adjuster works from if you are filing a claim',
  '$1,199 + GST — adds a measured sketch and diagram of the affected areas, alongside the report and estimate. Where lab samples are taken, results take 3–5 business days',
];

/**
 * When the money moves, and what the figures above are worth.
 *
 * ── EVERY SENTENCE HERE MUST BE TRUE ON BOTH APPROVAL BRANCHES ─────────────
 *
 * This is static text a customer ticks a box to accept, and the flow underneath
 * it forks. At approval, `paymentDeadline()` either computes a due date or —
 * when the slot is less than `PAY_NOW_THRESHOLD_HOURS` away — returns
 * `dueAt: null` and the pay-now branch takes over: the approval email states NO
 * date (`APPROVED_PAY_NOW_NOTE` replaces the deadline paragraph), and
 * `isPaymentOverdue(null)` is false, so the expiry cron never releases the slot.
 *
 * So this block says "when we need it paid", not "the date"; and "we may
 * release the time", not "we release it". The first draft said both of the
 * stronger things and the plan review caught it. A customer whose booking takes
 * the pay-now branch would have held a written term contradicted by the very
 * email that asked them for money — this ticket's own worked example, inverted.
 * The specific date and the automatic release are true only on the deferred
 * branch, and they stay where they are true: in the approval email, per branch.
 *
 * ── AND THE STANDARD-RATES SENTENCE IS NOT DECORATION ──────────────────────
 *
 * `FEE_TERMS_ITEMS` carries the STANDARD figures. A mould customer is quoted
 * $385 beside the radio and reads $399 in the box; a Saturday customer reads
 * $399 and is quoted $598.50. Without the first sentence below, neither has any
 * way to know which number is real. It is the single most likely way this copy
 * ships subtly wrong, because nothing about it looks like an error.
 *
 * It deliberately does NOT say "the price shown for your job is the one that
 * applies", which is what the ticket proposed. That is false for a job beyond
 * 30 km: the 2026-08-18 amendments give the office an editable amount and a
 * travel-fee field at approval, and the itemized approval email is where the
 * final number is stated. Writing the stronger claim would manufacture exactly
 * the contradiction this block exists to prevent.
 *
 * The first attempt made that claim anyway, by other means: it listed the
 * determinants ("the service you need and the time you pick") as though they
 * were exhaustive and then said the form shows the result. A customer 40 km out
 * would read that and then open an approval email with a bigger number on it.
 * So the list is no longer offered as complete, and the sentence now ends where
 * the final figure actually lives. Whether the travel fee should be disclosed
 * in these terms at all is the client's call and is an open assumption on
 * BK-36 — this wording pre-empts neither answer.
 *
 * The weekend sentence is a SECOND SENTENCE about the same fact as
 * `AFTER_HOURS_NOTE`, not a second copy of that string. `AFTER_HOURS_NOTE` is a
 * just-in-time explanation gated on `tierQuotes[…].afterHours` and rendered
 * beside the inflated figure; the terms need the fact unconditionally, on
 * surfaces where no price renders at all. `verify-booking-email.ts` pins that
 * both agree with `AFTER_HOURS_NUMERATOR / AFTER_HOURS_DENOMINATOR`, so they
 * cannot drift to two different multipliers.
 */
export const FEE_TERMS_PAYMENT: readonly string[] = [
  'Those are our standard rates. What you pay depends on the service you need and the time you pick — the booking form shows that price before you send your request, and the approval email states the amount we will charge.',
  'Saturday and Sunday appointments are charged at 1.5 times the weekday price.',
  'Nothing is charged when you send your request. Once we approve it we email you a secure payment link, stating the amount and when we need it paid.',
  'If we do not have the payment in time, we may release the time, and you are welcome to book again.',
];

/**
 * The refund policy. Client-answered 2026-08-18, and it is a real policy with a
 * window rather than the blanket clause that preceded it.
 *
 * FIVE LINES, AND THE ORDER IS THE ARGUMENT:
 *
 *   - **What we owe you comes first.** The section opens on our own
 *     cancellation, not on what the customer loses. The superseded draft's
 *     failure mode was a block that ended on forfeiture.
 *   - **"Inside 24 hours" is stated once and covers no-shows.** The client's
 *     answer did not name no-shows separately, and a missed appointment is by
 *     construction inside the window. A separate forfeiture clause would be
 *     inventing a policy.
 *   - **The word "forfeit" appears nowhere.** It is a term of art that reads as
 *     punitive; "not refunded" says the same thing and is what the client said.
 *   - **The walk-away term is the client's own, from 2026-08-14, retimed.** It
 *     covers the customer who HAS the assessment done and then declines the
 *     restoration work — a case the 2026-08-18 cancellation answer says nothing
 *     about. BK-36's first draft dropped it silently while replacing its gate
 *     with a 24-hour-window gate, so nothing would have asserted it because
 *     nothing said it. The plan review caught that. Deleting it would have been
 *     a policy change; restating it is not.
 *   - **It ends on the phone number**, and the whole block still ends on
 *     `FEE_TERMS_CREDIT` — so the negative immediately above is answered by the
 *     positive immediately below.
 *
 * A refund section that omitted customer cancellation would read as "fully
 * refundable" to a customer and "non-refundable" to us, which is the dispute
 * this block exists to prevent.
 *
 * The last line is `CANCEL_LINE` itself, not a retyped copy: the client's text
 * for it is character-for-character what that constant already holds, and the
 * phone number belongs in one place. It therefore renders twice in each
 * customer email — once closing this section, once as the message's own closing
 * instruction. Accepted deliberately: a customer scanning to the bottom of a
 * long email for "how do I cancel" should find it there, and the terms block
 * has to be self-contained on the homepage card, where no closing line exists.
 */
export const FEE_TERMS_REFUND: readonly string[] = [
  'If we cancel or cannot make the appointment, you get a full refund.',
  'Cancel 24 hours or more before your appointment and we refund you in full.',
  'Inside 24 hours, the assessment is not refunded — that includes a missed appointment.',
  'Once the assessment has been done, it is not refunded if you decide not to go ahead with the work.',
  CANCEL_LINE,
];

/**
 * The good news, and it is LAST on every surface for that reason.
 *
 * The client's own term (2026-08-14): the full amount comes off the final
 * invoice. It never names what the customer's share is called — see the header
 * on why that word is banned — and it never says who pays.
 *
 * OPEN QUESTION #6 IS ABOUT THIS SENTENCE and is deliberately unresolved:
 * whether "credited against your final invoice" matches how an insurance job
 * actually settles, i.e. that the credit comes off the CUSTOMER's share. It is
 * client-facing, it blocks nothing mechanical, and it is explicitly not a
 * Deploy 2 blocker. It ships as approved. Do not reword around it.
 */
export const FEE_TERMS_CREDIT =
  'Whichever assessment you choose, the full amount comes off your final invoice when you go ahead with the restoration work.';

/**
 * The checkbox label.
 *
 * It references the box rather than restating the figures, so the numbers exist
 * once. The rendered terms box must therefore sit immediately above the
 * checkbox on every surface that shows one — "above" is a claim this label
 * makes about the page, and moving `/book/`'s informational block below the
 * picker does not touch it, because the acknowledged copy is the island's own.
 *
 * "including the amount I will be asked to pay" is BK-36's addition. Under
 * prepay the money moves days before the visit, on a link, and the thing being
 * acknowledged is a charge rather than a price list.
 */
export const FEE_TERMS_ACK_LABEL =
  'I understand the assessment terms above, including the amount I will be asked to pay.';

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
// That was the standing risk in this block and BK-36 has closed it, in copy
// rather than in code: the terms box states the standard figures while the
// radios show the price that actually applies, so a mould customer saw $399 in
// one place and $385 in the other with nothing to say which was real.
// `FEE_TERMS_PAYMENT[0]` is now that sentence. Do not delete it thinking it is
// filler — it is the only thing reconciling two different numbers on one
// screen, and it reads like filler by design.
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

/**
 * Says when the money moves, under the computed total.
 *
 * "Nothing is charged now" alone was true and half a sentence: it answered the
 * question a visitor has while looking at a figure ("is this button about to
 * bill me?") and left the one they ask next ("then when?") to
 * `FEE_TERMS_PAYMENT` a few lines above. Under prepay that second half is the
 * whole mechanism, so it is said here too, in the shorter form the position
 * allows.
 */
export const QUOTE_TIMING_NOTE =
  'Nothing is charged now — once we approve your request we email you a payment link.';

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

/**
 * BK-45 widened this sentence, and the reason is the ticket's whole thesis.
 *
 * It used to name three things — the time, the address, the reference — which
 * was an exhaustive description of what `planFirstConfirmationEmail` carried.
 * The confirmation now carries the have-ready list, the assessment terms and
 * what was charged as well, and a page that lists three of six sends a customer
 * looking elsewhere for the list this ticket just put in their inbox.
 *
 * It still promises nothing this page cannot know: the email's CONTENTS are a
 * property of the builder, not of the payment, and the page continues to assert
 * no booking state — see the header above on why that distinction is the point.
 */
export const PAID_LEAD =
  'Your confirmation email and calendar invite are on their way. They carry the time, the address, your booking reference, what to have ready for the visit and what you paid.';

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
