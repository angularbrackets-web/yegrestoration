import type { Migration } from './types';

/**
 * Booking system: appointments, their uploaded files, admin blackout dates,
 * and a rate-limit counter used to gate the public upload funnel.
 */
export const migration: Migration = {
  name: '002-booking',
  up: async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS appointments (
        id               SERIAL      PRIMARY KEY,

        -- contact
        name             TEXT        NOT NULL,
        phone            TEXT        NOT NULL,
        email            TEXT,

        -- job
        service          TEXT        NOT NULL,
        description      TEXT,
        address          TEXT        NOT NULL,
        city             TEXT        NOT NULL DEFAULT 'Edmonton',
        postal_code      TEXT,

        -- payment route. policy_number and claim_number are insurance-only and
        -- must never appear in an SMS body — email and the admin panel only.
        payment_route    TEXT        NOT NULL
                                     CHECK (payment_route IN ('insurance', 'private')),
        insurer_name     TEXT,
        policy_number    TEXT,
        claim_number     TEXT,

        -- Pipeline stage and lifecycle status are independent: a job can be
        -- 'restoration' + 'booked' or 'assessment' + 'no_show'. Neither is
        -- derivable from the other.
        pipeline_stage   TEXT        NOT NULL DEFAULT 'assessment'
                                     CHECK (pipeline_stage IN ('assessment', 'mitigation', 'restoration')),
        status           TEXT        NOT NULL DEFAULT 'booked'
                                     CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show')),

        -- Scheduling. Stored as UTC instants; the wall clock is America/Edmonton
        -- per the shared constants in src/lib/booking-config.ts.
        slot_start       TIMESTAMPTZ NOT NULL,
        -- Pinned to 30 for now. A longer appointment would occupy a following
        -- slot that the slot_start-only unique index below cannot see, so the
        -- office books two consecutive slots instead. Widening this CHECK
        -- requires real overlap detection (see the note on the index).
        duration_minutes SMALLINT    NOT NULL DEFAULT 30
                                     CHECK (duration_minutes = 30),

        -- provenance and consent
        source           TEXT        NOT NULL DEFAULT 'web'
                                     CHECK (source IN ('web', 'admin')),
        sms_consent_at   TIMESTAMPTZ,
        reminder_sent_at TIMESTAMPTZ,

        admin_notes      TEXT,
        cancelled_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Double-booking guard. Cancelled appointments release their slot but keep
    // the record, which a plain UNIQUE(slot_start) could not express.
    //
    // Slot uniqueness assumes a SINGLE CREW. If technician_id becomes real,
    // this becomes:
    //   UNIQUE (slot_start, technician_id) WHERE status <> 'cancelled'
    //
    // It also only catches identical start times, which is why manual admin
    // entries are snapped to the same hourly grid and capped at 30 minutes.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot_unique
        ON appointments (slot_start)
        WHERE status <> 'cancelled'
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS appointments_admin_list_idx
        ON appointments (slot_start DESC)
    `;

    // Files land in Blob storage before the appointment row exists. A row is
    // written here when the upload token is minted, with appointment_id NULL,
    // and claimed when the booking commits. Cleanup is therefore a DB query
    // rather than a storage listing diff.
    await sql`
      CREATE TABLE IF NOT EXISTS appointment_files (
        id             SERIAL      PRIMARY KEY,
        appointment_id INTEGER     REFERENCES appointments(id) ON DELETE CASCADE,
        draft_id       UUID        NOT NULL,
        pathname       TEXT        NOT NULL UNIQUE,
        url            TEXT,
        content_type   TEXT        NOT NULL,
        -- Client-declared at token mint, overwritten with the true size when
        -- the upload-completed callback fires.
        size_bytes     BIGINT,
        original_name  TEXT,
        upload_state   TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (upload_state IN ('pending', 'uploaded')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS appointment_files_appointment_idx
        ON appointment_files (appointment_id)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS appointment_files_draft_idx
        ON appointment_files (draft_id)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS appointment_files_orphan_idx
        ON appointment_files (created_at)
        WHERE appointment_id IS NULL
    `;

    // Admin-blocked days. Fridays are permanently off via config, not rows.
    // Named `day` rather than `date` to avoid colliding with the type name.
    await sql`
      CREATE TABLE IF NOT EXISTS blackout_dates (
        day        DATE        PRIMARY KEY,
        reason     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Fixed-window counters. The public form has no user session, so this is
    // what stops a bot minting unlimited upload drafts. Pruned by the cleanup cron.
    await sql`
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket       TEXT        NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        count        INTEGER     NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, window_start)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS rate_limits_window_idx
        ON rate_limits (window_start)
    `;
  },
};
