import type { APIRoute } from 'astro';

export const prerender = false;

import {
  ADMIN_APPOINTMENT_NEW_PATH,
  adminAppointmentPath,
} from '../../../../lib/booking-admin';
import { appendUntickedNote, parseAdminEntry } from '../../../../lib/booking-admin-entry';
import { planForPayload, sendConfirmationAndStamp } from '../../../../lib/booking-admin-notify';
import { insertBooking } from '../../../../lib/booking-commit';
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

  // BK-35. Unticking the confirmation box used to be silent, which made "the
  // customer says they were never told" unanswerable. The line goes on the ROW,
  // not only into the platform log, because the office reads appointments and
  // does not read Vercel logs.
  //
  // Appended BEFORE the insert rather than as a post-commit UPDATE: past the
  // insert nothing may fail the request, and a second statement there would be
  // a way for a saved appointment to answer 500. It also means the note is
  // never missing from a row that exists.
  // The log line itself is emitted after the insert, where there is an id to
  // name — a warning about "an appointment" is not something anyone can act on.
  const notes = sendConfirmation ? adminNotes : appendUntickedNote(adminNotes);

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
    created = await insertBooking(sql, payload, null, now, 'admin', notes);
  } catch (err) {
    console.error('Admin entry insert failed:', err);
    return back(ADMIN_APPOINTMENT_NEW_PATH, { err: 'db' });
  }

  // Zero rows means ON CONFLICT DO NOTHING fired — the slot is already held by
  // a non-cancelled appointment. The only real double-booking guard there is.
  if (created === null) return back(ADMIN_APPOINTMENT_NEW_PATH, { taken: '1' });

  // BK-35. Now there is an id to name. Paired with the `admin_notes` line
  // appended above — the log is for whoever is debugging, the note is for
  // whoever is answering the customer.
  if (!sendConfirmation) {
    console.warn(
      `Admin entry ${created.id}: send-confirmation was unticked — no customer email sent.`,
    );
  }

  // Past this point the appointment EXISTS. Nothing below may fail the request.
  // The fallback cannot fire — the parser was handed these very keys — and
  // exists so the two cannot drift into an `undefined` in a subject line.
  const serviceLabel = SERVICE_LABELS[payload.service] ?? payload.service;

  // ── BK-23: A PHONE BOOKING IS A REQUEST TOO ──────────────────────────────
  //
  // What the customer gets is the ACKNOWLEDGEMENT, not a confirmation, and
  // there is no office calendar invite. Under prepay nothing is confirmed until
  // it is paid — client decision 2026-08-16, "payment always precedes dispatch,
  // no exceptions", and phone customers pay by link like everybody else.
  //
  // The row lands in `pending_review` (the column default) and the office
  // approves it from the review panel, which is where the amount is set. See
  // the note in BK-23 on why this is `pending_review` rather than the
  // `approved_awaiting_payment` P9 first sketched: an approval needs an amount,
  // an amount needs a tier, and the tier is optional on this form by the same
  // exemption that makes email optional. Landing here means one screen sets the
  // amount instead of two, and nothing is ever approved without one.
  //
  // The office invite is GONE from this path, not merely conditional. It used
  // to fire here unconditionally, and it would have filled the calendar with
  // slots that may be declined or never paid — with no CANCEL to clear them,
  // because a row that reaches `declined` from `pending_review` never had an
  // invite issued.
  const emailOutcome =
    sendConfirmation && payload.email
      ? await sendConfirmationAndStamp(
          sql,
          planForPayload(created.id, payload, serviceLabel, now, created.files, 'request'),
        )
      : null;

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

/*
 * `sendOfficeInvite` lived here until BK-23 and is deliberately gone rather
 * than left behind a flag.
 *
 * It sent the office a calendar invite the moment a phone booking was typed in.
 * Under prepay that is an invite for a slot nobody has paid for, and there is
 * no CANCEL to clear it if the request is later declined or the payment lapses
 * — a row reaching `declined` from `pending_review` never had an invite issued,
 * which is exactly the property that makes the decline path a clean no-op.
 *
 * The office still sees the booking immediately: in the admin list, on this
 * page, and in the internal email. What their CALENDAR carries is only work
 * that has been paid for. BK-32 issues both invites from the payment
 * confirmation, which is the one place that knows the money moved.
 */

function back(path: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return redirect(query ? `${path}?${query}` : path);
}

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
