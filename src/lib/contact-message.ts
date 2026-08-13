/**
 * The contact form's message: what a valid submission is, what the office
 * receives, and — the part that matters — what the visitor is told.
 *
 * BK-10 demoted the form from "get a quote" to "send us a message". `/book/`
 * is the quote path now, and this is the only *written* channel left, which is
 * why the decision logic lives here rather than in the route body.
 *
 * THE TRUTH TABLE, and why send is the source of truth. The office works from
 * its inbox; the `leads` row is the admin surface's record of the same thing.
 * So:
 *
 *   | what happened                        | outcome           | visitor sees |
 *   | ------------------------------------ | ----------------- | ------------ |
 *   | send ok                              | ok / 'sent'       | success      |
 *   | send resolved `{ error }`, or threw  | failed            | 500          |
 *   | no API key (checked before any send) | failed            | 500          |
 *   | mail muted (`BOOKING_NOTIFY_DISABLED`)| ok / 'skipped'   | success      |
 *
 * A DB-write failure is logged and changes nothing: the message reached the
 * inbox, and telling the visitor otherwise would cost the lead. A send failure
 * is a 500 even when the row landed — a retried duplicate is visible in admin
 * and costs nothing, while a false success is a lead lost forever. That
 * inversion is deliberate; `api/contact.ts` before this ticket did the exact
 * opposite by accident, because **the Resend SDK never throws — it resolves
 * with `{ data: null, error }`** (ROADMAP, confirmed against resend@6.17.1's
 * installed source), so `try { await send() } catch` caught nothing and every
 * bounced key reached the visitor as "message sent".
 *
 * WHY DEPS ARE INJECTED, all three of them, with no defaults. Decision logic
 * in a route body is unobservable here: `BOOKING_NOTIFY_DISABLED` silences
 * injected seams too (the BK-08 lesson recorded at the top of
 * `verify-booking-admin-db.ts`), so a route-level script running under the mute
 * can only ever see the `skipped` arm. Driving `deps.send` directly is what
 * makes the other three assertable — see `scripts/verify-contact.ts`, which
 * says per assert whether it runs lib-level or route-level.
 */

import { z } from 'zod';

import { BOOKING_EMAIL_FROM, BOOKING_EMAIL_REPLY_TO, BOOKING_INTERNAL_TO } from './booking-config';
import { escapeHtml, type Message } from './booking-email';
import { mailDisabled, type SendResult } from './booking-notify';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * What the form may send.
 *
 * Two fields changed at cutover and they moved in opposite directions:
 *
 *   - `service` became OPTIONAL. Someone asking whether a smell is worth a
 *     call has no service to pick, and forcing one writes a wrong label onto a
 *     real lead. Migration 004 drops the matching `NOT NULL`, and the two must
 *     ship in that order — see `004-lead-service-optional.ts`.
 *   - `message` became REQUIRED. It is a message form; an optional message
 *     collects empty rows, and name-and-phone-only outreach is what the phone
 *     line is for.
 *
 * `z.email()` rather than the deprecated `z.string().email()`: the line was
 * being rewritten anyway, and the old spelling is one of the `astro check`
 * hints the ROADMAP has owed since BK-12.
 */
export const contactSchema = z.object({
  // `.trim()` before `.min()`, or a name of two spaces is a valid name.
  name: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.email().optional().or(z.literal('')),
  // The same spelling as `email`. A bare `z.string()` already admits `''`, so
  // the literal arm is belt-and-braces — but the Svelte form initializes
  // `service: ''` and sends it on every submit, and the two optional fields
  // reading identically is worth more than the redundancy costs.
  service: z.string().optional().or(z.literal('')),
  message: z.string().trim().min(1),
});

export type ContactSubmission = z.infer<typeof contactSchema>;

/** A submission with the empty strings resolved to the nulls the table stores. */
export type ContactMessage = {
  name: string;
  phone: string;
  email: string | null;
  /** NULL is a real, expected value since BK-10. Every consumer must guard it. */
  service: string | null;
  message: string;
};

/**
 * Parse, or say which it was. Returns the normalized record so no caller has
 * to remember that `''` and absent both mean "not given".
 */
export function parseContactSubmission(
  body: unknown,
): { ok: true; message: ContactMessage } | { ok: false } {
  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) return { ok: false };

  const { name, phone, email, service, message } = parsed.data;
  return {
    ok: true,
    message: {
      name: name.trim(),
      phone: phone.trim(),
      email: email ? email.trim() : null,
      service: service && service.trim() !== '' ? service.trim() : null,
      message: message.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// The message the office receives
// ---------------------------------------------------------------------------

/** "New message — Mold Removal", or just "New message" when none was picked. */
export function contactSubject(serviceLabel: string | null): string {
  return serviceLabel ? `New message — ${serviceLabel}` : 'New message';
}

const CELL = 'padding:8px 12px;border-bottom:1px solid #eee;';
const HEAD = 'padding:8px 12px;background:#f5f5f5;font-weight:600;';

function row(label: string, value: string): string {
  return `<tr><td style="${HEAD}">${label}</td><td style="${CELL}">${value}</td></tr>`;
}

/**
 * What the Email row says when the enquiry carries no address (BK-21).
 *
 * The same line the booking notice grew, in this file's voice — the visitor is
 * not a customer yet. A bare `—` reads as "nothing to see"; what it actually
 * means is that hitting Reply cannot reach this person, and used to bounce off
 * `noreply@` rather than say so. Three facts: no address was given, the visitor
 * is unreachable by email, replies land at the office. Internal copy only.
 */
const NO_EMAIL_NOTICE =
  '— (none given — visitor is NOT reachable by email; replies to this message go to the office)';

/** The same line, wrapped to the text part's 9-column label gutter. */
const NO_EMAIL_NOTICE_TEXT =
  '— (none given — visitor is NOT reachable by email;\n         replies to this message go to the office)';

/**
 * The internal notification, as a value.
 *
 * `serviceLabel` is passed in already resolved rather than looked up here:
 * `SERVICE_LABELS` lives in `db.ts` next to the Neon import, and reaching for
 * it would put this module out of reach of a `tsx` verify script. Same reason
 * `booking-admin-notify.ts` injects its label.
 *
 * `escapeHtml` is `booking-email.ts`'s — the five-character version, which
 * escapes the apostrophe. The four-character copy this file replaced did not,
 * and there is no reason for two.
 */
export function buildContactEmail(message: ContactMessage, serviceLabel: string | null): Message {
  const subject = contactSubject(serviceLabel);
  const serviceText = serviceLabel ?? 'Not specified';

  return {
    from: BOOKING_EMAIL_FROM,
    to: BOOKING_INTERNAL_TO,
    // Replying to the notification reaches the person who wrote it, or the
    // office when they gave no address — never absent, because absent means a
    // reply falls back to the `noreply@` From and bounces 550 (BK-21). `||`
    // and not `??`: the schema above admits `''`, and an empty `replyTo` is an
    // API error.
    replyTo: message.email || BOOKING_EMAIL_REPLY_TO,
    subject,
    html: `
        <h2 style="font-family:sans-serif;margin-bottom:16px;">${escapeHtml(subject)}</h2>
        <table style="font-family:sans-serif;border-collapse:collapse;width:100%;max-width:500px;">
          ${row('Name', escapeHtml(message.name))}
          ${row('Phone', escapeHtml(message.phone))}
          ${row('Email', escapeHtml(message.email || NO_EMAIL_NOTICE))}
          ${row('Service', escapeHtml(serviceText))}
          <tr>
            <td style="${HEAD}vertical-align:top;">Message</td>
            <td style="padding:8px 12px;">${escapeHtml(message.message).replace(/\n/g, '<br>')}</td>
          </tr>
        </table>
      `,
    text: [
      subject,
      '',
      `Name:    ${message.name}`,
      `Phone:   ${message.phone}`,
      `Email:   ${message.email || NO_EMAIL_NOTICE_TEXT}`,
      `Service: ${serviceText}`,
      `Message: ${message.message}`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** What the send did. `skipped` is the mute, and is test-only by construction. */
export type ContactDelivery = 'sent' | 'skipped' | 'failed';

export type ContactOutcome =
  | { ok: true; delivery: 'sent' | 'skipped' }
  | { ok: false; delivery: 'failed'; error: string };

export type ContactDeps = {
  /**
   * Resolves a service id to its display label. Injected — see
   * `buildContactEmail`.
   */
  labelFor: (service: string) => string;
  /**
   * Records the message. Best-effort: its failure is logged loudly and does
   * NOT change the outcome, because the office reads the inbox.
   */
  insert: (message: ContactMessage) => Promise<void>;
  /**
   * The send. `null` means `RESEND_API_KEY` is unset — a `failed` arm the
   * route cannot reach past, checked before anything is attempted.
   */
  send: ((message: Message) => Promise<SendResult>) | null;
};

/**
 * Record it, send it, and report which of the four arms happened.
 *
 * Order is load-bearing. The insert runs FIRST and unconditionally, so a
 * missing key or a muted run still leaves the office a row to find; the mute
 * is checked next, so a test run cannot mail the client's real inbox; and the
 * key check is last before the send, so "no key" is logged as itself rather
 * than as a send failure.
 */
export async function handleContactMessage(
  message: ContactMessage,
  deps: ContactDeps,
): Promise<ContactOutcome> {
  try {
    await deps.insert(message);
  } catch (err) {
    // Loud, and deliberately not fatal. The visitor's message is still going
    // out; what was lost is the admin surface's copy of it.
    console.error('Contact message: the lead row was NOT written:', err);
  }

  if (mailDisabled()) {
    console.error('BOOKING_NOTIFY_DISABLED is set — the contact message was not sent.');
    return { ok: true, delivery: 'skipped' };
  }

  if (!deps.send) {
    console.error('RESEND_API_KEY is not configured — the contact message was not sent.');
    return { ok: false, delivery: 'failed', error: 'RESEND_API_KEY is not configured' };
  }

  const serviceLabel = message.service ? deps.labelFor(message.service) : null;

  try {
    const result = await deps.send(buildContactEmail(message, serviceLabel));
    if (result.ok) return { ok: true, delivery: 'sent' };
    const error = result.error ?? 'unknown error';
    console.error(`Contact message from ${message.phone} failed to send: ${error}`);
    return { ok: false, delivery: 'failed', error };
  } catch (err) {
    // Not reachable through the real client, which resolves rather than
    // throws. Kept because an injected `send` and any future client can.
    console.error(`Contact message from ${message.phone} threw while sending:`, err);
    return { ok: false, delivery: 'failed', error: String(err) };
  }
}
