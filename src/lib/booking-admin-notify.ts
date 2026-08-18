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
 * WHAT BK-16 ADDS IS ON THE OTHER SIDE OF THE LEDGER, so it does not touch the
 * invariant above at all: a status edit that crosses the cancelled boundary now
 * also mails **the customer**, when the row has an address. Cancelling is the
 * one admin action a customer has a right to hear about in writing, and the
 * email carries the calendar artifact that clears the invite they were sent at
 * booking time. The office half is unchanged and still the only office mail.
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
  BOOKING_EMAIL_REPLY_TO,
  BOOKING_INTERNAL_TO,
  POST_COMMIT_BUDGET_MS,
  SUPPORT_PHONE,
} from './booking-config';
import { stampNotifications } from './booking-commit';
import {
  CANCEL_LINE,
  CANCELLED_CALENDAR_LINE,
  CANCELLED_HEADING,
  CANCELLED_LEAD,
  CANCELLED_REBOOK_LINE,
  RESTORED_CALENDAR_LINE,
  RESTORED_HEADING,
  RESTORED_LEAD,
  TIMEZONE_NOTE,
} from './booking-copy';
import {
  escapeHtml,
  headerSafe,
  planBookingNotifications,
  type Message,
  type BookingMessageType,
  type NotificationPlan,
} from './booking-email';
import {
  buildBookingIcs,
  icsAttachment,
  icsCustomer,
  ICS_OFFICE,
  type IcsEvent,
  type IcsKind,
} from './booking-ics';
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
  /**
   * Which transition this send is (BK-43). Defaults to the one message this
   * builder has ever produced; BK-23 passes 'payment-link' here when the admin
   * create path stops confirming on save.
   */
  messageType: BookingMessageType = 'confirmed',
): NotificationPlan {
  return planBookingNotifications({
    id,
    messageType,
    // Server-formatted in Edmonton time, exactly as the public path does it.
    // The message must never re-derive a zone from a raw instant.
    slotLabel: formatSlot(payload.slotStart),
    slotStart: payload.slotStart,
    now,
    name: payload.name,
    phone: payload.phone,
    email: payload.email,
    serviceLabel,
    service: payload.service,
    assessmentTier: payload.assessmentTier,
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
  /** See `planForPayload`. The resend button re-sends the confirmation. */
  messageType: BookingMessageType = 'confirmed',
): NotificationPlan {
  return planBookingNotifications({
    id: row.id,
    messageType,
    slotLabel: formatSlot(row.slot_start),
    slotStart: row.slot_start,
    now,
    name: row.name,
    phone: row.phone,
    email: row.email,
    serviceLabel,
    service: row.service,
    assessmentTier: row.assessment_tier,
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
    // The office, not the customer: a reply-to pointing at the customer would
    // invite a reply to a calendar notice. Present rather than omitted, though
    // — omitting it sends a reply to the `noreply@` From, which bounces 550
    // (BK-21). Pointing it at the office is harmless: this is the office
    // writing to itself, so a stray reply lands where it started.
    replyTo: BOOKING_EMAIL_REPLY_TO,
    subject: headerSafe(`${what} #${event.id} — ${event.name}`),
    html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;">${escapeHtml(line)}</div>`,
    text: line,
    attachments: [icsAttachment(buildBookingIcs(event, kind, now, ICS_OFFICE), kind, event.id)],
  };
}

// ---------------------------------------------------------------------------
// The customer's side of the cancelled boundary (BK-16)
//
// Client-decided 2026-08-12, from his BK-14 post-deploy test: "as a customer I
// did receive the booking confirmation email but not the cancelled
// notification email". These two are that email, plus the restore direction —
// which is not a flourish. The resend button cannot restore a customer's
// calendar: `sendCustomerConfirmation` keys idempotency on `booking-<id>`,
// byte-identical to the booking-time confirmation, so within Resend's dedupe
// window the restore is silently collapsed into a send from days ago and the
// customer's calendar shows "cancelled" forever, with the flash reading
// "sent". So un-cancel mails the restore itself, through the per-transition
// key. (The resend button's fixed key is recorded in the ticket's Mechanism
// and deliberately NOT changed here.)
//
// CANCELLATION IS STILL PHONE-IN (locked). Neither message carries a URL, a
// cancel link, or a token — they are the WRITTEN CONFIRMATION of something a
// person almost always arranged by phone, and the only action either offers is
// the phone number.
//
// Both take an `IcsEvent`, so neither CAN read an insurance identifier: the
// type has no such field. That is the same guarantee `customerConfirmation`
// gets from not reading them, one level stronger.
// ---------------------------------------------------------------------------

/**
 * One shape, two directions. The cancellation and the restore differ only in
 * their copy and in which ICS they carry, and writing them as two hand-rolled
 * templates is how the second one quietly grows a URL or drops the zone note.
 *
 * The subject carries the SLOT LABEL and not the customer's name — everything
 * in it is a constant or a server-formatted value, so nothing customer-typed
 * reaches a header here. `headerSafe` is applied anyway: it is load-bearing the
 * moment somebody adds `${event.name}` to this line, and a guard that only
 * appears once the hole does is a guard nobody adds.
 */
function planBoundaryEmail(
  event: IcsEvent,
  email: string,
  now: Date,
  kind: IcsKind,
  copy: { heading: string; lead: string; calendarLine: string; phoneLine: string },
): Message {
  const when = `${formatSlot(event.slotStart)} (${TIMEZONE_NOTE})`;
  const where = [event.address, event.city, event.postalCode].filter(Boolean).join(', ');

  const rows: [string, string][] = [
    ['When', when],
    ['Where', where],
    ['Service', event.serviceLabel],
    ['Reference', `#${event.id}`],
  ];

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:560px;">',
    `<h1 style="font-size:22px;margin:0 0 16px;">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0 0 16px;">${escapeHtml(copy.lead)}</p>`,
    '<table style="border-collapse:collapse;width:100%;">',
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:600;width:140px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(value)}</td></tr>`,
    ),
    '</table>',
    `<p style="margin:16px 0;">${escapeHtml(copy.calendarLine)}</p>`,
    `<p style="margin:16px 0;">${escapeHtml(copy.phoneLine)}</p>`,
    `<p style="margin:24px 0 0;color:#666;font-size:13px;">YEG Restoration · ${escapeHtml(SUPPORT_PHONE)}</p>`,
    '</div>',
  ].join('');

  const text = [
    copy.heading,
    '',
    copy.lead,
    '',
    ...rows.map(([label, value]) => `${`${label}:`.padEnd(11)}${value}`),
    '',
    copy.calendarLine,
    '',
    copy.phoneLine,
    '',
    `YEG Restoration · ${SUPPORT_PHONE}`,
  ].join('\n');

  return {
    from: BOOKING_EMAIL_FROM,
    to: email,
    // Same reasoning as the confirmation: the sender is `noreply`, and people
    // reply to a cancellation notice more than to anything else this system
    // sends.
    replyTo: BOOKING_EMAIL_REPLY_TO,
    subject: headerSafe(`${copy.heading} — ${formatSlot(event.slotStart)} (${TIMEZONE_NOTE})`),
    html,
    text,
    // THE CUSTOMER AUDIENCE, and this is the whole point of the audience
    // argument. An office-attendee ICS mailed to a customer names the office as
    // the invitee of their own appointment and prints their own phone number
    // back at them.
    attachments: [
      icsAttachment(buildBookingIcs(event, kind, now, icsCustomer(email)), kind, event.id),
    ],
  };
}

/** "We cancelled it" — plus the METHOD:CANCEL that clears their calendar. */
export function planCancellationEmail(event: IcsEvent, email: string, now: Date): Message {
  return planBoundaryEmail(event, email, now, 'cancel', {
    heading: CANCELLED_HEADING,
    lead: CANCELLED_LEAD,
    calendarLine: CANCELLED_CALENDAR_LINE,
    phoneLine: CANCELLED_REBOOK_LINE,
  });
}

/** "It is back on" — plus a fresh METHOD:REQUEST, same UID, later SEQUENCE. */
export function planRestoreEmail(event: IcsEvent, email: string, now: Date): Message {
  return planBoundaryEmail(event, email, now, 'request', {
    heading: RESTORED_HEADING,
    lead: RESTORED_LEAD,
    calendarLine: RESTORED_CALENDAR_LINE,
    // NOT the cancellation's rebook line: "if this cancellation is a surprise"
    // inside an email saying the appointment is back on reads as a
    // contradiction (implementation review, should-fix 2).
    phoneLine: CANCEL_LINE,
  });
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
