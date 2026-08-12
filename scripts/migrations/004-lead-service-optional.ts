import type { Migration } from './types';

/**
 * `leads.service` becomes nullable.
 *
 * BK-10 demotes the contact form from a quote request to a general "send us a
 * message" channel, so "which service?" stops being a question every visitor
 * can answer — someone asking whether their basement smell is worth a call has
 * no service to pick, and forcing one produces a wrong label on a real lead.
 *
 * THE ORDER MATTERS, and it is the reason this is its own migration rather
 * than a line in the deploy. `TEXT NOT NULL` plus a route that swallows DB
 * failures (which is what `api/contact.ts` did before this ticket) means an
 * omitted service under the old schema violates the constraint, the catch eats
 * it, the email still sends, and the visitor sees success while the row never
 * lands. So: apply this to production BEFORE the code that can omit the column
 * deploys. The reverse order loses leads silently for the length of the
 * window. Same sequencing as BK-05's 003.
 *
 * `DROP NOT NULL` is idempotent in Postgres — dropping a constraint that is
 * already gone is a no-op, not an error — so this satisfies the migration
 * framework's re-runnable shape without an IF EXISTS spelling (there isn't
 * one for column constraints).
 *
 * Nothing is backfilled: every existing row has a service, and they keep it.
 */
export const migration: Migration = {
  name: '004-lead-service-optional',
  up: async (sql) => {
    await sql`
      ALTER TABLE leads ALTER COLUMN service DROP NOT NULL
    `;
  },
};
