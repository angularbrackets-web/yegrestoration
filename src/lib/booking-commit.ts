/**
 * The one statement that creates an appointment.
 *
 * Lives here rather than in the route so BK-08's admin manual entry can call it
 * instead of writing a second copy. Two copies of this SQL is the drift the
 * shared `booking-config.ts` exists to prevent, on the one statement where drift
 * means a double-booked crew.
 *
 * Note what this deliberately does NOT do: it does not check the booking window.
 * The public route wraps it in `isSlotBookable`; admin books emergencies inside
 * the 4-hour notice and beyond the 14-day horizon by definition. Both callers
 * must still check `isSlotOnGrid` first — the partial unique index only catches
 * *identical* start times, so an off-grid entry can overlap a booking the index
 * cannot see.
 */

import type { getDb } from './db';
import type { BookingPayload } from './booking-payload';

type Sql = ReturnType<typeof getDb>;

export type CommitResult = { id: number; files: number };

/**
 * Insert the appointment and claim its uploads in ONE statement.
 *
 * The Neon HTTP driver has no interactive transaction and the claim needs the
 * id the insert produces, so a two-call sequence has a window where a booking
 * exists whose photos are still unclaimed — and the orphan cron deletes those
 * 24 hours later. A data-modifying CTE is a single atomic statement.
 *
 * `FROM new_appt` on the tail is load-bearing: the scalar-subquery form
 * (`SELECT (SELECT id FROM new_appt)`) always returns one row, with a NULL id on
 * conflict, so the race loser would be told they had booked. Reverting it during
 * the red pass made all 12 racers report success.
 *
 * Files are claimed regardless of `upload_state` — `onUploadCompleted` never
 * fires on localhost, so every dev upload is stuck at 'pending', and a
 * production callback can lag.
 *
 * Returns null when the slot was taken between the caller's check and this
 * insert. That is the only real double-booking guard in the system.
 */
export async function insertBooking(
  sql: Sql,
  p: BookingPayload,
  draftId: string | null,
  now: Date,
  source: 'web' | 'admin' = 'web',
): Promise<CommitResult | null> {
  const rows = (await sql`
    WITH new_appt AS (
      INSERT INTO appointments (
        name, phone, email, service, description, address, city, postal_code,
        payment_route, insurer_name, policy_number, claim_number,
        slot_start, source, sms_consent_at
      ) VALUES (
        ${p.name}, ${p.phone}, ${p.email}, ${p.service}, ${p.description},
        ${p.address}, ${p.city}, ${p.postal_code},
        ${p.payment_route}, ${p.insurer_name}, ${p.policy_number}, ${p.claim_number},
        ${p.slotStart.toISOString()}, ${source},
        ${p.smsConsent ? now.toISOString() : null}
      )
      ON CONFLICT (slot_start) WHERE status <> 'cancelled' DO NOTHING
      RETURNING id
    ), claimed AS (
      UPDATE appointment_files
      SET appointment_id = (SELECT id FROM new_appt)
      WHERE draft_id = ${draftId}::uuid
        AND appointment_id IS NULL
        AND EXISTS (SELECT 1 FROM new_appt)
      RETURNING id
    )
    SELECT new_appt.id, (SELECT COUNT(*)::int FROM claimed) AS files
    FROM new_appt
  `) as CommitResult[];

  return rows[0] ?? null;
}

/**
 * Record which of a booking's two notifications actually went out.
 *
 * Lives here beside `insertBooking` rather than inline in the route so that
 * `scripts/verify-booking-smoke.ts` can run the *same statement* against the
 * dev branch. That matters more than tidiness: the two `CASE WHEN ${boolean}`
 * parameters are sent untyped by the Neon HTTP driver and their type is inferred
 * from context, and "it should infer boolean" is exactly the kind of claim about
 * a third-party client that this ticket refused to make about Resend. Without a
 * shared symbol the statement would be executed by no gate at all — the email
 * verify injects a fake sender and never touches SQL, and the smoke run mutes
 * notifications so both outcomes are 'skipped'.
 *
 * Advisory only. Whether it succeeds changes nothing the customer sees, which is
 * why the caller must not let it decide the response.
 */
export async function stampNotifications(
  sql: Sql,
  id: number,
  sent: { customer: boolean; internal: boolean },
  at: Date,
): Promise<void> {
  if (!sent.customer && !sent.internal) return;

  const stamp = at.toISOString();
  await sql`
    UPDATE appointments
    SET confirmation_sent_at = CASE WHEN ${sent.customer}
          THEN ${stamp}::timestamptz ELSE confirmation_sent_at END,
        internal_notified_at = CASE WHEN ${sent.internal}
          THEN ${stamp}::timestamptz ELSE internal_notified_at END
    WHERE id = ${id}
  `;
}
