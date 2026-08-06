import type { Migration } from './types';

/**
 * The original contact-form table, unchanged.
 *
 * This already exists in production, so applying it is a no-op there — it is
 * recorded in `schema_migrations` purely so the ledger describes the whole
 * schema rather than starting halfway through.
 *
 * `leads` is not being migrated into `appointments`. The two coexist; the
 * admin panel shows them as separate sections and `leads` goes read-only once
 * the old contact form is retired.
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
