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
import { LIVE_STATUSES } from './booking-status';
import type { Appointment } from './db';

// ---------------------------------------------------------------------------
// Paths
//
// `astro.config.mjs` sets `trailingSlash: 'always'`, so every one of these ends
// in a slash and none of them is spelled out again at a call site. An unslashed
// href merely costs a 308 — but an unslashed *form action* is a POST replayed
// after a redirect, and an unslashed `PUBLIC_ADMIN_PATHS` entry is what made
// the whole `/admin` surface unreachable for a month (BK-07). One list, checked
// by `scripts/verify-booking-admin.ts`, is the cheapest way not to pay that
// again.
// ---------------------------------------------------------------------------

/**
 * The leads list, which is the admin root. Added by BK-10 along with the two
 * below: the leads surface outlived the plan to retire it (the contact form is
 * a message channel now, not a quote form), so its paths join the same list
 * the appointments surface uses rather than staying hand-spelled — each of
 * them was costing a 308 per click.
 */
export const ADMIN_LEADS_PATH = '/admin/';

export const ADMIN_REPLY_ENDPOINT = '/api/admin/reply/';

export const ADMIN_APPOINTMENTS_PATH = '/admin/appointments/';
export const ADMIN_APPOINTMENT_NEW_PATH = '/admin/appointments/new/';
export const ADMIN_BLACKOUTS_PATH = '/admin/blackouts/';

/** BK-09's authenticated file proxy. `/api/admin/files/7/` redirects to a signed URL. */
export const ADMIN_FILE_ENDPOINT = '/api/admin/files/';

export const ADMIN_APPOINTMENT_CREATE_ENDPOINT = '/api/admin/appointments/create/';
export const ADMIN_APPOINTMENT_UPDATE_ENDPOINT = '/api/admin/appointments/update/';
export const ADMIN_APPOINTMENT_RESEND_ENDPOINT = '/api/admin/appointments/resend/';

/** Approve or decline a request (BK-23). Separate from update for the reason in that route's header. */
export const ADMIN_APPOINTMENT_REVIEW_ENDPOINT = '/api/admin/appointments/review/';

/** "Mark as paid — Interac" (BK-32). The second caller of `markPaid()`. */
export const ADMIN_APPOINTMENT_MARK_PAID_ENDPOINT = '/api/admin/appointments/mark-paid/';

/**
 * BK-40's soft delete.
 *
 * Under `/appointments/`, not `/files/`, because `/api/admin/files/[id].ts` is
 * a dynamic route and `/api/admin/files/delete/` would be the same URL shape as
 * `/api/admin/files/7/`. See the route's own header.
 */
export const ADMIN_APPOINTMENT_FILE_DELETE_ENDPOINT = '/api/admin/appointments/file-delete/';
export const ADMIN_BLACKOUT_ADD_ENDPOINT = '/api/admin/blackouts/add/';
export const ADMIN_BLACKOUT_DELETE_ENDPOINT = '/api/admin/blackouts/delete/';

/** `/admin/leads/12/` — the one place that URL is spelled. */
export function adminLeadPath(id: number): string {
  return `${ADMIN_LEADS_PATH}leads/${id}/`;
}

/** `/admin/appointments/12/` — the one place that URL is spelled. */
export function adminAppointmentPath(id: number): string {
  return `${ADMIN_APPOINTMENTS_PATH}${id}/`;
}

/**
 * `/api/admin/files/7/` — an `appointment_files.id`, never a pathname.
 *
 * The id is the entire request input by design: the route reads the pathname
 * off the row, so nothing the browser sends can influence which blob gets
 * signed.
 */
export function adminFilePath(fileId: number): string {
  return `${ADMIN_FILE_ENDPOINT}${fileId}/`;
}

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
 * `upcoming` is a LIVE status AND `slot_start >= now`. The boundary instant
 * counts as upcoming: an appointment starting exactly now has not happened yet,
 * and dropping it out of the operational list at the moment it matters most is
 * the wrong way to round.
 *
 * **BK-23 widened "live" from the single `booked` to three statuses**, and the
 * widening is the point rather than a rename. Under prepay the office's day
 * contains work at three stages: requests waiting on a decision, approvals
 * waiting on money, and confirmed visits. All three are things somebody still
 * has to act on before the slot passes, so all three are upcoming. Leaving this
 * as "confirmed only" would have hidden every unreviewed request from the one
 * screen the office works from — which is the failure the review flow exists to
 * prevent, reintroduced one layer up.
 *
 * Cancelled, declined, expired and no-show rows are *past* whatever their date,
 * because nobody is driving to them — but they stay visible rather than being
 * filtered away, since a released slot that gets rebooked is tomorrow's
 * confusion.
 *
 * `completed` is past for the same reason it was never `booked`.
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
    if (LIVE_STATUSES.includes(appointment.status) && start >= cutoff) upcoming.push(appointment);
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
 * How the detail page renders a notification stamp. Three neutral states and
 * one failure, because a NULL means four different things.
 *
 * - `sent` — the column has a timestamp.
 * - `failed` — the row was OWED this message and never got it. Warning styling.
 * - `none` — nothing was sent and nothing was owed, but sending is *possible*.
 * - `not-applicable` — sending was never on the table.
 *
 * `none` is the state BK-08 added, and it is the reason this is a function
 * rather than the two-branch ternary BK-07 had. Since manual entries can send a
 * confirmation, "Not applicable" on an admin row with an email address is now
 * simply false — the office may have unticked the box, or the send may have
 * failed. Which of those it was is deliberately not recorded: a NULL stamp on
 * an admin row stays ambiguous after the flash is gone, the resend button
 * recovers either case, and a column to disambiguate would buy nothing an
 * operator would act on differently.
 *
 * `failed` stays web-only, matching `notificationFlags`: an admin row's missing
 * confirmation is not a system failure, so it must not raise the list page's
 * red marker.
 */
export type StampState = 'sent' | 'failed' | 'none' | 'not-applicable';

export function customerStampState(appointment: NotifiableAppointment): StampState {
  if (appointment.confirmation_sent_at != null) return 'sent';
  if (notificationFlags(appointment).customerMissing) return 'failed';
  const hasEmail = typeof appointment.email === 'string' && appointment.email.trim() !== '';
  // No email address means no confirmation was ever possible, on either source.
  return hasEmail ? 'none' : 'not-applicable';
}

/**
 * The office notification has no `none`: it is sent by the public commit path
 * or by nothing at all. An admin row was never owed one — the office typed it.
 */
export function internalStampState(appointment: NotifiableAppointment): StampState {
  if (appointment.internal_notified_at != null) return 'sent';
  return notificationFlags(appointment).internalMissing ? 'failed' : 'not-applicable';
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

/**
 * What an unpicked service reads as on the leads pages.
 *
 * `leads.service` is nullable since migration 004, and Astro renders `null` as
 * nothing — so a bare `{lead.service}` would leave a silently empty cell, and
 * `SERVICE_LABELS[lead.service] ?? lead.service` renders the empty string too.
 * Neither is the word "null", but neither says anything either. This does.
 */
export const LEAD_SERVICE_UNSPECIFIED = 'Not specified';

/**
 * A lead's service as a human reads it: the label, the raw id if it is not one
 * we know, or "Not specified" when there is none.
 *
 * `labels` is injected rather than imported: `SERVICE_LABELS` lives in `db.ts`
 * beside the Neon client, and this module's whole contract is that it can be
 * imported with no database and no environment.
 */
export function leadServiceLabel(
  service: string | null | undefined,
  labels: Record<string, string>,
): string {
  if (!service) return LEAD_SERVICE_UNSPECIFIED;
  return labels[service] ?? service;
}

/** Human label for `payment_route`. */
export const PAYMENT_ROUTE_LABELS: Record<Appointment['payment_route'], string> = {
  insurance: 'Insurance',
  private: 'Private pay',
};

/**
 * Human label for `status`. Defined in `booking-status.ts` beside the enum, so
 * a status added there without a label is a type error rather than an
 * `undefined` rendered into an admin table.
 */
export { STATUS_LABELS } from './booking-status';

/**
 * Human label for `appointment_files.source` (BK-40).
 *
 * `unrecorded` is the key a NULL maps to, and its label says exactly that. The
 * office reads this row to answer "did the customer send these, or did we?" —
 * and for a row written before migration 006 the honest answer is that nobody
 * wrote it down. Rendering NULL as any of the three real values would be a
 * guess presented as a record.
 */
export const FILE_SOURCE_LABELS: Record<'web' | 'link' | 'office' | 'unrecorded', string> = {
  web: 'from the booking form',
  link: 'from the customer’s upload link',
  office: 'added by the office',
  unrecorded: 'source not recorded',
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
