import type { Migration } from './types';
import {
  APPOINTMENT_STATUSES,
  SLOT_HOLD_PREDICATE,
  SLOT_UNIQUE_INDEX,
} from '../../src/lib/booking-status';

/**
 * The contract half of BK-23's lifecycle change. **Runs AFTER the code deploy.**
 *
 * 008 is the expand half and runs BEFORE it. Read that file's ORDER section
 * first — it carries the reasoning, and the reason the split exists at all:
 *
 *   1. 008 (expand)  — additive and widening only, safe with the OLD code live
 *   2. deploy the code
 *   3. **this file** — the narrowing that only the NEW code can survive
 *
 * ── WHY THE INDEX REBUILD CANNOT HAPPEN BEFORE THE DEPLOY ──────────────────
 *
 * `insertBooking`'s `ON CONFLICT (slot_start) WHERE ...` is resolved by proving
 * the arbiter's predicate IMPLIES the index's. That is directional, and the two
 * codebases sit on opposite sides of it:
 *
 *     old code: status <> 'cancelled'                                    (wider)
 *     new code: status NOT IN ('cancelled','declined','payment_expired') (narrower)
 *
 * The narrower one implies the wider, so **new code works against the old
 * index** — which is what makes step 2 safe. The wider does not imply the
 * narrower, so old code against the new index raises **42P10 on every booking**.
 * Rebuilding the index before the deploy therefore takes the entire funnel down
 * for the length of the window. Verified with `EXPLAIN` against a real
 * database, and pinned permanently by `verify-booking-commit.ts`'s both-arbiter
 * probe.
 *
 * ── THIS FILE IS RE-RUNNABLE, AND HAS TO BE ────────────────────────────────
 *
 * Every statement is idempotent, because the window between the two halves is
 * exactly when the old code is still creating `booked` rows: it leans on the
 * column default, which 008 deliberately left alone. Step 1 sweeps whatever it
 * made. If this migration is run twice, or run long after the deploy, it does
 * the same thing.
 */
export const migration: Migration = {
  name: '009-review-lifecycle-contract',
  up: async (sql) => {
    // 1. Sweep anything the old code created during the deploy window. 008 has
    //    already renamed the historical rows; this catches only what was booked
    //    between the two halves, which is usually nothing.
    await sql`UPDATE appointments SET status = 'confirmed' WHERE status = 'booked'`;

    // 2. NOW the default may move — nothing writes through it any more, because
    //    `insertBooking` names its status explicitly.
    await sql`ALTER TABLE appointments ALTER COLUMN status SET DEFAULT 'pending_review'`;

    // 3. Drop 'booked' from the closed set. Safe only after step 1, and only
    //    because no live code can produce it.
    const statusList = sql.unsafe(
      APPOINTMENT_STATUSES.map((s) => `'${s.replace(/'/g, "''")}'`).join(', '),
    );
    await sql`ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check`;
    await sql`
      ALTER TABLE appointments
        ADD CONSTRAINT appointments_status_check
        CHECK (status IN (${statusList}))
    `;

    // 4. The predicate widening this whole split was arranged around.
    //
    //    Dropped and recreated rather than altered — a partial index's
    //    predicate is not alterable in place. The new predicate selects a
    //    SUBSET of the old one's rows ('declined' and 'payment_expired' cannot
    //    exist before this point), so the CREATE cannot fail on a duplicate the
    //    old index did not already forbid.
    //
    //    A failure between the DROP and the CREATE leaves the table with no
    //    double-booking guard until this is re-run. That is the one window this
    //    file cannot close by itself — the runner is not transactional
    //    (`scripts/migrate.ts`) — so re-run it immediately if it errors here,
    //    and check for duplicate live rows on one `slot_start` before doing so.
    const holdPredicate = sql.unsafe(SLOT_HOLD_PREDICATE);
    const indexName = sql.unsafe(SLOT_UNIQUE_INDEX);
    await sql`DROP INDEX IF EXISTS ${indexName}`;
    await sql`
      CREATE UNIQUE INDEX ${indexName}
        ON appointments (slot_start)
        WHERE ${holdPredicate}
    `;
  },
};
