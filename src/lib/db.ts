import { neon } from '@neondatabase/serverless';

import type { AssessmentTier } from './booking-pricing';
import { readEnv } from './env';

export type Lead = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  /**
   * NULL since migration 004: the contact form is a general message channel
   * (BK-10), so "which service?" is optional and an absent one is a real,
   * expected value. Every render site must guard it — `SERVICE_LABELS[null]`
   * is `undefined`, and a template that falls back to the raw column prints
   * the word "null" into an admin page or, worse, a customer's email.
   */
  service: string | null;
  message: string | null;
  status: 'new' | 'read' | 'replied';
  /** `timestamptz` — the driver hands back a `Date`. See the note below. */
  replied_at: Date | null;
  created_at: Date;
};

/**
 * NOTE ON TIMESTAMP AND DATE COLUMNS
 *
 * `@neondatabase/serverless` deserializes `timestamptz` (OID 1184) and `date`
 * (OID 1082) into `Date` objects, so the booking types below say `Date` — that
 * is what a plain `SELECT` actually returns. Typing them as `string` (as they
 * originally were) let `row.slot_start === slot.toISOString()` typecheck while
 * never matching at runtime, which would show already-booked slots as free.
 *
 * `timestamptz` round-trips exactly: consume it as a `Date`, compare with
 * `.getTime()`. `date` does NOT — it is timezone-naive and parses at the
 * *server's* local midnight, which on Vercel (UTC) converts back to the
 * previous America/Edmonton day. So never read `blackout_dates.day` directly;
 * project it as `day::text` and use `BlackoutDayRow`.
 * `src/pages/api/booking/availability.ts` is the worked example.
 *
 * `Lead` above said `string` from BK-01 until BK-10 corrected it. It was a
 * documentation bug rather than a live one — every consumer wrapped the value
 * in `new Date(...)`, which takes either — but the corrected type is what the
 * driver returns, and `formatAdminTimestamp` takes a `Date`, so the leads
 * pages now hand it the column directly instead of re-parsing a lie.
 */

/** Where a job sits in the restoration process. Independent of `AppointmentStatus`. */
export type PipelineStage = 'assessment' | 'mitigation' | 'restoration';

/** Lifecycle of the booking itself. Only 'cancelled' releases the slot. */
export type AppointmentStatus = 'booked' | 'completed' | 'cancelled' | 'no_show';

/** Re-exported from the pricing module so a row type does not import a price table. */
export type { AssessmentTier };

export type Appointment = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  service: string;
  description: string | null;
  address: string;
  city: string;
  postal_code: string | null;
  payment_route: 'insurance' | 'private';
  insurer_name: string | null;
  /** Insurance only. Never include in an SMS body. */
  policy_number: string | null;
  /** Insurance only. Never include in an SMS body. */
  claim_number: string | null;
  pipeline_stage: PipelineStage;
  status: AppointmentStatus;
  /**
   * Which assessment the customer chose (BK-31). NULL for admin entries and for
   * every row predating migration 007 — see the migration for why that is
   * permanent rather than a backfill waiting to happen.
   *
   * Typed as the union rather than `string` so a render site cannot silently
   * print an unknown tier; the DB CHECK is what makes the narrowing true.
   */
  assessment_tier: AssessmentTier | null;
  /** UTC instant. Compare with `.getTime()`, never against an ISO string. */
  slot_start: Date;
  duration_minutes: number;
  source: 'web' | 'admin';
  /** Timestamp of CASL opt-in. Null means no consent — do not send SMS. */
  sms_consent_at: Date | null;
  /**
   * When the customer acknowledged the assessment fee terms (BK-27). Null is
   * correct and permanent for admin entries — exempt, the office explains the
   * terms on the phone — and for every row that predates migration 005.
   */
  terms_acked_at: Date | null;
  reminder_sent_at: Date | null;
  /** Set only when the customer's confirmation email actually sent. NULL = never sent. */
  confirmation_sent_at: Date | null;
  /** Set only when the office notification actually sent. NULL = nobody was told. */
  internal_notified_at: Date | null;
  admin_notes: string | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type AppointmentFile = {
  id: number;
  /** Null until the booking that owns this upload commits. */
  appointment_id: number | null;
  draft_id: string;
  pathname: string;
  url: string | null;
  content_type: string;
  /**
   * `BIGINT`, which `@neondatabase/serverless` deserializes as a STRING the way
   * `pg` does — a bigint does not fit a JS number, so the driver refuses to
   * guess. Typed `number` this column let `size_bytes / 1024` typecheck and
   * produce `NaN`; `formatFileSize` and `upload-token.ts` both already coerce.
   * See the note above on timestamp columns: same class of bug, opposite
   * direction.
   */
  size_bytes: string | number | null;
  original_name: string | null;
  upload_state: 'pending' | 'uploaded';
  /**
   * Who put this file here (BK-40, migration 006).
   *
   * `web` is the public booking funnel, `link` a customer using the texted
   * upload link, `office` an agent using the uploader on the admin page. The
   * last two are told apart by a signed claim inside the upload token, never by
   * anything the caller sends.
   *
   * NULL is correct and permanent for every row written before migration 006,
   * and renders as "source not recorded" — never as a guess. Nothing was
   * backfilled, because a backfilled guess is indistinguishable from a fact the
   * moment it lands.
   */
  source: 'web' | 'link' | 'office' | null;
  /**
   * Soft delete (BK-40). Non-null hides the row from the admin list, from the
   * file proxy, and from the upload caps — the BYTES ARE LEFT IN THE STORE on
   * purpose, so a mistaken click is recoverable. Every query that lists or
   * serves files must carry `deleted_at IS NULL`.
   */
  deleted_at: Date | null;
  /** The office's own words on why. The queryable half of the audit line. */
  deleted_note: string | null;
  created_at: Date;
};

export type BlackoutDate = {
  /**
   * A bare `SELECT day` returns this as a `Date` parsed at the server's local
   * midnight, which is the wrong calendar day once the server is UTC. Read it
   * through `BlackoutDayRow` instead.
   */
  day: Date;
  reason: string | null;
  created_at: Date;
};

/** The safe projection of `blackout_dates`: `SELECT day::text AS day`. */
export type BlackoutDayRow = {
  /** Local calendar date, `YYYY-MM-DD`. */
  day: string;
};

export function getDb() {
  const url = readEnv('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is not configured');
  return neon(url);
}

export const SERVICE_LABELS: Record<string, string> = {
  water: 'Water Damage Restoration',
  fire: 'Fire Damage Restoration',
  mold: 'Mold Removal',
  storm: 'Storm Damage Repair',
  sewage: 'Sewage Cleanup',
  construction: 'Construction Services',
  contents: 'Contents Restoration',
  biohazard: 'Biohazard Cleaning',
  asbestos: 'Asbestos Abatement',
  other: 'Other Emergency',
};
