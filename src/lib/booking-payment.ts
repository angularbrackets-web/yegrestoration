/**
 * The payment seam (BK-23 → BK-32).
 *
 * BK-23 owns the review loop: it decides the amount, computes the deadline,
 * transitions the row and sends the approval email. BK-32 owns the card
 * payment. This module is the joint between them, and it exists so that BK-23
 * is a complete, shippable ticket rather than one that has to wait for Stripe
 * to be finished.
 *
 * ── NULL IS A SUPPORTED ANSWER, NOT A STUB THAT LIES ───────────────────────
 *
 * `createCheckoutUrl` returns null when no card processor is configured, and
 * the approval path handles that by offering the Interac route alone — which
 * the client confirmed is a real way to pay, not a fallback. What the route
 * refuses to do is approve a booking with NEITHER (`canOfferPayment`), because
 * that is an approval the customer cannot act on.
 *
 * So the behaviour with this module unimplemented is correct rather than
 * broken: the office approves, the customer gets an itemised amount, a
 * deadline, and an e-Transfer address. BK-32 adds a card button to the same
 * email and a webhook that confirms on payment.
 *
 * ── WHAT BK-32 REPLACES ────────────────────────────────────────────────────
 *
 * The body of `createCheckoutUrl`, and nothing else. Its signature already
 * carries what a Stripe Checkout Session needs: the appointment to put in
 * `metadata.booking_id`, the amount to charge, and the deadline to clamp into
 * `expires_at`. The caller does not change.
 */

import { readEnv } from './env';

export type CheckoutRequest = {
  appointmentId: number;
  /** The itemised total, in cents, GST included. What the customer is charged. */
  totalCents: number;
  /** The payment deadline, or null on the pay-now branch. Becomes `expires_at`. */
  dueAt: Date | null;
};

/**
 * A hosted payment URL for this approval, or null when card payment is not
 * configured.
 *
 * Async because the implementation will be: creating a Checkout Session is a
 * network call. Declaring it async now means BK-32 does not change a single
 * call site, and the `await` at the call site is already written.
 */
export async function createCheckoutUrl(_request: CheckoutRequest): Promise<string | null> {
  // BK-32: create a Stripe Checkout Session here and return its `url`.
  //
  // Gated on the key rather than on a feature flag, so that configuring Stripe
  // is what turns it on and there is no second switch to forget. Until BK-32
  // lands this is null even with a key present — the key alone does not make a
  // session exist, and returning a fabricated URL would be worse than
  // returning nothing.
  const configured = readEnv('STRIPE_SECRET_KEY');
  if (!configured) return null;

  console.warn(
    'STRIPE_SECRET_KEY is set but card checkout is not implemented yet (BK-32) — ' +
      'the approval email will offer the Interac route only.',
  );
  return null;
}
