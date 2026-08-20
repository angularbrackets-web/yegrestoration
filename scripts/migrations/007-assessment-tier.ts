import type { Migration } from './types';

/**
 * Which assessment the customer chose at booking (BK-31).
 *
 * Under prepay the tier is what gets charged, so it is no longer a preference
 * the office settles on the day — it binds. BK-27's "tell the tech on the day
 * which of these you want" is deleted copy, not softened copy.
 *
 * NULLABLE, and NULL is correct and permanent for two populations: every row
 * that predates this migration, and every admin entry from here on. That is the
 * same exemption `terms_acked_at` carries in `005-assessment-terms.ts`, riding
 * the same `entry` discriminator, for the same client decision — the office
 * books over the phone and settles the tier verbally. Nothing is backfilled and
 * there is no NOT NULL to add later.
 *
 * The CHECK is the closed set, not a lookup table. Three values that change
 * only when the client changes their offering are not a table, and a CHECK is
 * the thing that makes a hand-crafted payload fail at the database rather than
 * at whatever validation someone remembers to write.
 *
 * **No price column here.** Prices live in `src/lib/booking-pricing.ts` and are
 * computed from `(tier, service, slot_start)`; what a booking is *charged* is
 * snapshotted at approval by BK-32's migration, because prices change under
 * live rows and a quote a customer accepted must not move with them. A price on
 * this row would be a third place the number lives.
 *
 * ORDER MATTERS, in 005's direction. `insertBooking` names this column, so new
 * code against the old schema 500s on EVERY booking, public and admin alike;
 * old code against the new schema is harmless. Apply to production BEFORE the
 * deploy — see the ticket's Rollout section.
 */
export const migration: Migration = {
  name: '007-assessment-tier',
  up: async (sql) => {
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS assessment_tier TEXT
    `;
    // Separate from the ADD COLUMN so a re-run over a table that already has
    // the column still installs the constraint. `IF NOT EXISTS` has no
    // constraint equivalent, so the catalog is consulted directly.
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'appointments_assessment_tier_check'
        ) THEN
          ALTER TABLE appointments
            ADD CONSTRAINT appointments_assessment_tier_check
            CHECK (assessment_tier IN ('standard', 'report', 'sketch'));
        END IF;
      END $$
    `;
  },
};
