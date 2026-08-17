import type { APIRoute } from 'astro';

export const prerender = false;

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import {
  APPOINTMENT_UPLOAD_RATE_LIMIT_PER_HOUR,
  MAX_FILES_PER_BOOKING,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../../../lib/booking-config';
import { parseUploadPathname, formatBytes } from '../../../lib/booking-uploads';
import { getDb } from '../../../lib/db';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { verifyAppointmentUploadToken } from '../../../lib/draft-token';

/** Same as the draft route's: a 100 MB video on a slow phone connection needs the room. */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type ClientPayload = {
  uploadToken: string;
  /** Byte length the browser reports for this file. Becomes the hard ceiling on the token. */
  size: number;
  originalName?: string;
};

function parseClientPayload(raw: string | null): ClientPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { uploadToken, size, originalName } = parsed as Record<string, unknown>;
    if (typeof uploadToken !== 'string' || typeof size !== 'number') return null;
    return {
      uploadToken,
      size,
      originalName: typeof originalName === 'string' ? originalName.slice(0, 200) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Blob client-upload tokens for a phone booking's photos (BK-34a).
 *
 * The sibling of `/api/booking/upload-token/`, and deliberately a sibling
 * rather than a branch inside it: that route's authorization is a draft token
 * and its caps are counted per draft, and threading a second identity through
 * it would put the two on one code path where a mistake in either reaches both.
 * Everything that is genuinely shared — `parseUploadPathname`, the content-type
 * whitelist, the size ceiling, the caps themselves — IS shared.
 *
 * Four differences from the draft route, all deliberate:
 *
 *   1. Authorization is an appointment upload token, so the appointment id
 *      comes out of a signature rather than out of the URL.
 *   2. The file-count and byte-total caps count against `appointment_id`, not
 *      `draft_id` — a customer texted a second link must not get a fresh
 *      10-file / 300 MB budget.
 *   3. The inserted row sets `appointment_id` as well as `draft_id`, which is
 *      what keeps the orphan-cleanup cron and the admin file proxy correct with
 *      no special case in either.
 *   4. IT IS RATE LIMITED. The draft route is not — a standing Known trap,
 *      tolerable there because a draft token dies in 6h and is minted behind a
 *      throttle. This token lives 72h and is handed to a customer by SMS.
 *      Bucketed per appointment, not per IP: the customer is on a phone behind
 *      CGNAT, so an IP bucket would be shared with strangers or meaningless.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,

      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = parseClientPayload(clientPayload);
        if (!payload) throw new Error('Malformed upload request');

        const claims = await verifyAppointmentUploadToken(payload.uploadToken);
        if (!claims) throw new Error('This upload link has expired — please call or text us');
        // `origin` comes out of the SIGNATURE (BK-40), never off the request —
        // it is what `appointment_files.source` records, and provenance the
        // caller could choose is provenance the office would wrongly believe.
        const { appointmentId, draftId, origin } = claims;

        // The pathname is checked against the draft id INSIDE the signature,
        // never against anything the caller sent alongside it.
        const parsed = parseUploadPathname(pathname, draftId);
        if (!parsed) throw new Error('That file type is not supported');

        const declaredSize = payload.size;
        if (!Number.isInteger(declaredSize) || declaredSize <= 0) {
          throw new Error('Invalid file size');
        }
        if (declaredSize > MAX_FILE_BYTES) {
          throw new Error(`Each file must be under ${formatBytes(MAX_FILE_BYTES)}`);
        }

        const sql = getDb();

        const limit = await consumeRateLimit(
          sql,
          `appt-upload:${appointmentId}`,
          APPOINTMENT_UPLOAD_RATE_LIMIT_PER_HOUR,
          HOUR_MS,
        );
        if (!limit.allowed) {
          throw new Error('Too many uploads just now — please wait a few minutes and try again');
        }

        // One statement answers two questions: does the appointment exist, and
        // what is already attached to it. A LEFT JOIN rather than two queries
        // because a missing row must be distinguishable from a row with no
        // files — an aggregate on its own returns 0 for both, and a token
        // naming a deleted appointment would then reach the INSERT and fail on
        // the foreign key as a 400 with no explanation.
        //
        // `pathname <> ...` excludes this file so a retry of a failed upload
        // does not consume a second slot against the quota — the same exclusion
        // the draft route makes, for the same reason.
        //
        // STALE `pending` ROWS ARE EXCLUDED, and unlike the draft route this is
        // not optional. A row here is born with `appointment_id` set, which is
        // exactly what makes the orphan-cleanup cron
        // (`WHERE appointment_id IS NULL`) never sweep it. So a request that
        // mints a token and never uploads leaves a row that counts against the
        // cap FOREVER: ten of them and the appointment can never receive another
        // file, through this link, a re-issued one, or the office's own admin
        // uploader, with no UI anywhere to delete one. The draft route's
        // equivalent self-heals because the cron does sweep its rows.
        //
        // The window matches `TOKEN_TTL_MS` — once a client token has expired
        // its row can no longer become an upload, so it is not holding a slot
        // for anything. A row that did complete is `uploaded` and counts for
        // good, whatever its age.
        const [totals] = (await sql`
          SELECT a.id,
                 COUNT(f.id)::int                      AS files,
                 COALESCE(SUM(f.size_bytes), 0)::bigint AS bytes
          FROM appointments a
          LEFT JOIN appointment_files f
            ON f.appointment_id = a.id
           AND f.pathname <> ${pathname}
           AND f.deleted_at IS NULL
           AND (
                 f.upload_state = 'uploaded'
              OR f.created_at > ${new Date(Date.now() - TOKEN_TTL_MS)}
           )
          WHERE a.id = ${appointmentId}
          GROUP BY a.id
        `) as { id: number; files: number; bytes: string | number }[];

        if (!totals) throw new Error('This upload link has expired — please call or text us');

        const existingFiles = totals.files ?? 0;
        const existingBytes = Number(totals.bytes ?? 0);

        if (existingFiles >= MAX_FILES_PER_BOOKING) {
          throw new Error(`You can attach up to ${MAX_FILES_PER_BOOKING} files`);
        }
        if (existingBytes + declaredSize > MAX_TOTAL_BYTES) {
          throw new Error(`Attachments must total under ${formatBytes(MAX_TOTAL_BYTES)}`);
        }

        // BOTH columns, from the start. `appointment_id` is what makes this row
        // invisible to the orphan cleanup cron and visible to the admin file
        // proxy; `draft_id` is what keeps the pathname shape identical to the
        // web funnel's.
        //
        // `GREATEST` ON CONFLICT, NOT `EXCLUDED.size_bytes`. `size_bytes` is
        // only ever the size the CLIENT declared — `onUploadCompleted` receives
        // no size from Vercel and so cannot correct it (the claim in migration
        // 002's comment that it is "overwritten with the true size" is not
        // true). A plain overwrite therefore lets a caller declare 100 MB,
        // upload 100 MB, then re-mint the same pathname declaring 1 byte: the
        // `pathname <> ...` exclusion above takes the row out of its own totals,
        // so the check passes and the recorded size is rewritten downward. Ten
        // rounds put 1 GB in the store against a 300 MB cap. Taking the larger
        // of the two keeps a retry working — the honest case declares the same
        // size twice — while making the budget monotonic. The draft route's twin
        // is a ROADMAP Known trap.
        // `source` is NOT in the DO UPDATE list, deliberately. A retry of the
        // same pathname keeps the origin the row was born with; letting a later
        // token rewrite it would make provenance depend on who retried last.
        await sql`
          INSERT INTO appointment_files
            (appointment_id, draft_id, pathname, content_type, size_bytes, original_name, source)
          VALUES
            (${appointmentId}, ${draftId}::uuid, ${pathname}, ${parsed.contentType},
             ${declaredSize}, ${payload.originalName ?? null}, ${origin})
          ON CONFLICT (pathname) DO UPDATE
            SET size_bytes    = GREATEST(appointment_files.size_bytes, EXCLUDED.size_bytes),
                original_name = EXCLUDED.original_name
        `;

        return {
          addRandomSuffix: false,
          allowOverwrite: false,
          allowedContentTypes: [parsed.contentType],
          maximumSizeInBytes: declaredSize,
          validUntil: Date.now() + TOKEN_TTL_MS,
          tokenPayload: JSON.stringify({ appointmentId, draftId, pathname }),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Called by Vercel, not by the browser — it does not fire against
        // localhost, so in dev rows stay 'pending' and the admin page says so.
        let pathname = blob.pathname;
        try {
          const parsed = JSON.parse(tokenPayload ?? '{}') as { pathname?: string };
          if (parsed.pathname) pathname = parsed.pathname;
        } catch {
          // fall back to the blob's own pathname
        }

        const sql = getDb();
        await sql`
          UPDATE appointment_files
          SET upload_state = 'uploaded',
              url          = ${blob.url}
          WHERE pathname = ${pathname}
        `;
      },
    });

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    console.error('Appointment upload token error:', err);
    // 400 rather than 500 — Vercel retries the upload-completed webhook five
    // times waiting for a 2xx, and a retry will not fix a rejected token.
    return Response.json({ error: message }, { status: 400 });
  }
};
