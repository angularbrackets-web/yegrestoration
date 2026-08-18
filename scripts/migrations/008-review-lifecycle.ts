import type { Migration } from './types';
import {
  APPOINTMENT_STATUSES,
  SLOT_HOLD_PREDICATE,
  SLOT_UNIQUE_INDEX,
} from '../../src/lib/booking-status';

/**
 * The review-and-prepay lifecycle (BK-23).
 *
 * A web booking stops being a booking. It becomes a REQUEST that the office
 * approves and the customer pays for, and only payment produces a confirmed
 * appointment, a calendar invite, or a dispatched crew.
 *
 * ── THE RENAME ─────────────────────────────────────────────────────────────
 *
 * `booked` becomes `confirmed`, in this migration, against live rows. Under
 * prepay "booked" is the word for the thing that has NOT happened yet, and
 * leaving the old value in place beside `approved_awaiting_payment` would have
 * invited exactly the confusion the flow exists to remove.
 *
 * Every existing row was created under the auto-confirm flow, so every one of
 * them genuinely is confirmed — the backfill is a rename, not a guess. At the
 * time of writing production holds 13 rows, 10 of them `booked` and only 2
 * future-dated, so this touches almost nothing live.
 *
 * ── THE INDEX PREDICATE, AND THE ONE WAY THIS BREAKS EVERYTHING ────────────
 *
 * The partial unique index is what stops two crews being sent to one address.
 * It widens from `status <> 'cancelled'` to a three-status deny-list.
 *
 * **`insertBooking`'s `ON CONFLICT (slot_start) WHERE ...` must match this
 * index predicate exactly.** Postgres resolves the arbiter by proving the index
 * predicate implies the `ON CONFLICT` one; when it cannot, it raises 42P10 —
 * and that fires on EVERY booking, public and admin alike, not on some edge
 * case. The whole funnel, at once.
 *
 * That is why both come from `SLOT_HOLD_PREDICATE` in `src/lib/booking-status.ts`
 * rather than being typed out twice. Do not inline this string here.
 *
 * ── DENY-LIST, NOT ALLOW-LIST ──────────────────────────────────────────────
 *
 * A status added later and forgotten then HOLDS its slot: the failure is a slot
 * that looks busy, which someone notices and books by phone. Under an
 * allow-list the same omission silently RELEASES, and the failure is a
 * double-booked crew on a job the customer already paid for. Restated here
 * because this is the kind of thing a later tidy-up reverses on the grounds
 * that an allow-list reads better.
 *
 * ── ORDER ──────────────────────────────────────────────────────────────────
 *
 * Apply to production BEFORE the deploy, like 005 and 007. `insertBooking` and
 * the availability query both name the new statuses, so new code against the
 * old schema fails on every booking; old code against the new schema writes
 * `pending_review` into a CHECK that already permits it.
 */
export const migration: Migration = {
  name: '008-review-lifecycle',
  up: async (sql) => {
    // 1. Widen the CHECK first, so the rename below has somewhere to land.
    await sql`ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check`;

    // 2. The rename, against live rows. Every pre-P9 booking was auto-confirmed
    //    at commit, so 'confirmed' is what they were, not a guess about them.
    await sql`UPDATE appointments SET status = 'confirmed' WHERE status = 'booked'`;

    // 3. The new closed set, generated from the same list the application reads.
    const statusList = sql.unsafe(
      APPOINTMENT_STATUSES.map((s) => `'${s.replace(/'/g, "''")}'`).join(', '),
    );
    await sql`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_status_check
        CHECK (status IN (${statusList}))
    `;

    // 4. The default moves with the flow: a row inserted without a status is a
    //    web request now, not a booking.
    await sql`ALTER TABLE appointments ALTER COLUMN status SET DEFAULT 'pending_review'`;

    // 5. Rebuild the partial unique index on the new predicate. Dropped and
    //    recreated rather than altered — a predicate is not alterable in place.
    const holdPredicate = sql.unsafe(SLOT_HOLD_PREDICATE);
    const indexName = sql.unsafe(SLOT_UNIQUE_INDEX);
    await sql`DROP INDEX IF EXISTS ${indexName}`;
    await sql`
      CREATE UNIQUE INDEX ${indexName}
        ON appointments (slot_start)
        WHERE ${holdPredicate}
    `;

    // 6. Lifecycle timestamps. All nullable; NULL means the transition has not
    //    happened, which is the only honest value for every existing row.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS declined_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS escalated_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS files_reviewed_at TIMESTAMPTZ
    `;

    // 7. The amount the office settled at approval, snapshotted rather than
    //    derived.
    //
    //    SNAPSHOT IS THE WHOLE POINT. `assessmentQuote` computes from the
    //    pricing table, and the table changes — the client has already moved
    //    these figures once. A customer who accepted a quote must not have it
    //    move under them because someone edited a constant, and the Stripe
    //    receipt has to match the approval email that quoted it.
    //
    //    These live here rather than in BK-32's migration (which the ticket
    //    originally assigned them to) because BK-23's approval screen is what
    //    WRITES them. A screen that ships one migration ahead of its own
    //    columns is a screen that 500s.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS assessment_amount_cents INTEGER,
        ADD COLUMN IF NOT EXISTS travel_fee_cents        INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gst_cents               INTEGER,
        ADD COLUMN IF NOT EXISTS total_amount_cents      INTEGER,
        ADD COLUMN IF NOT EXISTS payment_due_at          TIMESTAMPTZ
    `;

    // 8. Payment state, coarse. BK-32 adds the Stripe identifiers beside it.
    //
    //    'not_required' is the correct permanent value for every row that
    //    predates prepay: they were confirmed under a flow that took no money
    //    online, and calling them 'pending' would put 13 historical
    //    appointments into the office's unpaid queue on the day this ships.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_required'
    `;
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'appointments_payment_status_check'
        ) THEN
          ALTER TABLE appointments
            ADD CONSTRAINT appointments_payment_status_check
            CHECK (payment_status IN (
              'not_required', 'pending', 'paid', 'refunded', 'partially_refunded', 'failed'
            ));
        END IF;
      END $$
    `;

    // 9. The office's review queue is read by status and ordered by slot. One
    //    index, because "what is waiting on me" is the query this whole ticket
    //    creates and it runs on every admin page load.
    await sql`
      CREATE INDEX IF NOT EXISTS appointments_pending_review_idx
        ON appointments (slot_start)
        WHERE status = 'pending_review'
    `;
  },
};
