import type { APIRoute } from 'astro';

export const prerender = false;

import { BOOKING_RATE_LIMIT_PER_HOUR } from '../../../lib/booking-config';
import {
  blackoutQueryRange,
  bookedQueryRange,
  isSlotBookable,
} from '../../../lib/booking-availability';
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

  // The claimed draft id is whatever the signature yields — never a field from
  // the request. Otherwise a caller could pair their own valid token with
  // someone else's draft id and adopt that person's uploaded photos.
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

  try {
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

    if (!bookable) return slotTaken();

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

function slotTaken() {
  return json(
    { error: 'That time was just booked. Please choose another.', code: 'slot_taken' },
    409,
  );
}

/**
 * Insert the appointment and claim its uploads in ONE statement.
 *
 * The Neon HTTP driver has no interactive transaction and the claim needs the
 * id the insert produces, so a two-call sequence has a window where a booking
 * exists whose photos are still unclaimed — and the orphan cron deletes those
 * 24 hours later. A data-modifying CTE is a single atomic statement.
 *
 * `FROM new_appt` on the tail is load-bearing: the scalar-subquery form
 * (`SELECT (SELECT id FROM new_appt)`) always returns one row, with a NULL id on
 * conflict, so the race loser would be told they had booked.
 *
 * Files are claimed regardless of `upload_state` — `onUploadCompleted` never
 * fires on localhost, so every dev upload is stuck at 'pending', and a
 * production callback can lag.
 *
 * Exported only so `scripts/verify-booking-commit.ts` can race this exact
 * statement instead of a hand-copied one that could drift away from it.
 */
export async function insertBooking(
  sql: ReturnType<typeof getDb>,
  p: BookingPayload,
  draftId: string | null,
  now: Date,
): Promise<{ id: number; files: number } | null> {
  const rows = (await sql`
    WITH new_appt AS (
      INSERT INTO appointments (
        name, phone, email, service, description, address, city, postal_code,
        payment_route, insurer_name, policy_number, claim_number,
        slot_start, source, sms_consent_at
      ) VALUES (
        ${p.name}, ${p.phone}, ${p.email}, ${p.service}, ${p.description},
        ${p.address}, ${p.city}, ${p.postal_code},
        ${p.payment_route}, ${p.insurer_name}, ${p.policy_number}, ${p.claim_number},
        ${p.slotStart.toISOString()}, 'web',
        ${p.smsConsent ? now.toISOString() : null}
      )
      ON CONFLICT (slot_start) WHERE status <> 'cancelled' DO NOTHING
      RETURNING id
    ), claimed AS (
      UPDATE appointment_files
      SET appointment_id = (SELECT id FROM new_appt)
      WHERE draft_id = ${draftId}::uuid
        AND appointment_id IS NULL
        AND EXISTS (SELECT 1 FROM new_appt)
      RETURNING id
    )
    SELECT new_appt.id, (SELECT COUNT(*)::int FROM claimed) AS files
    FROM new_appt
  `) as { id: number; files: number }[];

  return rows[0] ?? null;
}
