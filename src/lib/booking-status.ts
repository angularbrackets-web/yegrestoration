/**
 * The booking lifecycle: what states exist, and which of them hold a slot.
 *
 * Pure and env-free, so the migration, the API routes, the admin pages and a
 * `tsx` verify script all read the same definitions.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ──────────────────────────────────────────
 *
 * Before BK-23 the slot-hold rule was the literal `status <> 'cancelled'`,
 * written out by hand in eight places: the index, `insertBooking`'s
 * `ON CONFLICT`, the availability query, the commit precheck, and four verify
 * scripts. P9 widens it to three releasing statuses, and a widening that has to
 * be applied identically in eight places by hand is a widening that will be
 * applied in seven.
 *
 * One of those eight is not like the others. **Postgres resolves an
 * `ON CONFLICT ... WHERE` arbiter by matching it against the index predicate,
 * and a mismatch is error 42P10 on EVERY booking** — public and admin, the
 * whole funnel, at once. So the index predicate and the arbiter predicate are
 * now generated from the same string rather than typed twice.
 */

/**
 * ── THE STATES ─────────────────────────────────────────────────────────────
 *
 * `booked` is GONE, renamed to `confirmed` by migration 008. Under prepay,
 * "booked" was the word for the thing that had not happened yet: a request
 * looks booked to the customer and is unpaid to us. Keeping the old value
 * alongside the new ones would have invited exactly the confusion the flow
 * exists to remove.
 *
 * `pipeline_stage` remains an independent column. A job can be
 * `restoration` + `confirmed`, or `assessment` + `no_show`. Neither derives
 * from the other.
 */
export type AppointmentStatus =
  /** Submitted online, waiting for the office to approve or decline. */
  | 'pending_review'
  /** Approved; the customer has a payment link and a deadline. */
  | 'approved_awaiting_payment'
  /** Paid. The only state in which a crew is dispatched or an invite issued. */
  | 'confirmed'
  /** The visit happened. */
  | 'completed'
  /** The visit did not happen and the slot was consumed anyway. */
  | 'no_show'
  /** The office said no. */
  | 'declined'
  /** Approved but never paid by the deadline. */
  | 'payment_expired'
  /** Called off after confirmation, by either side. */
  | 'cancelled';

/** Declaration order is the order the admin dropdown renders. */
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'pending_review',
  'approved_awaiting_payment',
  'confirmed',
  'completed',
  'no_show',
  'declined',
  'payment_expired',
  'cancelled',
];

export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * ── WHICH STATUSES RELEASE THE SLOT ────────────────────────────────────────
 *
 * A DENY-LIST, DELIBERATELY, AND THE DIRECTION IS THE POINT.
 *
 * Under a deny-list, a status added later and forgotten *holds* its slot. The
 * failure is a slot that looks busy — somebody notices, phones in, and books it
 * by hand. Under an allow-list, the same omission silently *releases*, and the
 * failure is two crews at one address on a job the customer has already paid
 * for. One of those is a nuisance and the other is the worst outcome this
 * system has.
 *
 * This is the kind of reasoning a later tidy-up reverses on the grounds that an
 * allow-list "reads better", which is why it is written here and repeated in
 * the migration.
 *
 * `completed` and `no_show` HOLD. Both are past visits: releasing them would
 * let a new booking overwrite history at that instant.
 */
export const SLOT_RELEASING_STATUSES: readonly AppointmentStatus[] = [
  'cancelled',
  'declined',
  'payment_expired',
];

/** The complement — every status that keeps its slot off the market. */
export const SLOT_HOLDING_STATUSES: readonly AppointmentStatus[] = APPOINTMENT_STATUSES.filter(
  (s) => !SLOT_RELEASING_STATUSES.includes(s),
);

/**
 * THE canonical slot-hold predicate, as SQL text.
 *
 * **Every consumer interpolates this, none retypes it** — the partial unique
 * index in migration 008, `insertBooking`'s `ON CONFLICT` arbiter, the
 * availability query, the commit precheck, and the verify scripts. Composed
 * into a query with `sql.unsafe(SLOT_HOLD_PREDICATE)`, which the Neon driver
 * inlines as raw SQL rather than binding as a parameter.
 *
 * A PARAMETER WOULD NOT WORK FOR THE ARBITER, and that is the reason this is a
 * string rather than the obvious `status <> ALL($1::text[])`. Postgres picks
 * the arbiter index by proving the index predicate implies the `ON CONFLICT`
 * predicate, and it cannot prove anything about a value that is not known until
 * execution. A parameterised arbiter is 42P10 on every booking.
 *
 * Built from `SLOT_RELEASING_STATUSES` rather than written out, so the list and
 * the predicate cannot disagree. The values are a closed set of identifiers
 * defined in this file — nothing user-supplied reaches it — but they are quoted
 * through a helper anyway, because "no untrusted input can reach this string"
 * is a property of today's code rather than of the string itself.
 */
export const SLOT_HOLD_PREDICATE = `status NOT IN (${SLOT_RELEASING_STATUSES.map(
  (s) => `'${s.replace(/'/g, "''")}'`,
).join(', ')})`;

/** The index this predicate belongs to. Named so the migration and any drift check agree. */
export const SLOT_UNIQUE_INDEX = 'appointments_slot_unique';

/**
 * ── LIFECYCLE PREDICATES ───────────────────────────────────────────────────
 */

/** A request the office has not yet ruled on. */
export function isAwaitingReview(status: AppointmentStatus): boolean {
  return status === 'pending_review';
}

/** Approved, unpaid, and still inside its deadline as far as the status knows. */
export function isAwaitingPayment(status: AppointmentStatus): boolean {
  return status === 'approved_awaiting_payment';
}

/**
 * Whether a calendar invite was ever issued for this row.
 *
 * Invites issue at payment-confirmed and nowhere else (P9), so a row that has
 * never been `confirmed` has nothing to CANCEL. `declined` and
 * `payment_expired` are reachable only from before that point, which is what
 * makes their CANCEL branches no-ops **by construction** rather than by
 * someone remembering.
 *
 * `cancelled` is the case that is NOT a no-op: it is reachable from
 * `confirmed`, where an invite does exist.
 */
export function couldHoldCalendarInvite(status: AppointmentStatus): boolean {
  return status === 'confirmed' || status === 'completed' || status === 'no_show';
}

/**
 * Statuses that still need somebody to do something before the slot arrives.
 *
 * This is the office's "today" list, and it is deliberately WIDER than
 * `confirmed`: a request nobody has reviewed and an approval nobody has paid
 * are both work, and both have a deadline attached. Showing only confirmed
 * visits would hide every unreviewed request from the one screen the office
 * works from.
 *
 * Distinct from `SLOT_HOLDING_STATUSES`, which also contains `completed` and
 * `no_show` — those hold their slot precisely because they are finished.
 */
export const LIVE_STATUSES: readonly AppointmentStatus[] = [
  'pending_review',
  'approved_awaiting_payment',
  'confirmed',
];

/** Human labels for the admin dropdown and the detail page. */
export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending_review: 'Pending review',
  approved_awaiting_payment: 'Approved — awaiting payment',
  confirmed: 'Confirmed',
  completed: 'Completed',
  no_show: 'No show',
  declined: 'Declined',
  payment_expired: 'Expired — not paid',
  cancelled: 'Cancelled',
};
