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
  GST_REGISTRATION_NUMBER,
  POST_COMMIT_BUDGET_MS,
} from './booking-config';
import {
  inviteEventFromAppointment,
  planCalendarInvite,
  planForAppointment,
  planRefundNotice,
  sendBoundaryMail,
} from './booking-admin-notify';
import { paymentAttentionAlert } from './booking-email';
import {
  sendCalendarInvite,
  sendCustomerMessage,
  sendOfficeMessage,
  withDeadline,
  type NotifyDeps,
} from './booking-notify';
import type { AssessmentTier } from './booking-pricing';
import { couldHoldCalendarInvite } from './booking-status';
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
  /** `open` | `complete` | `expired`, or null when the session cannot be read. */
  sessionStatus: (sessionId: string) => Promise<string | null>;
  /**
   * BK-33. Sends money back. The one call in this type that cannot be undone.
   *
   * Injectable for the same reason as the rest and more so: every guard around
   * a refund has to be driven through a fake that can return a refusal, an API
   * error and a hang, because none of the three is reachable against a real key
   * without moving real money.
   */
  createRefund: (
    params: Stripe.RefundCreateParams,
    idempotencyKey: string,
  ) => Promise<{ id: string; amount: number; status: string | null }>;
  /**
   * BK-33. What Stripe kept in processing fees on the ORIGINAL charge, or null
   * when it cannot be read.
   *
   * **The fee does not scale with the size of a refund.** Stripe returns no
   * part of it on any refund, so a $50 partial costs the business the same
   * $18.52 as the full $628.43 did. Anything rendered from this must say *the
   * fee on the original charge is not returned*, never "the fee on this
   * refund".
   *
   * Null is an answer, not a failure: the confirm screen degrades to a sentence
   * with no figure rather than refusing to let the office refund.
   */
  chargeFee: (paymentIntentId: string) => Promise<number | null>;
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
    sessionStatus: async (sessionId) => {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return session.status ?? null;
    },
    createRefund: async (params, idempotencyKey) => {
      const refund = await stripe.refunds.create(params, { idempotencyKey });
      return { id: refund.id, amount: refund.amount, status: refund.status ?? null };
    },
    chargeFee: async (paymentIntentId) => {
      // TWO EXPAND LEVELS, which Stripe allows (its limit is four). The fee is
      // not on the PaymentIntent and not on the Charge — it is on the charge's
      // BALANCE TRANSACTION, and without the expand both come back as bare id
      // strings.
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.balance_transaction'],
      });
      const charge = intent.latest_charge;
      if (!charge || typeof charge === 'string') return null;
      const balance = charge.balance_transaction;
      if (!balance || typeof balance === 'string') return null;
      return balance.fee;
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
  // THE REGISTRANT GOES IN THE NAME, and the field choice is evidence rather
  // than preference (BK-48). Live booking #36's receipt rendered
  // `GST (5%) × 1` — names only, no descriptions beside them — so the name is
  // the field observed to survive onto the document the customer keeps. The
  // Stripe SDK documents `description` as "for your own rendering purposes",
  // which is not a promise it appears anywhere.
  //
  // NOT `unit_label`, which IS documented as included in receipts and invoices
  // and is nonetheless wrong: it labels the unit of the quantity, so it would
  // render as a noun beside `× 1` rather than as a document-level tax
  // statement. Recorded because the next reader will find it in the types and
  // wonder.
  //
  // This also renders on the Checkout PAGE, not only the receipt — the customer
  // sees the registrant before paying as well as after. Deliberate.
  items.push(
    line(
      `GST (5%) — Reg. ${GST_REGISTRATION_NUMBER}`,
      'Goods and services tax',
      request.gstCents,
    ),
  );

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
 * What happened when we tried to stop a link working.
 *
 * THREE VALUES, NOT A BOOLEAN, and the middle one is the whole reason.
 * `sessions.expire` errors on any session that is not `open` — including one
 * Stripe already expired at its own `expires_at`, which is the ORDINARY case
 * for the payment sweep: `expires_at` equals `payment_due_at` exactly on the
 * deferred branch, so by the time the cron sees an overdue row Stripe has
 * already closed its session. Collapsing that into `false` made the cron email
 * the office "these links are still payable" about essentially every lapsed
 * booking, and made the approve route abort a re-approval on the normal path.
 * Both are the crying-wolf failure this ticket refuses elsewhere.
 */
export type ExpireOutcome =
  /** It was open, and now it is not. */
  | 'expired'
  /** It was already closed — expired, completed, or expired by us before. Fine. */
  | 'already-inactive'
  /** Stripe could not be reached, or said something we do not understand. */
  | 'failed';

/**
 * Expire a Checkout Session so its link stops working.
 *
 * Two callers, one reason each: the expiry cron, so a customer cannot pay for a
 * slot it has just released; and a re-approval, so a corrected amount does not
 * leave the old price payable.
 *
 * **Never throws** — a Stripe outage must not turn a cron sweep into a 500 or
 * stop a row being expired. The caller decides what `'failed'` means.
 *
 * The `retrieve` on the error path is what tells the two failure shapes apart,
 * and it costs a round trip only when something already went wrong.
 */
export async function expireCheckoutSession(
  sessionId: string,
  deps: StripeDeps = {},
): Promise<ExpireOutcome> {
  let gateway: StripeGateway | null;
  try {
    gateway = await gatewayFor(deps);
  } catch (err) {
    console.error(`Could not reach Stripe to expire ${sessionId}:`, err);
    return 'failed';
  }
  if (!gateway) return 'failed';

  try {
    await gateway.expireSession(sessionId);
    return 'expired';
  } catch (expireErr) {
    // Was it already closed? That is not a failure, and telling the office it
    // is would train them to ignore the alert that matters.
    try {
      const status = await gateway.sessionStatus(sessionId);
      if (status !== null && status !== 'open') return 'already-inactive';
    } catch (statusErr) {
      console.error(`Could not read the status of Checkout Session ${sessionId}:`, statusErr);
    }
    console.error(`Could not expire Checkout Session ${sessionId}:`, expireErr);
    return 'failed';
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
  /**
   * BK-33. Money arrived on a row whose payment had already been REFUNDED.
   * Nothing about the payment record was changed — the refund stands — and the
   * office was alerted. Distinct from `paid-after-release` because the office's
   * next move is different: there, money is owed to a booking that will not
   * happen; here, a second charge may need returning.
   */
  | 'paid-after-refund'
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
  /**
   * **`NotifyDeps` as well as `StripeDeps`, and that is BK-45's doing.**
   *
   * This module's header says every external call is injectable, *"without it
   * the whole of this module would be verified by reading it, which is precisely
   * how the fixed-idempotency-prefix defect survived two reviews."* The mail
   * calls were the ones that escaped — all three of them, the confirmation and
   * both office alerts, which is why `deps` reaches `flagAndAlert` and
   * `alertOffice` as well and not the confirm branch alone. A parameter that
   * covered one of three would have made this comment a promise the code did
   * not keep. The one that mattered for BK-45: `sendConfirmation` passed no deps, so the
   * only observable of a confirmation send was a mute line carrying no message
   * content — and "the message a paying customer receives" was checkable by
   * reading the source and nothing else. That is the shape of defect BK-45 was
   * filed for. Threading the seam through is what lets a verify script capture
   * the real `Message` this route hands its sender and compare it with the one
   * the Resend button builds.
   */
  deps: StripeDeps & NotifyDeps = {},
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
          -- BK-33. THE PREVIOUS CYCLE'S REFUND IS CLEARED HERE, and it is the
          -- only place anything clears it.
          --
          -- This row is being paid, now, for this cycle. Leaving a refund
          -- behind would be the never-cleared-columns defect with a new
          -- consequence rather than an old one: editorMaySetStatus reads the
          -- refund state to decide whether a booking may cross back into the
          -- invite-holding set, so a booking refunded, walked back to
          -- pending_review, re-approved and genuinely RE-PAID would be barred
          -- forever from completed or no_show while every screen showed it as
          -- paid. paid_at can afford to be stale because only a display reads
          -- it; a refund column cannot, because a rule does.
          --
          -- approve and rollBack still clear nothing — that is the unassigned
          -- ticket's job (ROADMAP Known traps) and a write-path change on a
          -- live payment route is not something to fold into a refund ticket.
          -- Clearing on the PAYMENT closes the case that rule depends on,
          -- which is the one that had to be closed here.
          stripe_refund_id         = NULL,
          refunded_amount_cents    = NULL,
          refunded_at              = NULL,
          refund_claim_key         = NULL,
          refund_started_at        = NULL,
          updated_at               = ${nowIso}
      WHERE id = ${appointmentId} AND status = 'approved_awaiting_payment'
      RETURNING *
    `) as Appointment[];
  } catch (err) {
    console.error(`markPaid(${appointmentId}) failed on the confirm transition:`, err);
    return 'error';
  }

  if (confirmed.length === 1) {
    await sendConfirmation(confirmed[0], input.now, deps);
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
    await flagAndAlert(sql, row, line, input.now, deps);
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
    //
    // ── UNLESS THE ROW HAS BEEN REFUNDED, WHICH IS BK-33's CASE ────────────
    //
    // The money columns must not be re-stamped over a refund — a row reading
    // `payment_status = 'paid'` after the money went back is exactly the defect
    // BK-33 exists to fix. But the OBVIOUS way to do that is to tighten this
    // statement's guard to `payment_status NOT IN ('paid','refunded',
    // 'partially_refunded')`, and plan review established that it converts an
    // arrival of real money into SILENCE: the UPDATE matches zero rows, the
    // early return below fires, and `alertOffice` — ten lines further down — is
    // never reached. Money lands on a refunded booking and nobody is told,
    // which is the "money taken, nothing flagged" outcome the webhook's own
    // three-layer design exists to prevent.
    //
    // So the refunded case is an ARM, not an exclusion: the money columns are
    // held back by a CASE, and the flag and the alert happen exactly as they do
    // for every other late payment.
    const isRefunded =
      row.payment_status === 'refunded' || row.payment_status === 'partially_refunded';

    // The payment's own identity, embedded in the note and guarded on below.
    //
    // The unrefunded arm dedupes on `payment_status <> 'paid'`: once the first
    // arrival stamps the row, a redelivery matches nothing. The refunded arm
    // has no such stamp to leave — it deliberately writes no money state — so a
    // replayed event would append the same paragraph every time it arrived.
    // This marker is what makes the append happen once instead.
    // The fallback is the ACTOR and the amount, not the amount alone: two
    // genuine Interac marks of the same amount on one refunded row would
    // otherwise dedupe against each other and the second would be silent — the
    // very failure this arm exists to prevent, one method over (N5). Where
    // there is no actor either, two identical assertions with nothing to tell
    // them apart is the same call made twice, which is what `isSamePayment`
    // already reasons about for the confirm path.
    const identity =
      input.paymentIntentId ??
      input.reference ??
      `${input.actor ?? 'anon'}:${input.amountCents}c`;
    const marker = `[${input.method}:${identity}]`;

    const line = isRefunded
      ? `PAID AFTER THIS BOOKING WAS REFUNDED ${marker}: a ${input.method} payment of ` +
        `${input.amountCents} cents (ref ${input.reference ?? 'none'}) arrived on a booking whose ` +
        `money had already been sent back. NOTHING about the payment record was changed — the ` +
        `refund still stands — and NOTHING was refunded automatically. Find this payment in ` +
        `Stripe and decide by hand whether it is a second charge to return or a booking to redo.`
      : `PAID AFTER THE SLOT WAS RELEASED ${marker}: a ${input.method} payment of ${input.amountCents} cents ` +
        `(ref ${input.reference ?? 'none'}) arrived while this booking was '${row.status}'. ` +
        `The money is recorded and the status is unchanged. NOT refunded automatically.`;
    try {
      // Restates its expectations rather than trusting the SELECT above — a
      // concurrent Interac mark must not have its method and stamp overwritten
      // by the losing side.
      // EVERY MONEY COLUMN IS CASE-GUARDED ON THE REFUND, and the note and the
      // stamp are not. That asymmetry is the whole fix: the record of the
      // refund survives, and the office still hears that money arrived.
      //
      // THE CASE READS THE COLUMN, NOT `isRefunded`. Implementation review
      // caught the first version deciding on the value the SELECT above
      // returned, interpolated as a literal — which this statement's own
      // docstring already forbids ("restates its expectations rather than
      // trusting the SELECT above"). A refund settling between the read and
      // this UPDATE would have made `isRefunded` stale-false and written
      // `payment_status = 'paid'` over a refunded row: the exact defect BK-33
      // exists to remove, recreated by BK-33's own code. `payment_status <>
      // 'paid'` in the WHERE does not stop it — 'refunded' satisfies that.
      //
      // `isRefunded` still chooses the NOTE's wording, and only that. A note in
      // the wrong variant is a sentence somebody reads; a money column in the
      // wrong variant is money.
      const updated = (await sql`
        UPDATE appointments
        SET payment_status           = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN payment_status ELSE 'paid' END,
            paid_at                  = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN paid_at ELSE ${nowIso}::timestamptz END,
            payment_method           = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN payment_method ELSE ${input.method}::text END,
            paid_amount_cents        = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN paid_amount_cents ELSE ${input.amountCents}::integer END,
            payment_reference        = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN payment_reference ELSE ${input.reference}::text END,
            -- NOT repointed on the refunded arm, deliberately. The new money
            -- arrived on a DIFFERENT charge, and overwriting this would aim any
            -- future refund at the new one while destroying the only link back
            -- to the charge that was already returned. The note above carries
            -- the new intent id in text, which is what a human needs.
            stripe_payment_intent_id = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN stripe_payment_intent_id
              ELSE COALESCE(${isStripe ? (input.paymentIntentId ?? null) : null}, stripe_payment_intent_id) END,
            -- The audit trail matters MORE here, not less: this is an office
            -- member asserting money arrived for a booking that is not
            -- happening, which is the row somebody will ask about months later.
            interac_marked_by        = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN interac_marked_by ELSE ${isInterac ? (input.actor ?? null) : null}::text END,
            interac_marked_at        = CASE WHEN payment_status IN ('refunded', 'partially_refunded') THEN interac_marked_at ELSE ${isInterac ? nowIso : null}::timestamptz END,
            needs_attention          = CASE
              WHEN needs_attention IS NULL OR needs_attention = '' THEN ${line}
              ELSE needs_attention || ${`\n\n${line}`}
            END,
            updated_at               = ${nowIso}
        WHERE id = ${appointmentId}
          AND status IN ('payment_expired', 'declined', 'cancelled')
          AND payment_status <> 'paid'
          -- The refunded arm's dedupe. See the marker constant above: without
          -- it a replayed event appends the same paragraph on every delivery,
          -- because that arm leaves no stamp for the guard above to catch.
          AND (needs_attention IS NULL OR position(${marker} in needs_attention) = 0)
        RETURNING id
      `) as { id: number }[];
      if (updated.length === 0) return 'not-applicable';
    } catch (err) {
      console.error(`markPaid(${appointmentId}) could not record a late payment:`, err);
      return 'error';
    }
    await alertOffice(row, line, input.now, deps);
    return isRefunded ? 'paid-after-refund' : 'paid-after-release';
  }

  console.error(
    `markPaid(${appointmentId}): the row is '${row.status}', which no payment transition applies to.`,
  );
  return 'not-applicable';
}

// ---------------------------------------------------------------------------
// refundPayment — the ONE path that sends money back (BK-33)
// ---------------------------------------------------------------------------

export type RefundOutcome =
  /** Money went back in full, and the booking is cancelled. */
  | 'refunded'
  /** Part of the money went back, and the booking is cancelled. */
  | 'partially-refunded'
  /** A refund is already in flight on this row. Nothing moved. */
  | 'already-refunding'
  /** **Money went back and the row did not record it.** Flagged. The loud one. */
  | 'refunded-not-cancelled'
  /** Not a card payment — there is no Stripe charge to refund. */
  | 'not-card'
  /** A card row with no payment intent recorded. Nothing to aim at. */
  | 'no-charge'
  /** Never paid, or already fully refunded. */
  | 'not-paid'
  /** The refundable balance moved between the confirm screen and the click. */
  | 'changed-underneath'
  /** More than is left to refund. Nothing moved. */
  | 'too-much'
  | 'invalid-amount'
  /** Stripe refused, definitively. Nothing moved and the claim is released. */
  | 'stripe-error'
  /** Stripe's answer never arrived. The claim is LEFT STANDING and flagged. */
  | 'stripe-unknown'
  | 'missing'
  | 'error';

export type RefundResult = {
  outcome: RefundOutcome;
  /** Stripe's running total for the charge, once it is known. */
  refundedTotalCents?: number;
};

export type RefundInput = {
  amountCents: number;
  /**
   * What the office was shown as already refunded on the confirm screen.
   *
   * Part of the claim's WHERE, so a refundable balance that moved between the
   * screen and the click refuses instead of refunding against a stale figure.
   */
  expectedAlreadyRefundedCents: number;
  now: Date;
};

/**
 * What is still refundable on a row: what ARRIVED, less what has gone back.
 *
 * `paid_amount_cents`, never `total_amount_cents`. `db.ts` is explicit that the
 * two are separate columns "precisely so a disagreement between them is a fact
 * somebody can query" — the total is the quote, and refunding against a quote
 * would send back money that never arrived.
 */
export function refundableCents(
  row: Pick<Appointment, 'paid_amount_cents' | 'refunded_amount_cents'>,
): number {
  return Math.max(0, (row.paid_amount_cents ?? 0) - (row.refunded_amount_cents ?? 0));
}

/**
 * DEFENCE IN DEPTH, AND NOT THE DEDUPE.
 *
 * The first draft of this ticket rested its whole double-refund argument on
 * this key. Stripe's own documentation disposes of that: keys may be pruned
 * once they are 24 hours old and *"we generate a new request if a key is reused
 * after the original is pruned"*, and a request that conflicts with another
 * executing concurrently is not saved as an idempotent result at all. So it
 * deduplicates neither a genuine double-click nor a retry a day later.
 *
 * The dedupe is `refund_claim_key` in the database. This is what stops a
 * *network-level* retry inside the window from becoming a second refund, which
 * is a real and different job.
 */
export function refundIdempotencyKey(
  appointmentId: number,
  alreadyRefundedCents: number,
  amountCents: number,
): string {
  return `refund-${appointmentId}-${alreadyRefundedCents}-${amountCents}`;
}

const DEFINITE_STRIPE_REFUSALS: readonly string[] = [
  // The request reached Stripe and was rejected on its merits: over-refund,
  // wrong state, invalid amount.
  'StripeInvalidRequestError',
  // ── AND FOUR MORE, ADDED AT IMPLEMENTATION REVIEW ────────────────────────
  //
  // Each of these also means the request ARRIVED and no money moved, and
  // leaving them on the unknown arm was wrong in an expensive direction: the
  // claim would stand, the row would be flagged "it may or may not have gone
  // through", and the booking would refuse every further refund until somebody
  // edited the database by hand.
  //
  // `StripeAuthenticationError` is the one that makes this urgent. A wrong or
  // expired STRIPE_SECRET_KEY is the single most likely misconfiguration on a
  // route that has never run in production, and it would have produced a false
  // "money may be in flight" alarm on a real customer's booking and locked it.
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeRateLimitError',
  'StripeIdempotencyError',
];

/**
 * Whether Stripe gave us a DEFINITE no, or no answer at all.
 *
 * The distinction decides whether the claim is released, and it is the
 * difference between "the office may try again" and "nobody may touch this
 * until a human has looked in Stripe".
 *
 * Read off the error's own `type` rather than by `instanceof`: the SDK is a
 * dynamic import here, and the verify suite drives this branch through an
 * injected gateway that throws plain objects.
 *
 * **The default is UNKNOWN**, and that direction is deliberate: an
 * unrecognised error shape leaves the claim standing and a human looking,
 * rather than freeing the row for a second refund on top of one that may have
 * gone through.
 */
function isDefiniteStripeRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' && DEFINITE_STRIPE_REFUSALS.includes(type);
}

/**
 * What Stripe kept in processing fees on the original charge, or null.
 *
 * Through the SAME gateway every other Stripe call in this system goes
 * through — the refund route wanted this and the obvious spelling was a second
 * `paymentIntents.retrieve` written out in the route file, which would be two
 * spellings of one call and unreachable from a verify script. It answers a
 * question about the PAST and moves nothing, which is why it is separate from
 * `refundPayment` rather than folded into it: the money-moving function has no
 * use for the figure, and a second Stripe call inside it would widen the
 * surface that has to be driven red.
 *
 * Never throws, and null is an answer. A failed read must not stop a refund the
 * office needs to issue; it must only stop us printing a figure we do not have.
 */
export async function chargeFeeCents(
  paymentIntentId: string,
  deps: StripeDeps = {},
): Promise<number | null> {
  const gateway = await gatewayFor(deps);
  if (!gateway) return null;
  try {
    return await gateway.chargeFee(paymentIntentId);
  } catch (err) {
    console.error(`Could not read the processing fee for ${paymentIntentId}:`, err);
    return null;
  }
}

/**
 * Send money back, and cancel the booking, as ONE action.
 *
 * Same contract as `markPaid`: **never throws**, returns an outcome, guards its
 * own writes. Two callers — the admin refund route, and nothing else. The
 * reconciliation webhook is NOT a caller: it creates no refund, it only records
 * ones that already happened (`reconcileRefund` below).
 *
 * ── THREE PHASES, AND ONLY THE MIDDLE ONE MOVES MONEY ─────────────────────
 *
 * Both obvious orderings are wrong, and the ticket's plan review is where that
 * was established rather than guessed:
 *
 *   - **Write "refunded", then call Stripe.** A Stripe failure leaves a row
 *     claiming money went back when it did not — and, since this path emails
 *     the customer, a written promise of a refund nobody issued.
 *   - **Call Stripe, then write, with nothing in between.** Two office members
 *     refunding DIFFERENT amounts that sum to less than the charge produce two
 *     idempotency keys and two real refunds, and Stripe's over-refund refusal —
 *     the tempting backstop — never fires at all.
 *
 * So phase 1 claims the ATTEMPT and writes no money state; phase 2 calls
 * Stripe; phase 3 records what happened. A failure in phase 1 leaves nothing. A
 * failure in phase 3 leaves money returned and a row that says so loudly, which
 * `charge.refunded` also reconciles from the other side.
 *
 * ── THE CUSTOMER IS TOLD, AND NOT VIA THE CALENDAR BOUNDARY ───────────────
 *
 * `sendBoundaryMail` returns early when no invite boundary is crossed. A refund
 * on a row `markPaid` recorded as `paid-after-release` — already `cancelled`,
 * carrying real money — crosses nothing, so hanging the money message off that
 * test would have sent that customer nothing at all. The boundary decides
 * whether an ICS is owed; it does not decide whether the customer hears about
 * their money.
 */
export async function refundPayment(
  sql: Sql,
  appointmentId: number,
  input: RefundInput,
  deps: StripeDeps & NotifyDeps = {},
): Promise<RefundResult> {
  const nowIso = input.now.toISOString();

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { outcome: 'invalid-amount' };
  }

  const key = refundIdempotencyKey(
    appointmentId,
    input.expectedAlreadyRefundedCents,
    input.amountCents,
  );

  // ── PHASE 1: CLAIM THE ATTEMPT ─────────────────────────────────────────
  //
  // Exclusive on `refund_claim_key IS NULL`. The second click, the second tab
  // and the second office member all match zero rows here and never reach
  // Stripe. Nothing written by this statement says money moved.
  let claimed: Appointment[];
  try {
    claimed = (await sql`
      UPDATE appointments
      SET refund_claim_key  = ${key},
          refund_started_at = ${nowIso},
          updated_at        = ${nowIso}
      WHERE id = ${appointmentId}
        AND payment_method = 'stripe'
        AND stripe_payment_intent_id IS NOT NULL
        AND paid_amount_cents IS NOT NULL
        AND payment_status IN ('paid', 'partially_refunded')
        AND COALESCE(refunded_amount_cents, 0) = ${input.expectedAlreadyRefundedCents}
        AND refund_claim_key IS NULL
      RETURNING *
    `) as Appointment[];
  } catch (err) {
    console.error(`refundPayment(${appointmentId}) could not claim the attempt:`, err);
    return { outcome: 'error' };
  }

  if (claimed.length === 0) {
    // Zero rows is six situations, and collapsing them would tell an office
    // member that a refund is in flight when the truth is that the booking was
    // never paid by card. Same discipline as markPaid's three-way read-back:
    // nothing has been written, so this read decides a MESSAGE, not an action.
    let rows: Appointment[];
    try {
      rows = (await sql`SELECT * FROM appointments WHERE id = ${appointmentId}`) as Appointment[];
    } catch (err) {
      console.error(`refundPayment(${appointmentId}) could not read the row back:`, err);
      return { outcome: 'error' };
    }
    const row = rows[0];
    if (!row) return { outcome: 'missing' };
    if (row.refund_claim_key !== null) return { outcome: 'already-refunding' };
    if (row.payment_method !== 'stripe') return { outcome: 'not-card' };
    if (row.stripe_payment_intent_id === null) return { outcome: 'no-charge' };
    if (row.paid_amount_cents === null) return { outcome: 'not-paid' };
    if (row.payment_status !== 'paid' && row.payment_status !== 'partially_refunded') {
      return { outcome: 'not-paid' };
    }
    return { outcome: 'changed-underneath' };
  }

  const row = claimed[0];

  /** Undo the claim. Safe by construction: it carries no money state. */
  const release = async (): Promise<void> => {
    try {
      await sql`
        UPDATE appointments
        SET refund_claim_key = NULL, refund_started_at = NULL, updated_at = ${nowIso}
        WHERE id = ${appointmentId} AND refund_claim_key = ${key}
      `;
    } catch (err) {
      console.error(`refundPayment(${appointmentId}) could not release its claim:`, err);
    }
  };

  // Checked against the CLAIMED row rather than against anything the screen
  // passed in. The claim is the authoritative snapshot, and it is held, so this
  // is not a check-then-act — nothing else can move the balance underneath it.
  const refundable = refundableCents(row);
  if (input.amountCents > refundable) {
    await release();
    return { outcome: 'too-much' };
  }

  const gateway = await gatewayFor(deps);
  if (!gateway) {
    console.error(`refundPayment(${appointmentId}): no card processor is configured.`);
    await release();
    return { outcome: 'stripe-error' };
  }

  // ── PHASE 2: STRIPE ────────────────────────────────────────────────────
  let refund: { id: string; amount: number; status: string | null };
  try {
    refund = await gateway.createRefund(
      {
        payment_intent: row.stripe_payment_intent_id!,
        amount: input.amountCents,
        // NO `reason`. Stripe's three values are 'duplicate', 'fraudulent' and
        // 'requested_by_customer'; none describes a company-side cancellation,
        // 'requested_by_customer' is false on the path this feature exists for,
        // and 'fraudulent' adds the card and the email to Radar's block lists —
        // quietly banning a customer we cancelled on.
        metadata: { appointment_id: String(appointmentId), source: 'admin-refund' },
      },
      key,
    );
  } catch (err) {
    if (isDefiniteStripeRefusal(err)) {
      console.error(`refundPayment(${appointmentId}): Stripe refused the refund:`, err);
      await release();
      return { outcome: 'stripe-error' };
    }
    // NO ANSWER. The claim STAYS, deliberately: money may be in flight, and a
    // released claim would let the office refund again on top of it. Refusing
    // until a human looks is the safe direction, and charge.refunded reconciles
    // the row if the money did go.
    console.error(`refundPayment(${appointmentId}): Stripe gave no answer:`, err);
    await flagAndAlert(
      sql,
      row,
      `A REFUND OF ${input.amountCents} CENTS WAS SENT TO STRIPE AND NO ANSWER CAME BACK. ` +
        'It may or may not have gone through. This booking will refuse further refunds until ' +
        'somebody checks the charge in Stripe and clears it by hand. NOTHING was recorded here ' +
        'and the customer has NOT been told.',
      input.now,
      deps,
    );
    return { outcome: 'stripe-unknown' };
  }

  // ── PHASE 3: RECORD IT ─────────────────────────────────────────────────
  const totalRefunded = input.expectedAlreadyRefundedCents + refund.amount;
  const paid = row.paid_amount_cents ?? 0;
  const fully = totalRefunded >= paid;
  const nextPaymentStatus = fully ? 'refunded' : 'partially_refunded';

  let settled: Appointment[];
  try {
    settled = (await sql`
      UPDATE appointments
      SET stripe_refund_id      = ${refund.id},
          refunded_amount_cents = ${totalRefunded},
          refunded_at           = ${nowIso},
          payment_status        = ${nextPaymentStatus},
          refund_claim_key      = NULL,
          refund_started_at     = NULL,
          -- A row that has ALREADY released its slot keeps the status it has.
          -- Rewriting declined or payment_expired to cancelled would erase why
          -- the booking ended, and the slot is off the market either way.
          status = CASE
                     WHEN status IN ('cancelled', 'declined', 'payment_expired') THEN status
                     ELSE 'cancelled'
                   END,
          cancelled_at = CASE
                           WHEN status IN ('cancelled', 'declined', 'payment_expired')
                             THEN cancelled_at
                           ELSE ${nowIso}::timestamptz
                         END,
          updated_at = ${nowIso}
      WHERE id = ${appointmentId} AND refund_claim_key = ${key}
      RETURNING *
    `) as Appointment[];
  } catch (err) {
    console.error(`refundPayment(${appointmentId}) refunded but could not record it:`, err);
    settled = [];
  }

  if (settled.length === 0) {
    // MONEY WENT BACK AND THE ROW DOES NOT SAY SO. The one outcome the office
    // must act on, so it is flagged rather than merely returned — and
    // charge.refunded will reconcile the figure from the other side even if
    // nobody reads the flag.
    await flagAndAlert(
      sql,
      row,
      `REFUND ${refund.id} OF ${refund.amount} CENTS WENT THROUGH AT STRIPE AND THIS BOOKING ` +
        'COULD NOT BE UPDATED. The money is on its way back to the customer. The booking is ' +
        'still holding its slot — cancel it here with the status dropdown, which will NOT ' +
        'attempt a second refund. Do not refund again in Stripe. ' +
        // Said explicitly, because this path never reaches the customer message
        // AND the recovery above sends the wrong one: cancelling through the
        // dropdown sends the NO-REFUND cancellation, which says "nothing
        // further is needed from you" and mentions money not at all. That is
        // verbatim the failure the pre-BK-33 manual procedure was recorded for,
        // reachable through this ticket's loudest outcome. Its two sibling
        // flags carry this sentence; implementation review found this one did
        // not.
        'THE CUSTOMER HAS NOT BEEN TOLD ANYTHING BY US about this refund, and cancelling ' +
        'through the dropdown will NOT tell them either — that message mentions no money. ' +
        'Phone them.',
      input.now,
      deps,
    );
    return { outcome: 'refunded-not-cancelled', refundedTotalCents: totalRefunded };
  }

  await tellCustomerAboutRefund(row, settled[0], totalRefunded - input.expectedAlreadyRefundedCents, input.now, deps);

  return {
    outcome: fully ? 'refunded' : 'partially-refunded',
    refundedTotalCents: totalRefunded,
  };
}

/**
 * The customer's word from us about their money.
 *
 * TWO ARMS, ONE BUILDER FAMILY, and the arm is chosen by whether a calendar
 * invite was cleared — never by whether a message is owed. A message is always
 * owed when money went back and we hold an address.
 */
async function tellCustomerAboutRefund(
  before: Appointment,
  after: Appointment,
  amountCents: number,
  now: Date,
  deps: NotifyDeps,
): Promise<void> {
  const email =
    typeof before.email === 'string' && before.email.trim() !== '' ? before.email : null;

  const crossedOut =
    couldHoldCalendarInvite(before.status) && !couldHoldCalendarInvite(after.status);

  if (crossedOut) {
    // The cancellation carries the refund and its CANCEL ics, and the office
    // gets its copy — one message per audience, not a cancellation and a
    // refund notice arriving separately about one event.
    await sendBoundaryMail(
      {
        next_status: after.status,
        prev_status: before.status,
        id: before.id,
        name: before.name,
        phone: before.phone,
        email: before.email,
        address: before.address,
        city: before.city,
        postal_code: before.postal_code,
        service_label: SERVICE_LABELS[before.service] ?? before.service,
        slot_start: before.slot_start,
      },
      now,
      deps,
      { amountCents },
    );
    return;
  }

  // No boundary: the booking was already off and their calendar already clear.
  // They still have to hear that their money is coming back.
  if (!email) return;
  const event = inviteEventFromAppointment(
    before,
    SERVICE_LABELS[before.service] ?? before.service,
  );
  await withDeadline(
    sendCustomerMessage(
      before.id,
      'refunded',
      planRefundNotice(event, email, now, { amountCents }),
      now,
      deps,
    ),
    POST_COMMIT_BUDGET_MS,
    'failed' as const,
  ).then((outcome) => {
    if (outcome === 'failed') {
      console.error(`Booking ${before.id}: the refund notice did not send.`);
    }
  });
}

// ---------------------------------------------------------------------------
// reconcileRefund — a refund that happened somewhere else (BK-33)
// ---------------------------------------------------------------------------

export type ReconcileOutcome =
  /** The row now matches Stripe. */
  | 'reconciled'
  /** Already matched. A redelivery, or our own path got there first. */
  | 'unchanged'
  /** No row carries that payment intent. */
  | 'no-row'
  | 'error';

/**
 * Record a refund Stripe already made, whoever made it.
 *
 * ── THIS IS WHERE THE OFFICE'S DASHBOARD REFUND LANDS ─────────────────────
 *
 * The office will sometimes refund in Stripe directly — for a case-by-case
 * exception, or simply because that is the window already open. Before BK-33
 * nothing here heard about it, so the row kept `payment_status = 'paid'` and
 * the admin screen stated **"Payment received — Paid by card"** on a booking
 * refunded in full. That is the defect this ticket exists for, and this
 * function is the only thing that can close it.
 *
 * ── THE FIGURE IS STRIPE'S RUNNING TOTAL, NEVER OUR ARITHMETIC ────────────
 *
 * `charge.amount_refunded` is what is written, and it is written as an
 * OVERWRITE rather than an addition. That is what makes a dashboard refund, a
 * screen refund and a redelivery of either converge on one number instead of
 * summing into a figure belonging to nobody.
 *
 * ── AND IT MAY MOVE DOWN, WHICH IS NOT AN ACCIDENT ────────────────────────
 *
 * A monotonic guard here — refuse anything lower than what is recorded — is the
 * obvious defence against an out-of-order redelivery, and it was in the first
 * implementation. It is wrong, and BK-33's own `refund.failed` reasoning is why:
 * **Stripe LOWERS `charge.amount_refunded` when a refund fails**, and that
 * corrected total arriving on the charge is the only authoritative correction
 * there is. A guard that refused it would leave the row permanently claiming
 * money went back that did not — the record-truth defect this ticket exists to
 * fix, pointed the other way, and reachable through an ordinary failed refund
 * rather than an exotic race.
 *
 * The residual, stated rather than hidden: Stripe does not guarantee event
 * order, so two charge events delivered out of sequence leave the row on the
 * one processed last. It self-corrects on the next event for that charge, the
 * webhook's own claim table means each event is applied exactly once, and the
 * office has the flag. Choosing Stripe's latest word over our own arithmetic is
 * the same rule the rest of this function follows.
 *
 * ── IT NEVER CANCELS AND NEVER EMAILS ─────────────────────────────────────
 *
 * A refund says something about money and nothing about whether the visit is
 * happening. Inferring a cancellation from it would strand a real customer, and
 * emailing "your assessment is cancelled" for a row that is still `confirmed`
 * would be a lie we sent on purpose. It flags instead.
 *
 * ── AND THE FLAG IS CONDITIONAL, WHICH IS THE PART THAT IS EASY TO MISS ───
 *
 * Flagging every reconciled refund would put a permanent red banner reading
 * *"still CONFIRMED and still holding its slot"* on the happy path of this
 * ticket's own feature: `charge.refunded` can arrive before `refundPayment`'s
 * phase 3 lands, `needs_attention` is append-only, and nothing clears it. So
 * the flag asks the ROW two questions — is one of our refunds in flight, and is
 * this booking still standing — and fires only for a refund that came from
 * outside and left work behind.
 */
export async function reconcileRefund(
  sql: Sql,
  paymentIntentId: string,
  totalRefundedCents: number,
  chargeAmountCents: number,
  refundId: string | null,
  now: Date,
  deps: NotifyDeps = {},
): Promise<ReconcileOutcome> {
  const nowIso = now.toISOString();
  const fully = totalRefundedCents >= chargeAmountCents;
  const nextPaymentStatus = fully ? 'refunded' : 'partially_refunded';

  let rows: Appointment[];
  try {
    // ORDERED AND LIMITED. `stripe_payment_intent_id` carries no unique index —
    // `markPaid`'s paid-after-release branch can stamp the same intent on more
    // than one row in principle — so an unordered `rows[0]` reconciles whichever
    // row the planner happened to return. Deterministic, and noisy when it is
    // ambiguous, beats silently correct-most-of-the-time on a money path.
    rows = (await sql`
      SELECT * FROM appointments
      WHERE stripe_payment_intent_id = ${paymentIntentId}
      ORDER BY id
      LIMIT 2
    `) as Appointment[];
  } catch (err) {
    console.error(`reconcileRefund could not read ${paymentIntentId}:`, err);
    return 'error';
  }
  const row = rows[0];
  if (!row) {
    // Not ours, or a charge from before this system recorded intents. A logged
    // no-op, in the same shape appointmentIdOf uses for an unusable id: there
    // is nothing to act on and retrying changes nothing.
    console.error(
      `reconcileRefund: no booking carries payment intent ${paymentIntentId}. Refund ignored.`,
    );
    return 'no-row';
  }
  if (rows.length > 1) {
    console.error(
      `reconcileRefund: payment intent ${paymentIntentId} is on more than one booking. ` +
        `Reconciling ${row.id} only — resolve the duplicate by hand.`,
    );
  }

  // Our own refund is mid-flight, or this event tells us nothing new.
  const oursInFlight = row.refund_claim_key !== null;
  const alreadyMatches =
    (row.refunded_amount_cents ?? 0) === totalRefundedCents &&
    row.payment_status === nextPaymentStatus;

  if (alreadyMatches) return 'unchanged';

  try {
    await sql`
      UPDATE appointments
      SET refunded_amount_cents = ${totalRefundedCents},
          refunded_at           = COALESCE(refunded_at, ${nowIso}::timestamptz),
          stripe_refund_id      = COALESCE(${refundId}, stripe_refund_id),
          payment_status        = ${nextPaymentStatus},
          -- AND THE CLAIM IS RELEASED, WHICH IS THE ONLY AUTOMATIC WAY OUT OF
          -- THE STANDING-CLAIM STATE (implementation review, S4).
          --
          -- refundPayment leaves a claim standing when Stripe gives no answer,
          -- deliberately: money may be in flight and a released claim would let
          -- the office refund again on top of it. But nothing anywhere cleared
          -- it, so recovery was a hand-written UPDATE against production
          -- Postgres by a developer, and no message said so.
          --
          -- If the money DID go through, this event is the proof — and once the
          -- refund is recorded, the attempt is over and the claim has nothing
          -- left to protect. That closes the common half automatically. The
          -- other half (no answer, and no money moved, so no event ever
          -- arrives) still needs a human, and the flash now says so.
          refund_claim_key      = NULL,
          refund_started_at     = NULL,
          updated_at            = ${nowIso}
      WHERE id = ${row.id}
    `;
  } catch (err) {
    console.error(`reconcileRefund could not update booking ${row.id}:`, err);
    return 'error';
  }

  // THE FLAG, and only when this refund left work behind. See the note above:
  // an unconditional flag would fire on this feature's own happy path.
  const stillStanding =
    row.status === 'confirmed' || row.status === 'completed' || row.status === 'no_show';
  if (!oursInFlight && stillStanding) {
    await flagAndAlert(
      sql,
      row,
      `REFUNDED IN STRIPE, OUTSIDE THIS SYSTEM: ${totalRefundedCents} cents of ` +
        `${chargeAmountCents} have been sent back. This booking is STILL '${row.status}' and ` +
        'is still holding its slot — cancel it here if the visit is not happening. ' +
        'THE CUSTOMER HAS NOT BEEN TOLD ANYTHING BY US about this money; Stripe may have ' +
        'emailed its own notice, which we do not control and cannot see.',
      now,
      deps,
    );
  }

  return 'reconciled';
}

/**
 * The customer's confirmation and the office's calendar invite.
 *
 * ── WHICH CUSTOMER MESSAGE THIS SENDS, AND WHY IT CHANGED (BK-45) ──────────
 *
 * It used to send `planFirstConfirmationEmail` — `update.ts`'s calendar-boundary
 * builder, reused on the argument that a second confirmation-email builder is
 * the *"branch in the email layer and a second status path"* the confirm seam
 * exists to prevent. The argument was right and the choice was still wrong,
 * because there was never one builder to reuse: `customerConfirmation` already
 * existed, already carried the assessment terms, the have-ready list and the
 * chosen tier, and was already what the **Resend confirmation** button sent. So
 * the seam produced exactly what it was meant to prevent — two materially
 * different emails both called the confirmation, with the thin one going to the
 * customer who paid and the full one to whoever the office resent.
 *
 * Found 2026-08-19 by the first real payment on production. It now sends
 * `planForAppointment(...).customer`, which is the builder `resend.ts` calls,
 * with the arguments derived from the same row — so "a resent confirmation is
 * the message the customer originally received" is true by construction rather
 * than by two builders being kept in step.
 *
 * **The ICS does not change, and that is a property rather than a promise.**
 * `icsEventOf` and `inviteEventFromAppointment` build the same eight-field
 * `IcsEvent` from the same row, both attach METHOD `request` with the customer
 * as ATTENDEE, and `buildBookingIcs` is a pure function of those plus `now`.
 * Same UID, same SEQUENCE, byte-identical body.
 *
 * **BK-23's B2 fix is still inherited**, one level more strongly than before: a
 * payment-confirmed row is told it is confirmed and never that it "was cancelled
 * and has now been reinstated", because the builder it now uses has no
 * reinstatement copy at all.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ─────────────────────────────────────────
 *
 * The SENDER stays `sendCalendarInvite`: the message is still invite-bearing,
 * and keeping it preserves the idempotency prefix (`booking-<id>-request-<seq>`)
 * and the mute line the admin verify suite reads. And nothing here stamps
 * `confirmation_sent_at` — `sendConfirmationAndStamp` writes that column, this
 * does not, and it must not start, because the column currently records the
 * REQUEST acknowledgement and stamping it here would overwrite that fact. The
 * column's mislabelling was BK-46's. BK-46 renamed the panel field to
 * "Request / confirmation email" and named the senders it does NOT record —
 * this one among them. It did NOT make the column answer "has the customer
 * heard from us"; that needs a second column, and it is recorded as open.
 *
 * One deadline over both sends, run concurrently — the same reasoning
 * `sendBoundaryMail` states: two serial budgets stack past the platform's
 * function limit on a request that has already written a row.
 */
async function sendConfirmation(
  row: Appointment,
  now: Date,
  deps: NotifyDeps = {},
): Promise<void> {
  try {
    // ONE LABEL FOR BOTH. The invite and the confirmation describe one
    // appointment; deriving the service label twice is how they come to disagree.
    const serviceLabel = SERVICE_LABELS[row.service] ?? row.service;
    const event = inviteEventFromAppointment(row, serviceLabel);
    const email = typeof row.email === 'string' && row.email.trim() !== '' ? row.email : null;

    const sends: Promise<[string, string]>[] = [
      sendCalendarInvite(
        planCalendarInvite(event, 'request', now),
        { id: row.id, kind: 'request', now, audience: 'office' },
        deps,
      ).then((o) => ['office', o] as [string, string]),
    ];

    // THE GUARD IS THIS ONE, NOT THE BUILDER'S (BK-45). `customerConfirmation`
    // returns null on a FALSY email; the line above trims first, so a
    // whitespace-only address is falsy here and truthy there. Keeping the send
    // gated on `email` rather than on `plan.customer` is what makes the
    // behaviour identical to what shipped before this ticket — a blank address
    // queues nothing, rather than queueing a message addressed to spaces.
    const customer = email ? planForAppointment(row, serviceLabel, now).customer : null;
    if (customer) {
      sends.push(
        sendCalendarInvite(
          customer,
          { id: row.id, kind: 'request', now, audience: 'customer' },
          deps,
        ).then((o) => ['customer', o] as [string, string]),
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
async function flagAndAlert(
  sql: Sql,
  row: Appointment,
  line: string,
  now: Date,
  deps: NotifyDeps = {},
): Promise<void> {
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
  await alertOffice(row, line, now, deps);
}

/**
 * The office alert. Email, because Twilio is not available in Deploy 2.
 *
 * Under its own deadline and unable to fail its caller: the money has already
 * moved and the row already says so.
 */
async function alertOffice(
  row: Appointment,
  line: string,
  now: Date,
  deps: NotifyDeps = {},
): Promise<void> {
  await withDeadline(
    sendOfficeMessage(row.id, 'payment-attention', paymentAttentionAlert(row, line, now), deps).then(
      () => true,
    ),
    POST_COMMIT_BUDGET_MS,
    false,
  );
}
