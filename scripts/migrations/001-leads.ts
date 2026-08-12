import type { Migration } from './types';

/**
 * The original contact-form table, unchanged.
 *
 * This already exists in production, so applying it is a no-op there — it is
 * recorded in `schema_migrations` purely so the ledger describes the whole
 * schema rather than starting halfway through.
 *
 * `leads` is not being migrated into `appointments`. The two coexist, and
 * `leads` STAYS WRITABLE indefinitely — BK-10's client-decided amendment
 * (2026-08-11) demoted the contact form to a general message channel rather
 * than deleting it, so this table is the message inbox, not a read-only
 * archive. The earlier plan for it to go read-only at cutover is dead.
 *
 * `service NOT NULL` below is the schema as first shipped; `004` drops it,
 * because a message form cannot demand a service.
 */
export const migration: Migration = {
  name: '001-leads',
  up: async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS leads (
        id         SERIAL       PRIMARY KEY,
        name       TEXT         NOT NULL,
        phone      TEXT         NOT NULL,
        email      TEXT,
        service    TEXT         NOT NULL,
        message    TEXT,
        status     TEXT         NOT NULL DEFAULT 'new',
        replied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `;
  },
};
