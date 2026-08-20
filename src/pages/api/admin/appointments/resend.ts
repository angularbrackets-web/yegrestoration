import type { APIRoute } from 'astro';

export const prerender = false;

import {
  ADMIN_APPOINTMENTS_PATH,
  adminAppointmentPath,
} from '../../../../lib/booking-admin';
import { parseAppointmentId } from '../../../../lib/booking-admin-entry';
import {
  planForAppointment,
  sendConfirmationAndStamp,
} from '../../../../lib/booking-admin-notify';
import { getDb, SERVICE_LABELS, type Appointment } from '../../../../lib/db';

/**
 * Resend the customer confirmation for one appointment. BK-05 deferred this to
 * the admin tickets; this is it.
 *
 * OFFERED AND ACCEPTED ONLY FOR `confirmed` ROWS WITH AN EMAIL ADDRESS. The
 * button is hidden otherwise, and this route re-checks rather than trusting
 * that — a cancelled or no-show appointment must not be told again that its
 * assessment is confirmed for a time that may since belong to somebody else.
 * Re-checking matters because the row can change between the page render and
 * the click.
 *
 * **AND IT RE-SENDS THE MESSAGE THE CUSTOMER ACTUALLY GOT** (BK-45). Until then
 * this button built `customerConfirmation` while the payment path built the
 * calendar-boundary message, so clicking it mailed a materially fuller message
 * under a different heading than the one that arrived when they paid. Both now
 * call `planForAppointment`, so the two are the same message by construction
 * rather than by being kept in step.
 *
 * The customer message and only the customer message: `sendCustomerConfirmation`
 * reads `plan.customer` and nothing else, so no admin action can mail the
 * office.
 */
export const POST: APIRoute = async ({ request }) => {
  // The two failures below have no detail page to return to, so they land on
  // the list — and they use `?saved=`, which is the parameter that page
  // renders. `?email=` is the DETAIL page's flash; sending it to the list would
  // put the office back on a screen with no message at all, having just asked
  // for an email to go out.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=invalid`);
  }

  const id = parseAppointmentId(form.get('id'));
  if (id === null) return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=invalid`);
  const detail = adminAppointmentPath(id);

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Admin resend could not reach the database:', err);
    return redirect(`${detail}?email=failed`);
  }

  try {
    // The file count is carried into the plan for completeness. It reaches only
    // the internal message, which this route never sends — but a plan built
    // with a made-up number is a plan that lies, and the next person to send
    // something else from it would inherit that.
    const rows = (await sql`
      SELECT a.*,
             (SELECT COUNT(*)::int FROM appointment_files f
               WHERE f.appointment_id = a.id
                 -- BK-40. A removed file is not one of this appointment's
                 -- photos. The comment above is why this matters even though
                 -- the count reaches only a message this route never sends:
                 -- the next person to send something else from this plan
                 -- inherits whatever it says.
                 AND f.deleted_at IS NULL)
               AS file_count
      FROM appointments a
      WHERE a.id = ${id}
    `) as (Appointment & { file_count: number })[];

    const appointment = rows[0];
    if (!appointment) return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=missing`);

    // BK-23: `booked` became `confirmed`, and the guard stays NARROW on purpose.
    // This button re-sends the confirmation — the terms, the have-ready list,
    // what was charged and the calendar invite. A `pending_review` or
    // `approved_awaiting_payment` row has not been paid for, so re-sending that
    // message would tell a customer they have an appointment they have not
    // bought — the single claim this whole flow exists to stop making. The other statuses get the payment link or the
    // decline notice through their own paths, not through this one.
    const hasEmail = typeof appointment.email === 'string' && appointment.email.trim() !== '';
    if (appointment.status !== 'confirmed' || !hasEmail) {
      return redirect(`${detail}?email=refused`);
    }

    // ONE CLOCK FOR BOTH USES, AND THE SECOND USE IS WHAT MAKES THIS BUTTON
    // WORK AT ALL (BK-32). It reaches the ICS on `plan.internal`, which this
    // route never delivers — and, since the idempotency prefix gained an
    // attempt component, it is also what makes a SECOND click a different
    // Resend key. Before that, clicking Resend inside Resend's 24-hour window
    // delivered nothing, flashed "sent", and logged nothing — on the one button
    // that exists to recover a message the customer never got.
    const now = new Date();
    const plan = planForAppointment(
      appointment,
      SERVICE_LABELS[appointment.service] ?? appointment.service,
      now,
      appointment.file_count,
    );
    const outcome = await sendConfirmationAndStamp(sql, plan, now);
    // 'skipped' here can only be the mute flag — the gate above already
    // established there is a customer message to send. Reported as "none sent"
    // rather than as a failure, so the office is not sent back to a button
    // that will do nothing either.
    const flash = outcome === 'sent' ? 'sent' : outcome === 'skipped' ? 'off' : 'failed';

    return redirect(`${detail}?email=${flash}`);
  } catch (err) {
    console.error(`Admin resend ${id} failed:`, err);
    return redirect(`${detail}?email=failed`);
  }
};

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
