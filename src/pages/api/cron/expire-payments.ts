import type { APIRoute } from 'astro';

export const prerender = false;

import { PAYMENT_DEADLINE_LEAD_HOURS, POST_COMMIT_BUDGET_MS } from '../../../lib/booking-config';
import {
  expiredRequestMessage,
  paymentAttentionAlert,
  paymentExpiredMessage,
  type BookingNotificationInput,
} from '../../../lib/booking-email';
import { sendCustomerMessage, sendOfficeMessage, withDeadline } from '../../../lib/booking-notify';
import { expireCheckoutSession } from '../../../lib/booking-payment';
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
  let sessionsCancelled = 0;
  let sessionsUncancelled = 0;
  let mailed = 0;
  let mailFailed = 0;

  // ── Sweep 1: payment expiry (BK-32) ──────────────────────────────────────
  //
  // `payment_due_at < now()` and nothing more. NULL fails that comparison, so
  // the pay-now rows are excluded by the shape of the predicate rather than by
  // a clause someone has to maintain.
  let unpaid: Appointment[] = [];
  try {
    unpaid = (await sql`
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
      RETURNING *
    `) as Appointment[];
    paymentsExpired = unpaid.length;
  } catch (err) {
    console.error('Payment expiry sweep failed:', err);
    return Response.json({ error: 'Expiry failed' }, { status: 500 });
  }

  // ── KILL THE LINK, OR THE SLOT IS SOLD TWICE (BK-32) ─────────────────────
  //
  // The row is `payment_expired` and the slot is back on the calendar the
  // instant the statement above commits. The Checkout Session is NOT — it sits
  // at Stripe, still payable, until its own `expires_at`. Between the two, the
  // customer can open the link they were emailed and pay for a time somebody
  // else may already have booked, and the webhook then lands on a released row:
  // recoverable, because `markPaid` records the money and flags it rather than
  // discarding it, but the customer has paid for a visit that is not happening
  // and a human has to unpick it. This is the open dependency the ROADMAP
  // records against BK-32, and closing it is one call per expired row.
  //
  // Failures are logged and counted, never fatal and never retried into a loop
  // — the same posture the header states for mail. A row whose session could not
  // be expired is still expired; what remains is a live link, which the webhook
  // handles as a late payment.
  for (const expiredRow of unpaid) {
    if (!expiredRow.stripe_session_id) continue;
    const killed = await expireCheckoutSession(expiredRow.stripe_session_id);
    if (killed) sessionsCancelled++;
    else sessionsUncancelled++;
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

  // ── The two customer messages, one per expired row ───────────────────────
  //
  // After the transitions, never before: a slot must be released whether or not
  // we can reach the customer, exactly as the manual decline decides it.
  //
  // BOTH SWEEPS USE `messageType: 'expired'` AND THAT IS SAFE BY CONSTRUCTION,
  // not by luck. A row reaches sweep 1 only from `approved_awaiting_payment`
  // and sweep 2 only from `pending_review`, so one booking can never send both
  // and the idempotency keys cannot collide. The MESSAGES are different
  // builders, because the two events are different: one customer did not pay by
  // a deadline they were given, the other was never looked at.
  for (const row of unpaid) {
    const message = paymentExpiredMessage(notificationInputFor(row, now));
    if (!message) continue;
    const sent = await withDeadline(
      sendCustomerMessage(row.id, 'expired', message, now).then((o) => o === 'sent'),
      POST_COMMIT_BUDGET_MS,
      false,
    );
    if (sent) mailed++;
    else mailFailed++;
  }

  // The office hears about a link that outlived its row. Not about the ordinary
  // expiry — that is visible in the admin list and a mail per lapsed booking is
  // noise — but a session Stripe would still accept money against is a thing
  // somebody has to go and close by hand.
  if (sessionsUncancelled > 0) {
    console.error(
      `Expiry sweep: ${sessionsUncancelled} Checkout Session(s) could not be expired. ` +
        'Those links are still payable against released slots.',
    );
    const first = unpaid.find((r) => r.stripe_session_id);
    if (first) {
      await withDeadline(
        sendOfficeMessage(
          first.id,
          'payment-attention',
          paymentAttentionAlert(
            first,
            `${sessionsUncancelled} Checkout Session(s) survived the expiry sweep and are still ` +
              'payable against slots that have been released. Expire them by hand in the Stripe ' +
              'dashboard.',
            now,
          ),
        ).then(() => true),
        POST_COMMIT_BUDGET_MS,
        false,
      );
    }
  }

  for (const row of stale) {
    const message = expiredRequestMessage(notificationInputFor(row, now));
    if (!message) continue;
    const sent = await withDeadline(
      sendCustomerMessage(row.id, 'expired', message, now).then((o) => o === 'sent'),
      POST_COMMIT_BUDGET_MS,
      false,
    );
    if (sent) mailed++;
    else mailFailed++;
  }

  if (mailFailed > 0) {
    console.error(
      `Expiry sweep: ${mailFailed} customer email(s) did not send. Those rows are expired and ` +
        'their slots released regardless.',
    );
  }

  return Response.json({
    paymentsExpired,
    requestsExpired,
    sessionsCancelled,
    sessionsUncancelled,
    mailed,
    mailFailed,
  });
};

/** One shape for both sweeps' messages. `filesAttached: 0` — neither mentions files. */
function notificationInputFor(row: Appointment, now: Date): BookingNotificationInput {
  return {
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
}
