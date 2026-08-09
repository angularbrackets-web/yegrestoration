import { neon } from '@neondatabase/serverless';

import { readEnv } from './env';

export type Lead = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  service: string;
  message: string | null;
  status: 'new' | 'read' | 'replied';
  replied_at: string | null;
  created_at: string;
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
 * `Lead` below predates this and still says `string`. Its consumers all wrap
 * the value in `new Date(...)`, which accepts either, so it is a documentation
 * bug rather than a live one — left alone here to keep BK-01's diff honest.
 */

/** Where a job sits in the restoration process. Independent of `AppointmentStatus`. */
export type PipelineStage = 'assessment' | 'mitigation' | 'restoration';

/** Lifecycle of the booking itself. Only 'cancelled' releases the slot. */
export type AppointmentStatus = 'booked' | 'completed' | 'cancelled' | 'no_show';

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
  /** UTC instant. Compare with `.getTime()`, never against an ISO string. */
  slot_start: Date;
  duration_minutes: number;
  source: 'web' | 'admin';
  /** Timestamp of CASL opt-in. Null means no consent — do not send SMS. */
  sms_consent_at: Date | null;
  reminder_sent_at: Date | null;
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
  size_bytes: number | null;
  original_name: string | null;
  upload_state: 'pending' | 'uploaded';
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
