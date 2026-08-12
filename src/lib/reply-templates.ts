/**
 * Canned replies the office sends from a lead's detail page.
 *
 * TWO THINGS BK-10 FIXED HERE, BOTH OF WHICH REACHED REAL CUSTOMERS.
 *
 * 1. **The phone number was wrong.** Every template said (780) 244-4747 — a
 *    number the client does not recognize — and every reply sent since these
 *    shipped carried it. The advertised line, and the only one that belongs in
 *    a customer message, is (780) 479-3285. It is imported from
 *    `booking-config.ts` now rather than typed, so there is one place to be
 *    wrong. **Contact details in copy must be checked against `BUSINESS`, not
 *    written from memory.**
 * 2. **`{{service}}` could interpolate to the literal string "null".**
 *    `leads.service` is nullable since migration 004, and the fill was a bare
 *    `String.replace` — so a message with no service picked produced "your
 *    null needs" in a customer's inbox. `fillTemplate` takes an already-
 *    resolved label and falls back to `SERVICE_FALLBACK`.
 *
 * The framing also moved off "Quote Request": quotes go through `/book/` now,
 * and this channel answers questions.
 */

import { SUPPORT_PHONE } from './booking-config';

/** What `{{service}}` becomes when the visitor picked no service. */
export const SERVICE_FALLBACK = 'your restoration needs';

export type ReplyTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

/**
 * Substitute `{{name}}` and `{{service}}`.
 *
 * `serviceLabel` is nullable on purpose — the caller passes the column through
 * and this decides what an absent one reads as, rather than every call site
 * remembering. Exported so `scripts/verify-booking-admin.ts` can assert that
 * neither "null" nor "undefined" can survive a fill.
 */
export function fillTemplate(
  text: string,
  vars: { name: string; serviceLabel: string | null | undefined },
): string {
  const service = vars.serviceLabel ? vars.serviceLabel : SERVICE_FALLBACK;
  return text.replace(/\{\{name\}\}/g, vars.name).replace(/\{\{service\}\}/g, service);
}

export const REPLY_TEMPLATES: ReplyTemplate[] = [
  {
    id: 'received',
    name: 'Message Received',
    subject: 'We got your message — YEG Restoration',
    body: `Hi {{name}},

Thanks for getting in touch with YEG Restoration. We've received your message about {{service}} and someone is looking at it now.

We'll follow up within 2 hours. If this is an active emergency, please call us directly at ${SUPPORT_PHONE} — we're available 24/7.

Best regards,
YEG Restoration Team`,
  },
  {
    id: 'emergency',
    name: 'Emergency Team Dispatched',
    subject: 'Emergency Response Team On The Way — YEG Restoration',
    body: `Hi {{name}},

We've dispatched an emergency response team to your location. They will arrive within [ETA].

Please ensure someone is available to provide access to the affected area. Our technicians will bring all required equipment.

If you need to reach us urgently, call ${SUPPORT_PHONE}.

Stay safe,
YEG Restoration Team`,
  },
  {
    id: 'appointment',
    name: 'Appointment Confirmed',
    subject: 'Your Appointment is Confirmed — YEG Restoration',
    body: `Hi {{name}},

Your appointment with YEG Restoration has been confirmed:

  Service:   {{service}}
  Date:      [DATE]
  Time:      [TIME]
  Location:  [ADDRESS]

Please ensure the affected area is accessible when we arrive. Our technician will bring all necessary equipment and materials.

Need to reschedule? Reply to this email or call ${SUPPORT_PHONE}.

See you soon,
YEG Restoration Team`,
  },
  {
    id: 'quote',
    name: 'Estimate Ready',
    subject: 'Your Restoration Estimate — YEG Restoration',
    body: `Hi {{name}},

Thank you for your patience while we assessed {{service}}. Here is our estimate:

  Scope of Work:   [DESCRIPTION]
  Estimated Cost:  $[AMOUNT]
  Estimated Time:  [TIMELINE]

This estimate is valid for 30 days. To approve and schedule, reply to this email or call us at ${SUPPORT_PHONE}.

Best regards,
YEG Restoration Team`,
  },
  {
    id: 'followup',
    name: 'Post-Service Follow-Up',
    subject: 'How Did We Do? — YEG Restoration',
    body: `Hi {{name}},

We hope the work on {{service}} was completed to your full satisfaction. We wanted to check in and make sure everything looks great.

If you have any concerns or questions, don't hesitate to reach out — we stand behind our work, and you can always reach us at ${SUPPORT_PHONE}.

We'd really appreciate it if you could take a moment to leave us a review:
  Google: [REVIEW LINK]

Thank you for choosing YEG Restoration. We're here whenever you need us.

Warm regards,
YEG Restoration Team`,
  },
];
