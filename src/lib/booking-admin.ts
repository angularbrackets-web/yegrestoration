/**
 * Read-only view logic for the admin appointments surface.
 *
 * Pure and env-free — no database, no environment lookups — so
 * `scripts/verify-booking-admin.ts` can import it under `tsx` and pin the two
 * conditions that are easy to get subtly wrong in an `.astro` template: which
 * appointments still need a crew, and which missing notification stamp is
 * actually a failure.
 */

import { TIMEZONE } from './booking-config';
import type { Appointment } from './db';

/**
 * The fields the partition reads. Declared structurally rather than as
 * `Appointment` so the list page can pass rows it has decorated with a file
 * count without casting.
 */
export type PartitionableAppointment = Pick<Appointment, 'slot_start' | 'status'>;

export type AppointmentPartition<T> = {
  /** Still needs a crew: booked, and not yet started. Soonest first. */
  upcoming: T[];
  /** Everything else, most recent first. */
  past: T[];
};

/**
 * Split appointments into what the office still has to do and what it does not.
 *
 * `upcoming` is `status === 'booked'` AND `slot_start >= now`. The boundary
 * instant counts as upcoming: an appointment starting exactly now has not
 * happened yet, and dropping it out of the operational list at the moment it
 * matters most is the wrong way to round.
 *
 * Cancelled and no-show rows are *past* whatever their date, because nobody is
 * driving to them — but they stay visible rather than being filtered away, since
 * a cancelled slot that gets rebooked is tomorrow's confusion.
 *
 * `completed` is past for the same reason it is not `booked`.
 */
export function partitionAppointments<T extends PartitionableAppointment>(
  appointments: readonly T[],
  now: Date,
): AppointmentPartition<T> {
  const cutoff = now.getTime();
  const upcoming: T[] = [];
  const past: T[] = [];

  for (const appointment of appointments) {
    const start = appointment.slot_start.getTime();
    if (appointment.status === 'booked' && start >= cutoff) upcoming.push(appointment);
    else past.push(appointment);
  }

  upcoming.sort((a, b) => a.slot_start.getTime() - b.slot_start.getTime());
  past.sort((a, b) => b.slot_start.getTime() - a.slot_start.getTime());

  return { upcoming, past };
}

/** The fields the notification check reads. See `PartitionableAppointment`. */
export type NotifiableAppointment = Pick<
  Appointment,
  'source' | 'email' | 'confirmation_sent_at' | 'internal_notified_at'
>;

export type NotificationFlags = {
  /** Nobody told the office. A crew is expected somewhere and only the row knows. */
  internalMissing: boolean;
  /** The customer is owed a confirmation that never sent. */
  customerMissing: boolean;
};

/**
 * Which notifications this appointment was owed and never got.
 *
 * Three conditions make a missing stamp *not* a failure, and all three are why
 * this is a function rather than a template ternary:
 *
 * - `source === 'admin'` — an appointment the office typed in (BK-08) never had
 *   notifications to fail.
 * - no email address — a customer who gave none was never owed a confirmation.
 * - `sms_consent_at` / `reminder_sent_at` are not read here at all. A null
 *   consent is a valid state (the timestamp *is* the consent), and a null
 *   reminder is expected on every row until BK-06 ships.
 */
export function notificationFlags(appointment: NotifiableAppointment): NotificationFlags {
  if (appointment.source !== 'web') {
    return { internalMissing: false, customerMissing: false };
  }
  const hasEmail = typeof appointment.email === 'string' && appointment.email.trim() !== '';
  return {
    internalMissing: appointment.internal_notified_at == null,
    customerMissing: hasEmail && appointment.confirmation_sent_at == null,
  };
}

/** True when either notification failed — the list page's one warning marker. */
export function hasNotificationWarning(appointment: NotifiableAppointment): boolean {
  const flags = notificationFlags(appointment);
  return flags.internalMissing || flags.customerMissing;
}

/**
 * Render a non-slot timestamp (created_at, the notification stamps) in Edmonton
 * time.
 *
 * Slot times go through `formatSlot`, which is already zone-aware and is what
 * the customer's email used. Everything else comes through here, so that no
 * `.astro` page has to remember to pass `timeZone` — a bare `toLocaleString()`
 * renders the *server's* zone, which on Vercel is UTC, six or seven hours off.
 */
export function formatAdminTimestamp(instant: Date, tz: string = TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instant);
}

/** Human label for `payment_route`. */
export const PAYMENT_ROUTE_LABELS: Record<Appointment['payment_route'], string> = {
  insurance: 'Insurance',
  private: 'Private pay',
};

/** Human label for `status`. `no_show` is the only one that does not read well raw. */
export const STATUS_LABELS: Record<Appointment['status'], string> = {
  booked: 'Booked',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No show',
};

/** Human label for `pipeline_stage`. */
export const PIPELINE_STAGE_LABELS: Record<Appointment['pipeline_stage'], string> = {
  assessment: 'Assessment',
  mitigation: 'Mitigation',
  restoration: 'Restoration',
};

/**
 * `1.4 MB` etc. Null size (a claimed row whose upload callback never fired —
 * see the localhost trap in the ROADMAP) reads as unknown.
 *
 * Accepts a string as well as a number: `size_bytes` is `BIGINT`, which the
 * driver hands back as a string however `db.ts` types it — `upload-token.ts`
 * already wraps the same column in `Number(...)` for that reason.
 */
export function formatFileSize(bytes: number | string | null): string {
  const size = bytes == null ? NaN : Number(bytes);
  if (!Number.isFinite(size) || size < 0) return 'unknown size';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
