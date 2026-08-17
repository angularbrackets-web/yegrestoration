import type { Migration } from './types';

/**
 * Where an appointment's file came from, and how the office un-attaches one.
 *
 * BK-40, from the client's production testing of Deploy 1. Two gaps in the
 * files list, both of which only appear once real photos start arriving:
 *
 *   1. The office cannot tell a photo the CUSTOMER sent from one an agent
 *      uploaded on their behalf. Under BK-34a both paths ran the same token
 *      through the same route, so nothing distinguished them at all.
 *   2. There is no way to remove a wrong or accidental upload. A file attached
 *      to the wrong appointment stayed there permanently, counting against the
 *      10-file cap, with no UI anywhere to undo it.
 *
 * ---
 *
 * `source` IS NULLABLE AND NOTHING IS BACKFILLED, on the same reasoning as
 * `terms_acked_at` (migration 005). NULL means "we did not record this", which
 * is the truth for every row written before this migration, and a backfilled
 * guess would be indistinguishable from a fact the moment it was written. The
 * detail page renders NULL as "source not recorded" rather than inventing one.
 *
 * The CHECK deliberately does not include an `'unknown'` value. An enum member
 * meaning "no value" alongside a nullable column gives two spellings of the
 * same state that can disagree — the trap migration 005's comment describes for
 * a boolean beside a timestamp.
 *
 * `web` is the public booking funnel (`/api/booking/upload-token/`), `link` is
 * a customer using the texted upload link, `office` is an agent using the
 * uploader on the admin page. The last two are told apart by the signature on
 * the token, not by anything the caller sends — see `draft-token.ts`.
 *
 * ---
 *
 * SOFT DELETE, AND THE BLOB IS DELIBERATELY LEFT ALONE. `deleted_at` hides the
 * row from the admin list, from the file proxy and from the upload caps; the
 * object stays in the store. Deleting the bytes would make this irreversible,
 * which is precisely what the office does NOT want from a button they will
 * press by accident — the whole reason they asked for it is accidental
 * uploads. The storage cost of a handful of mistaken files is not worth an
 * unrecoverable action. If it ever matters, the cleanup cron is the place to
 * sweep long-deleted rows, not this button.
 *
 * `deleted_note` is the audit line — who and why, in the office's words. It
 * duplicates nothing: the appointment's `admin_notes` gets a human-readable
 * line too (the BK-35 pattern), and this column is what makes the fact
 * queryable rather than buried in prose.
 *
 * ---
 *
 * ORDER OF ROLLOUT, and it is the same direction as 005's. The admin page and
 * both upload routes will name these columns, so **new code against the old
 * schema throws on every upload and on every view of an appointment**. Apply
 * this to production BEFORE the deploy. Old code against the new schema is
 * harmless: it simply never sets them.
 */
export const migration: Migration = {
  name: '006-file-provenance',
  up: async (sql) => {
    await sql`
      ALTER TABLE appointment_files
        ADD COLUMN IF NOT EXISTS source TEXT
    `;
    // Separate statement, and IF NOT EXISTS on the column above, because Neon's
    // HTTP driver has no cross-call transaction (ROADMAP) — every statement
    // here has to be independently re-runnable.
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'appointment_files_source_check'
        ) THEN
          ALTER TABLE appointment_files
            ADD CONSTRAINT appointment_files_source_check
            CHECK (source IS NULL OR source IN ('web', 'link', 'office'));
        END IF;
      END $$
    `;
    await sql`
      ALTER TABLE appointment_files
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `;
    await sql`
      ALTER TABLE appointment_files
        ADD COLUMN IF NOT EXISTS deleted_note TEXT
    `;
    // Every read path filters on `deleted_at IS NULL` — the admin list, the
    // detail page, the file proxy, and the upload caps. A partial index keeps
    // those the cheap case as deleted rows accumulate.
    await sql`
      CREATE INDEX IF NOT EXISTS appointment_files_live_idx
        ON appointment_files (appointment_id)
        WHERE deleted_at IS NULL
    `;
  },
};
