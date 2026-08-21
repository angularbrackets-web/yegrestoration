import type { Migration } from './types';

/**
 * The refund block (BK-33): what went back, and the claim that stops it going
 * back twice.
 *
 * ── ADDITIVE ONLY, SO IT MAY GO BEFORE THE DEPLOY ──────────────────────────
 *
 * Five columns. Nothing renamed, no CHECK narrowed, no index that live code
 * names rebuilt — so the code currently deployed keeps working unchanged while
 * this sits in front of it. That is the rule BK-23's 2026-08-18 outage
 * produced: *a migration that only ADDS may go before the deploy; a migration
 * that RENAMES, NARROWS a CHECK, or REBUILDS an index that live code names must
 * go after it.*
 *
 * ── `payment_status`'s CHECK IS NOT TOUCHED, AND THAT IS NOT AN OMISSION ───
 *
 * BK-33's ticket says `refunded` / `partially_refunded` are "already in BK-32's
 * CHECK". They are in **008's** — `008-review-lifecycle.ts` wrote the constraint
 * over all six values on the day the column was added, and `010-payments.ts`'s
 * header records that deviation. So the values this migration's columns describe
 * have been legal since 008 and nothing here has to widen anything.
 *
 * ── WHY THERE ARE FIVE COLUMNS AND THE TICKET SPECIFIED THREE ──────────────
 *
 * `stripe_refund_id`, `refunded_amount_cents` and `refunded_at` are the three.
 * `refund_claim_key` and `refund_started_at` are the fourth and fifth, and they
 * exist because plan review established that **a Stripe idempotency key is not
 * a dedupe**. Stripe's own documentation: keys may be pruned once they are 24
 * hours old and a reused key then generates a *new* request, and a request that
 * conflicts with another executing concurrently is not saved as an idempotent
 * result at all. The first draft of this ticket leaned its whole double-refund
 * safety argument on that key. The claim below is what actually holds.
 */
export const migration: Migration = {
  name: '011-refunds',
  up: async (sql) => {
    // 1. WHAT STRIPE SAYS WENT BACK — never our own arithmetic.
    //
    //    `refunded_amount_cents` is written from `charge.amount_refunded`, the
    //    RUNNING TOTAL Stripe keeps for the charge, on every path: the refund
    //    this system issues, a refund the office takes in the dashboard, and a
    //    redelivery of either. That is what makes three sources converge on one
    //    figure instead of summing into a number belonging to nobody.
    //
    //    `stripe_refund_id` holds the LAST refund's id, and it is deliberately
    //    not a running record: a charge can carry several refunds, and BK-33's
    //    plan review found a `refund.failed` handler that used this column as
    //    though it identified all of them — matching on it would have erased a
    //    different refund that genuinely went back. It is here for a human
    //    opening the dashboard, not for control flow over money.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS stripe_refund_id      TEXT,
        ADD COLUMN IF NOT EXISTS refunded_amount_cents INTEGER,
        ADD COLUMN IF NOT EXISTS refunded_at           TIMESTAMPTZ
    `;

    // 2. THE CLAIM. It is the dedupe, and it holds NO MONEY STATE.
    //
    //    A refund is irreversible and takes real money, so the two obvious
    //    orderings are both wrong:
    //
    //      - write "refunded" then call Stripe: a Stripe failure leaves a row
    //        claiming money went back when it did not, and a customer told so
    //        in writing.
    //      - call Stripe then write, with nothing in between: two office
    //        members refunding DIFFERENT amounts that sum to less than the
    //        charge produce two keys and two real refunds, and Stripe's
    //        over-refund refusal — the tempting backstop — never fires.
    //
    //    So the attempt is claimed first and the claim says nothing about
    //    money. `refund_claim_key IS NULL` in the claiming UPDATE makes it
    //    exclusive: the second click, the second tab and the second office
    //    member all match zero rows and are told a refund is in flight.
    //
    //    NULLABLE AND CLEARED ON SETTLE, so a later deliberate partial refund
    //    can claim in its turn. A claim left standing is the deliberate
    //    outcome of one case only — a Stripe call whose answer we never got —
    //    where refusing further refunds until a human looks is the safe
    //    direction and `charge.refunded` reconciles the row if the money did
    //    move.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS refund_claim_key  TEXT,
        ADD COLUMN IF NOT EXISTS refund_started_at TIMESTAMPTZ
    `;

    // 3. Answers "is a refund stuck?" — the query somebody runs when the office
    //    reports that the button says a refund is already in flight and no
    //    money has moved. Without this it is a sequential scan on a table that
    //    only grows.
    await sql`
      CREATE INDEX IF NOT EXISTS appointments_refund_claim_idx
        ON appointments (refund_started_at)
        WHERE refund_claim_key IS NOT NULL
    `;
  },
};
