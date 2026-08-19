import type { APIRoute } from 'astro';

export const prerender = false;

import {
  blackoutQueryRange,
  bookedQueryRange,
  computeAvailability,
} from '../../../lib/booking-availability';
import { getDb } from '../../../lib/db';
import { SLOT_HOLD_PREDICATE } from '../../../lib/booking-status';

function json(data: object, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * What the public date picker may offer for the next two weeks.
 *
 * Thin by design: two queries, then `computeAvailability` — which is pure and
 * separately verified — decides everything. No booking rule lives here.
 *
 * Note the two casts in the SQL. The Neon driver deserializes `timestamptz`
 * (OID 1184) and `date` (OID 1082) into `Date` objects, contradicting the
 * `string` typings in db.ts. `timestamptz` round-trips exactly, so `slot_start`
 * is consumed as a `Date` and compared by epoch. `date` does not: it is
 * timezone-naive and parses at the *server's* local midnight, which on Vercel
 * (UTC) converts back to the previous Edmonton day. Blackouts are therefore
 * selected as `day::text` and stay `DateKey` strings end to end.
 */
export const GET: APIRoute = async () => {
  const now = new Date();
  const slots = bookedQueryRange(now);
  const days = blackoutQueryRange(now);

  try {
    const sql = getDb();

    // The predicate is the partial unique index's, shared rather than mirrored:
    // an availability query that offers a held slot is a double booking one
    // click later. See SLOT_HOLD_PREDICATE.
    const [bookedRows, blackoutRows] = await Promise.all([
      sql`
        SELECT slot_start
        FROM appointments
        WHERE ${sql.unsafe(SLOT_HOLD_PREDICATE)}
          AND slot_start >= ${slots.from.toISOString()}
          AND slot_start <  ${slots.to.toISOString()}
      `,
      sql`
        SELECT day::text AS day
        FROM blackout_dates
        WHERE day BETWEEN ${days.from} AND ${days.to}
      `,
    ]);

    const booked = bookedRows as { slot_start: Date | string }[];
    const blackouts = blackoutRows as { day: string }[];

    return json(
      computeAvailability({
        now,
        blackoutDays: blackouts.map((r) => r.day),
        bookedSlotMs: booked.map((r) => new Date(r.slot_start).getTime()),
      }),
      200,
      { 'Cache-Control': 'no-store' },
    );
  } catch (err) {
    // Never fall back to an empty calendar: indistinguishable from "fully
    // booked", so it would turn away every visitor while looking healthy.
    console.error('Could not load availability:', err);
    return json({ error: 'Could not load availability. Please try again.' }, 500, {
      'Cache-Control': 'no-store',
    });
  }
};
