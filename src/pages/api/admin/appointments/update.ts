import type { APIRoute } from 'astro';

export const prerender = false;

import {
  ADMIN_APPOINTMENTS_PATH,
  adminAppointmentPath,
} from '../../../../lib/booking-admin';
import { parseAppointmentUpdate } from '../../../../lib/booking-admin-entry';
import { sendBoundaryMail } from '../../../../lib/booking-admin-notify';
import {
  AWAITING_PAYMENT_STATUSES,
  AWAITING_REVIEW_STATUSES,
  DECISION_ENTRY_STATUSES,
  INVITE_HOLDING_STATUSES,
  REFUNDED_PAYMENT_STATUSES,
} from '../../../../lib/booking-status';
import { getDb, SERVICE_LABELS } from '../../../../lib/db';

/** Postgres unique_violation. The partial index on `slot_start` is what raises it. */
const UNIQUE_VIOLATION = '23505';

/**
 * Edit status, pipeline stage and office notes. Nothing else is updatable.
 *
 * `slot_start` is absent from the whitelist on purpose: rescheduling is cancel
 * + re-enter, which the unique index already handles correctly, where a
 * slot-moving UPDATE would need its own conflict story for no operational gain
 * at one crew and five slots a day. `duration_minutes` is absent because the
 * locked `= 30` CHECK is what makes an identical-start-time index a sufficient
 * double-booking guard.
 *
 * THE INTERESTING CASE IS UN-CANCELLING. A cancelled row is outside the partial
 * unique index, so its slot may have been rebooked since. Flipping it back to
 * `booked` puts it back inside the index and can collide.
 *
 * The database is the arbiter, not a SELECT first — reading "is the slot free"
 * before the UPDATE is the check-then-act race this system already closed once.
 * The UPDATE runs, and a 23505 is caught and translated into a message. The
 * statement rolls back whole, so a stage or notes edit submitted alongside the
 * status flip is discarded with it; the message says nothing was saved rather
 * than implying a partial write.
 *
 * TRANSITIONS ARE RESTRICTED, AND THE RULE IS `editorMaySetStatus` (BK-44).
 * This paragraph used to read "No transition is otherwise restricted", which
 * documented a hole as a feature: `review.ts` was split out of this file so the
 * editor's dropdown could not perform a review decision, and nothing here
 * enforced the split. Approving with no amount, no deadline and no email was
 * one selection away, and so was mailing a confirmation and a calendar invite
 * for a job nobody had paid for.
 *
 * The rule lives in `booking-status.ts` because the dropdown and this guard
 * must not be able to disagree. It is transcribed into the WHERE clause below
 * rather than evaluated here: a function cannot be called from inside a
 * statement, and reading the row first to decide is the check-then-act shape
 * this file refuses everywhere else. `verify-booking-admin-db.ts` pins the
 * transcription against the function across the whole state space, driven
 * through this endpoint.
 *
 * What the office KEEPS is the correction it actually makes — completed back to
 * confirmed, no-show back to confirmed, and cancel from anywhere. Those move
 * within the invite-holding set or out of it, cross no boundary inward, and are
 * exactly the slips restricting transitions must not cost SQL to undo.
 */
export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=invalid`);
  }

  const parsed = parseAppointmentUpdate(Object.fromEntries(form));
  if (!parsed.ok) {
    // The id may be the thing that failed, so there may be no detail page to
    // return to. The list is always a valid destination.
    const id = form.get('id');
    const back =
      typeof id === 'string' && /^[1-9][0-9]{0,9}$/.test(id)
        ? `${adminAppointmentPath(Number(id))}?saved=invalid`
        : `${ADMIN_APPOINTMENTS_PATH}?saved=invalid`;
    return redirect(back);
  }

  const { id, status, pipeline_stage, admin_notes, assessment_tier } = parsed.update;
  const detail = adminAppointmentPath(id);

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Admin update could not reach the database:', err);
    return redirect(`${detail}?saved=error`);
  }

  // Absent fields are left alone rather than nulled. `admin_notes` cannot use
  // COALESCE for that — clearing the notes is a legitimate write of NULL — so
  // it takes a `CASE WHEN <boolean>` on whether the field was submitted at all,
  // the same untyped-boolean-parameter shape `stampNotifications` already uses
  // against this driver.
  const notesProvided = admin_notes !== undefined;
  // Same shape, same reason (BK-31): the select's empty option is a legitimate
  // write of NULL — the office un-choosing a tier — which COALESCE cannot
  // express.
  const tierProvided = assessment_tier !== undefined;
  const nextStatus = status ?? null;
  const now = new Date().toISOString();

  // The transition rule's status sets, bound as parameters (BK-44).
  //
  // Spread into mutable arrays for the driver, and DERIVED rather than typed
  // out: `INVITE_HOLDING_STATUSES` comes from `couldHoldCalendarInvite`, and
  // the two singletons come from `isAwaitingPayment` / `isAwaitingReview`. A
  // status literal retyped into a query string is the drift this rule exists to
  // prevent, so there is none below.
  //
  // A BOUND PARAMETER IS FINE HERE, unlike `SLOT_HOLD_PREDICATE`, and the
  // difference is worth stating because the two sit in the same file's mental
  // model: that one is a string only because an `ON CONFLICT` arbiter cannot be
  // parameterised without 42P10. This is an ordinary WHERE with no arbiter.
  const decisionEntry = [...DECISION_ENTRY_STATUSES];
  const inviteHolding = [...INVITE_HOLDING_STATUSES];
  const awaitingPayment = [...AWAITING_PAYMENT_STATUSES];
  const awaitingReview = [...AWAITING_REVIEW_STATUSES];
  // BK-33. Derived, like the four above, so the rule and the transcription
  // cannot disagree about which values mean "the money went back".
  const refundedStatuses = [...REFUNDED_PAYMENT_STATUSES];

  try {
    // ONE STATEMENT, WITH A SELF-JOIN AGAINST A PRE-UPDATE SNAPSHOT, and the
    // shape is load-bearing rather than clever. BK-14 has to know whether this
    // edit CROSSED the cancelled boundary — a re-submit of `cancelled` sends
    // nothing, an actual cancellation sends a CANCEL — and `RETURNING id`
    // cannot tell those apart, while a SELECT before the UPDATE is the
    // check-then-act race the docstring above rules out. The subquery is
    // evaluated against the snapshot the statement began with, so `prev_status`
    // is the value before this UPDATE and there is no window between the two.
    //
    // The same round trip also carries every column the invite needs. They are
    // all outside the whitelist and therefore unchanged by this UPDATE, so
    // reading them from the snapshot is the same value as reading them after.
    const rows = (await sql`
      UPDATE appointments
      SET status         = COALESCE(${nextStatus}::text, status),
          pipeline_stage = COALESCE(${pipeline_stage ?? null}::text, pipeline_stage),
          admin_notes    = CASE WHEN ${notesProvided}
                             THEN ${admin_notes ?? null}::text ELSE admin_notes END,
          assessment_tier = CASE WHEN ${tierProvided}
                             THEN ${assessment_tier ?? null}::text ELSE assessment_tier END,
          -- Entering cancelled stamps the clock; leaving it clears the stamp;
          -- re-submitting cancelled keeps the ORIGINAL time, because the bare
          -- \`status\` on the right-hand side is still the pre-UPDATE value.
          cancelled_at   = CASE
                             WHEN ${nextStatus}::text IS NULL THEN cancelled_at
                             WHEN ${nextStatus}::text = 'cancelled'
                               THEN CASE WHEN status = 'cancelled'
                                      THEN cancelled_at ELSE ${now}::timestamptz END
                             ELSE NULL
                           END,
          updated_at     = ${now}::timestamptz
      FROM (
        SELECT id, status AS prev_status, name, phone, email, address, city,
               postal_code, service, slot_start
        FROM appointments
        WHERE id = ${id}
      ) old
      WHERE appointments.id = old.id
        -- THE TRANSITION GUARD (BK-44), transcribed from editorMaySetStatus.
        -- Reading appointments.* here reads the PRE-UPDATE row, which is the
        -- same snapshot old was built from, so the guard and the mail
        -- boundary below judge one state.
        AND (
              -- No status edit at all: a stage, notes or tier save.
              ${nextStatus}::text IS NULL
              -- Re-submitting the current status is not a transition.
           OR ${nextStatus}::text = appointments.status
           OR (
                    -- Never conjure a status a decision route owns entry to.
                    ${nextStatus}::text <> ALL(${decisionEntry}::text[])
                -- Crossing INTO the invite-holding set needs a payment. Asked
                -- only of rows arriving from outside it, so movement within is
                -- free and pre-prepay rows (008 renamed them, 010 never
                -- backfilled paid_at) stay correctable.
                AND (
                      ${nextStatus}::text <> ALL(${inviteHolding}::text[])
                   OR appointments.status = ANY(${inviteHolding}::text[])
                   OR (
                        appointments.paid_at IS NOT NULL
                        -- BK-33. AND THE MONEY MUST STILL BE OURS. paid_at is
                        -- never cleared, so on its own it said yes to a booking
                        -- that was paid, refunded and cancelled — which this
                        -- dropdown would then have un-cancelled straight back
                        -- to confirmed, dispatching a crew and mailing a fresh
                        -- REQUEST ics on returned money.
                        --
                        -- Keyed on payment_status, NOT on refunded_at: nothing
                        -- clears the latter, so a booking refunded, re-approved
                        -- and genuinely re-paid would be barred here forever.
                        -- payment_status is the column the payment path
                        -- maintains.
                        AND appointments.payment_status <> ALL(${refundedStatuses}::text[])
                      )
                )
                -- An approved row is markPaid's to confirm. paid_at survives
                -- from a previous cycle, so it cannot tell this approval's
                -- money from the last one's.
                AND NOT (
                      appointments.status = ANY(${awaitingPayment}::text[])
                  AND ${nextStatus}::text = ANY(${inviteHolding}::text[])
                )
                -- rollBack's rule: never walk an approval backwards while its
                -- payment link is still live.
                AND NOT (
                      appointments.status = ANY(${awaitingPayment}::text[])
                  AND ${nextStatus}::text = ANY(${awaitingReview}::text[])
                  AND appointments.stripe_session_id IS NOT NULL
                )
              )
        )
      RETURNING appointments.status AS next_status,
                old.prev_status, old.id, old.name, old.phone, old.email,
                old.address, old.city, old.postal_code, old.service,
                old.slot_start
    `) as UpdatedRow[];

    // ZERO ROWS NOW MEANS TWO DIFFERENT THINGS (BK-44). Before the transition
    // guard it could only be "no such id"; it is now also "that transition is
    // not this control's to make", and an office member told a booking does not
    // exist when it does would go looking for a database problem.
    //
    // THE READ BELOW IS NOT CHECK-THEN-ACT. Nothing was written — the statement
    // matched no row and rolled back whole — so there is no window between a
    // decision and an action, only a message to choose. `markPaid` distinguishes
    // its own no-op arms the same way and for the same reason.
    if (rows.length === 0) {
      let exists: { id: number }[];
      try {
        exists = (await sql`SELECT id FROM appointments WHERE id = ${id}`) as { id: number }[];
      } catch (err) {
        // The write already failed and we cannot say why. Wrong in the safe
        // direction: report an error rather than claim a refusal we did not
        // establish.
        console.error(`Admin update ${id}: could not tell missing from refused:`, err);
        return redirect(`${detail}?saved=error`);
      }
      if (exists.length === 0) return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=missing`);
      return redirect(`${detail}?saved=blocked`);
    }

    // Best-effort, and awaited: post-response work is not guaranteed to run on
    // this platform. Nothing below changes the redirect — the office is
    // standing at the screen having just cancelled something, and a failed
    // invite is a line in the function log plus an event they delete by hand,
    // not a UI state worth inventing. The customer half added in BK-16 is held
    // to the same posture: a cancellation email that did not go out is a phone
    // call the office was going to make anyway.
    // The label, not the key — `sendBoundaryMail` takes an injected label so
    // that `booking-admin-notify.ts` stays free of `db.ts`'s runtime imports
    // and therefore reachable from a `tsx` verify script. Same lookup this
    // route did before the function moved.
    await sendBoundaryMail(
      { ...rows[0], service_label: SERVICE_LABELS[rows[0].service] ?? rows[0].service },
      new Date(),
    );

    return redirect(`${detail}?saved=1`);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Un-cancelling into a slot somebody else now holds. The row is
      // untouched — the whole statement rolled back.
      console.error(`Admin update ${id} lost the slot race:`, err);
      return redirect(`${detail}?saved=conflict`);
    }
    console.error(`Admin update ${id} failed:`, err);
    return redirect(`${detail}?saved=error`);
  }
};

/**
 * What the statement above returns: the new status, and the old row beside it.
 *
 * `email` joined the snapshot in BK-16 for the customer's copy. It is outside
 * the SET whitelist like every other column here, so the pre-UPDATE value IS
 * the post-UPDATE value — reading it from the snapshot costs no second query
 * and cannot be stale.
 */
type UpdatedRow = {
  next_status: string;
  prev_status: string;
  id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string;
  city: string;
  postal_code: string | null;
  service: string;
  /** `timestamptz` — the driver returns a `Date`. */
  slot_start: Date;
};

/**
 * `NeonDbError` carries the SQLSTATE. Read off the installed driver rather than
 * assumed: `@neondatabase/serverless@1.1.0`'s HTTP path, on a 400 response,
 * copies `severity, code, detail, hint, …` from the JSON body onto a fresh
 * `NeonDbError` and throws it (`index.mjs`, the `status === 400` branch). So
 * `.code` is populated over HTTP the way it is over the socket.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
