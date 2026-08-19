/**
 * The payment seam (BK-23 → BK-32), and the one function that confirms a
 * booking.
 *
 * BK-23 owns the review loop: it decides the amount, computes the deadline and
 * transitions the row. This module owns everything downstream of that — minting
 * the Checkout Session, expiring it, and the single `markPaid()` every payment
 * of every kind passes through.
 *
 * ── THE ORDER: TRANSITION FIRST, THEN STRIPE ───────────────────────────────
 *
 * `createCheckoutSession` is called AFTER the approve route's guarded UPDATE,
 * not before it, and the reversal is load-bearing three times over:
 *
 *   1. The Stripe idempotency key names `approved_at`, and nothing stores an
 *      `approved_at` until the transition runs.
 *   2. A double-click's second UPDATE returns zero rows and therefore never
 *      reaches Stripe at all — a stronger guarantee than the idempotency key
 *      was buying, and one that makes an orphan APPROVAL impossible. (An
 *      orphan SESSION is still possible in one narrow window; see
 *      `createCheckoutSession`.)
 *   3. "The line items come from the STORED amount columns" stops being a
 *      claim about locals that happen to match and becomes literally true: the
 *      caller passes what `RETURNING` gave it.
 *
 * ── NULL IS STILL A SUPPORTED ANSWER ───────────────────────────────────────
 *
 * `createCheckoutSession` returns null when no card processor is configured,
 * and the approval path handles that by offering the Interac route alone —
 * which the client confirmed is a real way to pay. What the route refuses is
 * approving with NEITHER method available.
 *
 * ── EVERY EXTERNAL CALL IS INJECTABLE ──────────────────────────────────────
 *
 * `StripeDeps` mirrors `NotifyDeps` in `booking-notify.ts`. Without it the
 * whole of this module would be verified by reading it, which is precisely how
 * the fixed-idempotency-prefix defect survived two reviews.
 */

import type Stripe from 'stripe';

import {
  checkoutCancelUrl,
  checkoutSuccessUrl,
  POST_COMMIT_BUDGET_MS,
} from './booking-config';
import {
  inviteEventFromAppointment,
  planCalendarInvite,
  planFirstConfirmationEmail,
} from './booking-admin-notify';
import { paymentAttentionAlert } from './booking-email';
import { sendCalendarInvite, sendOfficeMessage, withDeadline } from './booking-notify';
import type { AssessmentTier } from './booking-pricing';
import { getDb, SERVICE_LABELS, type Appointment } from './db';
import { readEnv } from './env';

/** Stripe's own bounds on a Checkout Session's lifetime. */
const STRIPE_MIN_EXPIRY_MS = 30 * 60_000;
const STRIPE_MAX_EXPIRY_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// The injectable seam
// ---------------------------------------------------------------------------

/** What this module needs from Stripe, and nothing more. */
export type StripeGateway = {
  createSession: (
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ) => Promise<{ id: string; url: string | null; amount_total: number | null }>;
  expireSession: (sessionId: string) => Promise<void>;
};

export type StripeDeps = {
  /**
   * The gateway. Defaults to the real SDK; the verify suite injects a fake to
   * drive success, an API error, an amount mismatch and a hang — none of which
   * are reachable through the real client without a network and a live key.
   */
  gateway?: StripeGateway;
};

/**
 * Whether card payment is configured at all.
 *
 * A CONFIGURATION fact, answerable without a network call, which is what lets
 * the approve route decide *before* its guarded UPDATE whether the customer
 * will have any way to pay — preserving BK-23's rule that it refuses to
 * transition rather than approving into a state nobody can act on.
 */
export function stripeConfigured(): boolean {
  return Boolean(readEnv('STRIPE_SECRET_KEY'));
}

/**
 * The real gateway, constructed LAZILY and never at module scope.
 *
 * `new Stripe(key)` on a falsy key throws, and this module is imported
 * transitively by `review.ts`, the cron and several verify scripts — a
 * module-scope client would take all of them down at import time in any
 * environment without a key, which is every developer machine and every one of
 * those scripts. `booking-notify.ts` records the identical lesson for
 * `new Resend(key)`; this is that lesson applied a second time rather than
 * relearned.
 *
 * The dynamic import keeps the SDK out of every bundle that merely touches this
 * module for `markPaid`.
 */
async function realGateway(secretKey: string): Promise<StripeGateway> {
  const { default: StripeSdk } = await import('stripe');
  const stripe = new StripeSdk(secretKey);

  return {
    createSession: async (params, idempotencyKey) => {
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
      return { id: session.id, url: session.url, amount_total: session.amount_total };
    },
    expireSession: async (sessionId) => {
      await stripe.checkout.sessions.expire(sessionId);
    },
  };
}

async function gatewayFor(deps: StripeDeps): Promise<StripeGateway | null> {
  if (deps.gateway) return deps.gateway;
  const key = readEnv('STRIPE_SECRET_KEY');
  if (!key) return null;
  return realGateway(key);
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export type CheckoutRequest = {
  appointmentId: number;
  tier: AssessmentTier;
  /** The STORED amount columns. Never recomputed, never from a request. */
  baseCents: number;
  travelCents: number;
  gstCents: number;
  totalCents: number;
  /** The stored `payment_due_at`, or null on the pay-now branch. */
  dueAt: Date | null;
  slotStart: Date;
  /** The stored `approved_at`. The idempotency key is built from its epoch. */
  approvedAt: Date;
  customerEmail: string;
  /**
   * NOT `approvedAt`. Stripe's 30-minute `expires_at` floor is measured from
   * CREATION, so the clamp needs the current instant — and
   * `booking-review.ts` records the house rule that this family of module takes
   * an explicit `now` rather than reading a clock, so a verify script can drive
   * the boundary cases.
   */
  now: Date;
  /** Where Stripe sends the customer back. Absolute; built from `Astro.site`. */
  origin: string;
};

export type CheckoutSession = { url: string; sessionId: string };

/**
 * When the Checkout Session lapses, clamped into Stripe's 30min–24h window.
 *
 * Pure, and it lives here rather than in `booking-review.ts` because it is a
 * STRIPE fact — that module is BK-23's payment arithmetic and knows nothing
 * about a payment processor's bounds.
 *
 * ── THE DEFERRED BRANCH NEVER REACHES EITHER BOUND, AND THAT IS ASSERTED ───
 *
 * With `PAY_NOW_THRESHOLD_HOURS = 8` and `PAYMENT_DEADLINE_LEAD_HOURS = 4`, a
 * deferred `dueAt` is bounded to `[now+4h, now+12h]` — so `expires_at` equals
 * `payment_due_at` exactly, and the link cannot die before the deadline the
 * customer was given. That relationship is pinned in
 * `verify-booking-review.ts` rather than observed here, because it holds
 * because of three constants and would break silently if any of them moved.
 *
 * ── TWO PAY-NOW CONSEQUENCES, STATED RATHER THAN REDISCOVERED ──────────────
 *
 * On the pay-now branch the session is clamped to the slot. When the slot is
 * less than 30 minutes away the floor pushes `expires_at` PAST `slot_start`, so
 * the link stays payable after the visit has begun. And because
 * `payment_due_at` is NULL, nothing ever expires such a row, so an unpaid
 * pay-now booking holds its slot indefinitely. Both are consistent with P9's
 * "the office chases that one by phone" and neither is a defect to fix here.
 */
export function checkoutExpiresAt(dueAt: Date | null, slotStart: Date, now: Date): Date {
  const target = (dueAt ?? slotStart).getTime();
  const floor = now.getTime() + STRIPE_MIN_EXPIRY_MS;
  const ceiling = now.getTime() + STRIPE_MAX_EXPIRY_MS;
  return new Date(Math.min(Math.max(target, floor), ceiling));
}

/**
 * The Stripe idempotency key for one approval.
 *
 * The `approved_at` epoch is what makes it an APPROVAL's key rather than an
 * appointment's: a booking sent back to `pending_review` and approved again is
 * a different approval at a possibly different amount, and it must mint a new
 * session rather than resurrect the old one.
 *
 * Seconds, not milliseconds, matching `icsSequence`.
 */
export function checkoutIdempotencyKey(appointmentId: number, approvedAt: Date): string {
  return `appointment-${appointmentId}-approval-${Math.floor(approvedAt.getTime() / 1000)}`;
}

/** One `price_data` line. Travel is omitted entirely when it is zero. */
function lineItems(request: CheckoutRequest): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const line = (name: string, description: string, unitAmount: number) => ({
    price_data: {
      currency: 'cad',
      unit_amount: unitAmount,
      product_data: { name, description },
    },
    quantity: 1,
  });

  const items = [
    line('On-site restoration assessment', `Booking #${request.appointmentId}`, request.baseCents),
  ];
  // A ZERO TRAVEL FEE RENDERS NO LINE AT ALL rather than a $0.00 one. A line
  // item for nothing invites the question of what it might have been, and the
  // approval email omits it on the same rule.
  if (request.travelCents > 0) {
    items.push(line('Travel', 'Round trip beyond the free radius', request.travelCents));
  }
  // GST AS ITS OWN LINE (client, 2026-08-16). The tier figures are ex-GST on
  // every surface that renders them, so a single tax-inclusive line would
  // silently contradict all of them.
  items.push(line('GST (5%)', 'Goods and services tax', request.gstCents));

  return items;
}

/**
 * A hosted payment URL and its session id, or null when card payment is not
 * configured.
 *
 * ── WHAT IS ASSERTED, AND WHAT WOULD HAVE BEEN THEATRE ─────────────────────
 *
 * The obvious check — `base + travel + gst === total` — is a TAUTOLOGY on the
 * real path: the approve route wrote all four columns in one statement from
 * `subtotal + gst`, so both sides of that comparison move together and it
 * cannot fail on anything a customer could ever be charged. This repo has found
 * seven instances of that family already, and the rule it settled on is that an
 * assertion must never read the thing it is asserting about. It is still
 * checked, once, as a guard against a caller assembling a request by hand — but
 * it is not what defends the ticket's invariant.
 *
 * What defends it is **Stripe's own echo**: `session.amount_total` is what
 * Stripe will really charge, computed by Stripe from the line items we sent. A
 * mismatch against `totalCents` means the itemisation and the charge disagree
 * after the approval email has already told the customer the itemisation — so
 * the session is expired immediately and the approval refuses. The webhook
 * makes the same comparison again on the way back in, which is the only place a
 * stale link from an earlier approval at a different price becomes visible.
 *
 * ── THE ONE WINDOW THIS CANNOT CLOSE ───────────────────────────────────────
 *
 * The session exists at Stripe the instant this returns. Recording it on the
 * row is a separate statement, so a crash between the two leaves a live session
 * nothing knows about — it cannot be expired by the cron and cannot be
 * superseded by a re-approval. It is not closable without a distributed
 * transaction, so the caller flags `needs_attention` instead, and the webhook's
 * amount check is what stops such a session confirming at a stale price.
 */
export async function createCheckoutSession(
  request: CheckoutRequest,
  deps: StripeDeps = {},
): Promise<CheckoutSession | null> {
  const gateway = await gatewayFor(deps);
  if (!gateway) return null;

  const { baseCents, travelCents, gstCents, totalCents } = request;
  if (baseCents + travelCents + gstCents !== totalCents) {
    throw new Error(
      `Booking ${request.appointmentId}: itemisation does not sum to the total ` +
        `(${baseCents} + ${travelCents} + ${gstCents} != ${totalCents}). Refusing to charge.`,
    );
  }
  if (totalCents <= 0) {
    throw new Error(
      `Booking ${request.appointmentId}: a Checkout Session must never be opened for ` +
        `${totalCents} cents — a zero total is a booking that needs no payment step.`,
    );
  }

  const session = await gateway.createSession(
    {
      mode: 'payment',
      currency: 'cad',
      line_items: lineItems(request),
      client_reference_id: String(request.appointmentId),
      metadata: {
        appointment_id: String(request.appointmentId),
        tier: request.tier,
      },
      customer_email: request.customerEmail,
      success_url: checkoutSuccessUrl(request.origin),
      cancel_url: checkoutCancelUrl(request.origin),
      expires_at: Math.floor(
        checkoutExpiresAt(request.dueAt, request.slotStart, request.now).getTime() / 1000,
      ),
    },
    checkoutIdempotencyKey(request.appointmentId, request.approvedAt),
  );

  // Stripe's echo, not our arithmetic. See the header.
  if (session.amount_total !== totalCents) {
    await gateway.expireSession(session.id).catch((err) => {
      console.error(
        `Booking ${request.appointmentId}: could not expire the mismatched session ${session.id}:`,
        err,
      );
    });
    throw new Error(
      `Booking ${request.appointmentId}: Stripe would charge ${session.amount_total} but the ` +
        `approval settled ${totalCents}. Session expired; nothing was charged.`,
    );
  }

  if (!session.url) {
    throw new Error(`Booking ${request.appointmentId}: Stripe returned a session with no URL.`);
  }

  return { url: session.url, sessionId: session.id };
}

/**
 * Expire a Checkout Session so its link stops working.
 *
 * Two callers, one reason each: the expiry cron, so a customer cannot pay for a
 * slot it has just released; and a re-approval, so a corrected amount does not
 * leave the old price payable.
 *
 * Returns whether it worked. **Never throws** — a Stripe outage must not turn a
 * cron sweep into a 500 or stop a row being expired, and the caller decides
 * what a false means. Already-expired sessions answer with an error from Stripe
 * and are reported as a failure rather than special-cased: the distinction
 * needs a round trip to establish and changes nothing either caller does.
 */
export async function expireCheckoutSession(
  sessionId: string,
  deps: StripeDeps = {},
): Promise<boolean> {
  try {
    const gateway = await gatewayFor(deps);
    if (!gateway) return false;
    await gateway.expireSession(sessionId);
    return true;
  } catch (err) {
    console.error(`Could not expire Checkout Session ${sessionId}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// markPaid — the ONE confirmation path
// ---------------------------------------------------------------------------

export type PaymentMethod = 'stripe' | 'interac' | 'onsite' | 'none';

export type MarkPaidInput = {
  method: PaymentMethod;
  /** What actually arrived. Written to `paid_amount_cents`, never to the snapshot. */
  amountCents: number;
  /** The e-Transfer reference, or Stripe's, or null when there is none to have. */
  reference: string | null;
  /** Card path only. BK-33 refunds from this. */
  paymentIntentId?: string | null;
  sessionId?: string | null;
  /** Which admin asserted the money arrived. Stripe has none. */
  actor?: string | null;
  now: Date;
};

export type MarkPaidOutcome =
  /** The transition happened here. The confirmation and its ics went out. */
  | 'confirmed'
  /** THIS payment was already recorded. A redelivery or a double click. Silent. */
  | 'already-recorded'
  /** A DIFFERENT payment already confirmed this row. Flagged for a human. */
  | 'double-pay'
  /** The slot was already released. Money recorded, status untouched, flagged. */
  | 'paid-after-release'
  /** The row is in no state this applies to. */
  | 'not-applicable'
  | 'missing'
  | 'error';

/** The same alias `booking-admin-notify.ts` uses, for the same reason. */
type Sql = ReturnType<typeof getDb>;

/**
 * Whether an arriving payment is the SAME one already recorded on this row.
 *
 * This is the difference between "Stripe delivered the event twice" and "the
 * customer paid twice", and getting it wrong in the cheap direction is a real
 * cost: the office is told to issue a refund for a single charge, and the
 * ticket's instruction is that a human acts on that alert. A branch that cries
 * wolf on every redelivery is worse than no branch, because it trains the
 * office to ignore the one that matters.
 *
 * On the card path the identity is Stripe's own — the payment intent or the
 * session. On every other path it is the reference the office typed.
 *
 * **Two null references on the same method count as the same payment**, and
 * that is deliberate rather than lazy: an office member clicking "Mark as paid"
 * twice with nothing typed in the reference field is one assertion made twice.
 * A genuinely second transfer arrives under a different method (which is the
 * real double-pay race — Interac marked, then the Stripe link paid) or under a
 * different reference, and if the office has neither then they have nothing to
 * tell the two apart with either.
 */
function isSamePayment(row: Appointment, input: MarkPaidInput): boolean {
  if (row.payment_method !== input.method) return false;

  if (input.method === 'stripe') {
    if (input.paymentIntentId && row.stripe_payment_intent_id === input.paymentIntentId) return true;
    if (input.sessionId && row.stripe_session_id === input.sessionId) return true;
    return false;
  }

  return row.payment_reference === (input.reference ?? null);
}

/** Append without destroying what is already there. BK-40's rule, third column. */
export function appendAttention(existing: string | null, line: string): string {
  return existing && existing.trim() !== '' ? `${existing}\n\n${line}` : line;
}

/**
 * Confirm a booking against a payment. **The only path to `confirmed` for a
 * payment, and there are exactly two callers** — the Stripe webhook and the
 * admin's "Mark as paid — Interac" action. A Terminal handler would be a third
 * and would need nothing new.
 *
 * One function performs the transition, writes the payment columns, and fires
 * the confirmation with its `REQUEST` ics. There is no second confirmation
 * path, no branch in the email layer, and no status logic anywhere but here —
 * which is what makes the two entry points indistinguishable downstream, the
 * property the ticket names as its risk.
 *
 * ── THE THREE THINGS ZERO ROWS CAN MEAN ────────────────────────────────────
 *
 * The guarded UPDATE names `approved_awaiting_payment`. Zero rows is not one
 * situation, and treating it as one is how a real payment gets discarded or a
 * single charge gets refunded:
 *
 *   - the row is `confirmed` and this is THE SAME payment → silent no-op
 *   - the row is `confirmed` and this is a DIFFERENT payment → double pay:
 *     flag, alert, **never refund automatically**
 *   - the slot was already released → the money is real and must be recorded;
 *     `status` is NOT touched, because putting a released slot back would
 *     double-book it
 *
 * ── MAIL IS UNREACHABLE WITHOUT THE TRANSITION ─────────────────────────────
 *
 * Layer 3 of the idempotency design is structural, not remembered: the send
 * sits inside the one-row branch and no zero-row path can reach it. A second
 * arrival therefore cannot produce a second confirmation or a second ics.
 *
 * ── NEVER THROWS ───────────────────────────────────────────────────────────
 *
 * Same contract as `booking-notify.ts`. It runs from a webhook that must answer
 * 200 to avoid days of Stripe retries, and from an admin action that has
 * already taken the office's click.
 */
export async function markPaid(
  sql: Sql,
  appointmentId: number,
  input: MarkPaidInput,
  deps: StripeDeps = {},
): Promise<MarkPaidOutcome> {
  const nowIso = input.now.toISOString();
  const isStripe = input.method === 'stripe';
  const isInterac = input.method === 'interac';

  let confirmed: Appointment[];
  try {
    confirmed = (await sql`
      UPDATE appointments
      SET status                   = 'confirmed',
          payment_status           = 'paid',
          paid_at                  = ${nowIso},
          payment_method           = ${input.method},
          paid_amount_cents        = ${input.amountCents},
          payment_reference        = ${input.reference},
          stripe_session_id        = COALESCE(${input.sessionId ?? null}, stripe_session_id),
          -- CARD PATH ONLY. An e-Transfer reference in this column is a refund
          -- request BK-33 would aim at money Stripe never took; the reference
          -- for every other method goes to payment_reference above.
          stripe_payment_intent_id = COALESCE(
            ${isStripe ? (input.paymentIntentId ?? null) : null},
            stripe_payment_intent_id
          ),
          interac_marked_by        = ${isInterac ? (input.actor ?? null) : null},
          interac_marked_at        = ${isInterac ? nowIso : null},
          updated_at               = ${nowIso}
      WHERE id = ${appointmentId} AND status = 'approved_awaiting_payment'
      RETURNING *
    `) as Appointment[];
  } catch (err) {
    console.error(`markPaid(${appointmentId}) failed on the confirm transition:`, err);
    return 'error';
  }

  if (confirmed.length === 1) {
    await sendConfirmation(confirmed[0], input.now);
    return 'confirmed';
  }

  // Zero rows. Read the row back to find out WHICH of the three situations this
  // is. This is not the check-then-act the house rule forbids — the transition
  // has already been attempted and refused; what follows re-states its own
  // expectations in its own WHERE rather than trusting what this read saw.
  let rows: Appointment[];
  try {
    rows = (await sql`SELECT * FROM appointments WHERE id = ${appointmentId}`) as Appointment[];
  } catch (err) {
    console.error(`markPaid(${appointmentId}) could not read the row back:`, err);
    return 'error';
  }
  const row = rows[0];
  if (!row) {
    console.error(`markPaid(${appointmentId}): no such appointment.`);
    return 'missing';
  }

  if (row.status === 'confirmed') {
    if (isSamePayment(row, input)) {
      // A Stripe redelivery, a retried handler, or a second click. Nothing
      // happened twice, so nothing is reported.
      return 'already-recorded';
    }
    const line =
      `DOUBLE PAYMENT: a ${input.method} payment of ${input.amountCents} cents ` +
      `(ref ${input.reference ?? 'none'}) arrived after this booking was already confirmed by ` +
      `${row.payment_method ?? 'an unrecorded method'}. NOT refunded automatically — ` +
      `issue any refund by hand in the Stripe dashboard.`;
    await flagAndAlert(sql, row, line, input.now);
    return 'double-pay';
  }

  if (
    row.status === 'payment_expired' ||
    row.status === 'declined' ||
    row.status === 'cancelled'
  ) {
    // THE MONEY IS REAL AND THE SLOT IS GONE. Record the payment; leave the
    // status alone. Putting a released slot back would double-book it, and the
    // ticket is explicit that a customer who paid and got silently refunded is
    // a worse outcome than a slot the office sorts out by phone.
    const line =
      `PAID AFTER THE SLOT WAS RELEASED: a ${input.method} payment of ${input.amountCents} cents ` +
      `(ref ${input.reference ?? 'none'}) arrived while this booking was '${row.status}'. ` +
      `The money is recorded and the status is unchanged. NOT refunded automatically.`;
    try {
      // Restates its expectations rather than trusting the SELECT above — a
      // concurrent Interac mark must not have its method and stamp overwritten
      // by the losing side.
      const updated = (await sql`
        UPDATE appointments
        SET payment_status           = 'paid',
            paid_at                  = ${nowIso},
            payment_method           = ${input.method},
            paid_amount_cents        = ${input.amountCents},
            payment_reference        = ${input.reference},
            stripe_payment_intent_id = COALESCE(${isStripe ? (input.paymentIntentId ?? null) : null}, stripe_payment_intent_id),
            needs_attention          = CASE
              WHEN needs_attention IS NULL OR needs_attention = '' THEN ${line}
              ELSE needs_attention || ${`\n\n${line}`}
            END,
            updated_at               = ${nowIso}
        WHERE id = ${appointmentId}
          AND status IN ('payment_expired', 'declined', 'cancelled')
          AND payment_status <> 'paid'
        RETURNING id
      `) as { id: number }[];
      if (updated.length === 0) return 'not-applicable';
    } catch (err) {
      console.error(`markPaid(${appointmentId}) could not record a late payment:`, err);
      return 'error';
    }
    await alertOffice(row, line, input.now);
    return 'paid-after-release';
  }

  console.error(
    `markPaid(${appointmentId}): the row is '${row.status}', which no payment transition applies to.`,
  );
  return 'not-applicable';
}

/**
 * The confirmation and the two calendar invites — **exactly what the inward
 * invite crossing in `update.ts` already sends**, reused rather than rebuilt.
 *
 * A second confirmation-email builder is precisely the "branch in the email
 * layer and a second status path" the confirm seam exists to prevent. Reusing
 * these also inherits BK-23's B2 fix for free: a payment-confirmed row is told
 * it is confirmed, never that it "was cancelled and has now been reinstated".
 *
 * One deadline over both sends, run concurrently — the same reasoning
 * `sendBoundaryMail` states: two serial budgets stack past the platform's
 * function limit on a request that has already written a row.
 */
async function sendConfirmation(row: Appointment, now: Date): Promise<void> {
  try {
    const event = inviteEventFromAppointment(row, SERVICE_LABELS[row.service] ?? row.service);
    const email = typeof row.email === 'string' && row.email.trim() !== '' ? row.email : null;

    const sends: Promise<[string, string]>[] = [
      sendCalendarInvite(planCalendarInvite(event, 'request', now), {
        id: row.id,
        kind: 'request',
        now,
        audience: 'office',
      }).then((o) => ['office', o] as [string, string]),
    ];

    if (email) {
      sends.push(
        sendCalendarInvite(planFirstConfirmationEmail(event, email, now), {
          id: row.id,
          kind: 'request',
          now,
          audience: 'customer',
        }).then((o) => ['customer', o] as [string, string]),
      );
    }

    const outcomes = await withDeadline(
      Promise.all(sends),
      POST_COMMIT_BUDGET_MS,
      sends.map((_, i) => [i === 0 ? 'office' : 'customer', 'failed'] as [string, string]),
    );

    for (const [audience, outcome] of outcomes) {
      if (outcome === 'failed') {
        console.error(`Booking ${row.id}: the ${audience} confirmation did not send.`);
      }
    }
  } catch (err) {
    // A payment has landed and a row is confirmed. Neither may be turned into a
    // failure by a calendar artifact.
    console.error(`Booking ${row.id} was confirmed but its confirmation threw:`, err);
  }
}

/** Append to `needs_attention` and tell the office. */
async function flagAndAlert(sql: Sql, row: Appointment, line: string, now: Date): Promise<void> {
  try {
    await sql`
      UPDATE appointments
      SET needs_attention = CASE
            WHEN needs_attention IS NULL OR needs_attention = '' THEN ${line}
            ELSE needs_attention || ${`\n\n${line}`}
          END,
          updated_at = ${now.toISOString()}
      WHERE id = ${row.id}
    `;
  } catch (err) {
    console.error(`Booking ${row.id}: could not flag needs_attention:`, err);
  }
  await alertOffice(row, line, now);
}

/**
 * The office alert. Email, because Twilio is not available in Deploy 2.
 *
 * Under its own deadline and unable to fail its caller: the money has already
 * moved and the row already says so.
 */
async function alertOffice(row: Appointment, line: string, now: Date): Promise<void> {
  await withDeadline(
    sendOfficeMessage(row.id, 'payment-attention', paymentAttentionAlert(row, line, now)).then(
      () => true,
    ),
    POST_COMMIT_BUDGET_MS,
    false,
  );
}
