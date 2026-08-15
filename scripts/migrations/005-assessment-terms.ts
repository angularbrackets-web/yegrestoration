import type { Migration } from './types';

/**
 * Records that a public booking acknowledged the assessment fee terms.
 *
 * BK-27, client decision 2026-08-13: the assessment is free when the customer
 * proceeds with us and priced when they do not, so the terms are shown on both
 * booking surfaces and a checkbox blocks submission until they are
 * acknowledged. This column is the record of that acknowledgment.
 *
 * A TIMESTAMPTZ and no boolean, for the reason `sms_consent_at` is one: the
 * presence of the stamp IS the acknowledgment, and a pair of columns that can
 * disagree with each other is a bug waiting for the first row that sets one and
 * not the other.
 *
 * NULL is correct and permanent for two populations: every row that predates
 * this migration, and every admin entry from here on — the office books over
 * the phone and explains the terms verbally (the same exemption BK-22 gave the
 * email and photo requirements, riding the same `entry` discriminator). So
 * nothing is backfilled and there is no NOT NULL to add later.
 *
 * ORDER MATTERS, in the direction opposite to 004's. `insertBooking` names this
 * column, so new code against the old schema 500s on *every* booking, public
 * and admin alike; old code against the new schema is harmless. Apply this to
 * production BEFORE the deploy — see the ticket's Rollout section.
 */
export const migration: Migration = {
  name: '005-assessment-terms',
  up: async (sql) => {
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS terms_acked_at TIMESTAMPTZ
    `;
  },
};
