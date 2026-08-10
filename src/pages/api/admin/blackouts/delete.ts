import type { APIRoute } from 'astro';

export const prerender = false;

import { ADMIN_BLACKOUTS_PATH } from '../../../../lib/booking-admin';
import { parseBlackoutDay } from '../../../../lib/booking-admin-entry';
import { getDb } from '../../../../lib/db';

/**
 * Reopen a blacked-out day. Validated exactly as the add form's date is —
 * a `DELETE` taking a looser value than the `INSERT` is how a delete form ends
 * up removing something nobody named.
 *
 * Deleting a row that is not there is a no-op, not an error: two clicks on the
 * same delete button should not produce a red message on the second.
 */
export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`${ADMIN_BLACKOUTS_PATH}?err=form`);
  }

  const day = parseBlackoutDay(form.get('day'));
  if (day === null) return redirect(`${ADMIN_BLACKOUTS_PATH}?err=day`);

  try {
    const sql = getDb();
    // `::date` on a validated string, never a Date — see the note in add.ts.
    await sql`DELETE FROM blackout_dates WHERE day = ${day}::date`;
  } catch (err) {
    console.error(`Blackout delete ${day} failed:`, err);
    return redirect(`${ADMIN_BLACKOUTS_PATH}?err=db`);
  }

  return redirect(`${ADMIN_BLACKOUTS_PATH}?removed=1`);
};

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
