import type { APIRoute } from 'astro';

export const prerender = false;

import { BOOKING_RATE_LIMIT_PER_HOUR, POST_COMMIT_BUDGET_MS } from '../../../lib/booking-config';
import {
  blackoutQueryRange,
  bookedQueryRange,
  isSlotBookable,
} from '../../../lib/booking-availability';
import { insertBooking, stampNotifications } from '../../../lib/booking-commit';
import { planBookingNotifications } from '../../../lib/booking-email';
import { notifyAndStamp, withDeadline } from '../../../lib/booking-notify';
import { parseBookingPayload, type BookingPayload } from '../../../lib/booking-payload';
import { formatSlot, type DateKey } from '../../../lib/booking-time';
import { verifyDraftToken } from '../../../lib/draft-token';
import { getDb, SERVICE_LABELS } from '../../../lib/db';
import { clientIp, consumeRateLimit } from '../../../lib/rate-limit';

const HOUR_MS = 60 * 60 * 1000;

function json(data: object, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * Commits a booking.
 *
 * The order matters. The availability precheck is a courtesy — it turns the
 * common "someone booked that while you were typing" into a clean message — but
 * it is not the guard. The guard is the partial unique index, reached through
 * the CTE below, and only its result decides whether a booking happened.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const now = new Date();
  const ip = clientIp(request, clientAddress);

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    console.error('Booking commit could not reach the database:', err);
    return json({ error: 'Something went wrong. Please call us instead.' }, 500);
  }

  const limit = await consumeRateLimit(sql, `booking-create:${ip}`, BOOKING_RATE_LIMIT_PER_HOUR, HOUR_MS, now);
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetsAt.getTime() - now.getTime()) / 1000));
    return json({ error: 'Too many requests. Please try again shortly.' }, 429, {
      'Retry-After': String(retryAfter),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 422);
  }

  const parsed = parseBookingPayload(body, {
    allowedServices: new Set(Object.keys(SERVICE_LABELS)),
  });
  if (!parsed.ok) {
    return json({ error: 'Please check the highlighted fields.', fields: parsed.errors }, 422);
  }
  const payload = parsed.payload;

  try {
    // The claimed draft id is whatever the signature yields — never a field from
    // the request. Otherwise a caller could pair their own valid token with
    // someone else's draft id and adopt that person's uploaded photos.
    //
    // Inside the try because verifyDraftToken throws when BOOKING_DRAFT_SECRET
    // is unset: outside it, a misconfigured deploy would answer with Astro's
    // HTML 500 instead of this route's JSON, and BK-03's `res.json()` would
    // throw a parse error rather than show a message.
    let draftId: string | null = null;
    if (payload.draftToken !== null) {
      draftId = await verifyDraftToken(payload.draftToken, now);
      if (draftId === null) {
        return json(
          { error: 'Your upload session expired. Reload the page and try again.' },
          400,
        );
      }
    }

    const slots = bookedQueryRange(now);
    const days = blackoutQueryRange(now);

    const [bookedRows, blackoutRows] = await Promise.all([
      sql`
        SELECT slot_start
        FROM appointments
        WHERE status <> 'cancelled'
          AND slot_start >= ${slots.from.toISOString()}
          AND slot_start <  ${slots.to.toISOString()}
      `,
      sql`
        SELECT day::text AS day
        FROM blackout_dates
        WHERE day BETWEEN ${days.from} AND ${days.to}
      `,
    ]);

    const bookable = isSlotBookable(payload.slotStart, {
      now,
      blackoutDays: new Set((blackoutRows as { day: DateKey }[]).map((r) => r.day)),
      bookedSlotMs: new Set(
        (bookedRows as { slot_start: Date | string }[]).map((r) => new Date(r.slot_start).getTime()),
      ),
    });

    // Not bookable for *some* reason — booked, blacked out, Friday, or outside
    // the window. Which one is deliberately not disclosed (it would leak the
    // schedule), but it is a different code from a lost race: retrying will not
    // help, and BK-03 should re-fetch availability rather than trust the prose.
    if (!bookable) return slotUnavailable();

    const created = await insertBooking(sql, payload, draftId, now);

    // Zero rows means ON CONFLICT DO NOTHING fired: another request took the
    // slot between the precheck and the insert. This is the real guard, and the
    // only thing that decides a booking did not happen.
    if (created === null) return slotTaken();

    const slotLabel = formatSlot(payload.slotStart);
    const emailSent = await notify(sql, created.id, slotLabel, payload, created.files, now);

    return json(
      {
        id: created.id,
        slotStart: payload.slotStart.toISOString(),
        slotLabel,
        filesAttached: created.files,
        emailSent,
      },
      201,
    );
  } catch (err) {
    // Never report a booking that may not exist. A swallowed insert error
    // returned as 201 is an appointment nobody is coming to.
    console.error('Booking commit failed:', err);
    return json({ error: 'Something went wrong. Please call us instead.' }, 500);
  }
};

/**
 * Send the two booking notifications and record what happened. Returns whether
 * the customer's confirmation went out.
 *
 * **This function cannot fail the request.** By the time it runs the
 * appointment row exists and the slot is gone, so anything that escaped here
 * would reach the caller's `catch` and answer 500 for a booking that committed
 * — the customer books again, or phones to report a failure that did not
 * happen. That is a worse outcome than every failure this function swallows,
 * which is why it swallows all of them and returns `false`.
 *
 * The whole block runs under ONE deadline covering both sends and both stamps.
 * Per-operation timers would stack on a path that already ran a rate-limit
 * query, two availability queries and the insert; exceeding the platform's
 * function limit returns a 504 that the island renders as "something went
 * wrong". See POST_COMMIT_BUDGET_MS.
 */
async function notify(
  sql: ReturnType<typeof getDb>,
  id: number,
  slotLabel: string,
  payload: BookingPayload,
  filesAttached: number,
  now: Date,
): Promise<boolean> {
  try {
    const plan = planBookingNotifications({
      id,
      slotLabel,
      // The instant as well as the label: the internal message carries the
      // calendar invite (BK-14), and an ICS carries instants. The payload has
      // always had this — it simply never reached the plan.
      slotStart: payload.slotStart,
      // The request's clock, not a fresh one. DTSTAMP and SEQUENCE come from
      // one instant per send.
      now,
      name: payload.name,
      phone: payload.phone,
      email: payload.email,
      // The fallback is unreachable: `parseBookingPayload` is handed
      // `Object.keys(SERVICE_LABELS)` as the allowed set, so `service` is always
      // a key here. Kept so the two cannot drift into a `undefined` in a subject
      // line, not because raw user input can reach one.
      serviceLabel: SERVICE_LABELS[payload.service] ?? payload.service,
      description: payload.description,
      address: payload.address,
      city: payload.city,
      postalCode: payload.postal_code,
      paymentRoute: payload.payment_route,
      insurerName: payload.insurer_name,
      policyNumber: payload.policy_number,
      claimNumber: payload.claim_number,
      smsConsent: payload.smsConsent,
      filesAttached,
    });

    return await withDeadline(
      // Send-then-record, with the answer decided by the send. The stamp is
      // awaited rather than fired and forgotten — the same reason the sends are
      // inline, that post-response work is not guaranteed to run — and its
      // failure is swallowed inside `notifyAndStamp`, where it is asserted.
      // 'skipped' and 'failed' both leave NULL, which reads as "nobody was told".
      notifyAndStamp(plan, {
        stamp: (sent) =>
          // Fresh clock, not the request's: this is when the send returned, and
          // BK-07/BK-08 read these columns as timestamps.
          stampNotifications(sql, id, sent, new Date()),
      }),
      POST_COMMIT_BUDGET_MS,
      // The deadline's answer. A message that lands late is reported as unsent,
      // which is wrong in the safe direction: the page then promises nothing.
      false,
    );
  } catch (err) {
    console.error(`Booking ${id} committed but notification failed:`, err);
    return false;
  }
}

/** Lost the race: the slot really was booked between the check and the insert. */
function slotTaken() {
  return json(
    { error: 'That time was just booked. Please choose another.', code: 'slot_taken' },
    409,
  );
}

/** Never offerable in the first place, or no longer offered. Retrying will not help. */
function slotUnavailable() {
  return json(
    { error: 'That time is no longer available. Please choose another.', code: 'slot_unavailable' },
    409,
  );
}
