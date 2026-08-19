/**
 * The review decision: what approving and declining mean, in one place.
 *
 * Pure — no database, no environment, no clock of its own. Everything takes an
 * explicit `now`, so a verify script can drive the boundary cases that a real
 * clock reaches twice a year and never on demand.
 *
 * The transitions themselves are guarded UPDATEs in the route
 * (`api/admin/appointments/review.ts`); what lives here is the arithmetic and
 * the rules, because those are the parts that are worth asserting and the parts
 * that a reviewer needs to be able to read without a database.
 */

import {
  PAYMENT_DEADLINE_LEAD_HOURS,
  PAYMENT_WINDOW_HOURS,
  PAY_NOW_THRESHOLD_HOURS,
} from './booking-config';
import { HOUR_MS } from './booking-time';

/**
 * When an approved booking must be paid by, and whether it is a deferred
 * deadline at all.
 *
 * `dueAt: null` with `payNow: true` is not a missing value — it is the answer.
 * See `PAY_NOW_THRESHOLD_HOURS`: when the slot is close, there is no useful
 * window to defer, so the link is sent to be paid immediately and no timer owns
 * the row. The expiry cron must skip rows with a NULL `payment_due_at` for
 * exactly this reason, rather than treating NULL as "overdue".
 */
export type PaymentDeadline = {
  /** The instant the reservation lapses, or null when payment is due now. */
  dueAt: Date | null;
  /** True when the slot was too close to defer. */
  payNow: boolean;
  /** Which of the two bounds decided it. Useful in the admin UI and in logs. */
  boundedBy: 'window' | 'slot' | 'pay-now';
};

export function paymentDeadline(slotStart: Date, approvedAt: Date): PaymentDeadline {
  const msToSlot = slotStart.getTime() - approvedAt.getTime();

  // The pay-now branch is tested FIRST and on time-to-slot, not on the computed
  // deadline. Testing the deadline instead would mean computing a value that is
  // already in the past and then noticing — which works, but only until someone
  // reads `min(...)` and assumes it is always a real future instant.
  if (msToSlot < PAY_NOW_THRESHOLD_HOURS * HOUR_MS) {
    return { dueAt: null, payNow: true, boundedBy: 'pay-now' };
  }

  const byWindow = approvedAt.getTime() + PAYMENT_WINDOW_HOURS * HOUR_MS;
  const bySlot = slotStart.getTime() - PAYMENT_DEADLINE_LEAD_HOURS * HOUR_MS;

  return byWindow <= bySlot
    ? { dueAt: new Date(byWindow), payNow: false, boundedBy: 'window' }
    : { dueAt: new Date(bySlot), payNow: false, boundedBy: 'slot' };
}

/**
 * Whether a row in `approved_awaiting_payment` has run out of time.
 *
 * NULL `payment_due_at` is NEVER overdue. That is the pay-now case, and it is
 * the office's to chase by phone — a cron cancelling those would cancel exactly
 * the emergency bookings somebody is on the phone about.
 */
export function isPaymentOverdue(paymentDueAt: Date | null, now: Date): boolean {
  if (paymentDueAt === null) return false;
  return paymentDueAt.getTime() <= now.getTime();
}

/** The two things the office can do to a request. */
export type ReviewAction = 'approve' | 'decline' | 'preview';

/**
 * `'preview'` is the confirm step, and it is the guard rail Task 7 asks for:
 * "show the itemized total, as the customer will see it, before the admin
 * confirms — not just the fields."
 *
 * The screen it replaces rendered that total from the SUGGESTION at page load,
 * with no client script behind it, so the figure was correct only until the
 * admin touched a field — i.e. correct in exactly the case where it did not
 * matter. Found in BK-23's implementation review.
 *
 * Done as a server round trip rather than a live-updating field on purpose.
 * `new.astro` records that the admin pages carry no client JS ("CSS, not JS"),
 * and a screen where money is typed is the wrong place to set the opposite
 * precedent: a total kept honest by a script is a total that is wrong whenever
 * the script fails to run, and nothing on the page would say so. A round trip
 * cannot disagree with itself — the figures shown are computed from the same
 * parse of the same strings that the approve step re-parses.
 */
export function isReviewAction(value: unknown): value is ReviewAction {
  return value === 'approve' || value === 'decline' || value === 'preview';
}

/**
 * The ceiling on any amount the office can type at approval.
 *
 * A sanity bound, not a business rule: the dearest assessment is $1,199 and a
 * travel fee is tens of dollars, so five figures means a slipped decimal or a
 * stray keystroke. It is checked server-side because the screen it guards turns
 * a typo directly into a card charge.
 */
export const MAX_ADMIN_AMOUNT_CENTS = 1_000_000; // $10,000.00

/**
 * Dollars, for a form field. `39900` → `"399.00"`.
 *
 * The inverse of `parseAmountCents`, and shared rather than local to a page
 * because the confirm step round-trips through it: the amounts the office sees
 * on the confirmation are re-posted through these strings and re-parsed by
 * `parseAmountCents`. Two spellings of this would be two numbers.
 */
export function amountField(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Parse an admin-entered dollar amount into cents.
 *
 * Returns null for anything that is not a plain, non-negative money value —
 * blanks, words, negatives, more than two decimal places, or a number past the
 * ceiling. The caller reports the field error; this refuses to guess.
 *
 * Deliberately NOT `parseFloat`: `parseFloat('12abc')` is 12, and a field that
 * silently accepts "12abc" as twelve dollars is a field that will one day
 * accept a paste of something else entirely.
 */
export function parseAmountCents(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > MAX_ADMIN_AMOUNT_CENTS) return null;
  return cents;
}
