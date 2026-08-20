import type { Migration } from './types';
import { APPOINTMENT_STATUSES } from '../../src/lib/booking-status';

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
 * ── ORDER: THIS IS THE EXPAND HALF. 009 IS THE CONTRACT HALF. ──────────────
 *
 * **An earlier version of this migration rebuilt the index here, and the header
 * claimed the deploy window was safe. It was not, and the claim was the defect.**
 * Found in BK-23's implementation review, 2026-08-18, and proved with `EXPLAIN`
 * against a real database rather than by reasoning:
 *
 *     OK        status NOT IN ('cancelled','declined','payment_expired')   ← new code
 *     FAIL 42P10  status <> 'cancelled'                                    ← code live on production
 *
 * Postgres proves the ON CONFLICT predicate IMPLIES the index predicate, and
 * that relation is **directional**. Production's arbiter is `status <>
 * 'cancelled'`, which does not imply the three-status deny-list. So from the
 * moment the index was rebuilt until the new deployment went live — minutes,
 * longer if the build failed — EVERY booking, public and admin, would have
 * raised 42P10. The whole funnel, which is the exact failure this file's own
 * index section warns about, arriving through the rollout order it prescribed.
 * A Vercel instant-rollback would have re-opened it with no obvious cause.
 *
 * The asymmetry is also the fix: the NEW arbiter is strictly narrower, so it
 * implies the OLD index's predicate and works fine against it. Verified the
 * same way, and now pinned permanently by `verify-booking-commit.ts`'s
 * both-arbiter probe so the next predicate change cannot re-learn this from an
 * outage.
 *
 * Therefore the work is split:
 *
 *   1. **009 does NOT run yet.** This file (expand) runs against production
 *      while the OLD code is still live. Everything it does is additive or
 *      widening: new columns, a CHECK that permits the old value AND the new
 *      ones, the rename. **It does not touch the unique index and does not
 *      move the column default** — both are what the old code depends on.
 *   2. **Deploy the code.** Its arbiter works against the index still standing.
 *   3. **Then 009 (contract)** rebuilds the index, moves the default, and
 *      tightens the CHECK.
 *
 * `insertBooking` now writes `status` EXPLICITLY rather than leaning on the
 * column default, which is what lets step 2 sit between the two halves at all:
 * a lifecycle value that crosses a migration boundary must not be decided by a
 * default that one half of the boundary has not moved yet.
 */
export const migration: Migration = {
  name: '008-review-lifecycle',
  up: async (sql) => {
    // 1. Widen the CHECK first, so the rename below has somewhere to land.
    await sql`ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check`;

    // 2. The rename, against live rows. Every pre-P9 booking was auto-confirmed
    //    at commit, so 'confirmed' is what they were, not a guess about them.
    await sql`UPDATE appointments SET status = 'confirmed' WHERE status = 'booked'`;

    // 3. The new closed set — PLUS 'booked', for the length of the deploy
    //    window only.
    //
    //    The old code is still live while this runs, and its INSERT leans on
    //    the column default, which step 4 deliberately does not move. So it
    //    keeps writing 'booked' until the new deployment replaces it, and a
    //    CHECK without 'booked' would reject every booking it makes — the same
    //    outage this split exists to avoid, arriving through the constraint
    //    instead of the arbiter.
    //
    //    009 drops 'booked' from the set once nothing can write it. Until then
    //    the extra value is permitted but unreachable by new code, which names
    //    its status explicitly.
    const statusList = sql.unsafe(
      [...APPOINTMENT_STATUSES, 'booked' as const]
        .map((s) => `'${s.replace(/'/g, "''")}'`)
        .join(', '),
    );
    await sql`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_status_check
        CHECK (status IN (${statusList}))
    `;

    // 4. THE DEFAULT DOES NOT MOVE HERE, and neither does the unique index.
    //    Both belong to 009, after the code is live. See the ORDER note above:
    //    the old code's arbiter cannot resolve against the new index, and its
    //    INSERT still relies on this default.

    // 5. Lifecycle timestamps. All nullable; NULL means the transition has not
    //    happened, which is the only honest value for every existing row.
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS declined_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS escalated_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS files_reviewed_at TIMESTAMPTZ
    `;

    // 6. The amount the office settled at approval, snapshotted rather than
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

    // 7. Payment state, coarse. BK-32 adds the Stripe identifiers beside it.
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

    // 8. The office's review queue is read by status and ordered by slot. One
    //    index, because "what is waiting on me" is the query this whole ticket
    //    creates and it runs on every admin page load.
    await sql`
      CREATE INDEX IF NOT EXISTS appointments_pending_review_idx
        ON appointments (slot_start)
        WHERE status = 'pending_review'
    `;
  },
};
