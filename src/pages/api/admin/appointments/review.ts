import type { APIRoute } from 'astro';

export const prerender = false;

import { adminAppointmentPath, ADMIN_APPOINTMENTS_PATH } from '../../../../lib/booking-admin';
import { INTERAC_EMAIL, POST_COMMIT_BUDGET_MS } from '../../../../lib/booking-config';
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
import { createCheckoutUrl } from '../../../../lib/booking-payment';
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

export const POST: APIRoute = async ({ request }) => {
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

  return action === 'approve'
    ? approve(sql, row, notificationInput, form, now, detail)
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
): Promise<Response> {
  // A tier is required to approve, because the amount is derived from one. The
  // office sets it on the edit form first; the button is hidden without one,
  // and this is the server-side half of that.
  if (!isAssessmentTier(row.assessment_tier)) {
    return back(detail, { review: 'notier' });
  }

  // THE SLOT MUST STILL BE IN THE FUTURE.
  //
  // Task 4's auto-decline at slot-4h is what would normally make this
  // unreachable, and it is not built — an omission that is fine on its own but
  // leaves the built path with no equivalent. A request submitted Monday for
  // Tuesday 11:30 that nobody reviews is still sitting in `pending_review` on
  // Wednesday, and Approve would email "please pay as soon as you can" for a
  // visit two days gone, then (under BK-32) open a live Checkout Session for
  // it. Taking money for a slot that has passed is the one outcome this whole
  // ticket exists to prevent.
  //
  // `paymentDeadline` will not catch it: a negative time-to-slot lands in the
  // pay-now branch, which is correct for a slot four hours out and wrong for
  // one that is behind us. The check belongs here, on the transition, not in
  // the deadline arithmetic.
  //
  // Refuses rather than auto-declining. Declining is a customer-facing message
  // and an irreversible slot release; an office member who meant to approve
  // should be told why they cannot, not have a different transition chosen for
  // them. Task 4 is what turns this into an automatic apology.
  if (row.slot_start.getTime() <= now.getTime()) {
    return back(detail, { review: 'elapsed' });
  }

  // The pre-filled quote, recomputed server-side rather than trusted from the
  // form: the form's numbers came from here in the first place, and a round
  // trip through a browser is not a reason to start believing them.
  const suggested = assessmentQuote({
    tier: row.assessment_tier,
    service: row.service,
    slotStart: row.slot_start,
  });

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

  const details: ApprovalDetails = {
    baseCents,
    travelCents,
    gstCents,
    totalCents,
    dueAt: deadline.dueAt,
    // BK-32 fills this in. Null today, and null is a supported state rather
    // than a failure — see `canOfferPayment`.
    paymentUrl: await createCheckoutUrl({
      appointmentId: row.id,
      totalCents,
      dueAt: deadline.dueAt,
    }),
    interacEmail: INTERAC_EMAIL,
  };

  // REFUSE BEFORE TRANSITIONING, not after. Both of these leave the row in
  // `pending_review`, which is recoverable; approving into a state the customer
  // cannot act on is not.
  if (!canOfferPayment(details)) {
    console.error(`Booking ${row.id} cannot be approved: no payment method is configured.`);
    return back(detail, { review: 'nopayment' });
  }
  const message = approvalMessage(input, details);
  if (!message) return back(detail, { review: 'noemail' });

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
          total_amount_cents      = ${totalCents},
          payment_due_at          = ${deadline.dueAt ? deadline.dueAt.toISOString() : null},
          updated_at              = ${now.toISOString()}
      WHERE id = ${row.id} AND status = 'pending_review'
      RETURNING id
    `) as { id: number }[];
  } catch (err) {
    console.error(`Approving booking ${row.id} failed:`, err);
    return back(detail, { review: 'error' });
  }

  // Zero rows: somebody else already reviewed it, or a double-click got here
  // twice. Not an error, and emphatically not a second email.
  if (updated.length === 0) return back(detail, { review: 'stale' });

  const sent = await withDeadline(
    sendCustomerMessage(row.id, 'payment-link', message).then((o) => o === 'sent'),
    POST_COMMIT_BUDGET_MS,
    false,
  );

  return back(detail, { review: sent ? 'approved' : 'approved-nomail' });
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
    sendCustomerMessage(row.id, 'declined', message).then((o) => o === 'sent'),
    POST_COMMIT_BUDGET_MS,
    false,
  );

  return back(detail, { review: sent ? 'declined' : 'declined-nomail' });
}
