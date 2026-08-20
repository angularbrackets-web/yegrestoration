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
 * never been `confirmed` has nothing to CANCEL.
 *
 * `declined` and `payment_expired` were described here as no-ops **by
 * construction**, on the grounds that both are reachable only from before an
 * invite exists. THAT IS NOT TRUE and has not been since P9: `update.ts`
 * permits `confirmed -> payment_expired` and `confirmed -> declined`, and its
 * own docstring says so — those are outward crossings that correctly send a
 * CANCEL. The branches are no-ops for rows that never held an invite and live
 * for rows that did, which is what keying on the boundary rather than on the
 * status names buys.
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

/**
 * ── WHICH TRANSITIONS THE OFFICE'S EDITOR MAY MAKE (BK-44) ─────────────────
 *
 * `update.ts` is a whitelist editor and `review.ts` was split out of it so that
 * the editor's status dropdown could not perform a review decision. That split
 * was never enforced: the dropdown rendered all eight statuses and the route
 * guarded none of them, so approving a booking with no amount, no deadline and
 * no email was one selection away — and so was mailing a customer a
 * confirmation and a calendar invite for a job nobody had paid for.
 *
 * This is the rule that closes it, and it lives HERE rather than in either
 * consumer because the dropdown and the route guard must not be able to
 * disagree. The same reason `APPOINTMENT_STATUSES` is re-exported by
 * `booking-admin-entry.ts` rather than retyped.
 *
 * ── THE RULE IS ABOUT THE INVITE BOUNDARY, NOT ABOUT `confirmed` ───────────
 *
 * The obvious rule — "the dropdown may never write `confirmed`" — does not
 * work, and the way it fails is the whole reason this comment is long.
 *
 * `couldHoldCalendarInvite` is `confirmed || completed || no_show`, and
 * `update.ts` mails on the BOUNDARY rather than on the status name. So setting
 * an unpaid `pending_review` row to `completed` crosses inward just as surely:
 * `hadInvite` false, `hasInvite` true, and the customer receives
 * `planFirstConfirmationEmail` — "Your assessment is confirmed" — with an ICS
 * REQUEST attached, for a job nobody paid for. Guarding `confirmed` alone would
 * have left two more doors into the same room.
 *
 * ── AND `paid_at` IS ASKED ONLY OF ROWS CROSSING IN ────────────────────────
 *
 * Movement WITHIN the invite-holding set is free. No boundary is crossed, no
 * mail is owed, and `update.ts`'s docstring names those edits as the ones the
 * office must keep — "completed back to booked, no-show back to booked".
 *
 * That is also what makes this safe for rows that predate prepay. Migration 008
 * renamed `booked -> confirmed` against live rows; `paid_at` did not exist
 * until 010 and was never backfilled, so **every pre-P9 row is `confirmed` with
 * a NULL `paid_at`**. A rule that asked `paid_at` of every write to `confirmed`
 * would refuse to correct a legacy no-show back to confirmed, and `review.ts`
 * could not recover it either — its guards all start at `pending_review`. An
 * over-tight map is worse than the hole, because the office works around it and
 * the workaround is recorded nowhere.
 *
 * The residual is accepted and small: a legacy row that is CANCELLED must cross
 * back in, has no `paid_at`, and is refused. Every such row is a past
 * appointment, so un-cancelling one is not a workflow.
 *
 * ── AND ONE MORE DOOR, IN THE OTHER DIRECTION ──────────────────────────────
 *
 * `review.ts`'s `rollBack` refuses to walk an approval back to `pending_review`
 * while a Checkout Session is live, because "the link would still be payable
 * against a `pending_review` row that `markPaid` would refuse". The dropdown
 * could do exactly that, and `markPaid`'s paid-after-released branch does not
 * cover `pending_review`, so the money could land with nothing raised at all.
 * The same guard is applied here rather than left to a later ticket: a map that
 * ships as "the legal transitions" must not bless a money-loss path.
 */

/** Whether a status is one of the three that could hold a calendar invite. */
export const INVITE_HOLDING_STATUSES: readonly AppointmentStatus[] =
  APPOINTMENT_STATUSES.filter(couldHoldCalendarInvite);

/**
 * The statuses an office member may not conjure with a dropdown, because
 * entering them is a decision route's job and carries obligations a status
 * write cannot discharge.
 *
 * `approved_awaiting_payment` is `review.ts`'s: it snapshots four amounts,
 * computes a deadline, mints a Checkout Session and sends a message the
 * customer acts on. `confirmed` is NOT listed here — it is covered by the
 * invite-boundary rule above, which catches `completed` and `no_show` with it.
 *
 * An exhaustive `Record` rather than a hand-written array, and that is the
 * safety property: a ninth member of `AppointmentStatus` is a TYPECHECK ERROR
 * until somebody classifies it. `SLOT_RELEASING_STATUSES` can afford a
 * deny-list because a forgotten status merely holds a slot; a forgotten status
 * here would be a crew dispatched to a job nobody paid for, so the compiler is
 * made to ask.
 */
export const STATUS_ENTRY_OWNER: Record<AppointmentStatus, 'editor' | 'decision'> = {
  pending_review: 'editor',
  approved_awaiting_payment: 'decision',
  confirmed: 'editor',
  completed: 'editor',
  no_show: 'editor',
  declined: 'editor',
  payment_expired: 'editor',
  cancelled: 'editor',
};

/** The complement — what only a decision route may create. */
export const DECISION_ENTRY_STATUSES: readonly AppointmentStatus[] =
  APPOINTMENT_STATUSES.filter((s) => STATUS_ENTRY_OWNER[s] === 'decision');

/**
 * Singletons, derived from the lifecycle predicates rather than written out.
 *
 * They look redundant beside the predicates themselves and they are not: the
 * SQL guard in `update.ts` needs these as VALUES to bind, and typing
 * `'pending_review'` into a query string is exactly the retyping this module
 * exists to prevent. If a second status ever satisfies either predicate, the
 * guard follows it for free.
 */
export const AWAITING_REVIEW_STATUSES: readonly AppointmentStatus[] =
  APPOINTMENT_STATUSES.filter(isAwaitingReview);
export const AWAITING_PAYMENT_STATUSES: readonly AppointmentStatus[] =
  APPOINTMENT_STATUSES.filter(isAwaitingPayment);

/**
 * What the guard needs to know about a row. Deliberately the three columns and
 * nothing else, so a caller cannot accidentally satisfy it with a stale record
 * carrying more than it read.
 */
export type EditorGuardRow = {
  status: AppointmentStatus;
  paid_at: Date | null;
  stripe_session_id: string | null;
};

/**
 * May the office's editor move this row to `next`?
 *
 * THE ONE SOURCE. `update.ts` transcribes this into its WHERE clause — it
 * cannot call a TypeScript function from inside a statement, and reading the
 * row first would be the check-then-act shape that route already refuses — and
 * `scripts/verify-booking-admin-db.ts` pins the two against each other across
 * the whole state space, driven through the endpoint. The dropdown calls it
 * directly.
 */
export function editorMaySetStatus(row: EditorGuardRow, next: AppointmentStatus): boolean {
  // Re-submitting the current status is not a transition. It is what a
  // notes-only or stage-only save posts, and refusing it would make every
  // unrelated edit on an approved row fail.
  if (next === row.status) return true;

  if (DECISION_ENTRY_STATUSES.includes(next)) return false;

  // Crossing INTO the invite-holding set. Asked only of rows arriving from
  // outside it, so movement within is free and legacy rows are unaffected.
  if (couldHoldCalendarInvite(next) && !couldHoldCalendarInvite(row.status)) {
    if (row.paid_at === null) return false;
  }

  // AN APPROVED ROW IS `markPaid`'s TO CONFIRM, and `paid_at` alone cannot say
  // otherwise. Nothing ever clears that column — not `approve`, not `rollBack`,
  // and not the late-payment branch that stamps it on a released row without
  // moving the status — so a row can sit at `approved_awaiting_payment`
  // carrying a PREVIOUS cycle's `paid_at` while a fresh Checkout Session is
  // live and unpaid. The invite-crossing rule above would wave it through.
  //
  // What that costs is everything `markPaid` does and a status write does not:
  // the `payment_status` and amount columns keep describing the old money, the
  // live session is never expired, and the double-payment detection never runs
  // — on a row that then mails "Your assessment is confirmed" and an invite.
  //
  // This is not over-tight. "Mark as paid — Interac" renders for exactly this
  // status, so the sanctioned control is already on the screen beside the
  // dropdown; the office loses nothing but the wrong way to do it.
  if (isAwaitingPayment(row.status) && couldHoldCalendarInvite(next)) return false;

  // `rollBack`'s rule, applied to the editor: never walk an approval backwards
  // while its payment link is still live.
  if (
    isAwaitingPayment(row.status) &&
    isAwaitingReview(next) &&
    row.stripe_session_id !== null
  ) {
    return false;
  }

  return true;
}

/**
 * The options the status dropdown renders, for this row.
 *
 * ALWAYS CONTAINS `row.status`, by construction — `editorMaySetStatus` returns
 * true for it on the first line. That is a contract rather than an incidental
 * property, and it is pinned: a `<select>` that omits its own current value
 * submits the FIRST option instead, so an office member saving a note on an
 * approved booking would silently un-approve it.
 */
export function editorStatusTargets(row: EditorGuardRow): readonly AppointmentStatus[] {
  return APPOINTMENT_STATUSES.filter((next) => editorMaySetStatus(row, next));
}
