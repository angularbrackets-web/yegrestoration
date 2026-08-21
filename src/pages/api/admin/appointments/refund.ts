import type { APIRoute } from 'astro';

export const prerender = false;

import { adminAppointmentPath, ADMIN_APPOINTMENTS_PATH } from '../../../../lib/booking-admin';
import {
  chargeFeeCents,
  refundableCents,
  refundPayment,
} from '../../../../lib/booking-payment';
import { amountField, parseAmountCents } from '../../../../lib/booking-review';
import { getDb, type Appointment } from '../../../../lib/db';

/**
 * "Cancel and refund": the office sending money back, in ONE action (BK-33).
 *
 * ── WHY ONE ACTION AND NOT A CHECKBOX ON THE CANCEL PATH ──────────────────
 *
 * The ticket's 2026-08-16 draft specified a *Refund in full* checkbox appearing
 * in the status editor when `cancelled` is selected, defaulted ON for a
 * company-side reason. That was written against a screen BK-46 has since
 * rebuilt, and two things make it wrong now: there is no company-side *reason*
 * field anywhere to default off, and the only cancel control is the status
 * dropdown inside **"Update the record"** — the panel whose own on-screen line
 * reads *"Record-keeping, not a decision."* Putting a money-moving control in
 * it would re-create exactly the panel ambiguity BK-44 was filed to remove.
 *
 * The draft's INTENT survives and is what this route is for: *"a customer who
 * paid for a visit we cancelled and then had to phone to chase their money is
 * the worst outcome this feature has."* So refunding and cancelling are one
 * click, and the status dropdown keeps plain cancel for unpaid rows and for the
 * rare cancel-without-refund.
 *
 * ── TWO STEPS, BECAUSE THIS IS IRREVERSIBLE AND THE FEE IS REAL ───────────
 *
 * `action=preview` parses the amount, asks Stripe what it kept in fees on the
 * original charge, and bounces back to the detail page. The panel that renders
 * from that is what the office reads; the button inside it is the one that
 * moves money. Same shape as `review.ts`'s `preview` → `approve`, and for the
 * same reason: the click AFTER the total is the one that costs something.
 *
 * The fee is fetched HERE rather than on every render of the appointment page.
 * A Stripe read on every admin page load would add latency and a failure mode
 * to a screen that is mostly not about refunding, and "at the moment they
 * click" is satisfied — this is that moment.
 *
 * ── THE QUERY STRING IS DISPLAY ONLY ──────────────────────────────────────
 *
 * `refundPayment` re-derives the refundable balance from the row it claims, and
 * the claim's own WHERE re-checks the already-refunded figure. Nothing bounced
 * through the URL is trusted for a decision about money — a tampered or stale
 * confirm link can show a wrong fee and cannot cause a wrong refund.
 *
 * ── A NEW ADMIN POST ENDPOINT, PLACED WITH THE ROUTE TABLE IN MIND ────────
 *
 * See `ADMIN_APPOINTMENT_REFUND_ENDPOINT`'s note for why this path is safe
 * against both the dynamic-route collision and the trailing-slash 308, and
 * where that is pinned.
 */

function back(path: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${path}?${query}` } });
}

/** What the confirm step needs, and what the refund needs. One parse each. */
type Parsed =
  | { ok: true; amountCents: number }
  | { ok: false; reason: 'amount' };

function amountFrom(form: FormData): Parsed {
  const cents = parseAmountCents(form.get('amount'));
  if (cents === null || cents <= 0) return { ok: false, reason: 'amount' };
  return { ok: true, amountCents: cents };
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
  if (action !== 'preview' && action !== 'refund') return back(detail, { refund: 'invalid' });

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Refund could not reach the database:', err);
    return back(detail, { refund: 'error' });
  }

  const parsed = amountFrom(form);
  if (!parsed.ok) return back(detail, { refund: 'amount' });

  // ── THE CONFIRM STEP ────────────────────────────────────────────────────
  //
  // Nothing here writes. A preview that moved money would be a refund with an
  // extra click, and the whole point is that it is not.
  if (action === 'preview') {
    let row: Appointment | undefined;
    try {
      const rows = (await sql`SELECT * FROM appointments WHERE id = ${id}`) as Appointment[];
      row = rows[0];
    } catch (err) {
      console.error(`Refund preview could not load appointment ${id}:`, err);
      return back(detail, { refund: 'error' });
    }
    if (!row) return back(ADMIN_APPOINTMENTS_PATH, { saved: 'missing' });

    // Refused here as well as inside `refundPayment`, so the office is told at
    // the step where they can still fix it rather than after a claim and a
    // release. This is not the guard — the guard is the claim's WHERE.
    if (row.payment_method !== 'stripe') return back(detail, { refund: 'notcard' });
    if (row.stripe_payment_intent_id === null) return back(detail, { refund: 'nocharge' });
    const already = row.refunded_amount_cents ?? 0;
    const refundable = refundableCents(row);
    if (refundable <= 0) return back(detail, { refund: 'notpaid' });
    if (parsed.amountCents > refundable) return back(detail, { refund: 'toomuch' });

    // THE REAL FEE, AND NULL IS AN ANSWER. A Stripe read that fails must not
    // stop the office refunding — the confirm panel degrades to a sentence with
    // no figure. Wrong in the safe direction: it never invents one.
    const fee = await chargeFeeCents(row.stripe_payment_intent_id);

    return back(detail, {
      refundconfirm: '1',
      amount: amountField(parsed.amountCents),
      already: String(already),
      ...(fee === null ? {} : { fee: String(fee) }),
    });
  }

  // ── THE CLICK THAT MOVES MONEY ──────────────────────────────────────────
  //
  // `already` is re-posted from the confirm panel and forms part of the claim's
  // WHERE, so a refundable balance that moved between the two steps refuses
  // rather than refunding against a figure the office is no longer looking at.
  const rawAlready = form.get('already');
  const already = Number.parseInt(typeof rawAlready === 'string' ? rawAlready : '', 10);
  if (!Number.isInteger(already) || already < 0) return back(detail, { refund: 'invalid' });

  const result = await refundPayment(sql, id, {
    amountCents: parsed.amountCents,
    expectedAlreadyRefundedCents: already,
    now,
  });

  // The total is logged rather than discarded: it is what Stripe now says has
  // gone back on this charge, and a refund that lands in the function log
  // beside its outcome is what somebody reads when the row and the dashboard
  // are being compared months later.
  console.log(
    `Refund on booking ${id}: ${result.outcome}` +
      (result.refundedTotalCents === undefined
        ? ''
        : ` (total refunded now ${result.refundedTotalCents} cents)`),
  );

  return back(detail, { refund: result.outcome });
};
