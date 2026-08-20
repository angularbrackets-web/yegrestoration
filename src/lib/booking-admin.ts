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
import { assessmentQuote, isAfterHoursSlot } from './booking-pricing';
import { isAwaitingPayment, LIVE_STATUSES } from './booking-status';
import type { Appointment, AppointmentStatus } from './db';

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

// ---------------------------------------------------------------------------
// What a booking costs, as ONE derivation (BK-46)
//
// THE DEFECT THIS EXISTS TO REMOVE. The detail page derived money in two
// places. The header called `assessmentQuote({tier, service, slotStart})`,
// which takes an optional `travelFeeCents` **defaulting to zero** and
// recomputes from today's price table; the panel below it read the four stored
// columns. So on any booking with a travel fee — the figure the office adjusts
// most often — one screen showed two totals, both labelled in dollars, with
// nothing saying which the customer was charged. The page's own comment had
// predicted it: "BK-32 adds one, snapshotted at approval, and at that point
// this display should read the snapshot instead". The column shipped; the
// display did not follow.
//
// So the fix is not "add travel to the header". It is to delete the header's
// arithmetic and have both surfaces read this. **One consequence, stated
// because it decides how this is tested:** once both read one function, "the
// header total equals the settled total" is true by construction and cannot
// fail. It is not asserted as though it could. What is asserted is this
// function's own answers, and — structurally — that the page has no second
// derivation.
// ---------------------------------------------------------------------------

/**
 * What the office may say about this booking's money, and on what authority.
 *
 * Three kinds, because there are three different authorities and collapsing any
 * two of them is how a screen states a number it cannot stand behind:
 *
 *   `settled`  — the office approved these figures and they are ON the row.
 *   `estimate` — nothing is settled; this is arithmetic, shown as arithmetic.
 *   `none`     — no tier was chosen, so there is not even a price to compute.
 */
export type AppointmentMoney =
  | {
      kind: 'settled';
      baseCents: number;
      travelCents: number;
      gstCents: number;
      totalCents: number;
      afterHours: boolean;
    }
  | {
      kind: 'estimate';
      /**
       * WHY nothing is settled, because the two reasons need different words.
       *
       * `suggestion`    — the row is awaiting review. The figure is what the
       *                   office is about to be offered on the Review panel.
       * `never-settled` — the row is past review and no amount was ever
       *                   recorded: declined, or cancelled from the dropdown
       *                   before anyone approved it.
       *
       * **Neither claims anything about the row's AGE**, and an earlier version
       * of this split did. It called the second case a row that "predates the
       * amount snapshot" — false twice: those columns are migration 008's, not
       * 010's, and the rows that actually land here are declines from this
       * week. `assessment_tier` is 007's and was never backfilled, so genuinely
       * old rows carry no tier and answer `none`. Caught at plan review, on the
       * screen this ticket exists to make honest.
       */
      basis: 'suggestion' | 'never-settled';
      baseCents: number;
      totalCents: number;
      afterHours: boolean;
    }
  | { kind: 'none' };

/** The columns this reads. Narrow on purpose — it is a view, not a row. */
export type MoneyBearingAppointment = Pick<
  Appointment,
  | 'status'
  | 'service'
  | 'slot_start'
  | 'assessment_tier'
  | 'assessment_amount_cents'
  | 'travel_fee_cents'
  | 'gst_cents'
  | 'total_amount_cents'
>;

/**
 * ORDER IS THE RULE, and it is written here rather than left to the shape of
 * the `if`s, because plan review found the precedence genuinely undecided.
 *
 * 1. **No tier, no answer.** Nothing to settle and nothing to compute.
 *
 * 2. **`pending_review` outranks a surviving snapshot.** A row walked back from
 *    `approved_awaiting_payment` through the STATUS DROPDOWN keeps its amount
 *    columns — `update.ts`'s SET clause writes status, stage, notes, tier and
 *    `cancelled_at`, and nothing else — while `review.ts`'s own `rollBack`
 *    nulls them and says exactly why: *"leaving them set would make the admin
 *    page render 'Amount settled at approval' over a row nobody has approved."*
 *    That sentence describes the dropdown path today. So a `pending_review` row
 *    shows the SUGGESTION, which is the number the office is about to act on,
 *    and the settled panel does not render for it at all.
 *
 * 3. **A snapshot past review is the truth**, read whole. `gst_cents` and
 *    `total_amount_cents` are read, never re-derived: `review.ts` computes GST
 *    once on the overridden subtotal, and recomputing at 5% here would
 *    reintroduce the same drift one rounding later. A $0 approval reaches this
 *    arm with four zeros, which is correct — it WAS settled, at zero.
 *
 * 4. **Otherwise it is an estimate that was never settled.**
 */
/**
 * Which side of the approval each status sits on, as an EXHAUSTIVE record
 * rather than a predicate call.
 *
 * A `Record<AppointmentStatus, …>` makes a ninth status a typecheck error here.
 * The `isAwaitingReview(...)` this replaces was correct and silently
 * open-ended: a status added later fell through to the `never-settled` arm,
 * whose copy reads *"no amount was ever settled"* — which would be a confident
 * false sentence about a row nobody had classified. Implementation review
 * caught the omission; the plan had specified this shape and the first
 * implementation wrote an if-chain.
 *
 * The same pattern, and the same reason, as `STATUS_ENTRY_OWNER`.
 */
const MONEY_STAGE: Record<AppointmentStatus, 'review' | 'past'> = {
  pending_review: 'review',
  approved_awaiting_payment: 'past',
  confirmed: 'past',
  completed: 'past',
  no_show: 'past',
  declined: 'past',
  payment_expired: 'past',
  cancelled: 'past',
};

export function appointmentMoney(row: MoneyBearingAppointment): AppointmentMoney {
  if (!row.assessment_tier) return { kind: 'none' };

  const afterHours = isAfterHoursSlot(row.slot_start);

  const estimate = (basis: 'suggestion' | 'never-settled'): AppointmentMoney => {
    const quote = assessmentQuote({
      tier: row.assessment_tier!,
      service: row.service,
      slotStart: row.slot_start,
    });
    return {
      kind: 'estimate',
      basis,
      baseCents: quote.baseCents,
      totalCents: quote.totalCents,
      afterHours,
    };
  };

  if (MONEY_STAGE[row.status] === 'review') return estimate('suggestion');

  // All four or none. A partial snapshot cannot be rendered honestly, and the
  // obvious spelling of "keyed on one, read four" is a `?? 0` that would print
  // $0.00 for a real GST amount on the screen somebody reads during a dispute.
  const { assessment_amount_cents: base, gst_cents: gst, total_amount_cents: total } = row;
  if (base !== null && gst !== null && total !== null) {
    return {
      kind: 'settled',
      baseCents: base,
      // `NOT NULL DEFAULT 0` — the one amount column that cannot be missing.
      travelCents: row.travel_fee_cents,
      gstCents: gst,
      totalCents: total,
      afterHours,
    };
  }

  return estimate('never-settled');
}

/**
 * Whether this row still owes money — the question the due line should have
 * been asking all along.
 *
 * It asked whether `payment_due_at` was non-null. **Nothing ever clears that
 * column**, so its presence describes the past: a paid booking's only money
 * panel read "Payment due by Thu, Aug 20 · 11:39 a.m.", and so did every
 * expired, declined and cancelled row, where it invites somebody to chase a
 * payment on a booking that is closed.
 *
 * `total > 0` is not defensive. `approveFree` leaves a $0 row at
 * `approved_awaiting_payment` with `payment_status = 'pending'` until `markPaid`
 * moves it, and a row that owes $0.00 does not owe.
 */
export function stillOwesPayment(
  row: Pick<Appointment, 'status' | 'payment_status' | 'total_amount_cents'>,
): boolean {
  return (
    isAwaitingPayment(row.status) &&
    row.payment_status !== 'paid' &&
    (row.total_amount_cents ?? 0) > 0
  );
}

/**
 * How the money arrived, as a sentence — or null when it has not.
 *
 * ── GATED ON `payment_status`, NOT ON `paid_at` BEING NON-NULL ─────────────
 *
 * **Nothing clears `paid_at` or `payment_method`.** Not `approve`, not
 * `rollBack`, not `update.ts`. So a booking that was paid, walked back to
 * `pending_review` by the dropdown and re-approved at a corrected amount sits
 * at `approved_awaiting_payment` carrying the PREVIOUS cycle's stamp — and the
 * first draft of this function would have rendered "Payment due by …" and "Paid
 * by card · <last month>" in the same panel. The ROADMAP predicted it by name:
 * *"it becomes visible the moment BK-46 renders those columns."*
 *
 * `payment_status` is the column the payment path actually maintains, so it is
 * the one asked. **The staleness itself is not fixed here** — clearing those
 * columns is a write-path change to the approval route and is its own ticket.
 *
 * ── AND KEYED ON THE PAYMENT COLUMNS, NOT ON THE SNAPSHOT ─────────────────
 *
 * `markPaid`'s paid-after-release branch records real money on `declined`,
 * `cancelled` and `payment_expired` rows without touching the amount columns.
 * Hanging this off the settled panel's condition would leave a corner where
 * money arrived and no screen said so — which is the defect, surviving its own
 * fix.
 */
export function paymentReceipt(
  row: Pick<
    Appointment,
    'payment_status' | 'payment_method' | 'paid_at' | 'interac_marked_by' | 'interac_marked_at'
  >,
): { line: string; at: Date | null } | null {
  if (row.payment_status !== 'paid' || row.payment_method === null) return null;

  // Exhaustive over the four non-null methods rather than a switch with a
  // default: a fifth must be a typecheck error here, not a blank line on the
  // screen the office reads during a dispute. (Null is the early return above.)
  const LINES: Record<NonNullable<Appointment['payment_method']>, string> = {
    stripe: 'Paid by card',
    // A HUMAN CLAIM ABOUT MONEY, and it reads differently on purpose. BK-32
    // recorded an author for this one precisely because no inbox is parsed and
    // nothing is auto-matched — somebody looked at a bank notification and said
    // so. The actor is optional on the column, so a missing one degrades to the
    // passive rather than printing "by null".
    interac: row.interac_marked_by
      ? `Marked paid by ${row.interac_marked_by} — e-Transfer`
      : 'Marked paid — e-Transfer',
    none: 'Approved at no charge',
    // Pre-prepay rows. Named rather than hidden: "paid on site" is a real thing
    // that happened, and blank would read as unpaid.
    onsite: 'Paid on site — before prepay',
  };

  return {
    line: LINES[row.payment_method],
    at: row.payment_method === 'interac' ? (row.interac_marked_at ?? row.paid_at) : row.paid_at,
  };
}
