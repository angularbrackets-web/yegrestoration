/**
 * Replying to a lead from the admin detail page: build the message, send it,
 * and only then record that it was sent.
 *
 * **SEND THEN STAMP, IN THAT ORDER, AND NEVER THE OTHER WAY.** The route this
 * replaced stamped `status = 'replied'` and `replied_at = NOW()` on the line
 * after an unchecked `await resend.emails.send(...)` — and the Resend SDK
 * *resolves* with `{ data: null, error }` rather than throwing (ROADMAP,
 * confirmed against resend@6.17.1's installed source). So a bounced key, a
 * rate limit, or an outage marked the lead replied, showed the office
 * `?success=1`, and left a customer waiting for an email nobody would ever
 * notice was missing. The stamp is bookkeeping about a fact; it must not
 * create the fact.
 *
 * The mute is the one deliberate exception: `BOOKING_NOTIFY_DISABLED` reports
 * `skipped`, and a skip **does** stamp. That row is test-only by construction
 * — the flag is fail-open and never set in a deployed environment — and it
 * exists so a route-level verification run under the mute exercises the
 * success path end to end instead of only ever seeing the failure arm.
 *
 * Shaped like `sendConfirmationAndStamp` in `booking-admin-notify.ts`: the
 * send is injectable, the stamp is a real statement against the passed `sql`.
 * That split is what lets `verify-booking-admin-db.ts` drive every arm against
 * the dev branch without a key and without mail leaving.
 */

import { BOOKING_EMAIL_REPLY_TO } from './booking-config';
import { escapeHtml, type Message } from './booking-email';
import { mailDisabled, type SendResult } from './booking-notify';
import type { getDb } from './db';

type Sql = ReturnType<typeof getDb>;

/** Sent, deliberately not sent, or attempted and failed. Mirrors `SendOutcome`. */
export type ReplyOutcome = 'sent' | 'skipped' | 'failed';

export type ReplyInput = {
  leadId: number;
  /** The lead's email address. The caller has already refused a lead without one. */
  to: string;
  subject: string;
  body: string;
};

/** The one place the office's sending identity is spelled for lead replies. */
const REPLY_FROM = `YEG Restoration <${BOOKING_EMAIL_REPLY_TO}>`;

/**
 * The reply as a value. Plain text is the source; the HTML part is the same
 * text in a `white-space: pre-wrap` block, so the two can never disagree.
 */
export function buildReplyMessage(input: ReplyInput): Message {
  return {
    from: REPLY_FROM,
    to: input.to,
    replyTo: BOOKING_EMAIL_REPLY_TO,
    subject: input.subject,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap;max-width:600px;">${escapeHtml(input.body)}</div>`,
    text: input.body,
  };
}

export type ReplyDeps = {
  /**
   * The seam. `null` means `RESEND_API_KEY` is unset — a logged `failed`, not
   * a throw: the route this replaced threw a bare Error there, which answered
   * 500 on a page whose every other outcome is a redirect with a flash.
   */
  send: ((message: Message) => Promise<SendResult>) | null;
};

/** `UPDATE leads SET status = 'replied', replied_at = NOW()`. Runs only after a send. */
async function stampReplied(sql: Sql, leadId: number): Promise<void> {
  await sql`UPDATE leads SET status = 'replied', replied_at = NOW() WHERE id = ${leadId}`;
}

/**
 * Send the reply, then record it. Reports what the *send* did.
 *
 * Never throws: every arm is a value the route maps to a redirect. A failed
 * stamp after a successful send is logged and does not downgrade the outcome
 * — the customer has the email either way, and re-sending it to fix a database
 * row would be the worse mistake.
 */
export async function sendReplyAndStamp(
  sql: Sql,
  input: ReplyInput,
  deps: ReplyDeps,
): Promise<ReplyOutcome> {
  const outcome = await deliver(input, deps);

  if (outcome === 'failed') return 'failed';

  try {
    await stampReplied(sql, input.leadId);
  } catch (err) {
    console.error(`Lead ${input.leadId} was replied to but the stamp failed:`, err);
  }

  return outcome;
}

/** The send half, with every way it can fail turned into a value. */
async function deliver(input: ReplyInput, deps: ReplyDeps): Promise<ReplyOutcome> {
  if (mailDisabled()) {
    console.error(`BOOKING_NOTIFY_DISABLED is set — the reply to lead ${input.leadId} was not sent.`);
    return 'skipped';
  }

  if (!deps.send) {
    console.error(`RESEND_API_KEY is not configured — the reply to lead ${input.leadId} was not sent.`);
    return 'failed';
  }

  try {
    const result = await deps.send(buildReplyMessage(input));
    if (result.ok) return 'sent';
    console.error(`Lead ${input.leadId} reply failed: ${result.error ?? 'unknown error'}`);
    return 'failed';
  } catch (err) {
    // Not reachable through the real client, which resolves rather than
    // throws. Kept because an injected `send` and any future client can.
    console.error(`Lead ${input.leadId} reply threw:`, err);
    return 'failed';
  }
}
