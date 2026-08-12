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
 * OFFERED AND ACCEPTED ONLY FOR `booked` ROWS WITH AN EMAIL ADDRESS. The button
 * is hidden otherwise, and this route re-checks rather than trusting that —
 * a cancelled or no-show appointment must not receive a fresh "You're booked"
 * for a time that may since belong to somebody else. Re-checking matters
 * because the row can change between the page render and the click.
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
             (SELECT COUNT(*)::int FROM appointment_files f WHERE f.appointment_id = a.id)
               AS file_count
      FROM appointments a
      WHERE a.id = ${id}
    `) as (Appointment & { file_count: number })[];

    const appointment = rows[0];
    if (!appointment) return redirect(`${ADMIN_APPOINTMENTS_PATH}?saved=missing`);

    const hasEmail = typeof appointment.email === 'string' && appointment.email.trim() !== '';
    if (appointment.status !== 'booked' || !hasEmail) {
      return redirect(`${detail}?email=refused`);
    }

    const plan = planForAppointment(
      appointment,
      SERVICE_LABELS[appointment.service] ?? appointment.service,
      // Reaches only the ICS on `plan.internal`, which this route never
      // delivers — see `planForAppointment`. A real clock rather than a
      // placeholder for the same reason the file count is real.
      new Date(),
      appointment.file_count,
    );
    const outcome = await sendConfirmationAndStamp(sql, plan);
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
