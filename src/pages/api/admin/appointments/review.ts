import type { APIRoute } from 'astro';

export const prerender = false;

import { adminAppointmentPath, ADMIN_APPOINTMENTS_PATH } from '../../../../lib/booking-admin';
import {
  CHECKOUT_BUDGET_MS,
  INTERAC_EMAIL,
  POST_COMMIT_BUDGET_MS,
} from '../../../../lib/booking-config';
import {
  approvalMessage,
  canOfferPayment,
  declineMessage,
  type ApprovalDetails,
  type BookingNotificationInput,
} from '../../../../lib/booking-email';
import { sendCustomerMessage, withDeadline } from '../../../../lib/booking-notify';
import { assessmentQuote, gstFor, isAssessmentTier } from '../../../../lib/booking-pricing';
import {
  isReviewAction,
  parseAmountCents,
  amountField,
  paymentDeadline,
} from '../../../../lib/booking-review';
import { formatSlot } from '../../../../lib/booking-time';
import {
  createCheckoutSession,
  expireCheckoutSession,
  markPaid,
  stripeConfigured,
} from '../../../../lib/booking-payment';
import { getDb, SERVICE_LABELS, type Appointment } from '../../../../lib/db';

/**
 * Approve or decline a request (BK-23).
 *
 * ── WHY THIS IS NOT PART OF `update.ts` ────────────────────────────────────
 *
 * `update.ts` is a whitelist editor: the office sets a status, a stage, a note,
 * and the route's job is to not let anything else through. A review decision is
 * a different animal. It reads amounts, computes a deadline, moves money's
 * worth of state, and sends a message the customer acts on — and it must be
 * refused outright when the row is not in the state the decision assumes.
 * Folding that into the editor would mean the editor's dropdown could also
 * perform it, which is exactly what must not happen: an office member setting
 * the status to `approved_awaiting_payment` by hand would approve a booking
 * with no amount, no deadline and no email.
 *
 * ── EVERY TRANSITION IS A GUARDED UPDATE ───────────────────────────────────
 *
 * `WHERE id = $1 AND status = 'pending_review'` — and zero rows returned means
 * this was not our transition to make. A double-click, a second tab, or a
 * decline racing an approve all land there and become no-ops rather than
 * second sends. There is no SELECT-then-UPDATE anywhere in here; that is the
 * check-then-act race this codebase already closed once on the booking path.
 *
 * ── THE ORDER OF THE TWO SIDE EFFECTS ──────────────────────────────────────
 *
 * State first, mail second, and the mail can never fail the request — the same
 * contract `create.ts` runs under, for the same reason. But approval carries an
 * extra rule that the booking path does not: **it refuses to transition at all
 * unless the customer can be told.** An approved booking whose customer never
 * heard is worse than one left pending, because the slot is held and a clock is
 * running while nobody is coming. So the message is BUILT before the UPDATE and
 * only SENT after it.
 */

function back(path: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${path}?${query}` } });
}

export const POST: APIRoute = async ({ request, site }) => {
  const now = new Date();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(ADMIN_APPOINTMENTS_PATH, { saved: 'invalid' });
  }

  const rawId = form.get('id');
  const id = Number.parseInt(typeof rawId === 'string' ? rawId : '', 10);
  if (!Number.isInteger(id) || id <= 0) {
    return back(ADMIN_APPOINTMENTS_PATH, { saved: 'invalid' });
  }
  const detail = adminAppointmentPath(id);

  const action = form.get('action');
  if (!isReviewAction(action)) return back(detail, { review: 'invalid' });

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Review could not reach the database:', err);
    return back(detail, { review: 'error' });
  }

  // One read, for the message contents and the amounts to check against. It is
  // NOT a permission check — the guarded UPDATE below is what decides whether
  // the transition happens, so a row that changes between this SELECT and that
  // UPDATE simply produces zero rows and a no-op.
  let row: Appointment | undefined;
  try {
    const rows = (await sql`SELECT * FROM appointments WHERE id = ${id}`) as Appointment[];
    row = rows[0];
  } catch (err) {
    console.error(`Review could not load appointment ${id}:`, err);
    return back(detail, { review: 'error' });
  }
  if (!row) return back(ADMIN_APPOINTMENTS_PATH, { saved: 'missing' });

  const notificationInput: BookingNotificationInput = {
    id: row.id,
    messageType: action === 'approve' ? 'payment-link' : 'declined',
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

  if (action === 'preview') return preview(row, form, now, detail);

  // Stripe redirects a browser back from its own domain, so the success and
  // cancel URLs must be ABSOLUTE — a relative path is not a destination for a
  // redirect that starts at checkout.stripe.com. `site` is the configured
  // production origin from `astro.config.mjs`.
  //
  // The fallback is read off `request.url` rather than off the context's `url`,
  // and that is not a style choice: `url` is absent when the route is invoked
  // directly rather than through the dev server, which is how
  // `verify-booking-admin-db.ts` drives every one of these arms. A `Request`
  // always carries an absolute URL, so this cannot be undefined however the
  // route is reached — and a preview deployment on a generated hostname gets a
  // working success URL out of it for free.
  const origin = site?.toString() ?? new URL(request.url).origin;

  return action === 'approve'
    ? approve(sql, row, notificationInput, form, now, detail, origin)
    : decline(sql, row, notificationInput, now, detail);
};

/**
 * The confirm step. Parses and validates the typed amounts, changes nothing,
 * and sends the office back to the detail page with the figures to look at.
 *
 * **Nothing here writes.** A preview that transitioned would be an approval
 * with an extra click, and the whole point is that the click AFTER the total is
 * the one that charges.
 *
 * The amounts go back as normalised decimal strings rather than as cents,
 * because the page re-posts them into the same `assessment_amount` /
 * `travel_fee` fields that `approve` re-parses. One parser, one spelling: the
 * number the office confirms cannot differ from the number that is charged,
 * because they are produced by the same call on the same string.
 */
function preview(row: Appointment, form: FormData, now: Date, detail: string): Response {
  const parsed = amountsFrom(row, form);
  if ('error' in parsed) return back(detail, { review: parsed.error });

  const deadline = paymentDeadline(row.slot_start, now);
  return back(detail, {
    confirm: '1',
    base: amountField(parsed.baseCents),
    travel: amountField(parsed.travelCents),
    due: deadline.dueAt ? String(deadline.dueAt.getTime()) : 'now',
  });
}

/**
 * The one place the typed amounts become numbers, shared by `preview` and
 * `approve` so the confirmed figure and the charged figure cannot drift.
 *
 * Absent fields fall back to the suggestion; present-but-unparseable ones are
 * an error, never a silent fallback — a typo that quietly becomes the suggested
 * price is a charge nobody chose.
 */
function amountsFrom(
  row: Appointment,
  form: FormData,
):
  | { baseCents: number; travelCents: number; suggested: ReturnType<typeof assessmentQuote> }
  | { error: 'amount' | 'travel' | 'tier' } {
  if (!row.assessment_tier) return { error: 'tier' };

  const suggested = assessmentQuote({
    tier: row.assessment_tier,
    service: row.service,
    slotStart: row.slot_start,
  });

  const baseRaw = form.get('assessment_amount');
  const travelRaw = form.get('travel_fee');

  const baseCents =
    baseRaw === null || baseRaw === '' ? suggested.baseCents : parseAmountCents(baseRaw);
  const travelCents = travelRaw === null || travelRaw === '' ? 0 : parseAmountCents(travelRaw);
  if (baseCents === null) return { error: 'amount' };
  if (travelCents === null) return { error: 'travel' };
  return { baseCents, travelCents, suggested };
}

async function approve(
  sql: ReturnType<typeof getDb>,
  row: Appointment,
  input: BookingNotificationInput,
  form: FormData,
  now: Date,
  detail: string,
  origin: string,
): Promise<Response> {
  // A tier is required to approve, because the amount is derived from one. The
  // office sets it on the edit form first; the button is hidden without one,
  // and this is the server-side half of that.
  if (!isAssessmentTier(row.assessment_tier)) {
    return back(detail, { review: 'notier' });
  }

  // THE SLOT MUST STILL BE IN THE FUTURE.
  //
  // Task 4's auto-decline at slot-4h is what normally makes this unreachable,
  // and the two compose deliberately: the cron expires at slot-4h, and this
  // catches anything it missed because it was down, throttled, or deployed
  // late. Without it a Monday request for Tuesday 11:30 that nobody reviewed is
  // still approvable on Wednesday — emailing "please pay as soon as you can"
  // for a visit two days gone and opening a live Checkout Session for it.
  //
  // `paymentDeadline` will not catch it: a negative time-to-slot lands in the
  // pay-now branch, which is correct for a slot four hours out and wrong for
  // one behind us. The check belongs here, on the transition.
  //
  // Refuses rather than auto-declining. Declining is a customer-facing message
  // and an irreversible slot release; an office member who meant to approve
  // should be told why they cannot, not have a different transition chosen for
  // them.
  if (row.slot_start.getTime() <= now.getTime()) {
    return back(detail, { review: 'elapsed' });
  }

  // ...but the office may override both, which is the point of the screen.
  // Absent fields fall back to the suggestion; present-but-unparseable ones are
  // an error, never a silent fallback — a typo that quietly becomes the
  // suggested price is a charge nobody chose.
  const parsed = amountsFrom(row, form);
  if ('error' in parsed) return back(detail, { review: parsed.error });
  const { baseCents, travelCents } = parsed;

  // GST AND THE TOTAL ARE COMPUTED, NEVER TYPED — there is no field for either,
  // so no typo can put the tax and the subtotal on different numbers.
  //
  // `gstFor` rather than reusing the suggestion's `gstCents`: the base may have
  // been overridden, and scaling a previously-rounded figure to the new
  // subtotal drifts by a cent. One rounding, on the number actually charged.
  const subtotalCents = baseCents + travelCents;
  const gstCents = gstFor(subtotalCents);
  const totalCents = subtotalCents + gstCents;

  const deadline = paymentDeadline(row.slot_start, now);

  // ── A $0.00 TOTAL IS A BOOKING WITH NO PAYMENT STEP ──────────────────────
  //
  // `parseAmountCents` accepts zero deliberately — a goodwill visit, or a job
  // the office is absorbing. Under prepay that is a booking needing no payment
  // step, not one with a broken step, so it must never open a Checkout Session.
  //
  // TESTED BEFORE THE `noemail` AND `nopayment` CHECKS BELOW, because it needs
  // neither: there is no link to send and no method to offer. A goodwill visit
  // for a customer with no email address is still a booking the office should
  // be able to confirm.
  if (totalCents === 0) {
    return approveFree(sql, row, baseCents, travelCents, gstCents, now, detail);
  }

  // REFUSE BEFORE TRANSITIONING, not after. Both of these leave the row in
  // `pending_review`, which is recoverable; approving into a state the customer
  // cannot act on is not.
  //
  // ── WHY THESE TWO AND NOT `canOfferPayment` ON A REAL SESSION ────────────
  //
  // Since BK-32 the Checkout Session is created AFTER the transition — it has
  // to be, because its idempotency key names the stored `approved_at`. So the
  // card link is not knowable here. What IS knowable without a network call is
  // whether ANY payment method is configured at all, and that is the half of
  // BK-23's rule that has to survive:
  //
  //   * no email address  → `approvalMessage` would return null, so there is
  //     nobody to tell. `if (!input.email) return null` is that function's only
  //     refusal, which makes this check a faithful stand-in for building it.
  //   * neither Interac nor Stripe configured → an approval nobody can act on.
  //
  // If Stripe is configured but the call then FAILS, the approval degrades to
  // the Interac route; and if there is no Interac route either, the transition
  // is rolled back below rather than left standing.
  if (!input.email) return back(detail, { review: 'noemail' });
  if (INTERAC_EMAIL === null && !stripeConfigured()) {
    console.error(`Booking ${row.id} cannot be approved: no payment method is configured.`);
    return back(detail, { review: 'nopayment' });
  }

  // ── THE TRANSITION, FIRST ────────────────────────────────────────────────
  //
  // Before Stripe, not after, and the inversion is what BK-32's plan review
  // turned on. `RETURNING` hands back the columns the Session is then built
  // from, so "the line items come from the STORED amounts" is literally true
  // rather than a claim about locals that happen to match — and a double-click
  // gets zero rows here and never reaches Stripe at all.
  //
  // `stripe_session_id` comes back too: a re-approval after a corrected amount
  // has to expire the old link before minting a new one, or the customer holds
  // two live links at two prices.
  type Approved = Pick<
    Appointment,
    | 'id'
    | 'approved_at'
    | 'assessment_amount_cents'
    | 'travel_fee_cents'
    | 'gst_cents'
    | 'total_amount_cents'
    | 'payment_due_at'
    | 'stripe_session_id'
  >;
  let updated: Approved[];
  try {
    updated = (await sql`
      UPDATE appointments
      SET status                  = 'approved_awaiting_payment',
          payment_status          = 'pending',
          approved_at             = ${now.toISOString()},
          assessment_amount_cents = ${baseCents},
          travel_fee_cents        = ${travelCents},
          gst_cents               = ${gstCents},
          total_amount_cents      = ${totalCents},
          payment_due_at          = ${deadline.dueAt ? deadline.dueAt.toISOString() : null},
          updated_at              = ${now.toISOString()}
      WHERE id = ${row.id} AND status = 'pending_review'
      RETURNING id, approved_at, assessment_amount_cents, travel_fee_cents,
                gst_cents, total_amount_cents, payment_due_at, stripe_session_id
    `) as Approved[];
  } catch (err) {
    console.error(`Approving booking ${row.id} failed:`, err);
    return back(detail, { review: 'error' });
  }

  // Zero rows: somebody else already reviewed it, or a double-click got here
  // twice. Not an error, emphatically not a second email, and — the point of
  // the ordering — not a second Checkout Session either.
  if (updated.length === 0) return back(detail, { review: 'stale' });
  const settled = updated[0];

  // ── THE PREVIOUS SESSION DIES BEFORE A NEW ONE IS BORN ───────────────────
  //
  // Fatal if it fails, deliberately. The alternative is minting a second live
  // link while the first is still payable at the OLD amount, which is exactly
  // the state BK-23's approval screen promises cannot exist ("once a Checkout
  // Session exists the amount is frozen; changing it means cancelling and
  // re-approving"). Rolling the transition back is recoverable; two live prices
  // for one booking is not.
  if (settled.stripe_session_id) {
    const expired = await expireCheckoutSession(settled.stripe_session_id);
    if (!expired) {
      await rollBack(sql, row.id, now);
      return back(detail, { review: 'stale-session' });
    }
  }

  // ── NOW STRIPE ───────────────────────────────────────────────────────────
  //
  // Under its own deadline, and a smaller one than the mail budget: this call
  // now sits IN FRONT of a send that has its own 5s race, and two stacked races
  // blow the platform's function limit — which returns a 504 for an approval
  // that has already committed. Timing out resolves to null, which is the same
  // answer "Stripe is not configured" gives, so the approval degrades to Interac
  // rather than failing.
  let session: Awaited<ReturnType<typeof createCheckoutSession>> = null;
  try {
    session = await withDeadline(
      createCheckoutSession({
        appointmentId: settled.id,
        tier: row.assessment_tier,
        // THE STORED COLUMNS, read back off the UPDATE. Not the locals above.
        baseCents: settled.assessment_amount_cents ?? baseCents,
        travelCents: settled.travel_fee_cents,
        gstCents: settled.gst_cents ?? gstCents,
        totalCents: settled.total_amount_cents ?? totalCents,
        dueAt: settled.payment_due_at,
        slotStart: row.slot_start,
        approvedAt: settled.approved_at ?? now,
        customerEmail: input.email,
        now,
        origin,
      }),
      CHECKOUT_BUDGET_MS,
      null,
    );
  } catch (err) {
    // An amount mismatch, or Stripe refusing. The session, if one was made, has
    // already been expired by `createCheckoutSession` itself.
    console.error(`Booking ${row.id}: could not create a Checkout Session:`, err);
  }

  // ── RECORD IT, AND SAY SO IF THAT FAILS ──────────────────────────────────
  //
  // The session exists at Stripe the moment it is created; this is a separate
  // statement, so a crash between the two leaves a LIVE SESSION NOTHING KNOWS
  // ABOUT — the cron cannot expire it and a re-approval cannot supersede it.
  // That window cannot be closed without a distributed transaction, so it is
  // flagged instead, and the webhook's amount check is what stops such a
  // session confirming at a stale price.
  if (session) {
    try {
      await sql`
        UPDATE appointments
        SET stripe_session_id = ${session.sessionId}, updated_at = ${now.toISOString()}
        WHERE id = ${settled.id}
          AND status = 'approved_awaiting_payment'
          AND stripe_session_id IS DISTINCT FROM ${session.sessionId}
      `;
    } catch (err) {
      console.error(
        `Booking ${row.id}: Checkout Session ${session.sessionId} is LIVE but was not recorded:`,
        err,
      );
      await flagUnrecordedSession(sql, settled.id, session.sessionId, now);
    }
  }

  const details: ApprovalDetails = {
    baseCents: settled.assessment_amount_cents ?? baseCents,
    travelCents: settled.travel_fee_cents,
    gstCents: settled.gst_cents ?? gstCents,
    totalCents: settled.total_amount_cents ?? totalCents,
    dueAt: settled.payment_due_at,
    paymentUrl: session?.url ?? null,
    interacEmail: INTERAC_EMAIL,
  };

  // Nothing to pay WITH. Only reachable when Stripe was configured (so the
  // pre-check passed) but then failed, and there is no Interac address either.
  // The transition is undone rather than flagged: no session exists, so nothing
  // can pay and nothing can race, which makes a rollback safe and keeps BK-23's
  // rule — refuse to transition unless the customer can be told — intact.
  if (!canOfferPayment(details)) {
    console.error(`Booking ${row.id}: approved with no way to pay. Rolling back.`);
    await rollBack(sql, settled.id, now);
    return back(detail, { review: 'nopayment' });
  }

  const message = approvalMessage(input, details);
  if (!message) {
    // Unreachable: `input.email` was checked before the UPDATE and is
    // `approvalMessage`'s only refusal. Kept because "unreachable" is a property
    // of that function today.
    await rollBack(sql, settled.id, now);
    return back(detail, { review: 'noemail' });
  }

  const sent = await withDeadline(
    sendCustomerMessage(row.id, 'payment-link', message, now).then((o) => o === 'sent'),
    POST_COMMIT_BUDGET_MS,
    false,
  );

  return back(detail, {
    review: sent ? (session ? 'approved' : 'approved-interac') : 'approved-nomail',
  });
}

/**
 * Undo an approval that cannot be completed.
 *
 * Guarded on `stripe_session_id IS NULL`, which is what makes it safe: a row
 * with a live session must never be walked backwards, because the link would
 * still be payable against a `pending_review` row that `markPaid` would refuse.
 * The amount columns are nulled with the rest — leaving them set would make the
 * admin page render "Amount settled at approval" over a row nobody has
 * approved.
 */
async function rollBack(sql: ReturnType<typeof getDb>, id: number, now: Date): Promise<void> {
  try {
    await sql`
      UPDATE appointments
      SET status                  = 'pending_review',
          payment_status          = 'not_required',
          approved_at             = NULL,
          assessment_amount_cents = NULL,
          travel_fee_cents        = 0,
          gst_cents               = NULL,
          total_amount_cents      = NULL,
          payment_due_at          = NULL,
          updated_at              = ${now.toISOString()}
      WHERE id = ${id}
        AND status = 'approved_awaiting_payment'
        AND stripe_session_id IS NULL
    `;
  } catch (err) {
    console.error(`Booking ${id}: could not roll back an incomplete approval:`, err);
  }
}

/** A live Checkout Session that no row points at. A human has to close it. */
async function flagUnrecordedSession(
  sql: ReturnType<typeof getDb>,
  id: number,
  sessionId: string,
  now: Date,
): Promise<void> {
  const line =
    `UNRECORDED CHECKOUT SESSION: ${sessionId} is live at Stripe but could not be written to ` +
    `this row, so nothing here can expire it. Expire it by hand in the Stripe dashboard if this ` +
    `booking is not paid.`;
  try {
    await sql`
      UPDATE appointments
      SET needs_attention = CASE
            WHEN needs_attention IS NULL OR needs_attention = '' THEN ${line}
            ELSE needs_attention || ${`\n\n${line}`}
          END,
          updated_at = ${now.toISOString()}
      WHERE id = ${id}
    `;
  } catch (err) {
    console.error(`Booking ${id}: could not flag the unrecorded session:`, err);
  }
}

/**
 * A $0.00 approval: approve, then confirm, in one request.
 *
 * TWO GUARDED UPDATES RATHER THAN A DIRECT `pending_review -> confirmed`, and
 * that is the whole reason this function exists. `markPaid` guards on
 * `approved_awaiting_payment` and **it stays the one confirmation path** — a
 * second route to `confirmed` is exactly what the confirm seam exists to
 * prevent, and it is where a second confirmation email and a second ics would
 * come from. So the row takes the ordinary approval transition and is then
 * confirmed through the same function a card payment goes through.
 *
 * `payment_method = 'none'`, not `payment_status = 'not_required'`: migration
 * 008 reserves that value for rows predating prepay, and reusing it here would
 * mix a live booking in with the historical ones in the office's queues.
 *
 * The customer gets the confirmation and its ics, and no payment-link email —
 * there is nothing to pay.
 */
async function approveFree(
  sql: ReturnType<typeof getDb>,
  row: Appointment,
  baseCents: number,
  travelCents: number,
  gstCents: number,
  now: Date,
  detail: string,
): Promise<Response> {
  let updated: { id: number }[];
  try {
    updated = (await sql`
      UPDATE appointments
      SET status                  = 'approved_awaiting_payment',
          payment_status          = 'pending',
          approved_at             = ${now.toISOString()},
          assessment_amount_cents = ${baseCents},
          travel_fee_cents        = ${travelCents},
          gst_cents               = ${gstCents},
          total_amount_cents      = 0,
          payment_due_at          = NULL,
          updated_at              = ${now.toISOString()}
      WHERE id = ${row.id} AND status = 'pending_review'
      RETURNING id
    `) as { id: number }[];
  } catch (err) {
    console.error(`Approving booking ${row.id} at no charge failed:`, err);
    return back(detail, { review: 'error' });
  }
  if (updated.length === 0) return back(detail, { review: 'stale' });

  const outcome = await markPaid(sql, row.id, {
    method: 'none',
    amountCents: 0,
    reference: null,
    now,
  });

  return back(detail, { review: outcome === 'confirmed' ? 'approved-free' : 'error' });
}

async function decline(
  sql: ReturnType<typeof getDb>,
  row: Appointment,
  input: BookingNotificationInput,
  now: Date,
  detail: string,
): Promise<Response> {
  // Built before the UPDATE for symmetry with approve, but NOT required: a
  // decline with no email address is still a decline. The office took that
  // booking by phone and will decline it the same way, and holding the slot
  // because we cannot send a courtesy note would be the wrong trade.
  const message = declineMessage(input);

  let updated: { id: number }[];
  try {
    updated = (await sql`
      UPDATE appointments
      SET status      = 'declined',
          declined_at = ${now.toISOString()},
          updated_at  = ${now.toISOString()}
      WHERE id = ${row.id} AND status = 'pending_review'
      RETURNING id
    `) as { id: number }[];
  } catch (err) {
    console.error(`Declining booking ${row.id} failed:`, err);
    return back(detail, { review: 'error' });
  }

  if (updated.length === 0) return back(detail, { review: 'stale' });

  // The slot is released by the status alone — `declined` is one of
  // SLOT_RELEASING_STATUSES, so it falls out of the partial unique index and
  // the availability query the moment this commits. Nothing else to do, and
  // nothing to remember.
  //
  // NO CANCEL INVITE. A row reaching `declined` from `pending_review` never had
  // one issued: invites go out behind payment. See `couldHoldCalendarInvite`.
  if (!message) return back(detail, { review: 'declined' });

  const sent = await withDeadline(
    sendCustomerMessage(row.id, 'declined', message, now).then((o) => o === 'sent'),
    POST_COMMIT_BUDGET_MS,
    false,
  );

  return back(detail, { review: sent ? 'declined' : 'declined-nomail' });
}
