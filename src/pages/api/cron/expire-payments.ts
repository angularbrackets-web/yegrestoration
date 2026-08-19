import type { APIRoute } from 'astro';

export const prerender = false;

import { PAYMENT_DEADLINE_LEAD_HOURS, POST_COMMIT_BUDGET_MS } from '../../../lib/booking-config';
import { expiredRequestMessage, type BookingNotificationInput } from '../../../lib/booking-email';
import { sendCustomerMessage, withDeadline } from '../../../lib/booking-notify';
import { formatSlot } from '../../../lib/booking-time';
import { getDb, SERVICE_LABELS, type Appointment } from '../../../lib/db';
import { readEnv } from '../../../lib/env';

/**
 * Bounded so a backlog is worked off across runs rather than timing out. Each
 * expiry sends an email, so the ceiling here is a wall-clock budget as much as
 * a row count.
 */
const BATCH_SIZE = 25;

/**
 * The audit line a human reads when they ask why a request was declined and
 * nobody remembers doing it.
 *
 * A system actor has to be *recorded*, not inferred from `declined_at` being
 * set while no admin session was open — that inference is unavailable months
 * later and unavailable to the office entirely. Same idiom as BK-35's
 * `UNTICKED_NOTE`: the line is data, appended, never overwriting what the
 * office wrote.
 */
export const EXPIRED_REQUEST_NOTE =
  'Auto-declined by the expiry sweep — this request was never reviewed, and the slot was released so somebody else could book it.';

/** Append without destroying an existing note. BK-40's rule, restated. */
function appendSystemNote(notes: string | null): string {
  return notes ? `${notes}\n\n${EXPIRED_REQUEST_NOTE}` : EXPIRED_REQUEST_NOTE;
}

/**
 * Transitions that fall due with nobody watching. TWO SWEEPS, ONE HANDLER.
 *
 * | Sweep | Selects | Becomes | Owner |
 * | --- | --- | --- | --- |
 * | Payment | `approved_awaiting_payment` past `payment_due_at` | `payment_expired` | BK-32 |
 * | Stale request | `pending_review` past `slot - 4h` | `declined` | BK-23 Task 4 |
 *
 * One handler rather than two crons because both are the same kind of thing on
 * the same table at the same interval, and two schedules is two things to
 * reason about at 3am. They stay two STATEMENTS: different statuses, different
 * columns, different terminal states, different customer emails. Collapsing
 * them into one clever UPDATE is how the wrong customer gets the wrong message.
 *
 * ── NULL `payment_due_at` IS NOT OVERDUE, AND THIS IS THE IMPORTANT ONE ─────
 *
 * A NULL deadline is the **pay-now branch**: at approval, if the slot was
 * closer than `PAY_NOW_THRESHOLD_HOURS`, the deferred deadline is skipped
 * entirely and the customer is asked to pay immediately. There is no deadline
 * to be past, and SQL agrees — `payment_due_at < now()` is NULL, which is not
 * true, so the row is never selected. **The predicate is written so that this
 * is structural rather than remembered**: an `IS NOT NULL` here would be a
 * second place to get it right, and a `COALESCE` would be a way to get it
 * wrong.
 *
 * Treating NULL as overdue would auto-cancel every near-term booking — the 2am
 * emergency and the next-day 11:30 request are exactly the rows that carry it —
 * within 15 minutes of approval, which is the failure `isPaymentOverdue`
 * already exists to prevent on the read side and which this sweep must not
 * reintroduce on the write side.
 *
 * ── GUARDED UPDATES, ALWAYS ────────────────────────────────────────────────
 *
 * Each statement re-states the status it expects in its own `WHERE`. The office
 * approving, declining or paying at the same moment is not a race to win: one
 * of the two returns zero rows and no-ops, and the human action is the one that
 * should survive. Rows are selected and updated in the same statement via
 * `RETURNING` so nothing can change between the two.
 *
 * ── FAILURE POSTURE ────────────────────────────────────────────────────────
 *
 * A send that fails does not roll back the transition. The slot is already
 * released and the row already correct; retrying the whole sweep to re-send one
 * email would re-expire nothing and re-send nothing (the status no longer
 * matches), so a failed send is logged and counted, never retried into a loop.
 * The office sees the row in the admin list either way.
 *
 * Scheduled every 15 minutes in vercel.json. Vercel attaches
 * `Authorization: Bearer $CRON_SECRET` when that variable is set.
 */
export const GET: APIRoute = async ({ request }) => {
  const secret = readEnv('CRON_SECRET');
  if (!secret) {
    console.error('CRON_SECRET is not configured — refusing to run expiry.');
    return Response.json({ error: 'Not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sql = getDb();
  const now = new Date();

  let paymentsExpired = 0;
  let requestsExpired = 0;
  let mailed = 0;
  let mailFailed = 0;

  // ── Sweep 1: payment expiry (BK-32) ──────────────────────────────────────
  //
  // `payment_due_at < now()` and nothing more. NULL fails that comparison, so
  // the pay-now rows are excluded by the shape of the predicate rather than by
  // a clause someone has to maintain.
  try {
    const expired = (await sql`
      UPDATE appointments
      SET status     = 'payment_expired',
          updated_at = ${now.toISOString()}
      WHERE id IN (
        SELECT id FROM appointments
        WHERE status = 'approved_awaiting_payment'
          AND payment_due_at < ${now.toISOString()}
        ORDER BY payment_due_at
        LIMIT ${BATCH_SIZE}
      )
        AND status = 'approved_awaiting_payment'
      RETURNING id
    `) as { id: number }[];
    paymentsExpired = expired.length;
  } catch (err) {
    console.error('Payment expiry sweep failed:', err);
    return Response.json({ error: 'Expiry failed' }, { status: 500 });
  }

  // ── Sweep 2: stale requests (BK-23 Task 4) ───────────────────────────────
  //
  // Past `slot - PAYMENT_DEADLINE_LEAD_HOURS` a confirmation can no longer
  // complete: the payment deadline is behind us, so approving would take money
  // for a visit that cannot be paid for in time. `pending_review` holds its
  // slot, and this is the ONLY automatic way out of it — the sweep above never
  // looks at these rows, and BK-23's guard refuses to approve an elapsed slot,
  // so without this a lapsed request keeps its time off the calendar forever.
  //
  // `declined`, not `payment_expired`: no payment was ever requested, so the
  // latter would be false on its face and would corrupt the payment columns.
  const cutoff = new Date(now.getTime() + PAYMENT_DEADLINE_LEAD_HOURS * 60 * 60 * 1000);
  let stale: Appointment[] = [];
  try {
    stale = (await sql`
      UPDATE appointments
      SET status      = 'declined',
          declined_at = ${now.toISOString()},
          updated_at  = ${now.toISOString()},
          -- Appended, never overwriting. An office note explaining the job is
          -- the thing most worth not destroying, and BK-40's repair of this
          -- exact idiom is why the two branches are spelled out rather than
          -- collapsed into a COALESCE that would leave a leading blank line.
          admin_notes = CASE
            WHEN admin_notes IS NULL OR admin_notes = '' THEN ${EXPIRED_REQUEST_NOTE}
            ELSE admin_notes || ${`\n\n${EXPIRED_REQUEST_NOTE}`}
          END
      WHERE id IN (
        SELECT id FROM appointments
        WHERE status = 'pending_review'
          AND slot_start < ${cutoff.toISOString()}
        ORDER BY slot_start
        LIMIT ${BATCH_SIZE}
      )
        AND status = 'pending_review'
      RETURNING *
    `) as Appointment[];
    requestsExpired = stale.length;
  } catch (err) {
    console.error('Stale request expiry sweep failed:', err);
    return Response.json({ error: 'Expiry failed' }, { status: 500 });
  }

  // The apology, one per expired request. After the transition, never before:
  // the slot must be released whether or not we can reach the customer, exactly
  // as the manual decline decides it.
  for (const row of stale) {
    const input: BookingNotificationInput = {
      id: row.id,
      messageType: 'expired',
      slotLabel: formatSlot(row.slot_start),
      slotStart: row.slot_start,
      now,
      name: row.name,
      phone: row.phone,
      email: row.email,
      serviceLabel: SERVICE_LABELS[row.service] ?? row.service,
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
      smsConsent: row.sms_consent_at !== null,
      filesAttached: 0,
    };

    const message = expiredRequestMessage(input);
    if (!message) continue;

    const sent = await withDeadline(
      sendCustomerMessage(row.id, 'expired', message).then((o) => o === 'sent'),
      POST_COMMIT_BUDGET_MS,
      false,
    );
    if (sent) mailed++;
    else mailFailed++;
  }

  if (mailFailed > 0) {
    console.error(
      `Expiry sweep: ${mailFailed} apology email(s) did not send. Those requests are declined and their slots released regardless.`,
    );
  }

  return Response.json({ paymentsExpired, requestsExpired, mailed, mailFailed });
};
