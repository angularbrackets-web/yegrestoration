import type { Migration } from './types';

/**
 * Records whether each of a booking's two notifications actually went out.
 *
 * Both columns, not just the customer's. A failed *office* notification is the
 * failure that matters most — it is the whole reason BK-05 exists — and
 * recording only the customer side would leave it visible nowhere but a log
 * line nobody reads. NULL means "never sent", which is accurate for every row
 * that predates this migration, so there is nothing to backfill.
 *
 * `reminder_sent_at` in `002-booking` is the same idea for BK-06's SMS.
 */
export const migration: Migration = {
  name: '003-notification-stamps',
  up: async (sql) => {
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ
    `;
    await sql`
      ALTER TABLE appointments
        ADD COLUMN IF NOT EXISTS internal_notified_at TIMESTAMPTZ
    `;
  },
};
