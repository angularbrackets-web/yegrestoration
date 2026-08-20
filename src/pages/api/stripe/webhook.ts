import type { APIRoute } from 'astro';

export const prerender = false;

import { markPaid } from '../../../lib/booking-payment';
import { getDb, type Appointment, type StripeEvent } from '../../../lib/db';
import { readEnv } from '../../../lib/env';

/**
 * Stripe's payment events (BK-32).
 *
 * ── THIS ROUTE IS OUTSIDE THE ADMIN MIDDLEWARE, AND IT MUST STAY OUTSIDE ───
 *
 * `src/middleware.ts` gates `/admin` and `/api/admin` by prefix. This path is
 * neither, so it is already outside — the point of saying so is that somebody
 * tidying up will one day notice an unauthenticated POST endpoint and "fix" it.
 * **Do not.** Stripe authenticates with a signature over the request body, not
 * with a cookie it does not have; adding auth here does not harden the route,
 * it breaks every payment confirmation in production and nothing else. There is
 * an assertion in `scripts/verify-stripe-webhook.ts` whose only job is to make
 * that regression read as a failure rather than as housekeeping.
 *
 * ── THE RAW BODY IS THE SIGNED THING ───────────────────────────────────────
 *
 * `await request.text()` is the FIRST thing that touches the body, and nothing
 * anywhere in this file calls `request.json()`. Parsing and re-serialising JSON
 * reorders keys and normalises whitespace, so the bytes Stripe signed are not
 * the bytes that would be verified, and every event would fail its signature —
 * in production only, and silently, because a webhook cannot be smoke-tested
 * under `astro dev`.
 *
 * ── 200 TO EVERYTHING WE DO NOT HANDLE ─────────────────────────────────────
 *
 * A non-2xx tells Stripe to retry, with backoff, **for days**, and to email the
 * account owner about a failing endpoint. An event we have no opinion on is not
 * a failure. The one thing answered non-2xx is a bad signature (400): that is
 * not Stripe, so there is nothing to retry.
 *
 * ── THREE LAYERS OF IDEMPOTENCY ────────────────────────────────────────────
 *
 *   1. `stripe_events` — the CLAIM below. Not "have I seen this?" but "have I
 *      finished with it?"
 *   2. `markPaid`'s guarded UPDATE — the real dedupe, and the only thing that
 *      writes `confirmed`.
 *   3. Mail, which lives inside layer 2's one-row branch and is unreachable
 *      without it.
 */

/** Stripe's own prefix on the header it signs with. */
const SIGNATURE_HEADER = 'stripe-signature';

/** What the claim returns: the id, or nothing if somebody else finished it. */
type Claim = Pick<StripeEvent, 'event_id'>;

export const POST: APIRoute = async ({ request }) => {
  const secret = readEnv('STRIPE_WEBHOOK_SECRET');
  const apiKey = readEnv('STRIPE_SECRET_KEY');
  if (!secret || !apiKey) {
    // 500 rather than 200: this IS a failure on our side, and a configured
    // endpoint answering "not configured" is something the account owner should
    // hear about through Stripe's own alerting.
    console.error('STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY is not configured.');
    return Response.json({ error: 'Not configured' }, { status: 500 });
  }

  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature) return Response.json({ error: 'No signature' }, { status: 400 });

  // THE RAW BODY, BEFORE ANYTHING ELSE.
  const raw = await request.text();

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(apiKey);

  let event: import('stripe').Stripe.Event;
  try {
    // `constructEventAsync`, not the sync twin: it verifies through Web Crypto
    // and is therefore correct on both the Node and the edge runtimes, so a
    // future change of adapter runtime cannot silently break signature checking.
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret);
  } catch (err) {
    // A forgery, a misconfigured secret, or a proxy that rewrote the body.
    // None of the three is helped by Stripe retrying.
    console.error('Stripe webhook signature verification failed:', err);
    return Response.json({ error: 'Bad signature' }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    // 500 so Stripe retries: the event is real and we simply could not act on
    // it yet. This is the one case where a retry is exactly what we want.
    console.error('Stripe webhook could not reach the database:', err);
    return Response.json({ error: 'Unavailable' }, { status: 500 });
  }

  // ── LAYER 1: CLAIM THE EVENT ─────────────────────────────────────────────
  //
  // `ON CONFLICT ... DO UPDATE ... WHERE processed_at IS NULL` rather than
  // `DO NOTHING`, and the difference is a payment.
  //
  // With `DO NOTHING`, zero rows means "I have SEEN this event" — which is not
  // the same as having acted on it. A handler that dies between the insert and
  // the confirm transition (a function timeout, an OOM, a deploy rolling
  // underneath it) leaves the row `approved_awaiting_payment`; Stripe retries;
  // the id is already present; we answer 200 and do nothing. The expiry cron
  // then releases the slot within the deadline and emails the customer an
  // apology for a booking they have paid for. Money taken, booking cancelled,
  // nothing flagged.
  //
  // The claim closes it: an unstamped event is claimed again and completes.
  // Re-running the transition is safe — it is a guarded UPDATE, and `markPaid`
  // compares the payment reference so a redelivery is a silent no-op rather
  // than a reported double payment.
  let claimed: Claim[];
  try {
    claimed = (await sql`
      INSERT INTO stripe_events (event_id, type, received_at)
      VALUES (${event.id}, ${event.type}, ${new Date().toISOString()})
      ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
        WHERE stripe_events.processed_at IS NULL
      RETURNING event_id
    `) as Claim[];
  } catch (err) {
    console.error(`Stripe webhook could not claim event ${event.id}:`, err);
    return Response.json({ error: 'Unavailable' }, { status: 500 });
  }

  if (claimed.length === 0) {
    // Already handled, all the way through. Nothing to do and nothing to say.
    return Response.json({ received: true, duplicate: true });
  }

  try {
    await handle(sql, event);
  } catch (err) {
    // Left UNSTAMPED on purpose, so Stripe's retry claims it again. This is the
    // whole reason `processed_at` exists.
    console.error(`Stripe webhook failed handling ${event.type} (${event.id}):`, err);
    return Response.json({ error: 'Handler failed' }, { status: 500 });
  }

  try {
    await sql`
      UPDATE stripe_events SET processed_at = ${new Date().toISOString()}
      WHERE event_id = ${event.id}
    `;
  } catch (err) {
    // The work is done; only the bookkeeping failed. A retry would re-run
    // `markPaid`, which no-ops on the same reference — so this is safe to
    // swallow rather than answer 500 for.
    console.error(`Stripe webhook handled ${event.id} but could not stamp it:`, err);
  }

  return Response.json({ received: true });
};

/**
 * WHAT AN EVENT MEANS, AS A VALUE RATHER THAN AS CONTROL FLOW.
 *
 * Extracted from the switch it used to be so that the whole routing table can
 * be driven directly — `verify-stripe-webhook.ts` asserts every arm of it,
 * including "anything else is ignored", without a signature, a database or a
 * network.
 *
 * The first version of this was a `switch` with a `default: return`, pinned by
 * a source check that the word `default:` appeared in the file. Deleting the
 * default and replacing it with `case 'invoice.paid': return` left that check
 * **green** — an assertion about the shape of the code rather than about what
 * the code decides, and the eighth member of a family this repo has now caught
 * seven times. A pure function makes the property assertable instead of
 * describable.
 */
export type WebhookAction = 'confirm' | 'flag-failed' | 'ignore';

export function plannedAction(event: {
  type: string;
  data: { object: { payment_status?: string } };
}): WebhookAction {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      // A `completed` session whose payment is still `unpaid` is an async
      // method in flight — a bank debit, not a card. It confirms nothing; the
      // `async_payment_succeeded` event is what does.
      return event.data.object.payment_status === 'unpaid' ? 'ignore' : 'confirm';

    case 'checkout.session.async_payment_failed':
      return 'flag-failed';

    case 'checkout.session.expired':
      // Recorded and nothing else. The CRON owns row expiry — it is what
      // releases the slot and what tells the customer — and on the deferred
      // branch a session's `expires_at` equals `payment_due_at` exactly, so
      // this event and that sweep describe the same instant from two sides.
      // Acting here as well would race the cron for the same row and could send
      // two different customer emails about one lapse.
      return 'ignore';

    default:
      // Stripe sends dozens of event types and an endpoint that errors on the
      // unfamiliar ones is an endpoint Stripe disables. A non-2xx makes it
      // retry, with backoff, for days.
      return 'ignore';
  }
}

/** Carry out what `plannedAction` decided. */
async function handle(
  sql: ReturnType<typeof getDb>,
  event: import('stripe').Stripe.Event,
): Promise<void> {
  const action = plannedAction(event as never);
  if (action === 'ignore') return;

  // Both remaining actions are about a Checkout Session, and nothing else
  // reaches here — so the narrowing is safe and is stated rather than cast
  // blindly.
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded' &&
    event.type !== 'checkout.session.async_payment_failed'
  ) {
    return;
  }
  const session = event.data.object;

  if (action === 'confirm') {
    await confirm(sql, session, new Date());
    return;
  }

  const id = appointmentIdOf(session);
  if (id === null) return;
  // NOT a status change. The row is still `approved_awaiting_payment` and still
  // inside its deadline — the customer can pay again by another means, and
  // expiring it here would take that away from them.
  await flag(
    sql,
    id,
    'A Stripe payment FAILED after being submitted. The booking is still awaiting payment ' +
      'and its deadline still applies.',
    'failed',
  );
}

/** The appointment this session belongs to, or null if it does not say. */
function appointmentIdOf(session: import('stripe').Stripe.Checkout.Session): number | null {
  // `client_reference_id` first, `metadata` as the twin — both are set at
  // creation and either alone is enough, so a session missing one still lands.
  const raw = session.client_reference_id ?? session.metadata?.appointment_id ?? null;
  if (raw === null) return null;
  // As strict as the admin detail route's own id parse, PLUS the int4 ceiling
  // that parse also applies. `[0-9]{0,9}` alone admits 4294967295, which is a
  // valid ten-digit integer and an out-of-range value for a SERIAL column — the
  // SELECT would then raise 22003, this handler would answer 500, and Stripe
  // would retry an unusable event for days.
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) {
    console.error(`Stripe session ${session.id} carries an unusable appointment id: ${raw}`);
    return null;
  }
  return Number(raw);
}

/**
 * A paid session becomes a confirmed booking — through `markPaid` and nothing
 * else.
 *
 * ── THE AMOUNT IS CHECKED HERE, AND THIS IS THE CHECK THAT CAN FAIL ────────
 *
 * `amount_total` is what Stripe actually charged. Comparing it against the
 * stored `total_amount_cents` is the only place a STALE LINK becomes visible:
 * a session minted by an earlier approval at a different price, or one this
 * system minted and then failed to record. Both are live links that would
 * otherwise confirm a booking at a figure the customer was never quoted.
 *
 * The tempting check — that the itemisation sums to the total — is a tautology
 * here for the same reason it is one at session creation: one statement wrote
 * all four columns from each other.
 *
 * A mismatch confirms nothing, flags the row, and leaves the money with Stripe
 * for a human to refund deliberately.
 */
async function confirm(
  sql: ReturnType<typeof getDb>,
  session: import('stripe').Stripe.Checkout.Session,
  now: Date,
): Promise<void> {
  const id = appointmentIdOf(session);
  if (id === null) return;

  const rows = (await sql`
    SELECT total_amount_cents FROM appointments WHERE id = ${id}
  `) as Pick<Appointment, 'total_amount_cents'>[];
  const expected = rows[0]?.total_amount_cents ?? null;
  if (expected === null) {
    // The row exists but was never approved — there is no settled total to
    // check a charge against. Terminal rather than retryable: nothing about
    // waiting makes an unapproved booking acquire an amount, and the row is
    // flagged so a human sees the payment.
    console.error(`Stripe session ${session.id} names booking ${id}, which has no settled total.`);
    await flag(
      sql,
      id,
      `A Stripe payment arrived for session ${session.id} against a booking with no settled ` +
        'amount, so it could not be checked or confirmed. NOT refunded automatically.',
      null,
    );
    return;
  }

  if (session.amount_total !== expected) {
    console.error(
      `Booking ${id}: Stripe charged ${session.amount_total} but the approval settled ${expected}. ` +
        'NOT confirming.',
    );
    await flag(
      sql,
      id,
      `AMOUNT MISMATCH: Stripe charged ${session.amount_total} cents against a booking settled at ` +
        `${expected} cents (session ${session.id}). The booking was NOT confirmed and the money ` +
        'was NOT refunded automatically — resolve it by hand.',
      null,
    );
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  const outcome = await markPaid(sql, id, {
    method: 'stripe',
    amountCents: session.amount_total,
    reference: paymentIntentId,
    paymentIntentId,
    sessionId: session.id,
    now,
  });

  // ── THE OUTCOME IS NOT DECORATION, AND IGNORING IT REOPENED THE HOLE ──────
  //
  // `markPaid` never throws — that is its contract — so a failed confirm UPDATE
  // comes back as the VALUE `'error'`. The first version of this function
  // discarded the return, which meant a transient database blip produced:
  // event claimed, `markPaid` fails, handler returns normally, `processed_at`
  // stamped, Stripe gets a 200 and never retries. The row stays
  // `approved_awaiting_payment`, the cron expires it, and the customer is
  // emailed an apology for a booking they paid for.
  //
  // That is the exact "money taken, booking cancelled, nothing flagged" outcome
  // `processed_at` was introduced to prevent — reopened one layer up, on the
  // MOST likely failure rather than the most dramatic one: not a process death,
  // but a database error, which is precisely what a retry exists for.
  //
  // Throwing leaves the event unstamped, so Stripe's retry claims it again.
  // Re-running is safe: the guarded UPDATE is the real dedupe and the payment
  // reference tells a redelivery from a second payment.
  if (outcome === 'error') {
    throw new Error(
      `markPaid failed for booking ${id} on session ${session.id}. Leaving the event unstamped ` +
        'so Stripe retries it.',
    );
  }

  // `'missing'` is deliberately NOT retried. It means the appointment named by
  // the session does not exist, which no amount of retrying changes — and a
  // 500 here would put Stripe into a multi-day retry loop over an event nothing
  // can ever act on. There is no row to flag, so the log is the whole record,
  // and it is written at error level for that reason.
  if (outcome === 'missing') {
    console.error(
      `Stripe session ${session.id} paid against booking ${id}, WHICH DOES NOT EXIST. ` +
        'The money is with Stripe and nothing here can record it — resolve by hand.',
    );
  }
}

/** Append to `needs_attention`, and optionally move `payment_status`. */
async function flag(
  sql: ReturnType<typeof getDb>,
  id: number,
  line: string,
  paymentStatus: 'failed' | null,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    if (paymentStatus === null) {
      await sql`
        UPDATE appointments
        SET needs_attention = CASE
              WHEN needs_attention IS NULL OR needs_attention = '' THEN ${line}
              ELSE needs_attention || ${`\n\n${line}`}
            END,
            updated_at = ${now}
        WHERE id = ${id}
      `;
    } else {
      // Guarded: a row that has since been PAID by another route must not be
      // walked back to 'failed' by a late event about the card attempt.
      await sql`
        UPDATE appointments
        SET payment_status = ${paymentStatus},
            needs_attention = CASE
              WHEN needs_attention IS NULL OR needs_attention = '' THEN ${line}
              ELSE needs_attention || ${`\n\n${line}`}
            END,
            updated_at = ${now}
        WHERE id = ${id} AND payment_status <> 'paid'
      `;
    }
  } catch (err) {
    console.error(`Booking ${id}: could not flag '${line}':`, err);
  }
}
