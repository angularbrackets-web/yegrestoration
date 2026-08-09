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
  CANCEL_LINE,
  HAVE_READY_HEADING,
  HAVE_READY_ITEMS,
  TIMEZONE_NOTE,
  VISIT_LENGTH_LINE,
} from './booking-copy';

/** One outbound message, fully rendered. The adapter adds nothing but the API key. */
export type Message = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

export type NotificationPlan = {
  /** The appointment id, carried so the sender can key idempotency on it. */
  bookingId: number;
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
  /** Server-formatted, America/Edmonton. Never re-derived here. */
  slotLabel: string;
  name: string;
  phone: string;
  email: string | null;
  /** Display label, not the key — `SERVICE_LABELS[service]`. */
  serviceLabel: string;
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
 */
function customerConfirmation(input: BookingNotificationInput): Message | null {
  if (!input.email) return null;

  const when = `${input.slotLabel} (${TIMEZONE_NOTE})`;
  const where = fullAddress(input);
  const reference = input.id > 0 ? `Reference #${input.id}` : null;

  const html = [
    WRAP_OPEN,
    `<h1 style="font-size:22px;margin:0 0 16px;">You're booked, ${escapeHtml(input.name)}</h1>`,
    `<p style="margin:0 0 16px;">Thanks for booking an assessment with YEG Restoration. Here are the details.</p>`,
    table(
      [
        rawRow('When', `<strong>${escapeHtml(when)}</strong>`),
        row('Where', where),
        row('Service', input.serviceLabel),
        reference ? row('Reference', reference) : '',
      ].filter(Boolean),
    ),
    `<p style="margin:16px 0;">${escapeHtml(VISIT_LENGTH_LINE)}</p>`,
    `<h2 style="font-size:16px;margin:24px 0 8px;">${escapeHtml(HAVE_READY_HEADING)}</h2>`,
    '<ul style="margin:0 0 16px;padding-left:20px;">',
    ...HAVE_READY_ITEMS.map((item) => `<li style="margin:4px 0;">${escapeHtml(item)}</li>`),
    '</ul>',
    `<p style="margin:16px 0;">${escapeHtml(CANCEL_LINE)}</p>`,
    `<p style="margin:24px 0 0;color:#666;font-size:13px;">YEG Restoration · ${escapeHtml(SUPPORT_PHONE)}</p>`,
    WRAP_CLOSE,
  ].join('');

  const text = [
    `You're booked, ${input.name}`,
    '',
    'Thanks for booking an assessment with YEG Restoration. Here are the details.',
    '',
    `When:      ${when}`,
    `Where:     ${where}`,
    `Service:   ${input.serviceLabel}`,
    ...(reference ? [`${reference}`] : []),
    '',
    VISIT_LENGTH_LINE,
    '',
    `${HAVE_READY_HEADING}:`,
    ...HAVE_READY_ITEMS.map((item) => `  - ${item}`),
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
    subject: headerSafe(`You're booked — ${input.slotLabel} (${TIMEZONE_NOTE})`),
    html,
    text,
  };
}

// ---------------------------------------------------------------------------
// Internal notification
// ---------------------------------------------------------------------------

/**
 * The office's copy: everything, including the insurance identifiers.
 *
 * This is what replaces "open the database to find out a crew is expected
 * somewhere", so it errs toward completeness. It is not a "confirmation" and is
 * not bound by the settled customer copy list.
 */
function internalNotification(input: BookingNotificationInput): Message {
  const insurance = input.paymentRoute === 'insurance';
  const dash = '—';
  const or = (value: string | null) => value ?? dash;

  const rows = [
    rawRow('When', `<strong>${escapeHtml(`${input.slotLabel} (${TIMEZONE_NOTE})`)}</strong>`),
    row('Booking', `#${input.id}`),
    row('Name', input.name),
    row('Phone', input.phone),
    row('Email', or(input.email)),
    row('Service', input.serviceLabel),
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
    `Email:       ${or(input.email)}`,
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
    // Reply goes to the customer when there is one, matching `api/contact.ts`.
    ...(input.email ? { replyTo: input.email } : {}),
    // The name is here on purpose. The office wants to see who at a glance —
    // and it is the ONLY customer-typed string in either subject, which is what
    // makes `headerSafe` load-bearing rather than decorative. The customer's own
    // subject is built entirely from constants and server-formatted values.
    subject: headerSafe(
      `New booking #${input.id} — ${input.name} — ${input.serviceLabel} — ${input.slotLabel}`,
    ),
    html,
    text,
  };
}

export function planBookingNotifications(input: BookingNotificationInput): NotificationPlan {
  return {
    bookingId: input.id,
    customer: customerConfirmation(input),
    internal: internalNotification(input),
  };
}
