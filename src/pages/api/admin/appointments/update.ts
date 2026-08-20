import type { APIRoute } from 'astro';

export const prerender = false;

import {
  ADMIN_APPOINTMENTS_PATH,
  adminAppointmentPath,
} from '../../../../lib/booking-admin';
import { parseAppointmentUpdate } from '../../../../lib/booking-admin-entry';
import {
  inviteEventFromAppointment,
  planCalendarInvite,
  planCancellationEmail,
  planRestoreEmail,
  planFirstConfirmationEmail,
} from '../../../../lib/booking-admin-notify';
import { POST_COMMIT_BUDGET_MS } from '../../../../lib/booking-config';
import type { IcsKind } from '../../../../lib/booking-ics';
import { sendCalendarInvite, withDeadline } from '../../../../lib/booking-notify';
import {
  AWAITING_PAYMENT_STATUSES,
  AWAITING_REVIEW_STATUSES,
  couldHoldCalendarInvite,
  DECISION_ENTRY_STATUSES,
  INVITE_HOLDING_STATUSES,
} from '../../../../lib/booking-status';
import { getDb, SERVICE_LABELS, type AppointmentStatus } from '../../../../lib/db';

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
                   OR appointments.paid_at IS NOT NULL
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
    await sendBoundaryMail(rows[0], new Date());

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
 * The mail a status edit owes: the office's calendar artifact, and — since
 * BK-16 — the customer's written notice carrying their own copy of it.
 *
 * THE RULE IS THE INVITE BOUNDARY, not the status names — and BK-23 is what
 * made that distinction load-bearing rather than pedantic.
 *
 * It used to be the CANCELLED boundary, keyed on the literal `'cancelled'`,
 * because that was the only status a booking could leave the calendar through.
 * P9 added two more: a `confirmed` row can now be edited to `payment_expired`
 * or `declined`, and under the old rule each of those would have left a live
 * invite on two calendars with nothing to clear it.
 *
 * So the question is asked of the STATUSES rather than of one name: did the old
 * status hold an invite, and does the new one? Crossing that boundary outward
 * sends a CANCEL; crossing it inward sends a fresh REQUEST — same UID, and a
 * SEQUENCE strictly greater because it comes from a later clock. Everything
 * else sends nothing: a re-submit that keeps the status, and the ordinary
 * `confirmed → completed` / `confirmed → no_show` edits, which do not change
 * whether a crew is expected somewhere.
 *
 * `couldHoldCalendarInvite` is deliberately not "is it live" — invites issue at
 * payment-confirmed, so `pending_review` and `approved_awaiting_payment` never
 * had one, and moving between those and `declined` correctly sends nothing.
 *
 * A 23505 never reaches here — the statement threw, and the row is untouched.
 *
 * **ONE DEADLINE OVER BOTH SENDS, RUN CONCURRENTLY.** Two serial
 * `POST_COMMIT_BUDGET_MS` windows would stack on a request that has already run
 * an UPDATE, and the platform's function limit is what a stacked pair blows
 * through — the same reasoning the admin entry route states for its own
 * `Promise.all`. The two cannot collapse into one another at Resend either:
 * they share a per-transition idempotency prefix but go to different addresses,
 * and the sender appends `:<to>`.
 *
 * **Cannot fail its caller.** The status edit has already committed; neither a
 * calendar artifact nor a courtesy email may turn it into a `?saved=error` for
 * a change that saved.
 */
async function sendBoundaryMail(row: UpdatedRow, now: Date): Promise<void> {
  // Cast rather than validate: these came out of a CHECK-constrained column,
  // and `parseAppointmentUpdate` already refused anything outside the set on
  // the way in.
  const hadInvite = couldHoldCalendarInvite(row.prev_status as AppointmentStatus);
  const hasInvite = couldHoldCalendarInvite(row.next_status as AppointmentStatus);
  if (hadInvite === hasInvite) return;

  const kind: IcsKind = hadInvite ? 'cancel' : 'request';

  try {
    const event = inviteEventFromAppointment(
      row,
      SERVICE_LABELS[row.service] ?? row.service,
    );

    // The resend route's guard, and for the same reason: a column that is
    // present but blank is not an address, and handing `''` to Resend is a
    // failed send rather than a skip.
    const email = typeof row.email === 'string' && row.email.trim() !== '' ? row.email : null;

    const sends: Promise<[string, 'sent' | 'skipped' | 'failed']>[] = [
      sendCalendarInvite(planCalendarInvite(event, kind, now), {
        id: row.id,
        kind,
        now,
        audience: 'office',
      }).then((outcome) => ['office', outcome] as [string, 'sent' | 'skipped' | 'failed']),
    ];

    if (email) {
      // THREE messages across this boundary, not two.
      //
      // Before BK-23 the only inward crossing was `cancelled -> booked`, so
      // "restored" described every one of them. P9 made more crossings
      // reachable, and this block used to justify itself by saying the status
      // dropdown was "currently the ONLY route to `confirmed`" because
      // `createCheckoutUrl` returned null until BK-32. That was true when
      // written and false the day BK-32 shipped — and it is what left the hole
      // BK-44 closed looking like a considered decision.
      //
      // WHAT IS TRUE NOW, stated carefully, because the sentence this replaces
      // was true when written and false when read. `markPaid` is the only route
      // that confirms an UNPAID booking — card, Interac and free-approval
      // alike — and the dropdown cannot create `confirmed` for a row that has
      // never been paid. It CAN still produce it for one that has: a paid row
      // restored from `cancelled`, or from `declined` / `payment_expired` where
      // the money arrived late and stamped `paid_at` without moving the status.
      // Those are the inward crossings that still reach this code. Movement
      // between `confirmed`, `completed` and `no_show` crosses nothing.
      //
      // So the restore copy is still the wrong thing to send to most of them:
      // it tells a customer their assessment "was cancelled and has now been
      // reinstated", which is a claim only a row that was actually cancelled
      // has earned.
      //
      // The question is asked of where the row CAME FROM, because that is what
      // the word "reinstated" is a claim about. Only `cancelled` earns it.
      const message =
        kind === 'cancel'
          ? planCancellationEmail(event, email, now)
          : row.prev_status === 'cancelled'
            ? planRestoreEmail(event, email, now)
            : planFirstConfirmationEmail(event, email, now);
      sends.push(
        sendCalendarInvite(message, { id: row.id, kind, now, audience: 'customer' }).then(
          (outcome) => ['customer', outcome] as [string, 'sent' | 'skipped' | 'failed'],
        ),
      );
    }

    const outcomes = await withDeadline(
      Promise.all(sends),
      POST_COMMIT_BUDGET_MS,
      // The deadline's answer, one entry per send that was attempted. Wrong in
      // the safe direction: the log says nothing went out rather than claiming
      // something did.
      sends.map((_, i) => [i === 0 ? 'office' : 'customer', 'failed'] as [string, 'failed']),
    );

    for (const [audience, outcome] of outcomes) {
      if (outcome === 'failed') {
        console.error(`Admin update ${row.id}: the ${audience} calendar ${kind} did not send.`);
      }
    }
  } catch (err) {
    console.error(`Admin update ${row.id} calendar ${kind} failed:`, err);
  }
}

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
