/**
 * The admin surface's only outbound mail: the customer confirmation, sent from
 * a manual entry or from the detail page's resend button.
 *
 * Two callers, one path. Both build the BK-05 plan with
 * `planBookingNotifications` — the copy module is not taught an "admin mode",
 * so the locked PII rule (no policy or claim number in a customer message)
 * holds by construction rather than by a second implementation remembering it
 * — and both send through `sendCustomerConfirmation`, which structurally
 * cannot deliver the internal message. **No admin action ever mails the
 * office.** They are typing the booking in; they are the office.
 *
 * The two mappings below sit in one file precisely because they must agree: a
 * confirmation resent from a row has to be the same message the entry sent.
 *
 * `serviceLabel` is injected rather than looked up here: `SERVICE_LABELS` is a
 * value in `db.ts`, next to the Neon import, and importing it would put this
 * module out of reach of a `tsx` verify script. Same reason
 * `booking-payload.ts` injects its allowed-service set.
 */

import { POST_COMMIT_BUDGET_MS } from './booking-config';
import { stampNotifications } from './booking-commit';
import { planBookingNotifications, type NotificationPlan } from './booking-email';
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
  filesAttached = 0,
): NotificationPlan {
  return planBookingNotifications({
    id,
    // Server-formatted in Edmonton time, exactly as the public path does it.
    // The message must never re-derive a zone from a raw instant.
    slotLabel: formatSlot(payload.slotStart),
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

/** The plan for an appointment already in the table — the resend path. */
export function planForAppointment(
  row: Appointment,
  serviceLabel: string,
  filesAttached = 0,
): NotificationPlan {
  return planBookingNotifications({
    id: row.id,
    slotLabel: formatSlot(row.slot_start),
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
