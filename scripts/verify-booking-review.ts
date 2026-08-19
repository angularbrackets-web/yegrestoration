// Checks the review decision: the payment deadline, the pay-now branch, and the
// admin amount parser. Pure — no database, no network, no clock of its own.
//
//   npx tsx scripts/verify-booking-review.ts
//
// Exits non-zero if any assertion fails.
import {
  PAYMENT_DEADLINE_LEAD_HOURS,
  PAYMENT_WINDOW_HOURS,
  PAY_NOW_THRESHOLD_HOURS,
} from '../src/lib/booking-config';
import { readFileSync } from 'fs';

import { gstFor } from '../src/lib/booking-pricing';
import {
  MAX_ADMIN_AMOUNT_CENTS,
  amountField,
  isPaymentOverdue,
  isReviewAction,
  parseAmountCents,
  paymentDeadline,
} from '../src/lib/booking-review';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

const H = 60 * 60 * 1000;
const at = (ms: number) => new Date(ms);

// ---------------------------------------------------------------------------
console.log('\nThe payment deadline — which bound wins');
// ---------------------------------------------------------------------------
{
  // Slot far out: the 12-hour window is the binding constraint.
  const approved = at(0);
  const farSlot = at(10 * 24 * H);
  const far = paymentDeadline(farSlot, approved);
  check(far.payNow === false, 'a distant slot does not trigger pay-now');
  check(far.boundedBy === 'window', 'and the approval window is what bounds it');
  check(
    far.dueAt?.getTime() === PAYMENT_WINDOW_HOURS * H,
    `due exactly ${PAYMENT_WINDOW_HOURS}h after approval`,
  );

  // Slot close enough that slot−4h bites before approval+12h.
  const nearSlot = at(10 * H);
  const near = paymentDeadline(nearSlot, approved);
  check(near.payNow === false, '10h out is still above the pay-now threshold');
  check(near.boundedBy === 'slot', 'and the slot is what bounds it');
  check(
    near.dueAt?.getTime() === 10 * H - PAYMENT_DEADLINE_LEAD_HOURS * H,
    `due exactly ${PAYMENT_DEADLINE_LEAD_HOURS}h before the slot`,
  );

  // THE DEADLINE IS NEVER IN THE PAST. This is the property the whole pay-now
  // branch exists to guarantee, asserted across the entire range rather than at
  // the two boundaries — the failure it replaced was a formula that produced a
  // lapsed deadline for a whole band of inputs, not at one point.
  for (let hours = 0; hours <= 14 * 24; hours++) {
    const d = paymentDeadline(at(hours * H), approved);
    if (d.dueAt !== null) {
      check(
        d.dueAt.getTime() > approved.getTime(),
        `a slot ${hours}h out must not produce a deadline at or before approval`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe pay-now branch');
// ---------------------------------------------------------------------------
{
  const approved = at(0);

  // Exactly at the threshold is NOT pay-now; a millisecond inside it is. Pinned
  // on both sides so a `<` / `<=` edit cannot pass.
  const exactly = paymentDeadline(at(PAY_NOW_THRESHOLD_HOURS * H), approved);
  check(exactly.payNow === false, `exactly ${PAY_NOW_THRESHOLD_HOURS}h out is not pay-now`);
  const inside = paymentDeadline(at(PAY_NOW_THRESHOLD_HOURS * H - 1), approved);
  check(inside.payNow === true, 'a millisecond inside it is');
  check(inside.dueAt === null, 'and pay-now carries NO deadline');
  check(inside.boundedBy === 'pay-now', 'reported as such rather than as a bound');

  // THE 2AM EMERGENCY. The office types a booking at 02:00 for 03:00. The
  // deferred formula would give `min(14:00, 23:00 yesterday)` — a deadline an
  // hour in the past — and the customer would get a dead link.
  const emergency = paymentDeadline(at(1 * H), approved);
  check(emergency.payNow === true, 'a 2am-for-3am emergency is pay-now');
  check(emergency.dueAt === null, 'with no deadline for a cron to act on');

  // THE ORDINARY WEB CASE the notice rule leaves behind: a request at 15:29 for
  // the next day's 11:30, approved at 07:00 — 4.5 hours to the slot. Under
  // next-day-earliest this is reachable without any emergency at all, which is
  // why the branch is not an emergency feature.
  const nextMorning = paymentDeadline(at(4.5 * H), approved);
  check(nextMorning.payNow === true, 'and so is an early-morning approval for a late-morning slot');

  // A slot in the PAST — reachable if the office approves something stale.
  const stale = paymentDeadline(at(-2 * H), approved);
  check(stale.payNow === true, 'a slot already past is pay-now, never a negative deadline');
}

// ---------------------------------------------------------------------------
console.log('\nOverdue');
// ---------------------------------------------------------------------------
{
  const now = at(1000);
  check(isPaymentOverdue(at(999), now), 'a deadline in the past is overdue');
  check(isPaymentOverdue(at(1000), now), 'a deadline exactly now is overdue');
  check(!isPaymentOverdue(at(1001), now), 'a deadline in the future is not');

  // THE ONE THAT MATTERS. A pay-now row has no deadline, and a cron reading
  // NULL as "overdue" would cancel exactly the emergency bookings the office is
  // on the phone about.
  check(!isPaymentOverdue(null, now), 'a pay-now row (NULL deadline) is NEVER overdue');
}

// ---------------------------------------------------------------------------
console.log('\nThe admin amount field');
// ---------------------------------------------------------------------------
{
  check(parseAmountCents('399') === 39900, 'a whole number of dollars');
  check(parseAmountCents('399.00') === 39900, 'with cents');
  check(parseAmountCents('46.50') === 4650, 'a travel fee');
  check(parseAmountCents('$1,199.00') === 119900, 'a pasted figure with a symbol and separator');
  check(parseAmountCents('1,199') === 119900, 'and a grouped figure without cents');
  check(parseAmountCents('0') === 0, 'zero is a legitimate travel fee');
  check(parseAmountCents(1199) === 119900, 'a number, not only a string');

  // THE REASON THIS IS NOT parseFloat. `parseFloat('12abc')` is 12, and this
  // field turns its value directly into a card charge.
  for (const bad of ['12abc', 'abc', '', '  ', '1.234', '-5', '1e3', '.5', '399.', null, undefined, {}]) {
    check(parseAmountCents(bad) === null, `${JSON.stringify(bad)} is refused rather than guessed`);
  }

  // COMMA PLACEMENT, and the case the assertion above did not reach.
  //
  // The parser used to strip every comma before testing anything, so "46,50" —
  // a comma decimal, which is how most of the world writes forty-six fifty —
  // became "4650" and was accepted as $4,650.00. Under the ceiling, so nothing
  // else caught it, in the field whose natural range is two-digit dollars.
  // The positive assertion above passed throughout: it proved commas CAN be
  // stripped, never that they are only stripped where a separator belongs.
  //
  // Each of these is a real slip, not a fuzz case. A comma decimal, a short
  // group, a long group, a doubled comma, a leading comma, a trailing one.
  for (const ambiguous of [
    '46,50',
    '46,5',
    '1,23',
    '1,2345',
    '1,,199',
    ',199',
    '199,',
    '1,199,',
    '$46,50',
    '12,34.56',
  ]) {
    check(
      parseAmountCents(ambiguous) === null,
      `${JSON.stringify(ambiguous)} is refused — an ambiguous money value must never be interpreted`,
    );
  }

  // And the specific arithmetic of the defect, stated as a number so it cannot
  // come back quietly: if "46,50" ever parses again, it must not parse to this.
  check(
    parseAmountCents('46,50') !== 465000,
    '"46,50" must never become $4,650.00 — a hundredfold charge inside the sanity ceiling',
  );

  check(
    parseAmountCents(String(MAX_ADMIN_AMOUNT_CENTS / 100)) === MAX_ADMIN_AMOUNT_CENTS,
    'the ceiling itself is accepted',
  );
  check(
    parseAmountCents(String(MAX_ADMIN_AMOUNT_CENTS / 100 + 1)) === null,
    'a dollar past it is refused — five figures means a slipped decimal',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe action set');
// ---------------------------------------------------------------------------
{
  check(
    isReviewAction('approve') && isReviewAction('decline') && isReviewAction('preview'),
    'all three actions are recognised',
  );
  for (const bad of ['confirm', 'APPROVE', '', 'cancel', 1, null]) {
    check(!isReviewAction(bad), `${JSON.stringify(bad)} is not a review action`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe confirm step: the office sees the charge before it is sent (BK-23 Task 7)');
// ---------------------------------------------------------------------------
//
// The guard rail Task 7 spells out — "show the itemized total, as the customer
// will see it, before the admin confirms — not just the fields" — was rendered
// from the SUGGESTION at page load with no script behind it, so the figure was
// stale the instant either field was edited. Correct in exactly the case where
// it did not matter, wrong in the case the screen exists for. And nothing
// anywhere showed the amount after approval, so a typo had no recovery surface
// either.
//
// The fix is a server round trip: `action=preview` parses, bounces back with
// the normalised strings, and the page re-posts THOSE into the fields `approve`
// re-parses. What is asserted here is the property that makes the round trip
// worth anything — that the two stages cannot produce different numbers.
{
  // The round trip, end to end, in cents: parse -> render -> re-post -> parse.
  for (const typed of ['399', '399.00', '46.50', '1,199.00', '0', '0.00', '9999.99']) {
    const first = parseAmountCents(typed);
    check(first !== null, `${JSON.stringify(typed)} parses`);
    if (first === null) continue;
    // What the confirm screen puts in its hidden field...
    const roundTripped = amountField(first);
    // ...and what `approve` makes of it. These must be the same cents, or the
    // office confirms one number and the customer is charged another.
    check(
      parseAmountCents(roundTripped) === first,
      `${JSON.stringify(typed)} survives the confirm round trip (${roundTripped} -> ${parseAmountCents(roundTripped)}, expected ${first})`,
    );
  }

  // The itemisation the confirm screen renders is the one `approve` stores.
  // Spelled out rather than recomputed with gstFor, so the assertion does not
  // move with the function it is about.
  const cases: [number, number, number, number][] = [
    // base,  travel, gst,  total
    [39900, 0, 1995, 41895],
    [39900, 4650, 2228, 46778],
    [57750, 0, 2888, 60638],
    [0, 0, 0, 0],
  ];
  for (const [base, travel, gst, total] of cases) {
    const subtotal = base + travel;
    check(gstFor(subtotal) === gst, `GST on ${subtotal} is ${gst}, got ${gstFor(subtotal)}`);
    check(
      subtotal + gstFor(subtotal) === total,
      `and the total is ${total}, got ${subtotal + gstFor(subtotal)}`,
    );
  }

  // The route must not write on a preview. An approval with an extra click is
  // not a confirm step.
  const reviewSrc = readFileSync('src/pages/api/admin/appointments/review.ts', 'utf8');
  const previewBody = reviewSrc.slice(
    reviewSrc.indexOf('function preview('),
    reviewSrc.indexOf('function amountsFrom('),
  );
  check(previewBody.length > 0, 'the preview handler exists');
  check(
    !/\bUPDATE\b|\bINSERT\b|sendBookingNotifications|sql`/.test(previewBody),
    'the preview handler writes nothing and sends nothing — it only re-renders',
  );

  // One parser for both stages. Two would be two numbers.
  check(
    (reviewSrc.match(/parseAmountCents\(/g) ?? []).length === 2 &&
      /function amountsFrom\(/.test(reviewSrc) &&
      (reviewSrc.match(/amountsFrom\(row, form\)/g) ?? []).length === 2,
    'preview and approve both go through one amountsFrom, which is the only caller of parseAmountCents',
  );

  // The page must render the total from the TYPED amounts, not the suggestion.
  const pageSrc = readFileSync('src/pages/admin/appointments/[id].astro', 'utf8');
  check(
    /confirming\.totalCents/.test(pageSrc) && /name="action"\s*\n?\s*value="approve"/.test(pageSrc),
    'the approve button sits on the panel that renders confirming.totalCents',
  );
  check(
    !/suggestedQuote\.totalCents/.test(pageSrc),
    'and no total is rendered from the suggestion, which is what went stale',
  );
  check(
    /settled\.totalCents/.test(pageSrc),
    'an approved row still shows what was settled, so a disputed charge has a screen',
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ booking review checks passed\n');
