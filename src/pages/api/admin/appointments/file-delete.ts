import type { APIRoute } from 'astro';

export const prerender = false;

import { adminAppointmentPath, ADMIN_APPOINTMENTS_PATH } from '../../../../lib/booking-admin';
import { parseFileDeleteNote } from '../../../../lib/booking-admin-entry';
import { getDb } from '../../../../lib/db';

/**
 * Un-attach a file from an appointment (BK-40).
 *
 * **IT LIVES UNDER `/api/admin/appointments/`, NOT `/api/admin/files/`, AND
 * THAT IS NOT A FILING PREFERENCE.** `src/pages/api/admin/files/[id].ts` is a
 * dynamic route, so `/api/admin/files/delete/` and `/api/admin/files/7/` are
 * the same URL shape. Astro resolves static before dynamic and it would
 * probably work — "probably" being the word that cost BK-34a a production
 * outage with every gate green. `/api/admin/appointments/` has no dynamic
 * sibling, so there is nothing to resolve and nothing to be wrong about.
 *
 * SOFT, AND THE BYTES STAY. `deleted_at` hides the row from the files list,
 * from the file proxy (`claimedFilePathname`) and from the upload caps; the
 * object is left in the Blob store. The office asked for this button because of
 * *accidental* uploads, so the one thing it must not be is unrecoverable.
 *
 * **NOTHING IS APPENDED TO `admin_notes`, and that is a deliberate departure
 * from BK-35's audit-line pattern rather than an omission.** That pattern
 * appends one fixed sentence, once, and `MAX_STORED_ADMIN_NOTES` is sized for
 * exactly one — `MAX_ADMIN_NOTES + UNTICKED_NOTE.length + 2`. Deletions are
 * unbounded, so appending here would push the stored notes past the bound the
 * detail page's textarea and `parseAppointmentUpdate` both enforce, and the
 * consequence is documented at that constant: **every later status change is
 * rejected with "That edit was not valid", naming no field**, and the
 * appointment cannot be moved through the pipeline until somebody hand-deletes
 * text the system itself wrote. The audit lives in `deleted_note` instead —
 * queryable, in a TEXT column of its own, rendered on the row it describes,
 * which is where the office is already looking.
 *
 * The appointment id for the redirect comes off the ROW, not off the form. A
 * `Location` built from a request field is a redirect target the caller chose.
 */
export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`${ADMIN_APPOINTMENTS_PATH}?files=form`);
  }

  const raw = form.get('id');
  // The same shape `[id].astro` requires of a URL segment: digits, no leading
  // zero, inside int4. A looser parse on the delete path than on the read path
  // is how a delete removes something nobody named.
  const id =
    typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) && Number(raw) <= 2147483647
      ? Number(raw)
      : null;
  if (id === null) return redirect(`${ADMIN_APPOINTMENTS_PATH}?files=badid`);

  const note = parseFileDeleteNote(form.get('note'));

  try {
    const sql = getDb();

    // ONE guarded statement, the idiom `update.ts` already uses. `deleted_at IS
    // NULL` in the WHERE is what makes a double submit idempotent instead of
    // overwriting the first deletion's timestamp and note with the second's —
    // which would quietly rewrite the audit record this exists to keep.
    //
    // `appointment_id IS NOT NULL` matches `claimedFilePathname`: an unclaimed
    // draft row belongs to no appointment, renders on no admin page, and is the
    // orphan cron's to sweep.
    const rows = (await sql`
      UPDATE appointment_files
      SET deleted_at   = now(),
          deleted_note = ${note}
      WHERE id = ${id}
        AND appointment_id IS NOT NULL
        AND deleted_at IS NULL
      RETURNING appointment_id, original_name
    `) as { appointment_id: number; original_name: string | null }[];

    const row = rows[0];
    if (!row) {
      // Already deleted, never existed, or unclaimed. All three are the same
      // answer to the office — that file is not on this appointment — and
      // which appointment they came from is not knowable without trusting the
      // form, so this lands on the list.
      return redirect(`${ADMIN_APPOINTMENTS_PATH}?files=gone`);
    }

    // For whoever is debugging, exactly as BK-35 pairs a warn with its note.
    console.warn(
      `Admin removed file ${id} (${row.original_name ?? 'unnamed'}) ` +
        `from appointment ${row.appointment_id}.`,
    );

    return redirect(`${adminAppointmentPath(row.appointment_id)}?files=removed`);
  } catch (err) {
    console.error(`Soft delete of file ${id} failed:`, err);
    return redirect(`${ADMIN_APPOINTMENTS_PATH}?files=db`);
  }
};

/** Slashed Locations only — an unslashed one 308s straight back through here. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
