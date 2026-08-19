import type { APIRoute } from 'astro';

export const prerender = false;

import { adminAppointmentPath, ADMIN_APPOINTMENTS_PATH } from '../../../../lib/booking-admin';
import { markPaid } from '../../../../lib/booking-payment';
import { getDb } from '../../../../lib/db';

/**
 * "Mark as paid — Interac": the office asserting that money arrived (BK-32).
 *
 * ── THE SECOND CALLER OF ONE FUNCTION, NOT A SECOND CONFIRM PATH ───────────
 *
 * Everything this route does that matters happens inside `markPaid`, which the
 * Stripe webhook also calls. That is the whole design: one guarded transition,
 * one confirmation email, one ics, and no status logic anywhere else — so a
 * booking confirmed by e-Transfer and a booking confirmed by card are
 * indistinguishable downstream, and the double-pay race resolves the same way
 * whichever side arrives second.
 *
 * This file is therefore deliberately thin: parse, authorise (by being under
 * `/api/admin`, which the middleware gates), call, and translate the outcome
 * into a flash message. Every temptation to "just also update…" here is a
 * second status path.
 *
 * ── NO INBOX PARSING, AND THAT IS THE FEATURE ──────────────────────────────
 *
 * Nothing reads the e-Transfer inbox and nothing matches a transfer to a
 * booking. The office reads their own mail and clicks this, which is why the
 * audit columns exist: the office is making a CLAIM about money, so who made it
 * and when is the record. Out of scope is recorded on the ticket rather than
 * left as a gap somebody helpfully fills.
 *
 * ── A NEW ADMIN POST ENDPOINT, PLACED WITH THE ROUTE TABLE IN MIND ─────────
 *
 * A sibling of `create` / `update` / `review` / `resend` / `file-delete`, none
 * of which is a dynamic route — so this cannot collide the way
 * `/api/admin/files/delete/` would have collided with
 * `/api/admin/files/[id].ts` (ROADMAP, Known traps). Pinned in
 * `scripts/verify-stripe-webhook.ts` against the generated table rather than
 * argued for here.
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

  // The e-Transfer reference, if the office typed one. Optional deliberately:
  // requiring it would push somebody into inventing one, and an invented
  // reference is worse than none — it is what tells a redelivery from a second
  // payment.
  const rawRef = form.get('reference');
  const reference =
    typeof rawRef === 'string' && rawRef.trim() !== '' ? rawRef.trim().slice(0, 200) : null;

  const rawActor = form.get('actor');
  const actor =
    typeof rawActor === 'string' && rawActor.trim() !== '' ? rawActor.trim().slice(0, 120) : null;

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Mark-as-paid could not reach the database:', err);
    return back(detail, { paid: 'error' });
  }

  // THE AMOUNT IS THE ONE THAT WAS SETTLED, NOT ONE THE OFFICE RETYPES.
  //
  // The office is asserting that the quoted amount arrived; giving them a field
  // to type a different one would make this screen a second place money is
  // decided, and BK-23's whole approval design exists so that there is exactly
  // one. A partial payment is a conversation, not a form field.
  let expected: { total_amount_cents: number | null; status: string }[];
  try {
    expected = (await sql`
      SELECT total_amount_cents, status FROM appointments WHERE id = ${id}
    `) as { total_amount_cents: number | null; status: string }[];
  } catch (err) {
    console.error(`Mark-as-paid could not load appointment ${id}:`, err);
    return back(detail, { paid: 'error' });
  }
  const row = expected[0];
  if (!row) return back(ADMIN_APPOINTMENTS_PATH, { saved: 'missing' });

  // A pre-check, not the guard. `markPaid`'s own `WHERE` is what decides;
  // this only turns the common mistake into a clear message instead of a
  // puzzling no-op.
  if (row.status !== 'approved_awaiting_payment') {
    return back(detail, { paid: 'notawaiting' });
  }

  const outcome = await markPaid(sql, id, {
    method: 'interac',
    amountCents: row.total_amount_cents ?? 0,
    reference,
    actor,
    now,
  });

  const flash =
    outcome === 'confirmed'
      ? 'paid'
      : outcome === 'already-recorded'
        ? 'already'
        : outcome === 'double-pay'
          ? 'double'
          : outcome === 'paid-after-release'
            ? 'late'
            : outcome === 'missing'
              ? 'missing'
              : outcome === 'not-applicable'
                ? 'notawaiting'
                : 'error';

  return back(detail, { paid: flash });
};
