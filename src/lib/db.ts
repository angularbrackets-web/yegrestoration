import { neon } from '@neondatabase/serverless';

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
  slot_start: string;
  duration_minutes: number;
  source: 'web' | 'admin';
  /** Timestamp of CASL opt-in. Null means no consent — do not send SMS. */
  sms_consent_at: string | null;
  reminder_sent_at: string | null;
  admin_notes: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
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
  created_at: string;
};

export type BlackoutDate = {
  day: string;
  reason: string | null;
  created_at: string;
};

export function getDb() {
  const url = process.env.DATABASE_URL ?? import.meta.env.DATABASE_URL;
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
