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
} from '../../../../lib/booking-admin-notify';
import { POST_COMMIT_BUDGET_MS } from '../../../../lib/booking-config';
import type { IcsKind } from '../../../../lib/booking-ics';
import { sendCalendarInvite, withDeadline } from '../../../../lib/booking-notify';
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
 * No transition is otherwise restricted. The office corrects its own mistakes
 * — completed back to booked, no-show back to booked — and restricting that
 * would mean SQL for every slip.
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

  const { id, status, pipeline_stage, admin_notes } = parsed.update;
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
  const nextStatus = status ?? null;
  const now = new Date().toISOString();

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
      RETURNING appointments.status AS next_status,
                old.prev_status, old.id, old.name, old.phone, old.email,
                old.address, old.city, old.postal_code, old.service,
                old.slot_start
    `) as UpdatedRow[];

    // No row: the id is well-formed but nothing has it. Same answer the detail
    // page gives — send them to the list rather than to a 404 they cannot act
    // on.
    if (rows.length === 0) return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=missing`);

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
 * THE RULE IS THE CANCELLED BOUNDARY, not the status names. Into `cancelled`
 * from anything sends a CANCEL; out of `cancelled` to anything sends a fresh
 * REQUEST — same UID, and a SEQUENCE that is strictly greater because it comes
 * from a later clock. Everything else sends nothing: a re-submit that keeps the
 * status (the office fixing a typo in the notes on a cancelled row), and the
 * ordinary `booked → completed` / `booked → no_show` edits, which do not change
 * whether a crew is expected somewhere.
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
  const wasCancelled = row.prev_status === 'cancelled';
  const isCancelled = row.next_status === 'cancelled';
  if (wasCancelled === isCancelled) return;

  const kind: IcsKind = isCancelled ? 'cancel' : 'request';

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
      const message =
        kind === 'cancel'
          ? planCancellationEmail(event, email, now)
          : planRestoreEmail(event, email, now);
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
