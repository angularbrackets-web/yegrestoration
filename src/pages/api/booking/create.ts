import type { APIRoute } from 'astro';

export const prerender = false;

import { BOOKING_RATE_LIMIT_PER_HOUR } from '../../../lib/booking-config';
import {
  blackoutQueryRange,
  bookedQueryRange,
  isSlotBookable,
} from '../../../lib/booking-availability';
import { insertBooking } from '../../../lib/booking-commit';
import { parseBookingPayload } from '../../../lib/booking-payload';
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

    return json(
      {
        id: created.id,
        slotStart: payload.slotStart.toISOString(),
        slotLabel: formatSlot(payload.slotStart),
        filesAttached: created.files,
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
