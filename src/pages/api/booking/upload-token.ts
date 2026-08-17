import type { APIRoute } from 'astro';

export const prerender = false;

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import {
  MAX_FILES_PER_BOOKING,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../../../lib/booking-config';
import { parseUploadPathname, formatBytes } from '../../../lib/booking-uploads';
import { getDb } from '../../../lib/db';
import { verifyDraftToken } from '../../../lib/draft-token';

/** Client tokens stay valid this long — a 100 MB video on a slow phone connection needs the room. */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

type ClientPayload = {
  draftToken: string;
  /** Byte length the browser reports for this file. Becomes the hard ceiling on the token. */
  size: number;
  originalName?: string;
};

function parseClientPayload(raw: string | null): ClientPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { draftToken, size, originalName } = parsed as Record<string, unknown>;
    if (typeof draftToken !== 'string' || typeof size !== 'number') return null;
    return {
      draftToken,
      size,
      originalName: typeof originalName === 'string' ? originalName.slice(0, 200) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Mints Vercel Blob client-upload tokens for the booking form.
 *
 * There is no user session to authenticate against, so authorization is the
 * signed draft token issued by `/api/booking/draft`. Everything else is
 * enforced here rather than in the browser:
 *
 *   - the pathname must sit under the verified draft's prefix
 *   - the extension must map to an accepted content type, and the token
 *     permits only that one type
 *   - the token's `maximumSizeInBytes` is the size the client declared, so a
 *     client that under-declares cannot then upload something larger
 *   - file count and running byte total are checked against the draft
 *
 * The `appointment_files` row is written now, with `appointment_id` NULL, so
 * an upload that is never claimed by a booking is findable by the cleanup
 * cron without listing the blob store.
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

        const draftId = await verifyDraftToken(payload.draftToken);
        if (!draftId) throw new Error('Upload session expired — please reload the form');

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

        // Exclude this pathname so a retry of a failed upload does not consume
        // a second slot against the draft's quota.
        const [totals] = (await sql`
          SELECT COUNT(*)::int AS files,
                 COALESCE(SUM(size_bytes), 0)::bigint AS bytes
          FROM appointment_files
          WHERE draft_id = ${draftId}::uuid
            AND pathname <> ${pathname}
        `) as { files: number; bytes: string | number }[];

        const existingFiles = totals?.files ?? 0;
        const existingBytes = Number(totals?.bytes ?? 0);

        if (existingFiles >= MAX_FILES_PER_BOOKING) {
          throw new Error(`You can attach up to ${MAX_FILES_PER_BOOKING} files`);
        }
        if (existingBytes + declaredSize > MAX_TOTAL_BYTES) {
          throw new Error(`Attachments must total under ${formatBytes(MAX_TOTAL_BYTES)}`);
        }

        await sql`
          INSERT INTO appointment_files
            (draft_id, pathname, content_type, size_bytes, original_name, source)
          VALUES
            (${draftId}::uuid, ${pathname}, ${parsed.contentType},
             ${declaredSize}, ${payload.originalName ?? null}, 'web')
          ON CONFLICT (pathname) DO UPDATE
            SET size_bytes    = EXCLUDED.size_bytes,
                original_name = EXCLUDED.original_name
        `;

        return {
          addRandomSuffix: false,
          allowOverwrite: false,
          allowedContentTypes: [parsed.contentType],
          maximumSizeInBytes: declaredSize,
          validUntil: Date.now() + TOKEN_TTL_MS,
          tokenPayload: JSON.stringify({ draftId, pathname }),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Called by Vercel, not by the browser — it does not fire against
        // localhost. In dev, rows stay 'pending' until the booking claims them.
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
    console.error('Upload token error:', err);
    // 400 rather than 500 — Vercel retries the upload-completed webhook five
    // times waiting for a 2xx, and a retry will not fix a rejected token.
    return Response.json({ error: message }, { status: 400 });
  }
};
