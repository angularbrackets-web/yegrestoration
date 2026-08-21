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
  CANCELLED_REFUNDED_LEAD,
  REFUNDED_HEADING,
  REFUNDED_LEAD,
  REFUND_TIMING_LINE,
  refundedAmountLine,
  RESTORED_CALENDAR_LINE,
  CONFIRMED_HEADING,
  CONFIRMED_LEAD,
  CONFIRMED_CALENDAR_LINE,
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
  type SettledAmounts,
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
  sendCalendarInvite,
  sendCustomerConfirmation,
  withDeadline,
  type NotifyDeps,
  type SendOutcome,
} from './booking-notify';
import type { BookingPayload } from './booking-payload';
import { formatCents } from './booking-pricing';
import { couldHoldCalendarInvite, type AppointmentStatus } from './booking-status';
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
    // NO SNAPSHOT EXISTS YET (BK-45). This mapper builds the message a booking
    // sends at CREATION — the public request and the admin entry — and the
    // amount columns are written at approval, by `review.ts`. Null is the
    // honest answer, and it is what makes the request message keep quoting the
    // pricing table, which is correct for a quote.
    settled: null,
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
    settled: settledAmountsOf(row),
  });
}

/**
 * The approval snapshot as a value the message layer can render (BK-45).
 *
 * ── ALL FOUR NARROWED, AND THE SNAPSHOT DROPPED IF ANY IS MISSING ─────────
 *
 * `review.ts` writes `assessment_amount_cents`, `travel_fee_cents`, `gst_cents`
 * and `total_amount_cents` in ONE SET clause, on both the paid and the free
 * branch, so a non-null total means the other three are populated. Testing one
 * and reading four is therefore safe — but the obvious spelling of it is
 * `?? 0`, and a `?? 0` here would print `$0.00` for a real GST amount in the
 * record of a completed purchase. So each is narrowed and the whole snapshot is
 * dropped if any is missing: a partial answer about money is worse than none.
 *
 * ── ZERO IS A VALUE, NOT AN ABSENCE ────────────────────────────────────────
 *
 * `approveFree` writes a total of 0. That row IS approved and its customer IS
 * owed a message saying the visit is free, so this returns the snapshot and lets
 * the renderer decide what zero means. Collapsing zero to null here would make a
 * goodwill booking indistinguishable from one nobody has approved yet.
 */
function settledAmountsOf(row: Appointment): SettledAmounts | null {
  const { assessment_amount_cents: base, gst_cents: gst, total_amount_cents: total } = row;
  if (base === null || gst === null || total === null) return null;
  return {
    baseCents: base,
    // `NOT NULL DEFAULT 0` — the one amount column that cannot be missing.
    travelCents: row.travel_fee_cents,
    gstCents: gst,
    totalCents: total,
    paidCents: row.paid_amount_cents,
  };
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
// calendar: `sendCustomerConfirmation` keys idempotency on the CONFIRMATION
// transition, byte-identical to the booking-time confirmation, so within
// Resend's dedupe window the restore is silently collapsed into a send from
// days ago and the customer's calendar shows "cancelled" forever, with the
// flash reading "sent". So un-cancel mails the restore itself, through its own
// transition key.
//
// BK-43 changed the shape of that key (`booking-<id>-confirmed`, not
// `booking-<id>`) but NOT this hazard: `planForAppointment` defaults
// `messageType` to 'confirmed', so the resend button still collides with the
// booking-time confirmation. Under P9 that button is the office's only manual
// recovery for exactly the silent-loss failure BK-43 exists to prevent.
// Recorded in ROADMAP's Known traps with a severity and an owner rather than
// left in this comment; deliberately NOT changed here.
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
/**
 * ── `kind` MAY BE NULL, AND `calendarLine` WITH IT (BK-33) ─────────────────
 *
 * Every message this built used to cross the calendar boundary, so an ics was
 * unconditional. A refund does not have to: `markPaid`'s paid-after-release
 * branch records real money on rows that are ALREADY `cancelled`, `declined` or
 * `payment_expired`, and refunding one of those crosses nothing. That customer
 * still has to be told their money is coming back — so this builds the same
 * message shape with no attachment and no calendar sentence, rather than a
 * second builder existing to say one thing differently. BK-45 is the record of
 * what two builders for one event costs.
 *
 * ── AND `refundLines`, WHICH RENDER UNDER THE LEAD ────────────────────────
 *
 * Absent on every arm that is not about money, which is what keeps the
 * no-refund cancellation byte-identical to the message that shipped before this
 * ticket.
 */
function planBoundaryEmail(
  event: IcsEvent,
  email: string,
  now: Date,
  kind: IcsKind | null,
  copy: {
    heading: string;
    lead: string;
    calendarLine: string | null;
    phoneLine: string;
    refundLines?: readonly string[];
  },
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
    ...(copy.refundLines ?? []).map(
      (line) => `<p style="margin:0 0 16px;">${escapeHtml(line)}</p>`,
    ),
    '<table style="border-collapse:collapse;width:100%;">',
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:600;width:140px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(value)}</td></tr>`,
    ),
    '</table>',
    ...(copy.calendarLine
      ? [`<p style="margin:16px 0;">${escapeHtml(copy.calendarLine)}</p>`]
      : []),
    `<p style="margin:16px 0;">${escapeHtml(copy.phoneLine)}</p>`,
    `<p style="margin:24px 0 0;color:#666;font-size:13px;">YEG Restoration · ${escapeHtml(SUPPORT_PHONE)}</p>`,
    '</div>',
  ].join('');

  const text = [
    copy.heading,
    '',
    copy.lead,
    '',
    ...(copy.refundLines ?? []).flatMap((line) => [line, '']),
    ...rows.map(([label, value]) => `${`${label}:`.padEnd(11)}${value}`),
    '',
    ...(copy.calendarLine ? [copy.calendarLine, ''] : []),
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
    attachments: kind
      ? [icsAttachment(buildBookingIcs(event, kind, now, icsCustomer(email)), kind, event.id)]
      : [],
  };
}

/**
 * What went back to the customer, when a message is about a refund (BK-33).
 *
 * `amountCents` is WHAT WAS REFUNDED, and it is the only figure that reaches
 * the customer. The booking's total is deliberately absent: on a partial refund
 * a message carrying both numbers cannot tell the reader which one arrived, and
 * a pin holds the total out of it.
 */
export type RefundNotice = { amountCents: number };

/** The two sentences a refund owes a customer, in the order they read. */
function refundLinesFor(refund: RefundNotice): readonly string[] {
  return [refundedAmountLine(formatCents(refund.amountCents)), REFUND_TIMING_LINE];
}

/**
 * "We cancelled it" — plus the METHOD:CANCEL that clears their calendar.
 *
 * ── THE REFUND ARM (BK-33) ────────────────────────────────────────────────
 *
 * With `refund` absent this is byte-for-byte the message that shipped before
 * BK-33, and `verify-booking-ics.ts` pins that rather than trusting it.
 *
 * With `refund` present the LEAD CHANGES as well as the body, and the swap is
 * the point rather than a detail: `CANCELLED_LEAD` opens *"as requested"*,
 * which is a claim about who asked. On a company-side cancellation it is false,
 * and this is the one message where it would sit beside the customer's money.
 * See `CANCELLED_REFUNDED_LEAD`.
 */
export function planCancellationEmail(
  event: IcsEvent,
  email: string,
  now: Date,
  refund?: RefundNotice,
): Message {
  return planBoundaryEmail(event, email, now, 'cancel', {
    heading: CANCELLED_HEADING,
    lead: refund ? CANCELLED_REFUNDED_LEAD : CANCELLED_LEAD,
    calendarLine: CANCELLED_CALENDAR_LINE,
    phoneLine: CANCELLED_REBOOK_LINE,
    refundLines: refund ? refundLinesFor(refund) : undefined,
  });
}

/**
 * MONEY GOING BACK ON A BOOKING THAT WAS ALREADY OFF — no ics, no cancellation
 * claim (BK-33).
 *
 * This arm exists because the refund notice must NOT be gated on the calendar
 * boundary. `markPaid`'s paid-after-release branch records real money on rows
 * that are already `cancelled`, `declined` or `payment_expired`; refunding one
 * of those crosses no boundary, so the boundary mailer sends nothing — and the
 * customer whose money we just returned would have heard from us not at all, on
 * exactly the path the ticket added this copy for.
 *
 * No `CANCEL` ics: their calendar was cleared when the booking was released,
 * and a second CANCEL under the same UID for an event they no longer hold is
 * noise at best.
 */
export function planRefundNotice(
  event: IcsEvent,
  email: string,
  now: Date,
  refund: RefundNotice,
): Message {
  return planBoundaryEmail(event, email, now, null, {
    heading: REFUNDED_HEADING,
    lead: REFUNDED_LEAD,
    calendarLine: null,
    phoneLine: CANCELLED_REBOOK_LINE,
    refundLines: refundLinesFor(refund),
  });
}

/** "It is back on" — plus a fresh METHOD:REQUEST, same UID, later SEQUENCE. */
/**
 * The other inward crossing: a FIRST confirmation, not a reinstatement.
 *
 * See `CONFIRMED_HEADING`'s note for why this exists. `sendBoundaryMail` picks
 * between the two on whether the row is coming back from `cancelled` — the only
 * status for which "reinstated" is a true description of what happened.
 */
export function planFirstConfirmationEmail(
  event: IcsEvent,
  email: string,
  now: Date,
): Message {
  return planBoundaryEmail(event, email, now, 'request', {
    heading: CONFIRMED_HEADING,
    lead: CONFIRMED_LEAD,
    calendarLine: CONFIRMED_CALENDAR_LINE,
    phoneLine: CANCEL_LINE,
  });
}

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
  /**
   * The attempt, for the idempotency prefix (BK-32). Required rather than a
   * fresh `new Date()` here: the resend button's whole job is that a SECOND
   * click delivers, and a clock this function owned would be a clock a verify
   * script could not drive.
   */
  now: Date,
  deps: NotifyDeps = {},
): Promise<SendOutcome> {
  try {
    return await withDeadline(
      (async (): Promise<SendOutcome> => {
        const outcome = await sendCustomerConfirmation(plan, now, deps);
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

// ---------------------------------------------------------------------------
// The invite boundary (BK-14/BK-16/BK-23, moved here by BK-33)
// ---------------------------------------------------------------------------

/**
 * What a status edit's mail needs to know: the new status, and the old row
 * beside it.
 *
 * Every field outside `status` is unchanged by the edit that produced it, so a
 * caller may read them from a pre-UPDATE snapshot — which is what `update.ts`'s
 * self-join does, at no second query and with no window to be stale in.
 */
export type BoundaryRow = {
  next_status: string;
  prev_status: string;
  id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string;
  city: string;
  postal_code: string | null;
  /**
   * The LABEL, not the key — injected by the caller for the reason this
   * module's header gives: `SERVICE_LABELS` is a value in `db.ts` beside the
   * Neon import, and importing it here would put this module out of reach of a
   * `tsx` verify script. Moving `sendBoundaryMail` in was not a licence to
   * break the constraint that made the move safe.
   */
  service_label: string;
  /** `timestamptz` — the driver returns a `Date`. */
  slot_start: Date;
};

/**
 * The mail a status edit owes: the office's calendar artifact, and — since
 * BK-16 — the customer's written notice carrying their own copy of it.
 *
 * ── WHY THIS LIVES HERE AND NOT IN `update.ts` (BK-33) ────────────────────
 *
 * It was a private function of the update route until a second route needed to
 * cross the same boundary: "Cancel and refund" cancels a booking, so it owes
 * the identical CANCEL ics to the identical two audiences. Copying it would
 * have produced two functions that are both "the cancellation", differing by
 * whatever drifts first — which is BK-45 exactly: `markPaid` and the Resend
 * button sent two different messages both called "the confirmation", and a
 * customer got a materially different email depending on which control somebody
 * clicked.
 *
 * ── AND IT TOOK `NotifyDeps` IN THE SAME MOVE ─────────────────────────────
 *
 * It called `sendCalendarInvite` with no deps, so the only observable of these
 * sends was a mute line carrying no message content: **which message a
 * cancelled customer receives was checkable by reading the source and by
 * nothing else.** That is the shape of defect BK-45 was filed for, and
 * `booking-payment.ts`'s own header records the lesson —
 * *"without it the whole of this module would be verified by reading it, which
 * is precisely how the fixed-idempotency-prefix defect survived two reviews."*
 * Moving a function without its seam would have carried the gap into a second
 * caller instead of closing it.
 *
 * ── THE RULE IS THE INVITE BOUNDARY, not the status names ─────────────────
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
 * ── `refund` IS THREADED, BUT IT DOES NOT DECIDE WHETHER TO SEND ──────────
 *
 * A refund reaching this function rides along on a crossing that was happening
 * anyway. **It must never be the reason a send happens or does not**, because
 * this function's first act is to return when no boundary is crossed — and a
 * refund on an already-released row crosses nothing. That customer's notice is
 * `planRefundNotice`, sent by the refund path itself. Hanging a money message
 * off a calendar test is how one gets silently skipped.
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
export async function sendBoundaryMail(
  row: BoundaryRow,
  now: Date,
  deps: NotifyDeps = {},
  refund?: RefundNotice,
): Promise<void> {
  // Cast rather than validate: these came out of a CHECK-constrained column,
  // and `parseAppointmentUpdate` already refused anything outside the set on
  // the way in.
  const hadInvite = couldHoldCalendarInvite(row.prev_status as AppointmentStatus);
  const hasInvite = couldHoldCalendarInvite(row.next_status as AppointmentStatus);
  if (hadInvite === hasInvite) return;

  const kind: IcsKind = hadInvite ? 'cancel' : 'request';

  try {
    const event = inviteEventFromAppointment(row, row.service_label);

    // The resend route's guard, and for the same reason: a column that is
    // present but blank is not an address, and handing `''` to Resend is a
    // failed send rather than a skip.
    const email = typeof row.email === 'string' && row.email.trim() !== '' ? row.email : null;

    const sends: Promise<[string, SendOutcome]>[] = [
      sendCalendarInvite(planCalendarInvite(event, kind, now), {
        id: row.id,
        kind,
        now,
        audience: 'office',
      }, deps).then((outcome) => ['office', outcome] as [string, SendOutcome]),
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
          ? planCancellationEmail(event, email, now, refund)
          : row.prev_status === 'cancelled'
            ? planRestoreEmail(event, email, now)
            : planFirstConfirmationEmail(event, email, now);
      sends.push(
        sendCalendarInvite(message, { id: row.id, kind, now, audience: 'customer' }, deps).then(
          (outcome) => ['customer', outcome] as [string, SendOutcome],
        ),
      );
    }

    const outcomes = await withDeadline(
      Promise.all(sends),
      POST_COMMIT_BUDGET_MS,
      // The deadline's answer, one entry per send that was attempted. Wrong in
      // the safe direction: the log says nothing went out rather than claiming
      // something did.
      sends.map((_, i) => [i === 0 ? 'office' : 'customer', 'failed'] as [string, SendOutcome]),
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
