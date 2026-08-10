import type { APIRoute } from 'astro';

export const prerender = false;

import { ADMIN_BLACKOUTS_PATH } from '../../../../lib/booking-admin';
import { parseBlackoutInput } from '../../../../lib/booking-admin-entry';
import { getDb } from '../../../../lib/db';

/**
 * Close a day to public booking. Holidays, a crew off sick, a shop day.
 *
 * Idempotent by `ON CONFLICT (day) DO UPDATE`: the office double-submitting a
 * holiday should correct the reason, not error. The PK column is `day`, not
 * `date` (locked).
 *
 * **It does not touch appointments already booked on that day.** Blacking out a
 * day blocks *future public* booking and nothing else; anything already in the
 * calendar stays, and the office phones those customers. Auto-cancelling would
 * be a silent destructive bulk action hiding behind a one-field form, and it
 * would free slots that the crew is still committed to.
 */
export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`${ADMIN_BLACKOUTS_PATH}?err=form`);
  }

  const parsed = parseBlackoutInput(Object.fromEntries(form));
  if (!parsed.ok) {
    return redirect(`${ADMIN_BLACKOUTS_PATH}?err=${[...new Set(parsed.errors.map((e) => e.field))].join(',')}`);
  }
  const { day, reason } = parsed.input;

  try {
    const sql = getDb();
    // `day` is passed as the validated `YYYY-MM-DD` string and cast in SQL.
    // Never as a Date: the column is timezone-naive `DATE`, and a Date lands on
    // the server's midnight — UTC on Vercel, which is the previous Edmonton
    // day. Wrong day, silently.
    await sql`
      INSERT INTO blackout_dates (day, reason)
      VALUES (${day}::date, ${reason})
      ON CONFLICT (day) DO UPDATE SET reason = EXCLUDED.reason
    `;
  } catch (err) {
    console.error(`Blackout add ${day} failed:`, err);
    return redirect(`${ADMIN_BLACKOUTS_PATH}?err=db`);
  }

  return redirect(`${ADMIN_BLACKOUTS_PATH}?added=1`);
};

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
