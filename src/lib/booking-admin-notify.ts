/**
 * The admin surface's outbound mail: the customer confirmation, sent from a
 * manual entry or from the detail page's resend button — and, since BK-14, the
 * office's own calendar invite.
 *
 * Two callers, one path, for the confirmation. Both build the BK-05 plan with
 * `planBookingNotifications` — the copy module is not taught an "admin mode",
 * so the locked PII rule (no policy or claim number in a customer message)
 * holds by construction rather than by a second implementation remembering it
 * — and both send through `sendCustomerConfirmation`, which structurally
 * cannot deliver the internal message.
 *
 * THE INVARIANT, AS NARROWED BY BK-14. It used to read "no admin action ever
 * mails the office": they are typing the booking in, they are the office, and a
 * full lead-notification about their own keystrokes is noise in a real inbox.
 * That reasoning is intact and still forbids exactly what it forbade — what
 * changed is that a phone-in booking typed into admin is precisely the case
 * where the office wants a MACHINE artifact of what it just did, on the
 * calendar. So:
 *
 *   **No admin action sends a NOTIFICATION email to the office.** The calendar
 *   invite is a calendar artifact — one line of body, an ICS attached — and it
 *   is sent on exactly two transitions: a manual entry, and a status edit that
 *   crosses the cancelled boundary in either direction. Everything else the
 *   admin surface does still mails the office nothing.
 *
 * `sendCustomerConfirmation` still cannot deliver `plan.internal`; that has not
 * been loosened. The invite is built here, by `planCalendarInvite`, from a
 * record that structurally cannot carry an insurance identifier.
 *
 * The two mappings below sit in one file precisely because they must agree: a
 * confirmation resent from a row has to be the same message the entry sent.
 *
 * `serviceLabel` is injected rather than looked up here: `SERVICE_LABELS` is a
 * value in `db.ts`, next to the Neon import, and importing it would put this
 * module out of reach of a `tsx` verify script. Same reason
 * `booking-payload.ts` injects its allowed-service set.
 */

import {
  BOOKING_EMAIL_FROM,
  BOOKING_INTERNAL_TO,
  POST_COMMIT_BUDGET_MS,
} from './booking-config';
import { stampNotifications } from './booking-commit';
import {
  escapeHtml,
  headerSafe,
  planBookingNotifications,
  type Message,
  type NotificationPlan,
} from './booking-email';
import { buildBookingIcs, icsAttachment, type IcsEvent, type IcsKind } from './booking-ics';
import {
  sendCustomerConfirmation,
  withDeadline,
  type NotifyDeps,
  type SendOutcome,
} from './booking-notify';
import type { BookingPayload } from './booking-payload';
import { formatSlot } from './booking-time';
import type { Appointment, getDb } from './db';

type Sql = ReturnType<typeof getDb>;

/** The plan for a booking the office just typed in. */
export function planForPayload(
  id: number,
  payload: BookingPayload,
  serviceLabel: string,
  now: Date,
  filesAttached = 0,
): NotificationPlan {
  return planBookingNotifications({
    id,
    // Server-formatted in Edmonton time, exactly as the public path does it.
    // The message must never re-derive a zone from a raw instant.
    slotLabel: formatSlot(payload.slotStart),
    slotStart: payload.slotStart,
    now,
    name: payload.name,
    phone: payload.phone,
    email: payload.email,
    serviceLabel,
    description: payload.description,
    address: payload.address,
    city: payload.city,
    postalCode: payload.postal_code,
    paymentRoute: payload.payment_route,
    insurerName: payload.insurer_name,
    policyNumber: payload.policy_number,
    claimNumber: payload.claim_number,
    smsConsent: payload.smsConsent,
    filesAttached,
  });
}

/**
 * The plan for an appointment already in the table — the resend path.
 *
 * The `now` it takes reaches only the ICS on `plan.internal`, and the resend
 * path sends `plan.customer` and nothing else — so that attachment is built and
 * then never delivered. Harmless and stated rather than special-cased: a plan
 * built with a made-up instant is a plan that lies, and the next caller to send
 * something else from it would inherit that. Same reasoning as the file count
 * `resend.ts` already carries for the same reason.
 */
export function planForAppointment(
  row: Appointment,
  serviceLabel: string,
  now: Date,
  filesAttached = 0,
): NotificationPlan {
  return planBookingNotifications({
    id: row.id,
    slotLabel: formatSlot(row.slot_start),
    slotStart: row.slot_start,
    now,
    name: row.name,
    phone: row.phone,
    email: row.email,
    serviceLabel,
    description: row.description,
    address: row.address,
    city: row.city,
    postalCode: row.postal_code,
    paymentRoute: row.payment_route,
    insurerName: row.insurer_name,
    policyNumber: row.policy_number,
    claimNumber: row.claim_number,
    // The timestamp IS the consent (locked). A boolean here is derived for the
    // message, never stored back.
    smsConsent: row.sms_consent_at != null,
    filesAttached,
  });
}

// ---------------------------------------------------------------------------
// The calendar invite (BK-14)
//
// Two mappers mirroring the pair above, and for the same reason: the create
// path holds a `BookingPayload` plus the id the insert returned, while the
// update path holds a row snapshot. Neither can produce the other's shape, and
// a module that took one of them would push the conversion into a route.
//
// Both produce an `IcsEvent`, which HAS NO insurance fields — so "the invite
// carries no policy number" is a property of the type, not of these two
// functions remembering.
// ---------------------------------------------------------------------------

/** The invite's view of a booking the office just typed in. */
export function inviteEventFromPayload(
  id: number,
  payload: BookingPayload,
  serviceLabel: string,
): IcsEvent {
  return {
    id,
    name: payload.name,
    serviceLabel,
    phone: payload.phone,
    address: payload.address,
    city: payload.city,
    postalCode: payload.postal_code,
    slotStart: payload.slotStart,
  };
}

/**
 * The invite's view of a row.
 *
 * Deliberately typed against the fields it reads rather than the whole
 * `Appointment`: `update.ts` builds its event from a self-join snapshot of the
 * pre-UPDATE row, which is seven columns and not an `Appointment`. Demanding
 * the full row there would mean a second SELECT, which is the check-then-act
 * shape that route's docstring forbids.
 */
export function inviteEventFromAppointment(
  row: Pick<
    Appointment,
    'id' | 'name' | 'phone' | 'address' | 'city' | 'postal_code' | 'slot_start'
  >,
  serviceLabel: string,
): IcsEvent {
  return {
    id: row.id,
    name: row.name,
    serviceLabel,
    phone: row.phone,
    address: row.address,
    city: row.city,
    postalCode: row.postal_code,
    slotStart: row.slot_start,
  };
}

/**
 * The office's calendar invite: a deliberately tiny email whose entire point is
 * the attachment.
 *
 * One line of body on purpose. The office is either the person who just typed
 * this in or the person who just cancelled it — they know what happened; what
 * they do not have is the event on the calendar. Anything more here would be
 * the lead-notification the narrowed invariant still forbids.
 *
 * The subject names the transition. The ticket wrote one subject for both
 * kinds; a CANCEL arriving under a subject identical to the create is the kind
 * of thing that gets archived unread, and the office acting on the wrong one
 * costs a crew a drive.
 */
export function planCalendarInvite(event: IcsEvent, kind: IcsKind, now: Date): Message {
  const cancelled = kind === 'cancel';
  const what = cancelled ? 'Cancelled: assessment' : 'Calendar: assessment';
  const line = cancelled
    ? `Assessment #${event.id} for ${event.name} is cancelled. The attached update removes it from the calendar.`
    : `Assessment #${event.id} for ${event.name}. Open the attachment to add it to the calendar.`;

  return {
    from: BOOKING_EMAIL_FROM,
    to: BOOKING_INTERNAL_TO,
    // No replyTo. There is nobody to reply to — this is the office writing to
    // itself, and a reply-to pointing at the customer would invite a reply to
    // a calendar notice.
    subject: headerSafe(`${what} #${event.id} — ${event.name}`),
    html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;">${escapeHtml(line)}</div>`,
    text: line,
    attachments: [icsAttachment(buildBookingIcs(event, kind, now), kind, event.id)],
  };
}

/**
 * Send the confirmation, then record it — and report what the *send* did.
 *
 * **Cannot fail its caller.** By the time this runs the appointment row exists,
 * so an exception escaping here would turn a saved entry into a 500 and the
 * office would type it again into a slot that is already gone. Every failure is
 * swallowed and reported as `'failed'`, which the flash surfaces and the resend
 * button recovers.
 *
 * One deadline over the send and the stamp together, the same budget the public
 * commit path uses and for the same reason: stacking per-operation timers on a
 * request that has already run an insert is how a platform 504 happens.
 *
 * The stamp writes the customer column only — `stampNotifications`'s per-column
 * CASE leaves `internal_notified_at` alone, which is what keeps an admin row's
 * "office notified" honestly NULL.
 */
export async function sendConfirmationAndStamp(
  sql: Sql,
  plan: NotificationPlan,
  deps: NotifyDeps = {},
): Promise<SendOutcome> {
  try {
    return await withDeadline(
      (async (): Promise<SendOutcome> => {
        const outcome = await sendCustomerConfirmation(plan, deps);
        if (outcome === 'sent') {
          try {
            // Fresh clock: this is when the send returned, not when the request
            // started, and the admin pages render this column as a timestamp.
            await stampNotifications(
              sql,
              plan.bookingId,
              { customer: true, internal: false },
              new Date(),
            );
          } catch (err) {
            // Advisory bookkeeping. The customer has the email either way, so a
            // failed UPDATE must not rewrite a fact that already happened.
            console.error(`Booking ${plan.bookingId} was emailed but the stamp failed:`, err);
          }
        }
        return outcome;
      })(),
      POST_COMMIT_BUDGET_MS,
      // The deadline's answer. A message that lands late reports as failed,
      // which is wrong in the safe direction — the office is told nothing went
      // out rather than promised something did.
      'failed',
    );
  } catch (err) {
    console.error(`Booking ${plan.bookingId} confirmation failed:`, err);
    return 'failed';
  }
}
