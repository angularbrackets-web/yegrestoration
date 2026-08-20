import type { Migration } from './types';

/**
 * The payment block (BK-32): Stripe identifiers, the Interac audit trail, and
 * the event log that makes a replayed webhook a no-op.
 *
 * ── ADDITIVE ONLY, WHICH IS WHY IT GOES BEFORE THE DEPLOY ──────────────────
 *
 * Columns and one table. Nothing renamed, no CHECK narrowed, no index that live
 * code names rebuilt — so the code currently deployed keeps working unchanged
 * while this sits in front of it. That is the whole of the rule BK-23's outage
 * produced: *a migration that only ADDS may go before the deploy; a migration
 * that RENAMES, NARROWS a CHECK, or REBUILDS an index that live code names must
 * go after it.* See ROADMAP §P9's rollout table — this is step 1 alongside 007
 * and 008, and unlike 009 it has no ordering constraint of its own.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * `payment_status`, `assessment_amount_cents`, `travel_fee_cents`, `gst_cents`,
 * `total_amount_cents` and `payment_due_at` are **migration 008's**, added
 * there because BK-23's approval screen is what WRITES them and a screen
 * shipping one migration ahead of its own columns is a screen that 500s.
 * 008 also carries `payment_status`'s CHECK over all six values. BK-32's
 * ticket lists them because it was written before that deviation; this file is
 * the record of where they actually live.
 */
export const migration: Migration = {
  name: '010-payments',
  up: async (sql) => {
    // 1. How the money arrived. NULL until it does.
    //
    //    'none' is not 'not_required'. A $0.00 approval — a goodwill visit, or
    //    a booking the office is absorbing — is a booking that needs no payment
    //    STEP, and it is confirmed through the same `markPaid()` every other
    //    payment goes through. `not_required` (008) means something different
    //    and older: a row that predates prepay entirely. Collapsing the two
    //    would put a live booking in the same bucket as the 13 historical ones.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS payment_method TEXT
    `;
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'appointments_payment_method_check'
        ) THEN
          ALTER TABLE appointments
            ADD CONSTRAINT appointments_payment_method_check
            CHECK (payment_method IN ('stripe', 'interac', 'onsite', 'none'));
        END IF;
      END $$
    `;

    // 2. WHAT ACTUALLY ARRIVED, AND IT IS NOT `total_amount_cents`.
    //
    //    `total_amount_cents` is the snapshot the approval settled and the
    //    approval email quoted. It must survive the payment untouched, or the
    //    receipt and the quote stop being comparable and the ticket's own
    //    invariant — "base + travel + GST as emailed, as stored, and as Stripe
    //    billed, all the same number" — has nothing left to compare.
    //
    //    So the amount that landed gets its own column. On the card path it is
    //    what Stripe reports; on the Interac path it is what the office asserts
    //    arrived. A mismatch between the two columns is a fact somebody can
    //    query, which is exactly what it could not be if the payment wrote over
    //    the quote.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS paid_amount_cents INTEGER
    `;

    // 3. The reference, whatever kind of payment it was — an e-Transfer
    //    reference the office typed, or the Stripe reference on the card path.
    //
    //    SEPARATE FROM `stripe_payment_intent_id`, which is next and which
    //    BK-33 reads to issue a refund. An e-Transfer reference in that column
    //    is a refund request Stripe cannot honour, aimed at money it never
    //    took.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS payment_reference TEXT
    `;

    // 4. Who asserted the money arrived, and when. The office is making a claim
    //    about their own inbox, so the claim needs an author — this is an audit
    //    trail, not a convenience. Same reasoning as BK-35's `admin_notes`
    //    line: a system that cannot say who did something cannot answer the
    //    question three months later.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS interac_marked_by TEXT,
        ADD COLUMN IF NOT EXISTS interac_marked_at TIMESTAMPTZ
    `;

    // 5. Money landed somewhere it should not have. Read by the admin list and
    //    the detail page.
    //
    //    TEXT, not a boolean: "this needs a human" is useless without what
    //    happened. Appended to, never overwritten — BK-40's `admin_notes` rule
    //    for a second column — because the second thing to go wrong on a row is
    //    exactly when the first one matters most.
    //
    //    NOTHING CLEARS IT. That is this ticket's scope decision, recorded here
    //    so the absence does not read as an oversight: an acknowledge-and-clear
    //    action is a separate piece of admin UX and is out of scope.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS needs_attention TEXT
    `;

    // 6. Stripe's own identifiers.
    //
    //    `stripe_session_id` is UNIQUE because one Checkout Session belongs to
    //    exactly one appointment, and the reverse mapping is what the expiry
    //    cron needs in order to cancel the right link. A re-approval expires
    //    the old session before minting a new one, so the column holds at most
    //    one live session at a time.
    //
    //    `stripe_payment_intent_id` is written ONLY on the card path. BK-33
    //    refunds from it.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
        ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
        ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS appointments_stripe_session_idx
        ON appointments (stripe_session_id)
        WHERE stripe_session_id IS NOT NULL
    `;

    // 7. THE EVENT LOG, AND `processed_at` IS THE WHOLE POINT OF IT.
    //
    //    Stripe redelivers by design, so the webhook needs a record of what it
    //    has already acted on. The obvious spelling — insert the event id, and
    //    treat "already present" as "already handled" — has no state between
    //    SEEN and DONE, and that gap is where a real payment disappears:
    //
    //      1. the handler verifies the signature and records the event id
    //      2. it dies before the confirm transition commits — a function
    //         timeout, an OOM, a deploy rolling underneath it
    //      3. Stripe retries; the event id is present, so the handler returns
    //         200 and does nothing
    //      4. the row is still `approved_awaiting_payment`, so the expiry cron
    //         releases the slot and emails the customer an apology
    //
    //    Money taken, booking cancelled, nothing flagged, and the only trace is
    //    a row in this table. `processed_at` closes it: the insert CLAIMS the
    //    event, the stamp records that it was handled, and a retry of an
    //    unstamped event is claimed again and completes. Re-running the confirm
    //    transition is already safe — it is a guarded UPDATE and the payment
    //    reference tells one payment arriving twice from two payments.
    await sql`
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id    TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      )
    `;
    // Answers "did anything get stuck?" — the query an office or an on-call
    // reader actually runs, and the one that has no index without this.
    await sql`
      CREATE INDEX IF NOT EXISTS stripe_events_unprocessed_idx
        ON stripe_events (received_at)
        WHERE processed_at IS NULL
    `;
  },
};
