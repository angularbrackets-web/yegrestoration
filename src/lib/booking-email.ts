/**
 * The two messages a committed booking produces, as values.
 *
 * Pure: a plain record in, `{ customer, internal }` out. No Resend, no
 * `readEnv`, no clock, no DOM — `booking-notify.ts` is the half that sends, and
 * keeping the split is what lets `scripts/verify-booking-email.ts` assert the
 * locked PII rule and the escaping under plain `tsx`. Same shape as
 * `booking-confirmation.ts` / `booking-handoff.ts` from BK-04.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. `policy_number` and `claim_number`
 * are insurance-only, and they may never appear in a customer-facing message.
 * The confirmation may ask the customer to *have them ready* — that sentence
 * lives in `booking-copy.ts` — but it may never print them. The internal
 * notification is the office's own copy and is explicitly not bound by that
 * rule (`002-booking` scopes those columns to "email and the admin panel").
 * `customerConfirmation` therefore does not read the two fields at all, which
 * is a stronger guarantee than remembering not to interpolate them.
 *
 * `customer` is `null` rather than a flag when no email was given, so the skip
 * is a value a script can assert instead of a branch only the network sees.
 */

import {
  BOOKING_EMAIL_FROM,
  BOOKING_EMAIL_REPLY_TO,
  BOOKING_INTERNAL_TO,
  SUPPORT_PHONE,
} from './booking-config';
import {
  buildBookingIcs,
  icsAttachment,
  icsCustomer,
  ICS_OFFICE,
  type IcsEvent,
} from './booking-ics';
import {
  CALENDAR_ATTACHED_LINE,
  CANCEL_LINE,
  FEE_TERMS_HEADING,
  FEE_TERMS_INTRO,
  FEE_TERMS_ITEMS,
  FEE_TERMS_OUTRO,
  HAVE_READY_HEADING,
  HAVE_READY_ITEMS,
  TIMEZONE_NOTE,
  VISIT_LENGTH_LINE,
  ASSESSMENT_TIER_NAMES,
  RECEIVED_HEADING,
  RECEIVED_HOLD_LINE,
  RECEIVED_LEAD,
  RECEIVED_NEXT_STEPS,
  RECEIVED_TIMING_LINE,
  APPROVED_DEADLINE_NOTE,
  APPROVED_HEADING,
  APPROVED_INTERAC_LEAD,
  APPROVED_LEAD,
  APPROVED_PAY_NOW_NOTE,
  DECLINED_HEADING,
  DECLINED_LEAD,
  DECLINED_REBOOK_LINE,
} from './booking-copy';
import { assessmentQuote, formatCents, type AssessmentTier } from './booking-pricing';
import { formatSlot } from './booking-time';

/**
 * A file riding along with a message. Structurally Resend's `Attachment`
 * narrowed to the three fields this codebase sends — `content` as a string
 * rather than `string | Buffer`, because the one thing attached today is an
 * ICS body and a Buffer would make the verify scripts assert bytes.
 *
 * **Adding a field here is not enough to send it.** `createResendSender` maps
 * `Message` to the SDK through an explicit object literal, so a field that
 * literal does not name is silently dropped — and every verify script would
 * stay green, because their injected fake senders receive the whole `Message`.
 * See the source pin in `scripts/verify-booking-ics.ts`.
 */
export type EmailAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

/** One outbound message, fully rendered. The adapter adds nothing but the API key. */
export type Message = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
};

/**
 * WHICH LIFECYCLE TRANSITION A PLAN'S MESSAGES BELONG TO, and it is the whole
 * of BK-43.
 *
 * The Resend idempotency key is `<prefix>:<recipient>`, and until BK-43 the
 * prefix was a fixed `booking-<id>`. Under the auto-confirm flow that was
 * correct: one booking sent the customer exactly one message, so a retry
 * collapsing into the first send is precisely what the key is for.
 *
 * Under P9 one booking sends the same address up to five messages. With a fixed
 * prefix every one of them carries a byte-identical key, Resend collapses all
 * four later ones into duplicates of the first **and returns success**, and the
 * customer never sees the payment link. Nothing logs it: the send reports ok,
 * the stamp records sent, the admin panel shows a notified booking.
 *
 * Naming the transition keeps dedupe *within* a transition — a retried approval
 * must not mail twice — and makes it impossible *across* transitions. Same
 * treatment, and the same reasoning, as `inviteIdempotencyPrefix` on the
 * calendar side, which exists because a fixed prefix once collapsed CANCEL into
 * REQUEST.
 *
 * The full set is declared here, including the four nothing sends yet, so BK-23
 * and BK-32 add a send rather than also having to widen a type.
 */
export type BookingMessageType =
  | 'request'
  | 'payment-link'
  | 'payment-reminder'
  | 'confirmed'
  | 'declined'
  | 'expired';

export type NotificationPlan = {
  /** The appointment id, carried so the sender can key idempotency on it. */
  bookingId: number;
  /**
   * The transition these messages belong to. Required, never defaulted: the
   * defect this exists to prevent is precisely a thing someone forgets, so the
   * type system has to ask.
   */
  messageType: BookingMessageType;
  /** Null when the customer gave no email address — booking email is optional. */
  customer: Message | null;
  internal: Message;
};

/**
 * Everything the messages need, already resolved.
 *
 * Deliberately not the `appointments` row type and not `BookingPayload`: this
 * module should not care which of them the caller has, and a plain record is
 * what a verify script can build by hand.
 */
export type BookingNotificationInput = {
  id: number;
  /**
   * Which lifecycle transition this send is. See `BookingMessageType` — it
   * decides the idempotency key, so getting it wrong silently drops a message
   * rather than mislabelling one.
   */
  messageType: BookingMessageType;
  /** Server-formatted, America/Edmonton. Never re-derived here. */
  slotLabel: string;
  /**
   * The instant behind `slotLabel`. Both, because they are different things: a
   * label is for a human reading an email, and an ICS carries instants. Deriving
   * one from the other in either direction is how a zone gets re-guessed.
   */
  slotStart: Date;
  /** The send instant. DTSTAMP and SEQUENCE both come from it — see `icsSequence`. */
  now: Date;
  name: string;
  phone: string;
  email: string | null;
  /** Display label, not the key — `SERVICE_LABELS[service]`. */
  serviceLabel: string;
  /**
   * The service KEY (`water`, `mold`, …), not the label. Needed because the
   * price depends on it — mould carries its own figures — and a label cannot be
   * looked up in the pricing table.
   */
  service: string;
  /**
   * Which assessment the customer chose (BK-31). Null on an admin entry and on
   * every booking predating migration 007, and both messages must render that
   * absence honestly rather than defaulting to the cheapest tier.
   */
  assessmentTier: AssessmentTier | null;
  description: string | null;
  address: string;
  city: string;
  postalCode: string | null;
  paymentRoute: 'insurance' | 'private';
  insurerName: string | null;
  policyNumber: string | null;
  claimNumber: string | null;
  smsConsent: boolean;
  filesAttached: number;
};

/**
 * Escapes the five characters that matter, not the four `api/contact.ts` does.
 *
 * The apostrophe is the one it misses: a value interpolated into a
 * single-quoted attribute (`style='…'`, and every hand-written HTML email grows
 * one eventually) can break out of it without `&#39;`. Cheaper to escape now
 * than to remember the constraint on every future edit.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Collapses all whitespace, including newlines, to single spaces.
 *
 * `parseBookingPayload` trims a name but permits interior newlines, and the name
 * reaches the internal notification's `Subject:` line — the only customer-typed
 * string in either subject. Resend takes JSON over HTTPS rather than raw SMTP,
 * so this is not a header-injection hole, but a subject containing a newline is
 * a malformed subject and there is no reason to send one.
 */
export function headerSafe(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** `address, city, postal` — the one display string, blanks dropped. */
function fullAddress(input: BookingNotificationInput): string {
  return [input.address, input.city, input.postalCode].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Rendering helpers
//
// Hand-written table HTML with inline styles, matching `api/contact.ts`. Email
// clients have no `<style>` support worth relying on and no CSS framework is
// reaching them, so this is not a place to be clever.
// ---------------------------------------------------------------------------

const WRAP_OPEN =
  '<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:560px;">';
const WRAP_CLOSE = '</div>';

/**
 * A label/value row. **`value` is escaped**, because the default has to be the
 * safe one.
 *
 * The first draft took `value` as raw HTML and relied on every caller escaping.
 * Every caller did — but the next `row('Notes', input.whatever)` would be an
 * unescaped injection into an email body, and no assertion would catch it,
 * because the verify only knows about the fields that exist today. Use
 * `rawRow` where markup is genuinely intended; there are two such places and
 * both pass strings this module built.
 */
function row(label: string, value: string): string {
  return rawRow(label, escapeHtml(value));
}

/** `row`'s escape hatch. The caller owns the escaping of `html`. */
function rawRow(label: string, html: string): string {
  return [
    '<tr>',
    `<td style="padding:8px 12px;background:#f5f5f5;font-weight:600;width:140px;vertical-align:top;">${escapeHtml(label)}</td>`,
    `<td style="padding:8px 12px;border-bottom:1px solid #eee;">${html}</td>`,
    '</tr>',
  ].join('');
}

function table(rows: string[]): string {
  return `<table style="border-collapse:collapse;width:100%;">${rows.join('')}</table>`;
}

/** Multi-line free text: escaped, then newlines become breaks. */
function multiline(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------------------
// Customer confirmation
// ---------------------------------------------------------------------------

/**
 * The customer's copy. Carries the settled list and nothing else.
 *
 * Note what it does not read: `policyNumber`, `claimNumber`, `insurerName`.
 * Not reading them is the guarantee — see the module header.
 *
 * BK-16 hangs the customer's own calendar invite here. BK-14 deliberately left
 * this message attachment-free and recorded the follow-up; the client asked for
 * it, and it is not optional flourish — a `METHOD:CANCEL` only clears an event
 * a calendar already holds under the same UID, so without this attachment the
 * cancellation email BK-16 also adds would carry an artifact that clears
 * nothing. The two halves ship together for that reason.
 *
 * The ICS is built for the CUSTOMER audience: their address is the ATTENDEE,
 * and the description carries the reschedule line rather than their own phone
 * number. Same UID as the office's copy, on purpose — it is one event.
 */
function customerConfirmation(input: BookingNotificationInput): Message | null {
  if (!input.email) return null;

  const when = `${input.slotLabel} (${TIMEZONE_NOTE})`;
  const where = fullAddress(input);
  const reference = input.id > 0 ? `Reference #${input.id}` : null;

  /**
   * WHETHER THIS MESSAGE MAY CLAIM AN APPOINTMENT EXISTS (BK-23).
   *
   * A `request` is what submitting the form produces: the office has not looked
   * at it and nobody has paid. It gets no "you're booked" heading, no calendar
   * invite, and no line about one. A `confirmed` message is sent from behind
   * the payment webhook, where every one of those is true.
   *
   * Keyed off `messageType` rather than off a separate flag, so the thing that
   * decides the idempotency key and the thing that decides the claim cannot
   * disagree — a message that says "booked" under a `request` key would be both
   * wrong and undeliverable.
   */
  const isRequest = input.messageType === 'request';

  const html = [
    WRAP_OPEN,
    isRequest
      ? `<h1 style="font-size:22px;margin:0 0 16px;">${escapeHtml(`${RECEIVED_HEADING}, ${input.name}`)}</h1>`
      : `<h1 style="font-size:22px;margin:0 0 16px;">You're booked, ${escapeHtml(input.name)}</h1>`,
    isRequest
      ? `<p style="margin:0 0 16px;">${escapeHtml(RECEIVED_LEAD)}</p>`
      : `<p style="margin:0 0 16px;">Thanks for booking an assessment with YEG Restoration. Here are the details.</p>`,
    table(
      [
        rawRow('When', `<strong>${escapeHtml(when)}</strong>`),
        row('Where', where),
        row('Service', input.serviceLabel),
        reference ? row('Reference', reference) : '',
      ].filter(Boolean),
    ),
    `<p style="margin:16px 0;">${escapeHtml(VISIT_LENGTH_LINE)}</p>`,
    // What happens next, request only. The confirmed message has no next step
    // to describe, and the request message is useless without one — "we have
    // your request" with no account of what follows is the message that
    // generates the phone call this flow was meant to avoid.
    ...(isRequest
      ? [
          `<p style="margin:16px 0;">${escapeHtml(RECEIVED_HOLD_LINE)}</p>`,
          '<ol style="margin:0 0 16px;padding-left:20px;">',
          ...RECEIVED_NEXT_STEPS.map((step) => `<li style="margin:4px 0;">${escapeHtml(step)}</li>`),
          '</ol>',
          `<p style="margin:16px 0;">${escapeHtml(RECEIVED_TIMING_LINE)}</p>`,
        ]
      : []),
    `<h2 style="font-size:16px;margin:24px 0 8px;">${escapeHtml(HAVE_READY_HEADING)}</h2>`,
    '<ul style="margin:0 0 16px;padding-left:20px;">',
    ...HAVE_READY_ITEMS.map((item) => `<li style="margin:4px 0;">${escapeHtml(item)}</li>`),
    '</ul>',
    // BK-27. The terms the customer ticked a box to acknowledge, written back
    // to them in the message they keep. It is static copy — no field on
    // `BookingNotificationInput` — because it documents what the form said at
    // submission, not a per-booking value; the acknowledgment itself is the
    // `terms_acked_at` stamp on the row.
    //
    // BK-23 made that split, and kept this section in BOTH messages. The
    // request message carries it because that is the moment the box was ticked;
    // the confirmed message carries it because it is the one the customer keeps
    // after paying, and terms that vanish from the record of a completed
    // purchase are terms nobody can point at afterwards.
    `<h2 style="font-size:16px;margin:24px 0 8px;">${escapeHtml(FEE_TERMS_HEADING)}</h2>`,
    `<p style="margin:0 0 8px;">${escapeHtml(FEE_TERMS_INTRO)}</p>`,
    '<ul style="margin:0 0 16px;padding-left:20px;">',
    ...FEE_TERMS_ITEMS.map((item) => `<li style="margin:4px 0;">${escapeHtml(item)}</li>`),
    '</ul>',
    ...FEE_TERMS_OUTRO.map((line) => `<p style="margin:0 0 8px;">${escapeHtml(line)}</p>`),
    // BK-31. The tier list above is the menu; this is what THIS customer chose
    // and what it comes to. Written back to them in the message they keep,
    // because the figure on the form is the one thing they cannot re-check
    // later — the form is gone and the terms box states standard prices.
    ...(input.assessmentTier
      ? [`<p style="margin:0 0 8px;"><strong>${escapeHtml(`You chose: ${assessmentSummary(input)}`)}</strong></p>`]
      : []),
    // NO INVITE ON A REQUEST. An .ics for an unpaid slot is the "you're booked"
    // claim in a form the customer's calendar repeats back to them every day
    // until the appointment — worse than the sentence, because nothing about a
    // calendar entry says "provisional". The attachment itself is gated
    // alongside this line; see the `attachments` array below.
    ...(isRequest ? [] : [`<p style="margin:16px 0;">${escapeHtml(CALENDAR_ATTACHED_LINE)}</p>`]),
    `<p style="margin:16px 0;">${escapeHtml(CANCEL_LINE)}</p>`,
    `<p style="margin:24px 0 0;color:#666;font-size:13px;">YEG Restoration · ${escapeHtml(SUPPORT_PHONE)}</p>`,
    WRAP_CLOSE,
  ].join('');

  const text = [
    isRequest ? `${RECEIVED_HEADING}, ${input.name}` : `You're booked, ${input.name}`,
    '',
    isRequest ? RECEIVED_LEAD : 'Thanks for booking an assessment with YEG Restoration. Here are the details.',
    '',
    `When:      ${when}`,
    `Where:     ${where}`,
    `Service:   ${input.serviceLabel}`,
    ...(reference ? [`${reference}`] : []),
    '',
    VISIT_LENGTH_LINE,
    '',
    ...(isRequest
      ? [
          RECEIVED_HOLD_LINE,
          '',
          ...RECEIVED_NEXT_STEPS.map((step, i) => `  ${i + 1}. ${step}`),
          '',
          RECEIVED_TIMING_LINE,
          '',
        ]
      : []),
    `${HAVE_READY_HEADING}:`,
    ...HAVE_READY_ITEMS.map((item) => `  - ${item}`),
    '',
    `${FEE_TERMS_HEADING}:`,
    FEE_TERMS_INTRO,
    ...FEE_TERMS_ITEMS.map((item) => `  - ${item}`),
    ...FEE_TERMS_OUTRO.flatMap((line) => ['', line]),
    ...(input.assessmentTier ? ['', `You chose: ${assessmentSummary(input)}`] : []),
    ...(isRequest ? [] : ['', CALENDAR_ATTACHED_LINE]),
    '',
    CANCEL_LINE,
    '',
    `YEG Restoration · ${SUPPORT_PHONE}`,
  ].join('\n');

  return {
    from: BOOKING_EMAIL_FROM,
    to: input.email,
    // The sender is `noreply`, so without this a customer replying to ask about
    // the time is talking to nobody. Cancellation is phone-in, but people reply
    // to confirmations regardless.
    replyTo: BOOKING_EMAIL_REPLY_TO,
    subject: headerSafe(
      isRequest
        ? `${RECEIVED_HEADING} — ${input.slotLabel} (${TIMEZONE_NOTE})`
        : `You're booked — ${input.slotLabel} (${TIMEZONE_NOTE})`,
    ),
    html,
    text,
    // THE INVITE MOVES TO PAYMENT-CONFIRMED (BK-23), and this is the line that
    // moves it. `'request'` here is the iCalendar METHOD, not the message type
    // — an unfortunate collision of words, and worth being clear about, because
    // `isRequest` being true is exactly when this attachment must NOT be built.
    //
    // Spreading an empty array rather than passing `attachments: undefined`:
    // `createResendSender` maps the field with `...(message.attachments ? ...)`,
    // so an absent key and an empty array behave the same at the SDK boundary,
    // and the absent key is what the type already means by "no attachments".
    ...(isRequest
      ? {}
      : {
          attachments: [
            icsAttachment(
              buildBookingIcs(icsEventOf(input), 'request', input.now, icsCustomer(input.email)),
              'request',
              input.id,
            ),
          ],
        }),
  };
}

// ---------------------------------------------------------------------------
// Approval and decline (BK-23)
//
// Both are customer-only: the office just performed the action, so mailing them
// about their own click is noise. Both are built here rather than in the route
// for the reason every other message is — one module owns the copy, the
// escaping and the PII rules, and `policy_number` / `claim_number` reach none of
// them.
// ---------------------------------------------------------------------------

/** What the approval message needs beyond the booking itself. */
export type ApprovalDetails = {
  /** The itemised amounts as the office settled them, in cents. */
  baseCents: number;
  travelCents: number;
  gstCents: number;
  totalCents: number;
  /** When payment is due, or null when it is due immediately (pay-now). */
  dueAt: Date | null;
  /**
   * The hosted checkout URL, or null when no card payment is configured.
   *
   * BK-32 supplies it. Null is not an error state: the Interac route below is a
   * complete way to pay, confirmed by the client, so a message with no card
   * link still asks for money in a way the customer can act on. What must never
   * happen is a message with neither.
   */
  paymentUrl: string | null;
  /** Where an e-Transfer goes, or null if the client has not given one. */
  interacEmail: string | null;
};

/**
 * The approval: what it costs, when it is due, and what happens if it is not
 * paid.
 *
 * Returns null when the booking has no email address. An approval nobody can
 * receive is not an approval, and the route treats the null as a refusal to
 * transition rather than as a message it may skip — see `review.ts`.
 */
export function approvalMessage(
  input: BookingNotificationInput,
  details: ApprovalDetails,
): Message | null {
  if (!input.email) return null;

  const when = `${input.slotLabel} (${TIMEZONE_NOTE})`;
  const deadlineLabel = details.dueAt
    ? `${formatSlot(details.dueAt)} (${TIMEZONE_NOTE})`
    : null;

  // THE MESSAGE MUST OFFER AT LEAST ONE WAY TO PAY. Asserted here rather than
  // left to the caller, because "approved, pay us, no idea how" is a message
  // that generates a phone call for every single booking it goes out on.
  const ways: string[] = [];
  if (details.paymentUrl) ways.push('card');
  if (details.interacEmail) ways.push('interac');

  const amountRows = [
    row('Assessment', formatCents(details.baseCents)),
    // A zero travel fee renders NO row rather than "$0.00". A line item for
    // nothing invites the question of what it might have been.
    details.travelCents > 0 ? row('Travel', formatCents(details.travelCents)) : '',
    row('GST', formatCents(details.gstCents)),
    rawRow('Total', `<strong>${escapeHtml(formatCents(details.totalCents))}</strong>`),
  ].filter(Boolean);

  const html = [
    WRAP_OPEN,
    `<h1 style="font-size:22px;margin:0 0 16px;">${escapeHtml(APPROVED_HEADING)}, ${escapeHtml(input.name)}</h1>`,
    `<p style="margin:0 0 16px;">${escapeHtml(APPROVED_LEAD)}</p>`,
    table([
      rawRow('When', `<strong>${escapeHtml(when)}</strong>`),
      row('Where', fullAddress(input)),
      row('Service', input.serviceLabel),
      input.id > 0 ? row('Reference', `#${input.id}`) : '',
    ].filter(Boolean)),
    `<h2 style="font-size:16px;margin:24px 0 8px;">Amount</h2>`,
    table(amountRows),
    ...(deadlineLabel
      ? [
          `<p style="margin:16px 0;"><strong>${escapeHtml(`Please pay by ${deadlineLabel}.`)}</strong></p>`,
          `<p style="margin:0 0 16px;">${escapeHtml(APPROVED_DEADLINE_NOTE)}</p>`,
        ]
      : [`<p style="margin:16px 0;">${escapeHtml(APPROVED_PAY_NOW_NOTE)}</p>`]),
    ...(details.paymentUrl
      ? [
          `<p style="margin:24px 0;"><a href="${escapeHtml(details.paymentUrl)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Pay ${escapeHtml(formatCents(details.totalCents))}</a></p>`,
        ]
      : []),
    ...(details.interacEmail
      ? [
          `<p style="margin:16px 0;">${escapeHtml(APPROVED_INTERAC_LEAD)} ${escapeHtml(
            `Send ${formatCents(details.totalCents)} to ${details.interacEmail} and put your booking number #${input.id} in the message so we can match it.`,
          )}</p>`,
        ]
      : []),
    `<p style="margin:16px 0;">${escapeHtml(CANCEL_LINE)}</p>`,
    `<p style="margin:24px 0 0;color:#666;font-size:13px;">YEG Restoration · ${escapeHtml(SUPPORT_PHONE)}</p>`,
    WRAP_CLOSE,
  ].join('');

  const text = [
    `${APPROVED_HEADING}, ${input.name}`,
    '',
    APPROVED_LEAD,
    '',
    `When:      ${when}`,
    `Where:     ${fullAddress(input)}`,
    `Service:   ${input.serviceLabel}`,
    ...(input.id > 0 ? [`Reference: #${input.id}`] : []),
    '',
    'Amount',
    `  Assessment  ${formatCents(details.baseCents)}`,
    ...(details.travelCents > 0 ? [`  Travel      ${formatCents(details.travelCents)}`] : []),
    `  GST         ${formatCents(details.gstCents)}`,
    `  Total       ${formatCents(details.totalCents)}`,
    '',
    ...(deadlineLabel
      ? [`Please pay by ${deadlineLabel}.`, '', APPROVED_DEADLINE_NOTE]
      : [APPROVED_PAY_NOW_NOTE]),
    ...(details.paymentUrl ? ['', `Pay here: ${details.paymentUrl}`] : []),
    ...(details.interacEmail
      ? [
          '',
          `${APPROVED_INTERAC_LEAD} Send ${formatCents(details.totalCents)} to ${details.interacEmail} and put your booking number #${input.id} in the message so we can match it.`,
        ]
      : []),
    '',
    CANCEL_LINE,
    '',
    `YEG Restoration · ${SUPPORT_PHONE}`,
  ].join('\n');

  return {
    from: BOOKING_EMAIL_FROM,
    to: input.email,
    replyTo: BOOKING_EMAIL_REPLY_TO,
    subject: headerSafe(
      `${APPROVED_HEADING} — ${formatCents(details.totalCents)} to confirm ${input.slotLabel}`,
    ),
    html,
    text,
    // NO CALENDAR INVITE. Approval is not confirmation; the invite goes out
    // behind the payment, from `messageType: 'confirmed'`.
  };
}

/**
 * The decline. One reason, no menu, and a route back in.
 *
 * Returns null when there is no email address — the office declines those by
 * phone, which is how they were taken.
 */
export function declineMessage(input: BookingNotificationInput): Message | null {
  if (!input.email) return null;

  const when = `${input.slotLabel} (${TIMEZONE_NOTE})`;

  const html = [
    WRAP_OPEN,
    `<h1 style="font-size:22px;margin:0 0 16px;">${escapeHtml(DECLINED_HEADING)}</h1>`,
    `<p style="margin:0 0 16px;">${escapeHtml(DECLINED_LEAD)}</p>`,
    table([
      rawRow('Requested', `<strong>${escapeHtml(when)}</strong>`),
      row('Service', input.serviceLabel),
      input.id > 0 ? row('Reference', `#${input.id}`) : '',
    ].filter(Boolean)),
    `<p style="margin:16px 0;">${escapeHtml(DECLINED_REBOOK_LINE)}</p>`,
    `<p style="margin:24px 0 0;color:#666;font-size:13px;">YEG Restoration · ${escapeHtml(SUPPORT_PHONE)}</p>`,
    WRAP_CLOSE,
  ].join('');

  const text = [
    DECLINED_HEADING,
    '',
    DECLINED_LEAD,
    '',
    `Requested: ${when}`,
    `Service:   ${input.serviceLabel}`,
    ...(input.id > 0 ? [`Reference: #${input.id}`] : []),
    '',
    DECLINED_REBOOK_LINE,
    '',
    `YEG Restoration · ${SUPPORT_PHONE}`,
  ].join('\n');

  return {
    from: BOOKING_EMAIL_FROM,
    to: input.email,
    replyTo: BOOKING_EMAIL_REPLY_TO,
    subject: headerSafe(`About your assessment request — ${input.slotLabel}`),
    html,
    text,
  };
}

/**
 * Whether an approval message can be sent at all.
 *
 * Exported so the route can refuse the TRANSITION rather than perform it and
 * then discover the message cannot go. An approved booking whose customer was
 * never told is worse than a request left pending: the slot is held, the clock
 * is running, and nobody is coming.
 */
export function canOfferPayment(details: Pick<ApprovalDetails, 'paymentUrl' | 'interacEmail'>): boolean {
  return details.paymentUrl !== null || details.interacEmail !== null;
}

// ---------------------------------------------------------------------------
// Internal notification
// ---------------------------------------------------------------------------

/**
 * What the Email row says when the booking carries no address (BK-21).
 *
 * A bare `—` is what got read past on booking #25: the office hit Reply to send
 * a DocuSeal link, the notice had no `Reply-To` but the `noreply@` sender, and
 * Google bounced it 550. The row now carries all three facts — no address was
 * given, the customer cannot be reached by email at all, and a reply to this
 * notice lands at the office. Internal copy; no customer ever sees it.
 */
const NO_EMAIL_NOTICE =
  '— (none given — customer is NOT reachable by email; replies to this message go to the office)';

/** The same line, wrapped to the text part's 13-column label gutter. */
const NO_EMAIL_NOTICE_TEXT =
  '— (none given — customer is NOT reachable by email;\n             replies to this message go to the office)';

/**
 * The office's copy: everything, including the insurance identifiers.
 *
 * This is what replaces "open the database to find out a crew is expected
 * somewhere", so it errs toward completeness. It is not a "confirmation" and is
 * not bound by the settled customer copy list.
 *
 * BK-14 hangs the calendar invite here rather than sending a second email:
 * every public booking already produces exactly this message, and one office
 * email carrying the ICS is one thing to read. The ICS itself is bound by a
 * STRICTER rule than this message body — no policy or claim number in a
 * calendar artifact, for any audience, even the office that reads them three
 * rows above. See `booking-ics.ts`.
 */
/**
 * The tier and what it costs, as one line.
 *
 * Built from `assessmentQuote` rather than from a figure anybody typed, so the
 * office email, the customer email and the eventual Stripe line items all come
 * from one computation. Weekend slots and mould jobs are exactly the cases a
 * hand-written "$399 + GST" would get wrong.
 */
function assessmentSummary(input: BookingNotificationInput): string {
  if (!input.assessmentTier) return 'Not chosen (phone booking — settle with the customer)';
  const quote = assessmentQuote({
    tier: input.assessmentTier,
    service: input.service,
    slotStart: input.slotStart,
  });
  const name = ASSESSMENT_TIER_NAMES[input.assessmentTier];
  const weekend = quote.afterHours ? ' — weekend rate, 1.5x' : '';
  return `${name} — ${formatCents(quote.baseCents)} + GST (${formatCents(quote.totalCents)} total)${weekend}`;
}

function internalNotification(input: BookingNotificationInput): Message {
  const insurance = input.paymentRoute === 'insurance';
  const isRequest = input.messageType === 'request';
  const dash = '—';
  const or = (value: string | null) => value ?? dash;

  const rows = [
    rawRow('When', `<strong>${escapeHtml(`${input.slotLabel} (${TIMEZONE_NOTE})`)}</strong>`),
    row('Booking', `#${input.id}`),
    row('Name', input.name),
    row('Phone', input.phone),
    // Not `or()` — that helper feeds the Insurer/Policy/Claim rows below, where
    // a bare dash is the right answer. Only the Email row is a dead end worth
    // shouting about. `row` escapes, like every other row here.
    row('Email', input.email || NO_EMAIL_NOTICE),
    row('Service', input.serviceLabel),
    // BK-31. The office is about to approve this and set an amount, so the tier
    // and the computed price belong on the message they decide from. "Not
    // chosen" rather than a blank: an admin entry legitimately has none, and a
    // blank row reads as a rendering fault.
    row('Assessment', assessmentSummary(input)),
    row('Address', fullAddress(input)),
    row('Payment', insurance ? 'Insurance claim' : 'Private pay'),
  ];

  // Dropped entirely on the private route rather than shown empty — stale form
  // state cannot persist a claim number past `parseBookingPayload`, and an
  // "Insurer: —" row on a private-pay job invites the reader to wonder.
  if (insurance) {
    rows.push(
      row('Insurer', or(input.insurerName)),
      row('Policy #', or(input.policyNumber)),
      row('Claim #', or(input.claimNumber)),
    );
  }

  rows.push(
    rawRow('Description', input.description ? multiline(input.description) : dash),
    row('Photos/video', String(input.filesAttached)),
    row('SMS consent', input.smsConsent ? 'Yes' : 'No'),
  );

  const html = [
    WRAP_OPEN,
    '<h1 style="font-size:20px;margin:0 0 16px;">New booking</h1>',
    table(rows),
    input.filesAttached > 0
      ? '<p style="margin:16px 0 0;color:#666;font-size:13px;">Uploaded files are in the admin panel — the Blob store is private, so there is no direct link.</p>'
      : '',
    WRAP_CLOSE,
  ].join('');

  const text = [
    `New booking #${input.id}`,
    '',
    `When:        ${input.slotLabel} (${TIMEZONE_NOTE})`,
    `Name:        ${input.name}`,
    `Phone:       ${input.phone}`,
    `Email:       ${input.email || NO_EMAIL_NOTICE_TEXT}`,
    `Service:     ${input.serviceLabel}`,
    `Address:     ${fullAddress(input)}`,
    `Payment:     ${insurance ? 'Insurance claim' : 'Private pay'}`,
    ...(insurance
      ? [
          `Insurer:     ${or(input.insurerName)}`,
          `Policy #:    ${or(input.policyNumber)}`,
          `Claim #:     ${or(input.claimNumber)}`,
        ]
      : []),
    `Photos:      ${input.filesAttached}`,
    `SMS consent: ${input.smsConsent ? 'Yes' : 'No'}`,
    '',
    'Description:',
    input.description ?? dash,
  ].join('\n');

  return {
    from: BOOKING_EMAIL_FROM,
    to: BOOKING_INTERNAL_TO,
    // Reply goes to the customer when there is one, and to the office when
    // there is not — never absent, because absent means a reply falls back to
    // the `noreply@` From and bounces 550 (BK-21, booking #25). `||` and not
    // `??`: an empty string is a Resend API error, and `''` is a live value in
    // this codebase's email plumbing (`contact-message.ts` admits it).
    replyTo: input.email || BOOKING_EMAIL_REPLY_TO,
    // The name is here on purpose. The office wants to see who at a glance —
    // and it is the ONLY customer-typed string in either subject, which is what
    // makes `headerSafe` load-bearing rather than decorative. The customer's own
    // subject is built entirely from constants and server-formatted values.
    subject: headerSafe(
      isRequest
        ? `NEW REQUEST #${input.id} — ${input.name} — ${input.serviceLabel} — ${input.slotLabel}`
        : `New booking #${input.id} — ${input.name} — ${input.serviceLabel} — ${input.slotLabel}`,
    ),
    html,
    text,
    // THE OFFICE INVITE MOVES TOO (P9, 2026-08-16), not only the customer's.
    //
    // If it stayed at request time the office calendar would fill with slots
    // that may be declined or never paid — and there is no CANCEL to clear them
    // on either path, because a row that reaches `declined` from
    // `pending_review` never had an invite to cancel. The office already sees
    // pending requests in the admin queue and in this very email; the calendar
    // should carry only real visits.
    //
    // This was flagged as a behaviour change from what P7 implied rather than
    // assumed silently — see prepay-flow-spec.md section 6, item 7.
    ...(isRequest
      ? {}
      : {
          attachments: [
            icsAttachment(
              buildBookingIcs(icsEventOf(input), 'request', input.now, ICS_OFFICE),
              'request',
              input.id,
            ),
          ],
        }),
  };
}

/**
 * The invite's view of a booking. Written as an explicit field list rather than
 * a spread so the two insurance identifiers cannot arrive by accident — the
 * locked rule in `booking-ics.ts` is a property of what is handed in as much as
 * of what the builder reads.
 */
function icsEventOf(input: BookingNotificationInput): IcsEvent {
  return {
    id: input.id,
    name: input.name,
    serviceLabel: input.serviceLabel,
    phone: input.phone,
    address: input.address,
    city: input.city,
    postalCode: input.postalCode,
    slotStart: input.slotStart,
  };
}

export function planBookingNotifications(input: BookingNotificationInput): NotificationPlan {
  return {
    bookingId: input.id,
    messageType: input.messageType,
    customer: customerConfirmation(input),
    internal: internalNotification(input),
  };
}
