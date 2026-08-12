import type { APIRoute } from 'astro';

export const prerender = false;

import {
  ADMIN_APPOINTMENT_NEW_PATH,
  adminAppointmentPath,
} from '../../../../lib/booking-admin';
import { parseAdminEntry } from '../../../../lib/booking-admin-entry';
import {
  inviteEventFromPayload,
  planCalendarInvite,
  planForPayload,
  sendConfirmationAndStamp,
} from '../../../../lib/booking-admin-notify';
import { insertBooking } from '../../../../lib/booking-commit';
import { POST_COMMIT_BUDGET_MS } from '../../../../lib/booking-config';
import {
  sendCalendarInvite,
  withDeadline,
  type SendOutcome,
} from '../../../../lib/booking-notify';
import type { BookingPayload } from '../../../../lib/booking-payload';
import { getDb, SERVICE_LABELS } from '../../../../lib/db';

/**
 * Manual entry. The office types a phone-in emergency or a follow-up.
 *
 * Sits behind the middleware by prefix (`/api/admin`), like every other route
 * in this directory — no new public path, and nothing here re-checks auth.
 *
 * Two things it deliberately does NOT do:
 *
 *   - **No window checks.** No 4-hour notice, no 14-day horizon, no closed
 *     Friday, no blackout. Emergencies happen at 08:00 for 11:30 and
 *     follow-ups get booked six weeks out; the ROADMAP's "phone-in and entered
 *     manually" is exactly this bypass. It is expressed by not calling
 *     `isSlotBookable`, so the public path cannot inherit it.
 *   - **No second INSERT.** `insertBooking` is BK-02's statement, conflict
 *     contract and all. A check-then-insert here would reintroduce the race
 *     that the partial unique index closes, on the one table where losing it
 *     means two crews at one address.
 *
 * Every outcome is a 302 back to a GET, so a refresh never resubmits.
 */
export const POST: APIRoute = async ({ request }) => {
  const now = new Date();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(ADMIN_APPOINTMENT_NEW_PATH, { err: 'form' });
  }

  const parsed = parseAdminEntry(Object.fromEntries(form), {
    allowedServices: new Set(Object.keys(SERVICE_LABELS)),
  });

  if (!parsed.ok) {
    // Field NAMES only. Repopulating the form through the query string would
    // put the customer's name, address and insurance identifiers into the URL
    // and from there into platform request logs. The office retypes.
    const fields = [...new Set(parsed.errors.map((e) => e.field))].join(',');
    return back(ADMIN_APPOINTMENT_NEW_PATH, { err: fields });
  }
  const { payload, sendConfirmation, adminNotes } = parsed;

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Admin entry could not reach the database:', err);
    return back(ADMIN_APPOINTMENT_NEW_PATH, { err: 'db' });
  }

  let created: { id: number; files: number } | null;
  try {
    // `null` draft id: manual entries carry no uploads, which degrades the
    // file-claim half of the CTE to a no-op. `'admin'` is what keeps
    // `notificationFlags` from calling this row's missing office notification
    // a failure.
    created = await insertBooking(sql, payload, null, now, 'admin', adminNotes);
  } catch (err) {
    console.error('Admin entry insert failed:', err);
    return back(ADMIN_APPOINTMENT_NEW_PATH, { err: 'db' });
  }

  // Zero rows means ON CONFLICT DO NOTHING fired — the slot is already held by
  // a non-cancelled appointment. The only real double-booking guard there is.
  if (created === null) return back(ADMIN_APPOINTMENT_NEW_PATH, { taken: '1' });

  // Past this point the appointment EXISTS. Nothing below may fail the request.
  // The fallback cannot fire — the parser was handed these very keys — and
  // exists so the two cannot drift into an `undefined` in a subject line.
  const serviceLabel = SERVICE_LABELS[payload.service] ?? payload.service;

  // The two post-commit sends run CONCURRENTLY, each under the same budget,
  // rather than one after the other. Serially they would stack to two full
  // POST_COMMIT_BUDGET_MS windows on a request that has already run an insert,
  // and the platform's function limit is what a stacked pair blows through —
  // the same reasoning `sendBookingNotifications` uses for its `Promise.all`.
  const [emailOutcome, inviteOutcome] = await Promise.all([
    sendConfirmation && payload.email
      ? sendConfirmationAndStamp(
          sql,
          planForPayload(created.id, payload, serviceLabel, now, created.files),
        )
      : Promise.resolve<SendOutcome | null>(null),
    // Independent of the confirmation checkbox on purpose: that box is about
    // the CUSTOMER, and this invite is the office's own calendar. Best-effort —
    // the entry has saved, and a missed invite is an inconvenience the office
    // fixes by adding the event by hand. The flash below does not mention it.
    sendOfficeInvite(created.id, payload, serviceLabel, now),
  ]);

  // `deliver` already logs a failed send with its error. This line is here for
  // the one outcome it cannot see: a send that never settles and is answered by
  // the deadline, which returns 'failed' with nothing written anywhere.
  if (inviteOutcome === 'failed') {
    console.error(`Admin entry ${created.id}: no calendar invite went out.`);
  }

  // 'skipped' is the mute flag, not a failure. Telling the office "it did not
  // send — try again" would send them to a resend button that will also do
  // nothing. Test-only today, since the flag is fail-open and unset in
  // production, but the distinction is free.
  const email: 'sent' | 'failed' | 'off' =
    emailOutcome === null || emailOutcome === 'skipped'
      ? 'off'
      : emailOutcome === 'sent'
        ? 'sent'
        : 'failed';

  // The flash is the immediate surfacing, and it has to be: BK-07's warning
  // flags never fire for `source = 'admin'` rows, so a failed send would
  // otherwise show up nowhere at all. Afterwards the detail page's neutral
  // "None sent" and the resend button are the recovery.
  return redirect(`${adminAppointmentPath(created.id)}?email=${email}`);
};

/**
 * The office's calendar invite for an entry it just typed in.
 *
 * **Cannot fail its caller**, on the same terms as everything else past the
 * insert: the appointment exists, and no calendar artifact may turn a saved
 * entry into a 500 that sends the office to retype it into a slot that is now
 * taken. `sendCalendarInvite` already swallows a resolved error and a throwing
 * client; the deadline covers a send that never settles, and the try/catch
 * covers the plan-building above it.
 */
async function sendOfficeInvite(
  id: number,
  payload: BookingPayload,
  serviceLabel: string,
  now: Date,
): Promise<SendOutcome> {
  try {
    const event = inviteEventFromPayload(id, payload, serviceLabel);
    return await withDeadline(
      sendCalendarInvite(planCalendarInvite(event, 'request', now), { id, kind: 'request', now }),
      POST_COMMIT_BUDGET_MS,
      'failed',
    );
  } catch (err) {
    console.error(`Admin entry ${id} calendar invite failed:`, err);
    return 'failed';
  }
}

function back(path: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return redirect(query ? `${path}?${query}` : path);
}

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
